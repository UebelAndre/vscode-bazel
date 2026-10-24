// Copyright 2018 The Bazel Authors. All rights reserved.
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

import { BazelWorkspaceInfo, activateTaskProvider } from "../bazel";
import { BazelrcFeature } from "../bazelrc";
import { BuildifierFeature } from "../buildifier";
import { CodeLensFeature } from "../codelens/code_lens_feature";
import {
  BazelWorkspaceTreeProvider,
  WorkspaceTreeFeature,
} from "../workspace-tree";
import { IndexManager, MacroTargetOverlay } from "../index";
import { resolveLabelToLocation } from "../language_support/starlark_definition_provider";
import { activateCommandVariables } from "./command_variables";
import { TestExplorerFeature } from "../test-explorer";
import { activateWrapperCommands } from "./bazel_wrapper_commands";
import {
  registerLogger,
  logDebug,
  logInfo,
  logWarn,
  logError,
  showOutputChannel,
  ILogger,
} from "./logger";
import { registerBazelWorkspaceAvailabilityWatcher } from "../bazel/bazel_availability";
import { LanguageSupportFeature } from "../language_support/language_support_feature";
import { logDeprecatedSettingsInUse } from "./settings_migration";

// Global reference to the workspace tree provider for testing
declare global {
  var bazelWorkspaceTreeProvider: BazelWorkspaceTreeProvider | undefined;
}

// Clean way to access the provider for testing
export function getWorkspaceTreeProviderForTesting():
  BazelWorkspaceTreeProvider | undefined {
  return globalThis.bazelWorkspaceTreeProvider;
}

// Also set a global variable that can be accessed from tests
export function storeWorkspaceTreeProviderForTesting(
  provider: BazelWorkspaceTreeProvider | undefined,
) {
  globalThis.bazelWorkspaceTreeProvider = provider;
}

/**
 * Called when the extension is activated; that is, when its first command is
 * executed.
 *
 * @param context The extension context.
 */
export async function activate(context: vscode.ExtensionContext) {
  // Setup logging
  const logger = registerLogger(context);
  logInfo("Extension activated successfully.");
  context.subscriptions.push(
    vscode.commands.registerCommand("bazel.showOutputChannel", () => {
      showOutputChannel();
    }),
  );

  // Settings renamed by #490 are read through aliases; never rewrite
  // settings.json (#706).
  logDeprecatedSettingsInUse();

  // Watch for availability of bazel workspace
  registerBazelWorkspaceAvailabilityWatcher(context);

  // Workspace index: parses BUILD files so that the tree, CodeLens and
  // language features never have to wait on `bazel query`.
  const indexLogger: ILogger = {
    logDebug: (m, show, ...args) => logDebug(`[Index] ${m}`, show, ...args),
    logInfo: (m, show, ...args) => logInfo(`[Index] ${m}`, show, ...args),
    logWarn: (m, show, ...args) => logWarn(`[Index] ${m}`, show, ...args),
    logError: (m, show, ...args) => logError(`[Index] ${m}`, show, ...args),
  };
  const indexManager = new IndexManager(indexLogger);
  const macroTargets = new MacroTargetOverlay(indexManager, indexLogger);
  context.subscriptions.push(macroTargets, indexManager);

  // WorkspaceTreeFeature
  const workspaceTreeFeature = await WorkspaceTreeFeature.create(context);
  context.subscriptions.push(workspaceTreeFeature);
  storeWorkspaceTreeProviderForTesting(
    workspaceTreeFeature.getWorkspaceTreeProvider(),
  );

  // CodeLensFeature
  context.subscriptions.push(await CodeLensFeature.create(context));

  // BuildifierFeature
  context.subscriptions.push(await BuildifierFeature.create(context));

  // BazelrcFeature
  context.subscriptions.push(await BazelrcFeature.create(context));

  // LanguageSupportFeature
  context.subscriptions.push(await LanguageSupportFeature.create(context));

  // TestExplorerFeature
  context.subscriptions.push(await TestExplorerFeature.create(context));

  context.subscriptions.push(
    // Commands
    ...activateWrapperCommands(),
    // URI handler
    vscode.window.registerUriHandler({
      async handleUri(uri: vscode.Uri) {
        try {
          const workspace = vscode.workspace.workspaceFolders[0];
          const workspaceInfo =
            BazelWorkspaceInfo.fromWorkspaceFolder(workspace);
          if (!workspaceInfo) {
            throw new Error("No Bazel workspace found");
          }
          const location = await resolveLabelToLocation(
            indexManager,
            uri.path,
            workspaceInfo.bazelWorkspacePath,
          );
          if (!location) {
            throw new Error(`Could not resolve label ${uri.path}`);
          }
          await vscode.window.showTextDocument(location.uri, {
            selection: location.range,
          });
        } catch (err: any) {
          logError("While handling URI", true, JSON.stringify(uri), err);
        }
      },
    }),
    // Task provider
    ...activateTaskProvider(),
    // Command variables
    ...activateCommandVariables(),
  );
}

/** Called when the extension is deactivated. */
export function deactivate() {
  // Nothing to do here.
  logInfo("Extension deactivated.");
}
