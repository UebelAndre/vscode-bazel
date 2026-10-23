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

import { getBazelWorkspaceFolder } from "../bazel/bazel_utils";
import { ILogger } from "../extension/logger";
import {
  BuildFileModel,
  BzlFileModel,
  IndexedTarget,
  ModuleFileModel,
  SourceRange,
  extractBuildModel,
  extractBzlModel,
  extractModuleModel,
} from "./file_models";

/** Names recognised as BUILD files, in order of precedence. */
export const BUILD_FILE_NAMES = ["BUILD.bazel", "BUILD"];

/**
 * Orders package paths segment by segment, so that a package is directly
 * followed by its sub-packages (`foo`, `foo/bar`, `foo-bar`) rather than
 * by whatever sorts between `/` and the next character.
 */
export function comparePackagePaths(a: string, b: string): number {
  const as = a.split("/");
  const bs = b.split("/");
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    if (as[i] !== bs[i]) {
      return as[i] < bs[i] ? -1 : 1;
    }
  }
  return as.length - bs.length;
}

export interface IndexedPackage {
  /** Package path relative to the repository root, `""` for the root. */
  pkg: string;
  /** Absolute path of the BUILD file. */
  file: string;
  model: BuildFileModel;
  /** Document version the model was parsed from, if from an open editor. */
  version?: number;
}

export interface IndexChange {
  root: string;
  /** Packages whose contents changed; undefined for a full rebuild. */
  pkgs?: string[];
}

interface CachedParse<T> {
  mtimeMs: number;
  version?: number;
  model: T;
}

/** Returns true for files named like a BUILD file. */
export function isBuildFileName(name: string): boolean {
  return BUILD_FILE_NAMES.includes(name);
}

/** Returns true for paths that should be treated as Starlark `.bzl`. */
export function isBzlFileName(name: string): boolean {
  return name.endsWith(".bzl");
}

/** Returns true for repository-level module files. */
export function isModuleFileName(name: string): boolean {
  return (
    name === "MODULE.bazel" ||
    name === "WORKSPACE" ||
    name === "WORKSPACE.bazel" ||
    name === "WORKSPACE.bzlmod"
  );
}

/**
 * Converts an absolute path within `root` to a package path. Returns
 * undefined when the path is outside the root.
 */
export function packagePathOf(root: string, dir: string): string | undefined {
  const rel = path.relative(root, dir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return undefined;
  }
  return rel === "" ? "" : rel.split(path.sep).join("/");
}

/**
 * An in-memory model of the packages and targets of one Bazel repository,
 * built by parsing BUILD files directly rather than by querying Bazel.
 */
export class WorkspaceIndex implements vscode.Disposable {
  private readonly packagesByPath = new Map<string, IndexedPackage>();
  private readonly packagesByFile = new Map<string, string>();
  private readonly bzlCache = new Map<string, CachedParse<BzlFileModel>>();
  private readonly buildCache = new Map<string, CachedParse<BuildFileModel>>();
  private moduleModel: CachedParse<ModuleFileModel> | undefined;
  private sortedPackages: string[] | undefined;
  private generation = 0;

  private readonly onDidChangeEmitter = new vscode.EventEmitter<IndexChange>();
  /** Fires after the index contents change. */
  public readonly onDidChange = this.onDidChangeEmitter.event;

  private readyResolve: (() => void) | undefined;
  /** Resolves once the initial scan has completed. */
  public ready: Promise<void>;
  private isReady = false;
  private current: Promise<void> | undefined;
  private queued: Promise<void> | undefined;

  /** Directories relative to the root that Bazel ignores, from the last scan. */
  private ignored: string[] = [];

  /**
   * @param root Absolute path of the repository root.
   * @param folders VS Code workspace folders to scan for BUILD files; when
   * empty, the root directory itself is scanned.
   * @param logger Logger used for diagnostics.
   */
  constructor(
    public readonly root: string,
    private folders: readonly vscode.WorkspaceFolder[],
    private readonly logger: ILogger,
    private readonly isSeparateRoot: (root: string) => boolean = () => false,
  ) {
    this.ready = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
  }

