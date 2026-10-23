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

import { SchemaResolver } from "../index";
import { callContextAt } from "./document_analysis";
import { attrMarkdown, offeredAttrs, schemaTitle } from "./schema_support";
import { DocumentCache } from "./starlark_definition_provider";

/**
 * Parameter hints for rule and macro calls: lists the accepted attributes
 * and highlights the one whose value is being edited.
 */
export class StarlarkSignatureHelpProvider
  implements vscode.SignatureHelpProvider
{
  constructor(
    private readonly schemas: SchemaResolver,
    private readonly documents: DocumentCache,
  ) {}

  public async provideSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.SignatureHelp | undefined> {
    const analyzed = this.documents.get(document);
    const ctx = callContextAt(analyzed, document.offsetAt(position));
    if (!ctx) {
      return undefined;
    }
    const schema = await this.schemas.schemaFor(
      ctx.callee,
      document.uri.fsPath,
    );
    if (!schema) {
      return undefined;
    }
    const attrs = offeredAttrs(schema);
    const parameters: vscode.ParameterInformation[] = [];
    let label = `${schema.name}(`;
    attrs.forEach((attr, i) => {
      const start = label.length;
      label += attr.name;
      parameters.push(
        new vscode.ParameterInformation(
          [start, label.length],
          attrMarkdown(attr),
        ),
      );
      if (i < attrs.length - 1) {
        label += ", ";
      }
    });
    if (schema.openEnded) {
      label += attrs.length ? ", **kwargs" : "**kwargs";
    }
    label += ")";

    const signature = new vscode.SignatureInformation(label);
    signature.parameters = parameters;
    const doc = new vscode.MarkdownString();
    doc.appendMarkdown(`*${schemaTitle(schema)}*`);
    if (schema.doc) {
      doc.appendMarkdown(`\n\n${schema.doc}`);
    }
    signature.documentation = doc;

    const active = ctx.activeKeyword ?? (ctx.prefix || undefined);
    const activeIndex = active ? attrs.findIndex((a) => a.name === active) : -1;
    const help = new vscode.SignatureHelp();
    help.signatures = [signature];
    help.activeSignature = 0;
    help.activeParameter = activeIndex === -1 ? parameters.length : activeIndex;
    return help;
  }
}
