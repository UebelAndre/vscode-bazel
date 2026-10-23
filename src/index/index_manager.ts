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

import { BazelWorkspaceInfo } from "../bazel/bazel_workspace_info";
import { getBazelWorkspaceFolder } from "../bazel/bazel_utils";
import { getResolveRepositoriesOnStartup } from "../extension/configuration";
import { ExternalRepoResolver } from "./external_repos";
import { LabelResolver } from "./label_resolver";
import { ILogger } from "../extension/logger";
import { affectsRenamedSetting } from "../extension/settings_migration";
import {
  IndexChange,
  WorkspaceIndex,
  isBuildFileName,
  isBzlFileName,
  isModuleFileName,
} from "./workspace_index";

/**
 * Owns one {@link WorkspaceIndex} per Bazel repository open in VS Code and
 * keeps them up to date from file system and editor events.
 */
export class IndexManager implements vscode.Disposable {
  private static instance: IndexManager | undefined;

  /** Returns the manager created during activation, if any. */
  public static get(): IndexManager | undefined {
    return IndexManager.instance;
  }

  private readonly indexes = new Map<string, WorkspaceIndex>();
  /** Roots indexed on demand because they lie in an ignored directory. */
  private readonly derivedRoots = new Set<string>();
  private readonly resolvers = new Map<string, ExternalRepoResolver>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pendingDocuments = new Map<string, NodeJS.Timeout>();

  private readonly onDidChangeEmitter = new vscode.EventEmitter<IndexChange>();
  /** Fires whenever any index changes. */
  public readonly onDidChange = this.onDidChangeEmitter.event;

  /** Resolves labels and loaded symbols across the indexes. */
  public readonly labels: LabelResolver;

  private readonly indexListeners = new Map<string, vscode.Disposable>();

