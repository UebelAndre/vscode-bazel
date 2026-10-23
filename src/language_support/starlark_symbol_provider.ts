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

import {
  BzlDefinitionKind,
  IndexManager,
  SourceRange,
  extractBuildModel,
  extractBzlModel,
  isBuildFileName,
  toVsRange,
} from "../index";

const BZL_SYMBOL_KINDS: Record<BzlDefinitionKind, vscode.SymbolKind> = {
  function: vscode.SymbolKind.Function,
  rule: vscode.SymbolKind.Class,
  macro: vscode.SymbolKind.Class,
  provider: vscode.SymbolKind.Struct,
  aspect: vscode.SymbolKind.Class,
  repository_rule: vscode.SymbolKind.Class,
  module_extension: vscode.SymbolKind.Module,
  tag_class: vscode.SymbolKind.Struct,
  variable: vscode.SymbolKind.Variable,
};

/** Outline symbols for BUILD targets and `.bzl` definitions. */
export class StarlarkSymbolProvider implements vscode.DocumentSymbolProvider {
  constructor(private readonly manager: IndexManager) {}

  public provideDocumentSymbols(
    document: vscode.TextDocument,
  ): vscode.DocumentSymbol[] {
    const fsPath = document.uri.fsPath;
    if (isBuildFileName(path.basename(fsPath))) {
      const index = this.manager.getIndexForDocument(document);
      const entry = index?.syncDocument(document);
      const buildModel =
        entry?.model ?? extractBuildModel(fsPath, "", document.getText());
      return buildModel.targets.map(
        (t) =>
          new vscode.DocumentSymbol(
            t.name,
            t.kind,
            vscode.SymbolKind.Function,
            clampRange(document, t.range),
            clampRange(document, t.nameRange),
          ),
      );
    }
    const model = extractBzlModel(fsPath, document.getText());
    return [...model.definitions.values()].map(
      (d) =>
        new vscode.DocumentSymbol(
          d.name,
          d.kind === "variable" ? "" : d.kind,
          BZL_SYMBOL_KINDS[d.kind],
          clampRange(document, d.range),
          clampRange(document, d.nameRange),
        ),
    );
  }
}

/** Ensures the selection range sits inside the full range as VS Code requires. */
function clampRange(document: vscode.TextDocument, range: SourceRange) {
  return document.validateRange(toVsRange(range));
}