  public dispose() {
    // Abandons a scan in progress.
    this.generation++;
    this.onDidChangeEmitter.dispose();
  }

  /** Whether the initial scan has completed. */
  public get isBuilt(): boolean {
    return this.isReady;
  }

  /** Replaces the scanned folders and rebuilds. */
  public setFolders(folders: readonly vscode.WorkspaceFolder[]) {
    this.folders = folders;
  }

  // -----------------------------------------------------------------------
  // Building

  /**
   * Scans the workspace folders for BUILD files and parses them all. A build
   * requested while one is running starts over once it finishes, so the
   * returned promise reflects the files as they were at or after the call.
   */
  public build(): Promise<void> {
    if (this.current === undefined) {
      this.current = this.scan().finally(() => {
        this.current = undefined;
      });
      return this.current;
    }
    this.queued ??= this.current.then(() => {
      this.queued = undefined;
      return this.build();
    });
    return this.queued;
  }

  private async scan(): Promise<void> {
    const generation = ++this.generation;
    const started = Date.now();
    this.rootCache.clear();
    try {
      const files = await this.discoverBuildFiles();
      if (generation !== this.generation) {
        return;
      }
      const next = new Map<string, IndexedPackage>();
      let parsed = 0;
      for (const file of files) {
        const pkg = this.packageForBuildFile(file);
        if (pkg === undefined) {
          continue;
        }
        const existing = next.get(pkg);
        if (
          existing &&
          preferredBuildFile(existing.file, file) === existing.file
        ) {
          continue;
        }
        const entry = await this.parseBuildFile(file, pkg);
        if (entry) {
          next.set(pkg, entry);
        }
        if (++parsed % 64 === 0) {
          // Yield so that the extension host stays responsive.
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (generation !== this.generation) {
            return;
          }
        }
      }
      this.packagesByPath.clear();
      this.packagesByFile.clear();
      for (const [pkg, entry] of next) {
        this.packagesByPath.set(pkg, entry);
        this.packagesByFile.set(entry.file, pkg);
      }
      this.sortedPackages = undefined;
      this.logger.logInfo(
        `Indexed ${next.size} packages in ${Date.now() - started}ms: ${this.root}`,
      );
    } catch (err) {
      this.logger.logError("Failed to build index", false, err);
    } finally {
      if (!this.isReady) {
        this.isReady = true;
        this.readyResolve?.();
      }
      if (generation === this.generation) {
        this.onDidChangeEmitter.fire({ root: this.root });
      }
    }
  }

  /** The directories scanned for BUILD files. */
  private scanBases(): vscode.Uri[] {
    return this.folders.length
      ? this.folders.map((f) => f.uri)
      : [vscode.Uri.file(this.root)];
  }

  private async discoverBuildFiles(): Promise<string[]> {
    this.ignored = await this.ignoredDirectories();
    const results = new Set<string>();
    for (const base of this.scanBases()) {
      const exclude = this.excludeGlobFor(base, this.ignored);
      if (exclude === undefined) {
        continue;
      }
      const pattern = new vscode.RelativePattern(
        base,
        "**/{BUILD,BUILD.bazel}",
      );
      const uris = await vscode.workspace.findFiles(pattern, exclude);
      for (const uri of uris) {
        if (uri.scheme === "file") {
          results.add(uri.fsPath);
        }
      }
    }
    return [...results].sort();
  }

  /**
   * Directories (relative to the repository root) that Bazel ignores:
   * `.bazelignore` entries and the `bazel-*` convenience symlinks.
   */
  private async ignoredDirectories(): Promise<string[]> {
    const dirs = new Set<string>();
    try {
      const ignore = await fs.promises.readFile(
        path.join(this.root, ".bazelignore"),
        "utf8",
      );
      for (const raw of ignore.split(/\r?\n/)) {
        const line = raw.trim();
        if (line && !line.startsWith("#")) {
          dirs.add(line.replace(/^\.?\/+/, "").replace(/\/+$/, ""));
        }
      }
    } catch {
      // No .bazelignore.
    }
    try {
      const entries = await fs.promises.readdir(this.root, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (entry.isSymbolicLink() && entry.name.startsWith("bazel-")) {
          dirs.add(entry.name);
        }
      }
    } catch {
      // Ignore.
    }
    dirs.delete("");
    return [...dirs];
  }

