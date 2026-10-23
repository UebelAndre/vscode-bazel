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

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { ILogger } from "../extension/logger";
import { BindingResolver, ModuleLoader } from "./bindings";
import { ExternalRepoResolver, RepoResolution } from "./external_repos";
import { BzlDefinition, BzlFileModel, IndexedTarget } from "./file_models";
import type { IndexManager } from "./index_manager";
import { ParsedLabel, parseLabel } from "./label";
import { SchemaResolver } from "./rule_schema";
import {
  BUILD_FILE_NAMES,
  WorkspaceIndex,
  packagePathOf,
  toVsRange,
} from "./workspace_index";

/** The repository and package a Starlark file belongs to. */
export interface FileContext {
  /** Index of the main repository this file is viewed from. */
  index: WorkspaceIndex;
  resolver: ExternalRepoResolver;
  /** Canonical name of the repository containing the file; `""` for main. */
  canonicalRepo: string;
  /** Root directory of that repository. */
  repoRoot: string;
  /** Package of the file within its repository. */
  pkg: string;
  file: string;
}

/** A resolved definition site. */
export interface ResolvedLocation {
  uri: vscode.Uri;
  range: vscode.Range;
  /** The target at the location, when the label named one. */
  target?: IndexedTarget;
  /** The Starlark definition at the location, when resolving a symbol. */
  definition?: BzlDefinition;
}

const PROMPT_INTERVAL_MS = 30_000;

/** Whether a path names an existing regular file. */
function isFile(fsPath: string): boolean {
  try {
    return fs.statSync(fsPath).isFile();
  } catch {
    return false;
  }
}

