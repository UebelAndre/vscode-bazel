// Copyright 2026 The Bazel Authors. All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as path from "path";
import * as vscode from "vscode";

import { BazelQuery } from "../bazel/bazel_query";
import { QueryLocation } from "../bazel/query_location";
import {
  getBazelExecutablePath,
  getIndexScopePrefix,
  getMacroTargetsMode,
} from "../extension/configuration";
import { ILogger } from "../extension/logger";
import { affectsRenamedSetting } from "../extension/settings_migration";
import { blaze_query } from "../protos";
import { IndexedTarget } from "./file_models";
import { IndexManager } from "./index_manager";
import {
  IndexChange,
  WorkspaceIndex,
  isBuildFileName,
} from "./workspace_index";

/** Minimum time between automatic re-queries of one repository. */
const COOLDOWN_MS = 5 * 60 * 1000;
/** Delay after an index build before querying, to let the UI settle. */
const INITIAL_DELAY_MS = 1500;

/**
 * Augments the parsed index with targets that only Bazel knows about: those
 * created inside macros. Controlled by `bazel.index.macroTargets`.
 *
 * In `openFiles` mode one package is queried at a time, when a BUILD file
 * that calls a macro is opened or saved; rules create exactly one target, so
 * files that only call rules are never queried. In `workspace` mode the
 * whole repository is queried once after indexing and again on explicit
 * refresh or, rarely, after a BUILD file with dynamic macro calls changes.
 */