  /**
   * Builds the exclude glob for scanning one VS Code folder, translating the
   * root-relative ignored directories into folder-relative globs.
   *
   * @returns The glob, or undefined when the whole folder is ignored.
   */
  private excludeGlobFor(
    base: vscode.Uri,
    ignoredDirs: string[],
  ): string | undefined {
    const globs = new Set<string>(["**/.git/**", "**/node_modules/**"]);
    const folderPath = base.fsPath;
    const folderInRoot = packagePathOf(this.root, folderPath);
    if (folderInRoot !== undefined) {
      // The folder is the root or lies inside it.
      for (const dir of ignoredDirs) {
        if (folderInRoot === "") {
          globs.add(`${dir}/**`);
        } else if (folderInRoot === dir || folderInRoot.startsWith(`${dir}/`)) {
          return undefined;
        } else if (dir.startsWith(`${folderInRoot}/`)) {
          globs.add(`${dir.slice(folderInRoot.length + 1)}/**`);
        }
      }
    } else {
      // The root lies inside the folder (pinned via `bazel.workspace.path`).
      const rootInFolder = packagePathOf(folderPath, this.root);
      if (rootInFolder === undefined) {
        return undefined;
      }
      for (const dir of ignoredDirs) {
        globs.add(`${rootInFolder ? `${rootInFolder}/` : ""}${dir}/**`);
      }
    }
    return `{${[...globs].join(",")}}`;
  }

  private readonly rootCache = new Map<string, string | undefined>();

  /**
   * Returns the package path of a BUILD file, or undefined if it lies outside
   * this root or belongs to a different repository.
   *
   * A directory with its own MODULE.bazel or WORKSPACE nested inside the root
   * is still a package of this repository as far as Bazel is concerned, so it
   * is included unless it is separately indexed (opened as its own VS Code
   * folder or pinned via `bazel.workspace.path`).
   */
  private packageForBuildFile(file: string): string | undefined {
    const dir = path.dirname(file);
    let fileRoot = this.rootCache.get(dir);
    if (!this.rootCache.has(dir)) {
      fileRoot = getBazelWorkspaceFolder(file);
      this.rootCache.set(dir, fileRoot);
    }
    if (fileRoot !== this.root) {
      if (
        fileRoot === undefined ||
        packagePathOf(this.root, fileRoot) === undefined ||
        this.isSeparateRoot(fileRoot)
      ) {
        return undefined;
      }
    }
    return packagePathOf(this.root, dir);
  }

  private async parseBuildFile(
    file: string,
    pkg: string,
  ): Promise<IndexedPackage | undefined> {
    const open = findOpenDocument(file);
    if (open) {
      return {
        pkg,
        file,
        model: extractBuildModel(file, pkg, open.getText()),
        version: open.version,
      };
    }
    try {
      const text = await fs.promises.readFile(file, "utf8");
      return { pkg, file, model: extractBuildModel(file, pkg, text) };
    } catch (err) {
      this.logger.logDebug(`Could not read ${file}`, false, err);
      return undefined;
    }
  }

  // -----------------------------------------------------------------------
  // Incremental updates

  /**
   * Re-parses a BUILD file after it changed on disk or in an editor. Files
   * that no longer exist are removed from the index.
   */
  public async updateBuildFile(file: string, text?: string): Promise<void> {
    this.rootCache.delete(path.dirname(file));
    const pkg = this.packageForBuildFile(file);
    if (pkg === undefined) {
      this.removeBuildFile(file);
      return;
    }
    if (text === undefined && !fs.existsSync(file)) {
      this.removeBuildFile(file);
      return;
    }
    const existing = this.packagesByPath.get(pkg);
    if (existing && existing.file !== file) {
      // Two BUILD files in one directory; keep the preferred one.
      if (preferredBuildFile(existing.file, file) === existing.file) {
        if (fs.existsSync(existing.file)) {
          return;
        }
      }
    }
    let entry: IndexedPackage | undefined;
    if (text !== undefined) {
      entry = { pkg, file, model: extractBuildModel(file, pkg, text) };
    } else {
      entry = await this.parseBuildFile(file, pkg);
    }
    if (!entry) {
      return;
    }
    if (existing && existing.file !== file) {
      this.packagesByFile.delete(existing.file);
    }
    this.packagesByPath.set(pkg, entry);
    this.packagesByFile.set(file, pkg);
    this.sortedPackages = undefined;
    this.onDidChangeEmitter.fire({ root: this.root, pkgs: [pkg] });
  }

