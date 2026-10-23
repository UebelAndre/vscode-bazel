// Copyright 2025 The Bazel Authors. All rights reserved.
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
import * as lc from "vscode-languageclient/node";

import { BaseExtensionFeature } from "../extension/extension_feature";
import { getLspServerExecutablePath } from "../extension/configuration";
import { IndexManager } from "../index";
import { startLspClientFromCurrentConfig } from "./language-server-client";
import {
  DocumentCache,
  StarlarkDefinitionProvider,
} from "./starlark_definition_provider";
import { StarlarkCompletionProvider } from "./starlark_completion_provider";
import { StarlarkHoverProvider } from "./starlark_hover_provider";
import { StarlarkSignatureHelpProvider } from "./starlark_signature_help_provider";
import { StarlarkSymbolProvider } from "./starlark_symbol_provider";
import { RepositoryDiagnostics } from "./repository_diagnostics";

/** Documents the built-in providers apply to. */
export const STARLARK_SELECTOR: vscode.DocumentSelector = [
  { scheme: "file", language: "starlark" },
  { scheme: "file", pattern: "**/BUILD" },
  { scheme: "file", pattern: "**/BUILD.bazel" },
  { scheme: "file", pattern: "**/*.bzl" },
];

/**
 * Language Support feature for Bazel.
 *
 * Uses an external language server when one is configured, otherwise the
 * built-in providers backed by the workspace index.
 */
export class LanguageSupportFeature extends BaseExtensionFeature {
  private lspClient: lc.LanguageClient | undefined;
  private isUsingExternalLSP: boolean = false;

  constructor(context: vscode.ExtensionContext) {
    super("LanguageSupport", context);
  }

  protected async enable(context: vscode.ExtensionContext): Promise<boolean> {
    const lspCommand = getLspServerExecutablePath();
    this.isUsingExternalLSP = !!lspCommand;

    const enabled = this.isUsingExternalLSP
      ? this.enableExternalLSP(context)
      : this.enableBuiltInSupport();
    if (enabled) {
      // Lint-style warnings are independent of which server answers
      // language queries.
      this.disposables.push(new RepositoryDiagnostics());
    }
    return enabled;
  }

  protected disable(): boolean {
    if (this.lspClient) {
      this.lspClient.stop().catch((error) => {
        this.logError("Error stopping language server", true, error);
      });
      this.lspClient = undefined;
    }

    vscode.commands.executeCommand("setContext", "bazel.lsp.enabled", false);

    return super.disable();
  }

  /**
   * Enables external LSP implementation
   */
  private enableExternalLSP(context: vscode.ExtensionContext): boolean {
    this.logInfo("Enabling external language server support");

    const restartCommand = vscode.commands.registerCommand(
      "bazel.lsp.restart",
      async () => {
        this.logInfo("Restarting language server...");
        await startLspClientFromCurrentConfig(this.lspClient, context);
      },
    );
    this.disposables.push(restartCommand);

    startLspClientFromCurrentConfig(this.lspClient, context)
      .then(() => {
        this.logInfo("External language server started successfully");
      })
      .catch((error: any) => {
        this.logError("Failed to start external language server", true, error);
        return false;
      });

    vscode.commands.executeCommand("setContext", "bazel.lsp.enabled", true);

    return true;
  }

  /**
   * Enables the built-in, index-backed language providers.
   */
  private enableBuiltInSupport(): boolean {
    const manager = IndexManager.get();
    if (!manager) {
      this.logError("Workspace index is not available");
      return false;
    }
    this.logInfo("Enabling built-in language support");

    const resolver = manager.labels;
    const schemas = resolver.schemas;
    const documents = new DocumentCache();

    this.disposables.push(
      vscode.languages.registerDefinitionProvider(
        STARLARK_SELECTOR,
        new StarlarkDefinitionProvider(
          manager,
          resolver,
          documents,
          this.getLogger(),
        ),
      ),
      vscode.languages.registerHoverProvider(
        STARLARK_SELECTOR,
        new StarlarkHoverProvider(manager, resolver, documents),
      ),
      vscode.languages.registerDocumentSymbolProvider(
        STARLARK_SELECTOR,
        new StarlarkSymbolProvider(manager),
      ),
      vscode.languages.registerCompletionItemProvider(
        STARLARK_SELECTOR,
        new StarlarkCompletionProvider(manager, resolver, schemas, documents),
        "/",
        ":",
        "@",
        '"',
        "'",
        ".",
      ),
      vscode.languages.registerSignatureHelpProvider(
        STARLARK_SELECTOR,
        new StarlarkSignatureHelpProvider(schemas, documents),
        "(",
        ",",
      ),
    );

    this.logInfo("Built-in language support enabled successfully");
    return true;
  }
}