  constructor(private readonly logger: ILogger) {
    IndexManager.instance = this;
    this.labels = new LabelResolver(this, logger);

    const watcher = vscode.workspace.createFileSystemWatcher(
      "**/{BUILD,BUILD.bazel,*.bzl,MODULE.bazel,REPO.bazel,WORKSPACE," +
        "WORKSPACE.bazel,WORKSPACE.bzlmod,.bazelignore}",
    );
    this.disposables.push(
      watcher,
      watcher.onDidCreate((uri) => this.onFileEvent(uri, "create")),
      watcher.onDidChange((uri) => this.onFileEvent(uri, "change")),
      watcher.onDidDelete((uri) => this.onFileEvent(uri, "delete")),
      // The watcher reports files only; directories moved or deleted in
      // the explorer arrive here.
      vscode.workspace.onDidDeleteFiles((e) => {
        for (const uri of e.files) {
          this.onDirectoryRemoved(uri);
        }
      }),
      vscode.workspace.onDidRenameFiles((e) => {
        for (const { oldUri, newUri } of e.files) {
          this.onDirectoryRemoved(oldUri);
          if (isDirectory(newUri.fsPath)) {
            void this.getIndexForPath(newUri.fsPath)?.build();
          }
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) =>
        this.onDocumentChanged(e.document),
      ),
      vscode.workspace.onDidCloseTextDocument((doc) =>
        this.onDocumentClosed(doc),
      ),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.rebuildAll()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          affectsRenamedSetting(e, "bazel.workspace.path") ||
          affectsRenamedSetting(e, "bazel.workspace.pathsToIgnore")
        ) {
          this.rebuildAll();
        }
      }),
    );

    this.rebuildAll();
  }

  public dispose() {
    for (const timeout of this.pendingDocuments.values()) {
      clearTimeout(timeout);
    }
    this.pendingDocuments.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
    for (const root of [...this.indexes.keys()]) {
      this.dropIndex(root);
    }
    this.onDidChangeEmitter.dispose();
    if (IndexManager.instance === this) {
      IndexManager.instance = undefined;
    }
  }

  /** All indexes, one per repository root. */
  public getIndexes(): WorkspaceIndex[] {
    return [...this.indexes.values()];
  }

  /** Returns the index for a repository root, if one exists. */
  public getIndex(root: string): WorkspaceIndex | undefined {
    return this.indexes.get(root);
  }

  /** Returns (creating if needed) the index for a Bazel workspace. */
  public getIndexForWorkspace(info: BazelWorkspaceInfo): WorkspaceIndex {
    const root = info.bazelWorkspacePath;
    let index = this.indexes.get(root);
    if (!index) {
      index = this.createIndex(root, this.foldersForRoot(root));
      void index.build();
    }
    return index;
  }

  /** Returns the index that owns a file path, if any. */
  public getIndexForPath(fsPath: string): WorkspaceIndex | undefined {
    const root = getBazelWorkspaceFolder(fsPath);
    if (!root) {
      return undefined;
    }
    const exact = this.indexes.get(root);
    if (exact) {
      return exact;
    }
    let enclosing: WorkspaceIndex | undefined;
    for (const index of this.indexes.values()) {
      const rel = path.relative(index.root, root);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        continue;
      }
      if (!enclosing || index.root.length > enclosing.root.length) {
        enclosing = index;
      }
    }
    if (enclosing?.isIgnoredPath(root)) {
      // A module nested in a `.bazelignore`d directory is a workspace of its
      // own: Bazel never sees it from the enclosing repository, so labels in
      // it must resolve against its own root.
      const index = this.createIndex(root, []);
      this.derivedRoots.add(root);
      void index.build();
      return index;
    }
    // Otherwise a nested repository marker without its own index: the file
    // is part of the enclosing indexed repository.
    return enclosing;
  }

  /** Returns the index that owns a document, if any. */
  public getIndexForDocument(
    document: vscode.TextDocument,
  ): WorkspaceIndex | undefined {
    if (document.uri.scheme !== "file") {
      return undefined;
    }
    return this.getIndexForPath(document.uri.fsPath);
  }

  /** Returns the external repository resolver for a repository root. */
  public getResolver(root: string): ExternalRepoResolver {
    let resolver = this.resolvers.get(root);
    if (!resolver) {
      resolver = new ExternalRepoResolver(root, this.logger);
      this.resolvers.set(root, resolver);
    }
    return resolver;
  }

  /** Discards all indexes and rebuilds them for the current folders. */
  public rebuildAll() {
    const wanted = new Map<string, vscode.WorkspaceFolder[]>();
    for (const info of BazelWorkspaceInfo.getAll()) {
      const root = info.bazelWorkspacePath;
      const list = wanted.get(root) ?? [];
      if (info.workspaceFolder) {
        list.push(info.workspaceFolder);
      }
      wanted.set(root, list);
    }
    for (const root of [...this.indexes.keys()]) {
      if (!wanted.has(root) && !this.derivedRoots.has(root)) {
        this.dropIndex(root);
        this.fire({ root });
      }
    }
    // Derived roots are recreated on demand if still needed.
    for (const root of [...this.derivedRoots]) {
      this.derivedRoots.delete(root);
      if (!wanted.has(root)) {
        this.dropIndex(root);
      }
    }
    for (const [root, folders] of wanted) {
      let index = this.indexes.get(root);
      if (index) {
        index.setFolders(folders);
      } else {
        index = this.createIndex(root, folders);
      }
      void index.build();
    }
  }

  /** Rebuilds every index from scratch, e.g. on explicit refresh. */
  public refreshAll(): Promise<void[]> {
    return Promise.all(this.getIndexes().map((index) => index.build()));
  }

  private createIndex(
    root: string,
    folders: vscode.WorkspaceFolder[],
  ): WorkspaceIndex {
    const index = new WorkspaceIndex(
      root,
      folders,
      this.logger,
      (other) => other !== root && this.indexes.has(other),
    );
    this.indexes.set(root, index);
    this.indexListeners.set(
      root,
      index.onDidChange((change) => this.fire(change)),
    );
    void index.ready.then(() => this.preloadRepoMapping(root));
    return index;
  }

  private dropIndex(root: string) {
    this.indexes.get(root)?.dispose();
    this.indexes.delete(root);
    this.indexListeners.get(root)?.dispose();
    this.indexListeners.delete(root);
    this.resolvers.delete(root);
  }

  /**
   * Asks Bazel once for the main module's repository mapping so that labels
   * into external repositories resolve, and can be fetched, without a Bazel
   * invocation at click time. Runs after the index is built, in the
   * background, and only when enabled.
   */
  private preloadRepoMapping(root: string) {
    if (!getResolveRepositoriesOnStartup() || this.derivedRoots.has(root)) {
      return;
    }
    void this.getResolver(root)
      .getRepoMapping("")
      .then((mapping) => {
        if (mapping) {
          this.logger.logInfo(
            `Loaded the repository mapping of ${root} ` +
              `(${Object.keys(mapping).length} names)`,
          );
        }
      });
  }

  /** Publishes a change; resolved names are recomputed lazily. */
  private fire(change: IndexChange) {
    this.labels.bindings.clear();
    this.onDidChangeEmitter.fire(change);
  }

  private foldersForRoot(root: string): vscode.WorkspaceFolder[] {
    return BazelWorkspaceInfo.getAll()
      .filter((info) => info.bazelWorkspacePath === root)
      .map((info) => info.workspaceFolder)
      .filter((f): f is vscode.WorkspaceFolder => f !== undefined);
  }

  // -----------------------------------------------------------------------
  // Events

  private onFileEvent(uri: vscode.Uri, kind: "create" | "change" | "delete") {
    if (uri.scheme !== "file") {
      return;
    }
    const fsPath = uri.fsPath;
    const name = path.basename(fsPath);
    if (isBuildFileName(name)) {
      const index =
        kind === "delete"
          ? this.indexOwningFile(fsPath)
          : this.getIndexForPath(fsPath);
      if (!index) {
        return;
      }
      if (kind === "delete") {
        index.removeBuildFile(fsPath);
      } else {
        void index.updateBuildFile(fsPath);
      }
      return;
    }
    if (isBzlFileName(name)) {
      this.invalidateStarlark(fsPath);
      return;
    }
    if (
      isModuleFileName(name) ||
      name === "REPO.bazel" ||
      name === ".bazelignore"
    ) {
      for (const index of this.indexes.values()) {
        index.invalidateFile(fsPath);
      }
      // The visible repositories and their names may have changed.
      for (const resolver of this.resolvers.values()) {
        resolver.invalidate();
      }
      const owner = this.indexes.get(path.dirname(fsPath));
      if (name === ".bazelignore") {
        // Only a repository's own `.bazelignore` affects what it indexes.
        void owner?.build();
      } else if (
        kind !== "change" &&
        (owner || !this.getIndexes().some((i) => i.isIgnoredPath(fsPath)))
      ) {
        // A repository marker appeared or vanished, so package boundaries
        // may have moved. Edits to a marker only change its contents,
        // which are re-read lazily; markers in ignored directories (e.g.
        // node_modules) are irrelevant to the enclosing repository.
        this.rebuildAll();
      }
    }
  }

  private onDirectoryRemoved(uri: vscode.Uri) {
    if (uri.scheme !== "file") {
      return;
    }
    for (const index of this.indexes.values()) {
      index.removeDirectory(uri.fsPath);
    }
  }

  private indexOwningFile(fsPath: string): WorkspaceIndex | undefined {
    for (const index of this.indexes.values()) {
      if (index.getPackageForBuildFile(fsPath)) {
        return index;
      }
    }
    return undefined;
  }

  private onDocumentChanged(document: vscode.TextDocument) {
    if (document.uri.scheme !== "file") {
      return;
    }
    const fsPath = document.uri.fsPath;
    const name = path.basename(fsPath);
    if (!isBuildFileName(name) && !isBzlFileName(name)) {
      return;
    }
    const pending = this.pendingDocuments.get(fsPath);
    if (pending) {
      clearTimeout(pending);
    }
    this.pendingDocuments.set(
      fsPath,
      setTimeout(() => {
        this.pendingDocuments.delete(fsPath);
        if (document.isClosed) {
          return;
        }
        if (isBuildFileName(name)) {
          this.getIndexForPath(fsPath)?.syncDocument(document);
        } else {
          this.invalidateStarlark(fsPath);
        }
      }, 150),
    );
  }

  private onDocumentClosed(document: vscode.TextDocument) {
    if (document.uri.scheme !== "file") {
      return;
    }
    const fsPath = document.uri.fsPath;
    const name = path.basename(fsPath);
    if (isBuildFileName(name)) {
      // Fall back to the on-disk contents (discarding unsaved edits).
      void this.getIndexForPath(fsPath)?.updateBuildFile(fsPath);
    } else if (isBzlFileName(name)) {
      this.invalidateStarlark(fsPath);
    }
  }

  /** Drops cached parses and resolved names after a `.bzl` file changed. */
  private invalidateStarlark(fsPath: string) {
    for (const index of this.indexes.values()) {
      index.invalidateFile(fsPath);
    }
    this.labels.bindings.clear();
  }
}

function isDirectory(fsPath: string): boolean {
  try {
    return fs.statSync(fsPath).isDirectory();
  } catch {
    return false;
  }
}
