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

import { BazelWorkspaceInfo } from "../bazel";
import { ILogger } from "../extension/logger";
import { IndexManager, ruleInfoFor } from "../index";
import { CodeLensBuilder, CodeLensTarget } from "./code_lens_builder";

/**
 * Provides CodeLenses for targets in Bazel BUILD files.
 *
 * Targets come from the workspace index, so lenses are available immediately,
 * reflect unsaved edits, and never wait on a Bazel server.
 */
export class CodeLensProvider implements vscode.CodeLensProvider {
  public onDidChangeCodeLenses: vscode.Event<void>;
  private onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  private builder: CodeLensBuilder;
  private logger: ILogger;

  /**
   * Initializes a new CodeLens provider.
   * @param manager The workspace index manager.
   * @param logger Logger for feature-specific logging.
   */
  constructor(
    private readonly manager: IndexManager,
    logger: ILogger,
  ) {
    this.onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;
    this.builder = new CodeLensBuilder();
    this.logger = logger;
  }

  /**
   * Refreshes all CodeLens items by emitting a change event.
   */
  public refresh(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  /**
   * Provides CodeLenses for the given document.
   *
   * @param document A Bazel BUILD file
   */
  public async provideCodeLenses(
    document: vscode.TextDocument,
  ): Promise<vscode.CodeLens[]> {
    const workspaceInfo = BazelWorkspaceInfo.fromDocument(document);
    if (workspaceInfo === undefined) {
      this.logger.logDebug(
        "Skipping CodeLens - not in Bazel workspace:",
        false,
        document.uri.fsPath,
      );
      return [];
    }

    const index = this.manager.getIndexForDocument(document);
    if (!index) {
      return [];
    }
    await index.ready;
    const entry = index.syncDocument(document);
    if (!entry) {
      return [];
    }
    const targets: CodeLensTarget[] = index.getTargets(entry.pkg).map((t) => {
      const info = ruleInfoFor(t);
      return {
        label: t.label,
        line: t.range.start.line,
        isTest: info.isTest,
        isExecutable: info.isExecutable,
      };
    });

    const codeLenses = this.builder.buildCodeLenses(workspaceInfo, targets);
    this.logger.logDebug(
      `Generated ${codeLenses.length} CodeLenses for:`,
      false,
      document.uri.fsPath,
    );
    return codeLenses;
  }
}
