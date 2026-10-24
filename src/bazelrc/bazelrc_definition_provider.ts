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
import * as vscode from "vscode";

import { getBazelWorkspaceFolder } from "../bazel/bazel_utils";
import {
  CONFIG_HEAD,
  IMPORT_LINE,
  importedRcFiles,
  resolveImportPath,
} from "./bazelrc_document";

/**
 * Go to definition in `.bazelrc` files: the target of `import` and
 * `try-import` lines, and the lines defining a config named by
 * `--config=name` or by the `cmd:name` prefix of a line.
 */
export class BazelrcDefinitionProvider implements vscode.DefinitionProvider {
  public provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Location[] | undefined {
    if (document.uri.scheme !== "file") {
      return undefined;
    }
    const line = document.lineAt(position.line).text;
    const root = getBazelWorkspaceFolder(document.uri.fsPath);

    const imported = IMPORT_LINE.exec(line);
    if (imported) {
      const start = imported[0].length - imported[1].length;
      const range = new vscode.Range(
        position.line,
        start,
        position.line,
        start + imported[1].length,
      );
      if (!range.contains(position)) {
        return undefined;
      }
      const file = resolveImportPath(imported[1], document.uri.fsPath, root);
      return file && fs.existsSync(file)
        ? [
            new vscode.Location(
              vscode.Uri.file(file),
              new vscode.Position(0, 0),
            ),
          ]
        : undefined;
    }

    const config = configNameAt(line, position.character);
    if (!config) {
      return undefined;
    }
    const locations: vscode.Location[] = [];
    const matcher = new RegExp(`^\\s*[a-z-]+:${escapeRegExp(config)}(?=\\s|$)`);
    const addFrom = (rcText: string, uri: vscode.Uri, skipLine?: number) => {
      rcText.split(/\r?\n/).forEach((l, i) => {
        if (i !== skipLine && matcher.test(l)) {
          const column = l.indexOf(":") + 1;
          locations.push(
            new vscode.Location(uri, new vscode.Position(i, column)),
          );
        }
      });
    };
    const text = document.getText();
    addFrom(text, document.uri, position.line);
    for (const rc of importedRcFiles(text, document.uri.fsPath, root)) {
      addFrom(rc.text, vscode.Uri.file(rc.file));
    }
    return locations.length ? locations : undefined;
  }
}

/** The config name under the cursor: `--config=NAME` or the `cmd:NAME` prefix. */
export function configNameAt(
  line: string,
  character: number,
): string | undefined {
  for (const match of line.matchAll(/--config=([A-Za-z0-9_.-]+)/g)) {
    const start = (match.index ?? 0) + "--config=".length;
    if (character >= start && character <= start + match[1].length) {
      return match[1];
    }
  }
  const head = CONFIG_HEAD.exec(line);
  if (head) {
    const start = head[0].length - head[1].length;
    if (character >= start && character <= head[0].length) {
      return head[1];
    }
  }
  return undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