  /**
   * Updates the index from an open document synchronously. Used by providers
   * so that unsaved edits are reflected immediately. Listeners are not
   * notified: they learn about the change when the file is saved.
   *
   * @returns The package for the document, if it is an indexed BUILD file.
   */
  public syncDocument(
    document: vscode.TextDocument,
  ): IndexedPackage | undefined {
    const file = document.uri.fsPath;
    if (!isBuildFileName(path.basename(file))) {
      return undefined;
    }
    const pkg = this.packageForBuildFile(file);
    if (pkg === undefined) {
      return undefined;
    }
    const existing = this.packagesByPath.get(pkg);
    if (
      existing &&
      existing.file === file &&
      existing.version === document.version
    ) {
      return existing;
    }
    const entry: IndexedPackage = {
      pkg,
      file,
      model: extractBuildModel(file, pkg, document.getText()),
      version: document.version,
    };
    if (existing && existing.file !== file) {
      this.packagesByFile.delete(existing.file);
    }
    this.packagesByPath.set(pkg, entry);
    this.packagesByFile.set(file, pkg);
    this.sortedPackages = undefined;
    return entry;
  }

  /**
   * Removes a BUILD file from the index. The package survives when the
   * directory still has a BUILD file under the other name.
   */
  public removeBuildFile(file: string) {
    const pkg = this.packagesByFile.get(file);
    if (pkg === undefined) {
      return;
    }
    this.packagesByFile.delete(file);
    this.packagesByPath.delete(pkg);
    this.sortedPackages = undefined;
    for (const name of BUILD_FILE_NAMES) {
      const sibling = path.join(path.dirname(file), name);
      if (sibling !== file && fs.existsSync(sibling)) {
        void this.updateBuildFile(sibling);
        return;
      }
    }
    this.onDidChangeEmitter.fire({ root: this.root, pkgs: [pkg] });
  }

  /**
   * Removes every package whose BUILD file lies under a directory. File
   * watchers report a deleted or moved directory, not its files.
   */
  public removeDirectory(dir: string) {
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    const pkgs: string[] = [];
    for (const [file, pkg] of this.packagesByFile) {
      if (file.startsWith(prefix)) {
        this.packagesByFile.delete(file);
        this.packagesByPath.delete(pkg);
        pkgs.push(pkg);
      }
    }
    if (pkgs.length) {
      this.sortedPackages = undefined;
      this.onDidChangeEmitter.fire({ root: this.root, pkgs });
    }
  }

  /**
   * Whether a path lies in a directory Bazel ignores for this repository
   * (`.bazelignore` entries and convenience symlinks). Files there belong
   * to no package of this repository; if they have their own module file
   * they form a separate workspace.
   */
  public isIgnoredPath(fsPath: string): boolean {
    const rel = packagePathOf(this.root, fsPath);
    if (rel === undefined) {
      return false;
    }
    return this.ignored.some((dir) => rel === dir || rel.startsWith(`${dir}/`));
  }

  /** Drops cached models of a `.bzl`, MODULE or external BUILD file. */
  public invalidateFile(file: string) {
    this.bzlCache.delete(file);
    this.buildCache.delete(file);
    if (this.moduleModel && this.moduleModel.model.file === file) {
      this.moduleModel = undefined;
    }
  }

  // -----------------------------------------------------------------------
  // Queries

