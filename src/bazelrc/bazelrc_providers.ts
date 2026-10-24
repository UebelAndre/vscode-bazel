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

import { getBazelWorkspaceFolder } from "../bazel/bazel_utils";
import {
  configNames,
  contextAt,
  importedRcFiles,
  logicalLineAt,
  stripComment,
} from "./bazelrc_document";
import { FlagCatalogues, flagMarkdown } from "./flag_catalogue";
import { FlagIndex, RC_KEYWORDS } from "./flag_index";
import { FlagInfo } from "./flags_proto";

/** Config names visible from an rc file: its own and its imports'. */
function knownConfigs(document: vscode.TextDocument): string[] {
  const text = document.getText();
  const names = configNames(text);
  // Imports are relative to the file; an untitled buffer has none.
  if (document.uri.scheme === "file") {
    const file = document.uri.fsPath;
    const root = getBazelWorkspaceFolder(file);
    for (const imported of importedRcFiles(text, file, root)) {
      for (const name of configNames(imported.text)) {
        names.add(name);
      }
    }
  }
  return [...names].sort();
}

function simpleItems(
  names: string[],
  kind: vscode.CompletionItemKind,
  range: vscode.Range,
): vscode.CompletionItem[] {
  return names.map((name) => {
    const item = new vscode.CompletionItem(name, kind);
    item.range = range;
    return item;
  });
}

/** Completion of commands, configs, flags and flag values in `.bazelrc`. */
export class BazelrcCompletionProvider
  implements vscode.CompletionItemProvider
{
  /** Flags behind the items of the last request, for lazy documentation. */
  private readonly flagOf = new WeakMap<vscode.CompletionItem, FlagInfo>();

  constructor(private readonly catalogues: FlagCatalogues) {}

  /** Renders a flag's documentation only for the item being looked at. */
  public resolveCompletionItem(
    item: vscode.CompletionItem,
  ): vscode.CompletionItem {
    const flag = this.flagOf.get(item);
    if (flag) {
      item.documentation = flagMarkdown(flag);
    }
    return item;
  }

  public async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[]> {
    const catalogue = await this.catalogues.forDocument(document);
    if (!catalogue) {
      return [];
    }
    const lineBefore = document
      .lineAt(position.line)
      .text.slice(0, position.character);
    if (lineBefore.includes("#")) {
      return [];
    }
    const lines = document.getText().split(/\r?\n/);
    const logical = logicalLineAt(lines, position.line);
    const beforeCursor =
      lines
        .slice(logical.startLine, position.line)
        .map((l) => stripComment(l).replace(/\\\s*$/, " "))
        .join("") + lineBefore;
    const ctx = contextAt(beforeCursor);
    if (!ctx) {
      return [];
    }
    const replace = (length: number) =>
      new vscode.Range(position.translate(0, -length), position);

    switch (ctx.kind) {
      case "command": {
        const names = [...catalogue.commands(), ...RC_KEYWORDS];
        return names.map((name) => {
          const item = new vscode.CompletionItem(
            name,
            vscode.CompletionItemKind.Keyword,
          );
          item.range = replace(ctx.prefix.length);
          item.insertText = `${name} `;
          item.sortText = RC_KEYWORDS.includes(name) ? `1${name}` : `0${name}`;
          return item;
        });
      }
      case "config":
        return simpleItems(
          knownConfigs(document),
          vscode.CompletionItemKind.EnumMember,
          replace(ctx.prefix.length),
        );
      case "flag": {
        // The word under the cursor, dashes included, is what gets replaced.
        const word = /(\S*)$/.exec(lineBefore)?.[1] ?? "";
        return this.flagItems(catalogue, ctx.command, replace(word.length));
      }
      case "value": {
        if (ctx.separator === " " && !catalogue.find(ctx.flag)?.requiresValue) {
          // `--keep_going |`: the previous flag takes no value, so this is
          // the next flag.
          return this.flagItems(
            catalogue,
            ctx.command,
            replace(ctx.prefix.length),
          );
        }
        if (ctx.flag === "config") {
          return simpleItems(
            knownConfigs(document),
            vscode.CompletionItemKind.EnumMember,
            replace(ctx.prefix.length),
          );
        }
        const flag = catalogue.find(ctx.flag);
        const values =
          flag?.allowedValues ??
          (flag?.type === "Boolean" ? ["true", "false"] : []);
        // Bazel accepts enum values case-insensitively; rc files use lowercase.
        return simpleItems(
          values.map((v) => v.toLowerCase()),
          vscode.CompletionItemKind.Value,
          replace(ctx.prefix.length),
        );
      }
      default:
        return [];
    }
  }

  private flagItems(
    catalogue: FlagIndex,
    command: string,
    range: vscode.Range,
  ): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    const add = (flag: FlagInfo, label: string, negated: boolean) => {
      const item = flagItem(flag, label, range, negated);
      this.flagOf.set(item, flag);
      items.push(item);
    };
    for (const flag of catalogue.flagsFor(command)) {
      add(flag, `--${flag.name}`, false);
      if (flag.negatable) {
        add(flag, `--no${flag.name}`, true);
      }
    }
    return items;
  }
}

function flagItem(
  flag: FlagInfo,
  label: string,
  range: vscode.Range,
  negated: boolean,
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    label,
    vscode.CompletionItemKind.Property,
  );
  item.range = range;
  item.filterText = label;
  item.insertText = !negated && flag.requiresValue ? `${label}=` : label;
  if (!negated && flag.requiresValue) {
    item.command = {
      command: "editor.action.triggerSuggest",
      title: "Re-trigger completions",
    };
  }
  const tags = flag.metadataTags ?? [];
  item.detail = [flag.type, ...tags.map((t) => t.toLowerCase())]
    .filter(Boolean)
    .join(", ");
  if (tags.includes("DEPRECATED") || flag.deprecationWarning) {
    item.tags = [vscode.CompletionItemTag.Deprecated];
  }
  item.sortText = `${negated ? "1" : "0"}${flag.name}`;
  return item;
}

/** Hover with the documentation of the flag under the cursor. */
export class BazelrcHoverProvider implements vscode.HoverProvider {
  constructor(private readonly catalogues: FlagCatalogues) {}

  public async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    const catalogue = await this.catalogues.forDocument(document);
    if (!catalogue) {
      return undefined;
    }
    const range = document.getWordRangeAtPosition(
      position,
      /--?[A-Za-z0-9_:-]+/,
    );
    if (!range) {
      return undefined;
    }
    const name = document.getText(range).replace(/^--?/, "").split("=")[0];
    const flag = catalogue.find(name);
    if (!flag) {
      return undefined;
    }
    const md = new vscode.MarkdownString();
    md.appendCodeblock(
      `--${flag.name}${flag.abbreviation ? ` (-${flag.abbreviation})` : ""}`,
      "bazelrc",
    );
    md.appendMarkdown(flagMarkdown(flag).value);
    md.appendMarkdown(`\n\n*Bazel ${catalogue.collection.bazelVersion}*`);
    return new vscode.Hover(md, range);
  }
}
