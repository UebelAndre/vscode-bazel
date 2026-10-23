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

import {
  FileContext,
  IndexManager,
  LabelResolver,
  ResolvedLocation,
  looksLikeLabel,
  parseLabel,
} from "../index";
import { ILogger } from "../extension/logger";
import {
  AnalyzedDocument,
  analyzeDocument,
  loadBinding,
  nodeAt,
  topLevelBinding,
} from "./document_analysis";

/** Caches the parse of the most recently analyzed document versions. */
export class DocumentCache {
  private readonly entries = new Map<
    string,
    { version: number; doc: AnalyzedDocument }
  >();

  public get(document: vscode.TextDocument): AnalyzedDocument {
    const key = document.uri.toString();
    const cached = this.entries.get(key);
    if (cached && cached.version === document.version) {
      return cached.doc;
    }
    const doc = analyzeDocument(document.getText());
    if (this.entries.size > 32) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
    this.entries.set(key, { version: document.version, doc });
    return doc;
  }
}

/**
 * Go-to-definition for Starlark files.
 *
 * Labels resolve to the target or file they name, `load()` strings resolve to
 * the loaded file or symbol, and identifiers resolve to the `load()` or
 * top-level definition that binds them.
 */
export class StarlarkDefinitionProvider implements vscode.DefinitionProvider {
  constructor(
    private readonly manager: IndexManager,
    private readonly resolver: LabelResolver,
    private readonly documents: DocumentCache,
    private readonly logger: ILogger,
  ) {}

  public async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.DefinitionLink[] | undefined> {
    const analyzed = this.documents.get(document);
    const node = nodeAt(analyzed, document.offsetAt(position));
    if (!node) {
      return undefined;
    }
    const ctx = await this.resolver.contextFor(document.uri.fsPath);
    if (!ctx) {
      return undefined;
    }
    await ctx.index.ready;
    const origin = new vscode.Range(
      document.positionAt(
        node.kind === "string" ? node.literal.start : node.ident.start,
      ),
      document.positionAt(
        node.kind === "string" ? node.literal.end : node.ident.end,
      ),
    );
    try {
      const locations = await this.resolveNode(node, document, analyzed, ctx);
      return locations.map((loc) => ({
        originSelectionRange: origin,
        targetUri: loc.uri,
        targetRange: loc.range,
        targetSelectionRange: loc.range,
      }));
    } catch (err) {
      this.logger.logError("Go to definition failed", false, err);
      return undefined;
    }
  }

  private async resolveNode(
    node: ReturnType<typeof nodeAt>,
    document: vscode.TextDocument,
    analyzed: AnalyzedDocument,
    ctx: FileContext,
  ): Promise<ResolvedLocation[]> {
    if (!node) {
      return [];
    }
    if (node.kind === "string") {
      if (node.load && !node.loadSymbol) {
        const resolved = await this.resolver.resolveLoadModule(
          node.literal.value,
          ctx,
          true,
        );
        return resolved
          ? [
              {
                uri: vscode.Uri.file(resolved.file),
                range: new vscode.Range(0, 0, 0, 0),
              },
            ]
          : [];
      }
      if (node.load && node.loadSymbol) {
        return this.resolver.resolveLoadedSymbol(
          node.load.module.value,
          node.loadSymbol.original,
          ctx,
          true,
        );
      }
      const text = node.literal.value;
      if (!looksLikeLabel(text) || text.startsWith("//visibility:")) {
        return [];
      }
      const label = parseLabel(text, ctx.pkg);
      if (!label) {
        return [];
      }
      // Bare strings such as `"foo.cc"` resolve only when they name an
      // existing file or target, so `tags` entries and the like are noise
      // free. Only explicit `@repo//` labels are worth asking Bazel about.
      return this.resolver.resolveLabel(label, ctx, label.absolute);
    }

    // Identifier.
    const name = node.ident.name;
    if (node.loadSymbol && node.load) {
      return this.resolver.resolveLoadedSymbol(
        node.load.module.value,
        node.loadSymbol.original,
        ctx,
        true,
      );
    }
    const bound = loadBinding(analyzed.module, name);
    if (bound) {
      return this.resolver.resolveLoadedSymbol(
        bound.load.module.value,
        bound.symbol.original,
        ctx,
        true,
      );
    }
    const local = topLevelBinding(analyzed.module, name);
    if (local && local.start !== node.ident.start) {
      return [
        {
          uri: document.uri,
          range: new vscode.Range(
            document.positionAt(local.start),
            document.positionAt(local.end),
          ),
        },
      ];
    }
    return [];
  }
}

/**
 * Resolves a label string to a location, for use by commands such as the
 * URI handler. Returns undefined when the label cannot be resolved.
 */
export async function resolveLabelToLocation(
  manager: IndexManager,
  labelText: string,
  workspaceRoot: string,
): Promise<ResolvedLocation | undefined> {
  const index = manager.getIndex(workspaceRoot);
  if (!index) {
    return undefined;
  }
  await index.ready;
  const resolver = manager.labels;
  const ctx = await resolver.contextFor(workspaceRoot);
  if (!ctx) {
    return undefined;
  }
  const label = parseLabel(labelText.replace(/^"|"$/g, ""), "");
  if (!label) {
    return undefined;
  }
  const locations = await resolver.resolveLabel(label, ctx, true);
  return locations[0];
}