  /** All package paths, sorted. */
  /** All package paths, in {@link comparePackagePaths} order. */
  public getPackages(): string[] {
    if (!this.sortedPackages) {
      this.sortedPackages = [...this.packagesByPath.keys()].sort(
        comparePackagePaths,
      );
    }
    return this.sortedPackages;
  }

  public getPackage(pkg: string): IndexedPackage | undefined {
    return this.packagesByPath.get(pkg);
  }

  /** Returns the package defined by the given BUILD file. */
  public getPackageForBuildFile(file: string): IndexedPackage | undefined {
    const pkg = this.packagesByFile.get(file);
    return pkg === undefined ? undefined : this.packagesByPath.get(pkg);
  }

  /** Returns the targets of a package. */
  public getTargets(pkg: string): IndexedTarget[] {
    return this.packagesByPath.get(pkg)?.model.targets ?? [];
  }

  public findTarget(pkg: string, name: string): IndexedTarget | undefined {
    return this.getTargets(pkg).find((t) => t.name === name);
  }

  /** Iterates over every known target. */
  public *allTargets(): IterableIterator<IndexedTarget> {
    for (const pkg of this.getPackages()) {
      yield* this.getTargets(pkg);
    }
  }

  /** Number of indexed packages. */
  public get packageCount(): number {
    return this.packagesByPath.size;
  }

  // -----------------------------------------------------------------------
  // On-demand parsing of other files

  /**
   * Returns the model of a `.bzl` file, parsing it on first use. Open
   * documents take precedence over the file on disk.
   */
  public getBzlModel(file: string): BzlFileModel | undefined {
    return this.cached(this.bzlCache, file, (text) =>
      extractBzlModel(file, text),
    );
  }

  /**
   * Returns the model of a BUILD file that is not part of this index, e.g.
   * one inside an external repository.
   */
  public getForeignBuildModel(
    file: string,
    pkg: string,
  ): BuildFileModel | undefined {
    return this.cached(this.buildCache, file, (text) =>
      extractBuildModel(file, pkg, text),
    );
  }

  /** Returns the repository names declared by the module file, if any. */
  public getModuleModel(): ModuleFileModel | undefined {
    for (const name of [
      "MODULE.bazel",
      "WORKSPACE.bazel",
      "WORKSPACE",
      "WORKSPACE.bzlmod",
    ]) {
      const file = path.join(this.root, name);
      if (!fs.existsSync(file)) {
        continue;
      }
      if (this.moduleModel?.model.file === file) {
        const stat = fs.statSync(file);
        if (stat.mtimeMs === this.moduleModel.mtimeMs) {
          return this.moduleModel.model;
        }
      }
      try {
        const text = fs.readFileSync(file, "utf8");
        const model = extractModuleModel(file, text);
        this.moduleModel = { mtimeMs: fs.statSync(file).mtimeMs, model };
        return model;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private cached<T>(
    cache: Map<string, CachedParse<T>>,
    file: string,
    parse: (text: string) => T,
  ): T | undefined {
    const open = findOpenDocument(file);
    const entry = cache.get(file);
    if (open) {
      if (entry && entry.version === open.version) {
        return entry.model;
      }
      const model = parse(open.getText());
      cache.set(file, { mtimeMs: 0, version: open.version, model });
      return model;
    }
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      cache.delete(file);
      return undefined;
    }
    if (entry && entry.version === undefined && entry.mtimeMs === mtimeMs) {
      return entry.model;
    }
    try {
      const model = parse(fs.readFileSync(file, "utf8"));
      cache.set(file, { mtimeMs, model });
      return model;
    } catch {
      return undefined;
    }
  }
}

/** Converts an index range to a VS Code range. */
export function toVsRange(range: SourceRange): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
}

/** Picks `BUILD.bazel` over `BUILD` when both exist in a directory. */
function preferredBuildFile(a: string, b: string): string {
  const rank = (f: string) => BUILD_FILE_NAMES.indexOf(path.basename(f));
  return rank(a) <= rank(b) ? a : b;
}

function findOpenDocument(file: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find(
    (d) => d.uri.scheme === "file" && d.uri.fsPath === file,
  );
}
