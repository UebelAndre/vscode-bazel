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

import * as vscode from "vscode";

import { BazelWorkspaceInfo } from "../bazel/bazel_workspace_info";
import { BaseExtensionFeature } from "../extension/extension_feature";
import { BazelrcDefinitionProvider } from "./bazelrc_definition_provider";
import {
  BazelrcCompletionProvider,
  BazelrcHoverProvider,
} from "./bazelrc_providers";
import { FlagCatalogues } from "./flag_catalogue";

/** Documents the providers apply to. */
const BAZELRC_SELECTOR: vscode.DocumentSelector = [
  { scheme: "file", language: "bazelrc" },
  { scheme: "untitled", language: "bazelrc" },
];

/**
 * Completion and hover for `.bazelrc` files, from a catalogue of Bazel's
 * flags shipped with the extension and optionally refreshed from the
 * workspace's own Bazel.
 */
export class BazelrcFeature extends BaseExtensionFeature {
  constructor(context: vscode.ExtensionContext) {
    super("Bazelrc", context);
  }

  protected enable(context: vscode.ExtensionContext): Promise<boolean> {
    const catalogues = new FlagCatalogues(
      context.extensionPath,
      context.globalStorageUri?.fsPath,
      this.getLogger(),
    );
    const versionWatcher =
      vscode.workspace.createFileSystemWatcher("**/.bazelversion");
    const onVersionChange = () => catalogues.invalidate();

    this.disposables.push(
      versionWatcher,
      versionWatcher.onDidChange(onVersionChange),
      versionWatcher.onDidCreate(onVersionChange),
      versionWatcher.onDidDelete(onVersionChange),
      vscode.languages.registerCompletionItemProvider(
        BAZELRC_SELECTOR,
        new BazelrcCompletionProvider(catalogues),
        "-",
        ":",
        "=",
        " ",
      ),
      vscode.languages.registerHoverProvider(
        BAZELRC_SELECTOR,
        new BazelrcHoverProvider(catalogues),
      ),
      vscode.languages.registerDefinitionProvider(
        BAZELRC_SELECTOR,
        new BazelrcDefinitionProvider(),
      ),
      vscode.commands.registerCommand(
        "bazel.bazelrc.refreshFlags",
        async () => {
          const workspace = await BazelWorkspaceInfo.fromWorkspaceFolders();
          if (!workspace) {
            this.logError("No Bazel workspace found to run Bazel in", true);
            return;
          }
          try {
            const collection = await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: "Reading flags from bazel help flags-as-proto",
              },
              () => catalogues.refreshFromBazel(workspace.bazelWorkspacePath),
            );
            this.logInfo(
              `Loaded ${collection.flags.length} flags for Bazel ${collection.bazelVersion}`,
              true,
            );
          } catch (err) {
            this.logError("Could not read flags from Bazel", true, err);
          }
        },
      ),
    );
    return Promise.resolve(true);
  }
}