export class MacroTargetOverlay implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly lastRun = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Document versions already queried, by BUILD file path. */
  private readonly queriedVersions = new Map<string, number>();
  /** Roots whose running whole-workspace query must be repeated. */
  private readonly rerun = new Set<string>();
  /** Set while merging query results, whose index change is not a reason to query again. */
  private applying = false;

  constructor(
    private readonly manager: IndexManager,
    private readonly logger: ILogger,
  ) {
    this.disposables.push(
      manager.onDidChange((change) => this.onIndexChanged(change)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (affectsRenamedSetting(e, "bazel.index.macroTargets")) {
          this.onConfigurationChanged();
        }
      }),
      vscode.workspace.onDidOpenTextDocument((doc) =>
        this.onDocumentShown(doc),
      ),
      vscode.workspace.onDidSaveTextDocument((doc) =>
        this.onDocumentShown(doc),
      ),
      vscode.workspace.onDidCloseTextDocument((doc) =>
        this.queriedVersions.delete(doc.uri.fsPath),
      ),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.onDocumentShown(editor.document);
        }
      }),
    );
    // Files restored with the window were shown before this listener existed.
    for (const editor of vscode.window.visibleTextEditors) {
      this.onDocumentShown(editor.document);
    }
  }

  public dispose() {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private onConfigurationChanged() {
    this.queriedVersions.clear();
    switch (getMacroTargetsMode()) {
      case "workspace":
        for (const index of this.manager.getIndexes()) {
          this.schedule(index, 0, true);
        }
        break;
      case "openFiles":
        for (const index of this.manager.getIndexes()) {
          index.setGeneratedTargets(new Map());
        }
        for (const editor of vscode.window.visibleTextEditors) {
          this.onDocumentShown(editor.document);
        }
        break;
      default:
        for (const index of this.manager.getIndexes()) {
          index.setGeneratedTargets(new Map());
        }
    }
  }

  // -------------------------------------------------------------------------
  // Whole-workspace mode

  private onIndexChanged(change: IndexChange) {
    if (this.applying || getMacroTargetsMode() !== "workspace") {
      return;
    }
    const index = this.manager.getIndex(change.root);
    if (!index || !index.isBuilt) {
      return;
    }
    if (!change.pkgs) {
      // Full (re)build: always re-query.
      this.schedule(index, INITIAL_DELAY_MS, true);
      return;
    }
    if (change.pkgs.some((pkg) => index.mayCallMacros(pkg))) {
      this.schedule(index, INITIAL_DELAY_MS, false);
    }
  }

  private schedule(index: WorkspaceIndex, delay: number, force: boolean) {
    const root = index.root;
    const existing = this.timers.get(root);
    if (existing) {
      clearTimeout(existing);
    }
    if (!force) {
      const last = this.lastRun.get(root) ?? 0;
      delay = Math.max(delay, last + COOLDOWN_MS - Date.now());
    }
    this.timers.set(
      root,
      setTimeout(() => {
        this.timers.delete(root);
        void this.refresh(index);
      }, delay),
    );
  }

  /**
   * Queries Bazel for the repository's rules and merges generated ones. A
   * refresh requested while one is running is repeated afterwards, since
   * the running query may predate the change that requested it.
   */
  public refresh(index: WorkspaceIndex): Promise<void> {
    const root = index.root;
    let running = this.inFlight.get(root);
    if (running !== undefined) {
      this.rerun.add(root);
      return running;
    }
    running = this.doRefresh(index).finally(() => {
      this.inFlight.delete(root);
      if (this.rerun.delete(root)) {
        void this.refresh(index);
      }
    });
    this.inFlight.set(root, running);
    return running;
  }

  /** Merges results into the index without taking the change as a cue to query again. */
  private apply(merge: () => void) {
    this.applying = true;
    try {
      merge();
    } finally {
      this.applying = false;
    }
  }

  private async doRefresh(index: WorkspaceIndex): Promise<void> {
    this.lastRun.set(index.root, Date.now());
    const scope = getIndexScopePrefix();
    const universe = scope ? `//${scope}/...` : "//...";
    this.logger.logInfo(`Querying macro-generated targets in ${index.root}`);
    const byPkg = await this.query(index, `kind(rule, ${universe})`, [
      "--keep_going",
    ]);
    if (!byPkg) {
      return;
    }
    let count = 0;
    for (const targets of byPkg.values()) {
      count += targets.length;
    }
    this.logger.logInfo(
      `Found ${count} macro-generated targets in ${index.root}`,
    );
    this.apply(() => index.setGeneratedTargets(byPkg));
  }

  // -------------------------------------------------------------------------
  // Per-file mode

  private onDocumentShown(document: vscode.TextDocument) {
    if (
      getMacroTargetsMode() !== "openFiles" ||
      document.uri.scheme !== "file" ||
      !isBuildFileName(path.basename(document.uri.fsPath)) ||
      document.isDirty
    ) {
      return;
    }
    const file = document.uri.fsPath;
    if (this.queriedVersions.get(file) === document.version) {
      return;
    }
    const index = this.manager.getIndexForPath(file);
    if (index && !index.isBuilt) {
      // Shown while the index is still scanning: come back once it knows
      // the file's package.
      void index.ready.then(() => {
        if (!document.isClosed) {
          this.onDocumentShown(document);
        }
      });
      return;
    }
    const entry = index?.getPackageForBuildFile(file);
    if (!index || !entry) {
      return;
    }
    this.queriedVersions.set(file, document.version);
    void this.refreshPackage(index, entry.pkg, file);
  }

  /**
   * Queries one package, but only if its BUILD file calls something that may
   * create more than one target: a `def` macro, or a loaded symbol whose
   * definition cannot be resolved. Rules and native rules never need it.
   *
   * @returns Whether Bazel was queried.
   */
  public async refreshPackage(
    index: WorkspaceIndex,
    pkg: string,
    file: string,
  ): Promise<boolean> {
    const entry = index.getPackage(pkg);
    if (!entry) {
      return false;
    }
    const loaded = new Set(
      entry.model.loads.flatMap((l) => l.symbols.map((s) => s.local)),
    );
    const callees = new Set<string>([
      ...entry.model.targets.map((t) => t.kind),
      ...entry.model.calls.map((c) => c.callee),
    ]);
    let mayExpand = entry.model.calls.some((c) => c.dynamic);
    for (const callee of callees) {
      if (mayExpand) {
        break;
      }
      if (!loaded.has(callee.split(".")[0])) {
        continue; // Native rules and `package()`-style calls.
      }
      const binding = await this.manager.labels.bindings.bindingFor(
        callee,
        file,
      );
      const definition = binding?.model.definitions.get(binding.name);
      mayExpand = definition === undefined || definition.kind !== "rule";
    }
    if (!mayExpand) {
      this.apply(() => index.setGeneratedTargetsForPackage(pkg, []));
      return false;
    }
    const key = `${index.root}\u0000${pkg}`;
    const pending = this.inFlight.get(key);
    if (pending !== undefined) {
      await pending;
      return true;
    }
    const running = (async () => {
      this.logger.logInfo(
        `Querying macro-generated targets of //${pkg} in ${index.root}`,
      );
      const byPkg = await this.query(index, `kind(rule, //${pkg}:all)`, []);
      if (byPkg) {
        this.apply(() =>
          index.setGeneratedTargetsForPackage(pkg, byPkg.get(pkg) ?? []),
        );
      }
    })().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, running);
    await running;
    return true;
  }

  // -------------------------------------------------------------------------
  // Shared

  /**
   * Runs a query and returns, per package, the targets a macro generated
   * that the parser did not see. Returns undefined when the query failed,
   * so that earlier results stay in place.
   */
  private async query(
    index: WorkspaceIndex,
    expression: string,
    additionalOptions: string[],
  ): Promise<Map<string, IndexedTarget[]> | undefined> {
    let result: blaze_query.QueryResult;
    try {
      result = await new BazelQuery(
        getBazelExecutablePath(),
        index.root,
      ).queryTargets(expression, {
        additionalOptions,
        ruleAttributes: ["generator_name", "generator_function"],
      });
    } catch (err) {
      this.logger.logWarn(
        "Query for macro-generated targets failed",
        false,
        err,
      );
      return undefined;
    }
    const byPkg = new Map<string, IndexedTarget[]>();
    for (const target of result.target) {
      const rule = target.rule;
      if (!rule?.name || !rule.location) {
        continue;
      }
      const label = rule.name.replace(/^@@?\/\//, "//");
      const colon = label.lastIndexOf(":");
      if (!label.startsWith("//") || colon === -1) {
        continue;
      }
      const pkg = label.slice(2, colon);
      const name = label.slice(colon + 1);
      const entry = index.getPackage(pkg);
      if (!entry || entry.model.targets.some((t) => t.name === name)) {
        continue;
      }
      const generatorFunction = attribute(rule, "generator_function") ?? "";
      if (!generatorFunction && !entry.model.calls.some((c) => c.dynamic)) {
        // Not produced by a macro and the parser saw every call: a stale
        // query result that must not shadow the live parse. Packages with
        // computed names (`name = "lib_" + x` in a loop) keep such targets.
        continue;
      }
      const location = new QueryLocation(rule.location);
      const position = {
        line: Math.max(0, location.line - 1),
        character: Math.max(0, location.column - 1),
      };
      const generated: IndexedTarget = {
        label,
        name,
        pkg,
        kind: rule.ruleClass ?? "rule",
        file: location.path,
        range: { start: position, end: position },
        nameRange: { start: position, end: position },
        generated: {
          generatorName: attribute(rule, "generator_name") ?? "",
          generatorFunction,
        },
      };
      const list = byPkg.get(pkg);
      if (list) {
        list.push(generated);
      } else {
        byPkg.set(pkg, [generated]);
      }
    }
    return byPkg;
  }
}

function attribute(rule: blaze_query.IRule, name: string): string | undefined {
  const attr = rule.attribute?.find((a) => a.name === name);
  return attr?.stringValue ?? undefined;
}
