import * as vscode from "vscode";

import { BaseExtensionFeature } from "../extension/extension_feature";
import { checkBazelIsAvailable } from "../bazel/bazel_availability";
import { CodeLensProvider } from "./code_lens_provider";
import { IndexManager } from "../index";

/**
 * CodeLens feature for Bazel BUILD files.
 * Responsible for:
 * - Extension activation
 * - Precondition checks
 * - Provider registration with VSCode
 */
export class CodeLensFeature extends BaseExtensionFeature {
  constructor(context: vscode.ExtensionContext) {
    super("CodeLens", context);
  }

  enable(context: vscode.ExtensionContext): Promise<boolean> {
    // Precondition: bazel executable available
    if (!checkBazelIsAvailable()) {
      this.logWarn("Can not activate, no bazel executable found.");
      return Promise.resolve(false);
    }

    const manager = IndexManager.get();
    if (!manager) {
      this.logError("Workspace index is not available");
      return Promise.resolve(false);
    }

    // Create and register the CodeLens provider
    const codelensProvider = new CodeLensProvider(manager, this.getLogger());

    const codeLensRegistration = vscode.languages.registerCodeLensProvider(
      [{ pattern: "**/BUILD" }, { pattern: "**/BUILD.bazel" }],
      codelensProvider,
    );

    this.disposables.push(codeLensRegistration);

    return Promise.resolve(true);
  }
}