/** Finds the BUILD file of a directory, if any. */
export function findBuildFile(dir: string): string | undefined {
  for (const name of BUILD_FILE_NAMES) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Finds the package containing `fsPath` inside `repoRoot` by walking up to
 * the nearest directory with a BUILD file.
 */
function enclosingPackage(repoRoot: string, fsPath: string): string {
  let dir = path.dirname(fsPath);
  for (;;) {
    const pkg = packagePathOf(repoRoot, dir);
    if (pkg === undefined) {
      return "";
    }
    if (pkg === "" || findBuildFile(dir)) {
      return pkg;
    }
    dir = path.dirname(dir);
  }
}

/** The location of a target's `name` attribute. */
function targetLocation(target: IndexedTarget): ResolvedLocation {
  return {
    uri: vscode.Uri.file(target.file),
    range: toVsRange(target.nameRange),
    target,
  };
}

/**
 * Resolves labels and loaded symbols to source locations using the index
 * and, for external repositories, the files Bazel has fetched. Also serves
 * as the file loader of name resolution and schema evaluation, so that
 * following a `load()` uses the same label rules as go to definition.
 */
export class LabelResolver implements ModuleLoader {
  /** Resolves top-level names across files. */
  public readonly bindings = new BindingResolver(this);
  /** Schemas of rules, macros, structs and providers reachable from files. */
  public readonly schemas = new SchemaResolver(this, this.bindings);

  constructor(
    private readonly manager: IndexManager,
    private readonly logger: ILogger,
  ) {}

  // -------------------------------------------------------------------------
  // ModuleLoader

  public async resolveModule(
    moduleLabel: string,
    fromFile: string,
  ): Promise<string | undefined> {
    const ctx = await this.contextFor(fromFile);
    if (!ctx) {
      return undefined;
    }
    return (await this.resolveLoadModule(moduleLabel, ctx))?.file;
  }

  public getModel(file: string): BzlFileModel | undefined {
    const index =
      this.manager.getIndexForPath(file) ?? this.manager.getIndexes()[0];
    return index?.getBzlModel(file);
  }

  // -------------------------------------------------------------------------
  // Contexts

  /** Determines which repository and package a file belongs to. */
  public async contextFor(fsPath: string): Promise<FileContext | undefined> {
    const index = this.manager.getIndexForPath(fsPath);
    if (index) {
      return {
        index,
        resolver: this.manager.getResolver(index.root),
        canonicalRepo: "",
        repoRoot: index.root,
        pkg: enclosingPackage(index.root, fsPath),
        file: fsPath,
      };
    }
    // Perhaps the file lives in a fetched external repository of one of the
    // open workspaces.
    for (const candidate of this.manager.getIndexes()) {
      const resolver = this.manager.getResolver(candidate.root);
      const repo = await resolver.repoForPath(fsPath);
      if (repo && repo.canonical !== "") {
        return {
          index: candidate,
          resolver,
          canonicalRepo: repo.canonical,
          repoRoot: repo.dir,
          pkg: enclosingPackage(repo.dir, fsPath),
          file: fsPath,
        };
      }
    }
    return undefined;
  }

  /**
   * Resolves the directory of the repository a label refers to.
   *
   * @param interactive True for navigation the user asked for: Bazel may
   * then be consulted for the repository mapping, and the user is offered to
   * fetch a missing repository. Hover, completion and background work pass
   * false and only use what is already known.
   * @returns The directory and canonical name, or undefined when the
   * repository is unknown or has not been fetched.
   */
  public async repoDirFor(
    label: ParsedLabel,
    ctx: FileContext,
    interactive: boolean,
  ): Promise<{ dir: string; canonical: string } | undefined> {
    if (label.repo === undefined) {
      return { dir: ctx.repoRoot, canonical: ctx.canonicalRepo };
    }
    if (
      ctx.canonicalRepo === "" &&
      (label.repo === "" ||
        ctx.index.getModuleModel()?.selfNames.includes(label.repo))
    ) {
      // `@my_module//...` from inside my_module: no need to ask Bazel.
      return { dir: ctx.repoRoot, canonical: "" };
    }
    const resolution = await ctx.resolver.resolveRepo(
      label.repo,
      label.canonical,
      ctx.canonicalRepo,
      interactive,
    );
    if (resolution.dir) {
      return { dir: resolution.dir, canonical: resolution.canonical };
    }
    if (interactive) {
      this.offerFetch(label, resolution, ctx);
    }
    return undefined;
  }

  /** When each repository was last prompted about, to avoid stacking toasts. */
  private readonly prompted = new Map<string, number>();

  private offerFetch(
    label: ParsedLabel,
    resolution: RepoResolution,
    ctx: FileContext,
  ) {
    const repo = `@${label.repo}`;
    // Ctrl+hover link detection calls the definition provider too; one
    // prompt per repository every so often is plenty.
    const now = Date.now();
    const key = `${ctx.canonicalRepo}\u0000${resolution.canonical}`;
    if (now - (this.prompted.get(key) ?? 0) < PROMPT_INTERVAL_MS) {
      return;
    }
    this.prompted.set(key, now);
    if (resolution.missing !== "unfetched") {
      void vscode.window.showWarningMessage(
        `Repository ${repo} is not visible from ${
          ctx.canonicalRepo ? `@@${ctx.canonicalRepo}` : "the main repository"
        }.`,
      );
      return;
    }
    void vscode.window
      .showInformationMessage(
        `Repository ${repo} has not been fetched yet.`,
        "Fetch",
      )
      .then(async (choice) => {
        if (choice !== "Fetch") {
          return;
        }
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Fetching ${repo} (@@${resolution.canonical})`,
            },
            () => ctx.resolver.fetchRepo(resolution.canonical),
          );
          // Names that could not be resolved before may exist now.
          this.schemas.clear();
          const first = (await this.resolveLabel(label, ctx, false))[0];
          if (first) {
            await vscode.window.showTextDocument(first.uri, {
              selection: first.range,
            });
          }
        } catch (err) {
          // execFile errors carry Bazel's stderr, which is what explains
          // the failure; surface it instead of the generic message.
          const stderr = (err as { stderr?: string })?.stderr?.trim();
          this.logger.logError(
            `Failed to fetch ${repo}${stderr ? `: ${stderr.split("\n").pop()}` : ""}`,
            true,
            err,
          );
        }
      });
  }

  // -------------------------------------------------------------------------
  // Labels

  /** Resolves a label to the locations that define it. */
  public async resolveLabel(
    label: ParsedLabel,
    ctx: FileContext,
    interactive = false,
  ): Promise<ResolvedLocation[]> {
    const repo = await this.repoDirFor(label, ctx, interactive);
    if (!repo) {
      return [];
    }
    const pkgDir = path.join(repo.dir, ...label.pkg.split("/"));
    let target: IndexedTarget | undefined;
    if (repo.canonical === "" && repo.dir === ctx.index.root) {
      target = ctx.index.findTarget(label.pkg, label.name);
    } else {
      const buildFile = findBuildFile(pkgDir);
      target = buildFile
        ? ctx.index
            .getForeignBuildModel(buildFile, label.pkg)
            ?.targets.find((t) => t.name === label.name)
        : undefined;
    }
    if (target) {
      return [targetLocation(target)];
    }
    const file = path.join(pkgDir, label.name);
    return isFile(file)
      ? [{ uri: vscode.Uri.file(file), range: new vscode.Range(0, 0, 0, 0) }]
      : [];
  }

  /** Resolves the `.bzl` file named by a `load()` statement. */
  public async resolveLoadModule(
    moduleLabel: string,
    ctx: FileContext,
    interactive = false,
  ): Promise<{ file: string; ctx: FileContext } | undefined> {
    const label = parseLabel(moduleLabel, ctx.pkg);
    if (!label) {
      return undefined;
    }
    const repo = await this.repoDirFor(label, ctx, interactive);
    if (!repo) {
      return undefined;
    }
    const file = path.join(repo.dir, ...label.pkg.split("/"), label.name);
    if (!isFile(file)) {
      return undefined;
    }
    return {
      file,
      ctx: {
        ...ctx,
        canonicalRepo: repo.canonical,
        repoRoot: repo.dir,
        pkg: label.pkg,
        file,
      },
    };
  }

  /**
   * Resolves a symbol loaded from a module to its definition, following
   * re-exports such as `foo = _foo` and chained loads.
   */
  public async resolveLoadedSymbol(
    moduleLabel: string,
    symbol: string,
    ctx: FileContext,
    interactive = false,
  ): Promise<ResolvedLocation[]> {
    const resolved = await this.resolveLoadModule(
      moduleLabel,
      ctx,
      interactive,
    );
    if (!resolved) {
      return [];
    }
    const binding = await this.bindings.bindingFor(symbol, resolved.file);
    const definition = binding?.model.definitions.get(binding.name);
    if (!binding || !definition) {
      return [];
    }
    return [
      {
        uri: vscode.Uri.file(binding.file),
        range: toVsRange(definition.nameRange),
        definition,
      },
    ];
  }
}
