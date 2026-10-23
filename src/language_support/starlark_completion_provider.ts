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
import * as path from "path";
import * as vscode from "vscode";

import {
  FileContext,
  IndexManager,
  LabelResolver,
  SchemaResolver,
  WorkspaceIndex,
  findBuildFile,
  isBuildFileName,
} from "../index";
import {
  LoadContext,
  callContextAt,
  insideString,
  loadContextAt,
  memberAccessAt,
} from "./document_analysis";
import { attrMarkdown, offeredAttrs } from "./schema_support";
import { DocumentCache } from "./starlark_definition_provider";

/**
 * Completion for Starlark files.
 *
 * Inside string literals: labels, i.e. repository names after `@`, packages
 * after `//`, targets after `:`, files or targets of the current package
 * for bare strings, and `.bzl` files and exported symbols inside `load()`.
 * Fetched external repositories are browsed from their files. Outside
 * strings: keyword arguments of the rule or macro being called, and fields
 * after `struct.` or `Provider.`.
 */
export class StarlarkCompletionProvider
  implements vscode.CompletionItemProvider
{
  constructor(
    private readonly manager: IndexManager,
    private readonly resolver: LabelResolver,
    private readonly schemas: SchemaResolver,
    private readonly documents: DocumentCache,
  ) {}

  public async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[]> {
    const text = document.getText();
    const offset = document.offsetAt(position);
    if (!insideString(text, offset)) {
      return this.completeCode(document, text, offset, position);
    }
    const line = document.lineAt(position).text;
    const before = line.slice(0, position.character);
    const quote = Math.max(before.lastIndexOf('"'), before.lastIndexOf("'"));
    if (quote === -1) {
      return [];
    }
    const prefix = before.slice(quote + 1);
    if (/\s/.test(prefix)) {
      return [];
    }
    const ctx = await this.resolver.contextFor(document.uri.fsPath);
    if (!ctx) {
      return [];
    }
    const load = loadContextAt(text, offset);
    if (load?.kind === "symbol") {
      return this.completeLoadSymbols(load, prefix, ctx, position);
    }
    return this.complete(prefix, ctx, position, load?.kind === "module");
  }

  /** Completes the exported symbols of the module a `load()` names. */
  private async completeLoadSymbols(
    load: LoadContext,
    prefix: string,
    ctx: FileContext,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[]> {
    if (!load.module) {
      return [];
    }
    const resolved = await this.resolver.resolveLoadModule(load.module, ctx);
    const model = resolved && ctx.index.getBzlModel(resolved.file);
    if (!model) {
      return [];
    }
    const range = rangeBefore(position, prefix.length);
    const taken = new Set(load.existing);
    // use_extension() names a module extension, use_repo_rule() a
    // repository rule; load() takes any exported symbol.
    const wanted =
      load.callee === "use_extension"
        ? "module_extension"
        : load.callee === "use_repo_rule"
          ? "repository_rule"
          : undefined;
    const items: vscode.CompletionItem[] = [];
    for (const def of model.definitions.values()) {
      if (def.name.startsWith("_") || taken.has(def.name)) {
        continue;
      }
      if (wanted && def.kind !== wanted) {
        if (def.kind !== "variable") {
          continue;
        }
        // `pip = _pip`: look through the alias.
        const binding = await this.resolver.bindings.bindingFor(
          def.name,
          resolved.file,
        );
        const aliased = binding?.model.definitions.get(binding.name);
        if (aliased?.kind !== wanted) {
          continue;
        }
      }
      const item = new vscode.CompletionItem(
        def.name,
        def.kind === "function"
          ? vscode.CompletionItemKind.Function
          : def.kind === "variable"
            ? vscode.CompletionItemKind.Variable
            : vscode.CompletionItemKind.Class,
      );
      item.range = range;
      item.detail = def.kind === "variable" ? undefined : def.kind;
      if (def.doc) {
        item.documentation = new vscode.MarkdownString(def.doc);
      }
      items.push(item);
    }
    return items;
  }

  /** Keyword-argument and member completion outside of strings. */
  private async completeCode(
    document: vscode.TextDocument,
    text: string,
    offset: number,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[]> {
    const file = document.uri.fsPath;

    const member = memberAccessAt(text, offset);
    if (member) {
      const members = await this.schemas.membersFor(member.path, file);
      if (!members) {
        return [];
      }
      const memberRange = new vscode.Range(
        document.positionAt(member.prefixStart),
        position,
      );
      return members.map((m) => {
        const item = new vscode.CompletionItem(
          m.name,
          m.callable
            ? vscode.CompletionItemKind.Function
            : vscode.CompletionItemKind.Field,
        );
        item.range = memberRange;
        if (m.doc) {
          item.documentation = new vscode.MarkdownString(m.doc);
        }
        return item;
      });
    }

    const analyzed = this.documents.get(document);
    const ctx = callContextAt(analyzed, offset);
    if (!ctx || ctx.inValue) {
      return [];
    }
    const schema = await this.schemas.schemaFor(ctx.callee, file);
    if (!schema) {
      return [];
    }
    const range = new vscode.Range(
      document.positionAt(ctx.prefixStart),
      position,
    );
    const items: vscode.CompletionItem[] = [];
    offeredAttrs(schema).forEach((attr, index) => {
      if (ctx.existingKeywords.has(attr.name)) {
        return;
      }
      const item = new vscode.CompletionItem(
        attr.name,
        attr.type === "param"
          ? vscode.CompletionItemKind.Variable
          : vscode.CompletionItemKind.Property,
      );
      if (ctx.keywordEnd !== undefined) {
        // Inside an existing keyword: replace the whole name, keep its `=`.
        item.range = new vscode.Range(
          document.positionAt(ctx.prefixStart),
          document.positionAt(ctx.keywordEnd),
        );
        item.insertText = attr.name;
      } else {
        item.range = range;
        item.insertText = new vscode.SnippetString(`${attr.name} = $0`);
      }
      item.detail = attr.type === "param" ? undefined : attr.type;
      item.documentation = attrMarkdown(attr);
      // Required attributes first, then declared ones in order, then the
      // attributes common to all rules.
      const group =
        attr.name === "name" ? 0 : attr.mandatory ? 1 : attr.implicit ? 3 : 2;
      item.sortText = `${group}${String(index).padStart(4, "0")}`;
      items.push(item);
    });
    return items;
  }

  private async complete(
    prefix: string,
    ctx: FileContext,
    position: vscode.Position,
    bzlOnly = false,
  ): Promise<vscode.CompletionItem[]> {
    const index = ctx.index;
    await index.ready;

    // `@repo` — repository names.
    if (prefix.startsWith("@") && !prefix.includes("//")) {
      const repoTyped = prefix.replace(/^@@?/, "");
      // The repository mapping, once loaded, is exact. Until then the
      // module file and WORKSPACE-style directories under external/ give
      // a reasonable list without running Bazel.
      const names = new Set<string>(
        ctx.resolver.knownRepoNames(ctx.canonicalRepo) ?? [],
      );
      if (names.size === 0 && ctx.canonicalRepo === "") {
        for (const name of index.getModuleModel()?.repoNames ?? []) {
          names.add(name);
        }
        for (const name of await ctx.resolver.listFetchedRepos()) {
          if (!name.includes("+") && !name.includes("~")) {
            names.add(name);
          }
        }
      }
      return [...names].sort().map((name) =>
        makeItem(name, vscode.CompletionItemKind.Module, {
          range: rangeBefore(position, repoTyped.length),
          insertText: `${name}//`,
          retrigger: true,
        }),
      );
    }

    // `//pkg/...` or `@repo//pkg/...` — packages and targets.
    const slashes = prefix.indexOf("//");
    if (slashes !== -1) {
      const repoPart = prefix.slice(0, slashes);
      const rest = prefix.slice(slashes + 2);
      let repoView: RepoView | undefined = indexView(index);
      if (repoPart !== "" && repoPart !== "@" && repoPart !== "@@") {
        const repo = await this.resolver.repoDirFor(
          {
            repo: repoPart.replace(/^@@?/, ""),
            canonical: repoPart.startsWith("@@"),
            pkg: "",
            name: "",
            absolute: true,
          },
          ctx,
          false,
        );
        repoView = repo
          ? repo.dir === index.root
            ? indexView(index)
            : diskView(index, repo.dir)
          : undefined;
      }
      return repoView ? completeInRepo(repoView, rest, position, bzlOnly) : [];
    }

    const view =
      ctx.canonicalRepo === ""
        ? indexView(index)
        : diskView(index, ctx.repoRoot);

    // `:target` — targets of the current package, or `.bzl` files in a load.
    if (prefix.startsWith(":")) {
      return bzlOnly
        ? bzlFileItems(view, ctx.pkg, prefix.slice(1), position)
        : targetItems(
            view.targets(ctx.pkg),
            rangeBefore(position, prefix.length - 1),
          );
    }

    // Bare string: targets (inserted as `:name`) and files of the package.
    if (prefix.includes(":") || bzlOnly) {
      return [];
    }
    const slash = prefix.lastIndexOf("/");
    const dirPart = slash === -1 ? "" : prefix.slice(0, slash + 1);
    const typed = slash === -1 ? prefix : prefix.slice(slash + 1);
    const range = rangeBefore(position, typed.length);
    const items = dirPart
      ? []
      : targetItems(view.targets(ctx.pkg), range, true);
    const dir = path.join(ctx.repoRoot, ...ctx.pkg.split("/"), dirPart);
    for (const entry of await readDirectory(dir)) {
      if (entry.name.startsWith(".") || isBuildFileName(entry.name)) {
        continue;
      }
      if (entry.isDirectory()) {
        if (findBuildFile(path.join(dir, entry.name))) {
          continue; // A subpackage: its files aren't part of this package.
        }
        items.push(
          makeItem(entry.name, vscode.CompletionItemKind.Folder, {
            range,
            insertText: `${entry.name}/`,
            retrigger: true,
          }),
        );
      } else {
        items.push(
          makeItem(entry.name, vscode.CompletionItemKind.File, { range }),
        );
      }
    }
    return items;
  }
}

/** Packages and targets of one repository, however they are discovered. */
interface RepoView {
  /** Directory of a package on disk. */
  dirOf(pkg: string): string;
  /** Direct child directories of `parent` that lead to packages. */
  children(
    parent: string,
  ): Promise<{ names: string[]; parentIsPackage: boolean }>;
  /** Target names of a package. */
  targets(pkg: string): string[];
}

/** The main repository, served from the index. */
function indexView(index: WorkspaceIndex): RepoView {
  return {
    dirOf: (pkg) => path.join(index.root, ...pkg.split("/").filter(Boolean)),
    children: async (parent) => {
      const prefix = parent ? `${parent}/` : "";
      const names = new Set<string>();
      let parentIsPackage = false;
      for (const pkg of index.getPackages()) {
        if (pkg === parent) {
          parentIsPackage = true;
        } else if (pkg.startsWith(prefix)) {
          names.add(pkg.slice(prefix.length).split("/")[0]);
        }
      }
      return { names: [...names], parentIsPackage };
    },
    targets: (pkg) => index.getTargets(pkg).map((t) => t.name),
  };
}

/** A fetched external repository, served from its files. */
function diskView(index: WorkspaceIndex, repoRoot: string): RepoView {
  const dirOf = (pkg: string) =>
    path.join(repoRoot, ...pkg.split("/").filter(Boolean));
  return {
    dirOf,
    children: async (parent) => ({
      names: (await readDirectory(dirOf(parent)))
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name),
      parentIsPackage: !!findBuildFile(dirOf(parent)),
    }),
    targets: (pkg) => {
      const buildFile = findBuildFile(dirOf(pkg));
      return buildFile
        ? (index
            .getForeignBuildModel(buildFile, pkg)
            ?.targets.map((t) => t.name) ?? [])
        : [];
    },
  };
}

/** Completes `pkg/sub` or `pkg:target` after `//` within a repository. */
async function completeInRepo(
  view: RepoView,
  rest: string,
  position: vscode.Position,
  bzlOnly = false,
): Promise<vscode.CompletionItem[]> {
  const colon = rest.indexOf(":");
  if (colon !== -1) {
    const pkg = rest.slice(0, colon);
    const target = rest.slice(colon + 1);
    return bzlOnly
      ? bzlFileItems(view, pkg, target, position)
      : targetItems(view.targets(pkg), rangeBefore(position, target.length));
  }
  const slash = rest.lastIndexOf("/");
  const parent = slash === -1 ? "" : rest.slice(0, slash);
  const typed = slash === -1 ? rest : rest.slice(slash + 1);
  const range = rangeBefore(position, typed.length);
  const { names, parentIsPackage } = await view.children(parent);
  const items = names.sort().map((name) =>
    makeItem(name, vscode.CompletionItemKind.Folder, {
      range,
      insertText: `${name}/`,
      retrigger: true,
    }),
  );
  if (parentIsPackage && typed === "") {
    // Offer `:` to move on to the targets of the parent package. After
    // `//pkg/` it replaces the trailing slash; after a bare `//` there is
    // no slash to replace.
    const afterSlash = rest !== "";
    items.push(
      makeItem(":", vscode.CompletionItemKind.Operator, {
        range: rangeBefore(position, afterSlash ? 1 : 0),
        insertText: ":",
        filterText: afterSlash ? "/:" : ":",
        retrigger: true,
      }),
    );
  }
  return items;
}

/**
 * Completes the `.bzl` files of a package for a `load()` statement: the
 * files of the package directory (and of the typed subdirectory) plus
 * subdirectories that are not packages themselves.
 */
async function bzlFileItems(
  view: RepoView,
  pkg: string,
  typed: string,
  position: vscode.Position,
): Promise<vscode.CompletionItem[]> {
  const slash = typed.lastIndexOf("/");
  const subdir = slash === -1 ? "" : typed.slice(0, slash + 1);
  const name = slash === -1 ? typed : typed.slice(slash + 1);
  const dir = path.join(view.dirOf(pkg), subdir);
  const range = rangeBefore(position, name.length);
  const items: vscode.CompletionItem[] = [];
  for (const entry of await readDirectory(dir)) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".bzl")) {
      items.push(
        makeItem(entry.name, vscode.CompletionItemKind.File, { range }),
      );
    } else if (
      entry.isDirectory() &&
      !findBuildFile(path.join(dir, entry.name))
    ) {
      items.push(
        makeItem(entry.name, vscode.CompletionItemKind.Folder, {
          range,
          insertText: `${entry.name}/`,
          retrigger: true,
        }),
      );
    }
  }
  return items;
}

function targetItems(
  names: string[],
  range: vscode.Range,
  bare = false,
): vscode.CompletionItem[] {
  return [...names].sort().map((name) =>
    makeItem(name, vscode.CompletionItemKind.Field, {
      range,
      insertText: bare ? `:${name}` : undefined,
      filterText: bare ? name : undefined,
    }),
  );
}

function makeItem(
  label: string,
  kind: vscode.CompletionItemKind,
  options: {
    range: vscode.Range;
    insertText?: string;
    filterText?: string;
    retrigger?: boolean;
  },
): vscode.CompletionItem {
  const result = new vscode.CompletionItem(label, kind);
  result.range = options.range;
  result.insertText = options.insertText;
  result.filterText = options.filterText;
  if (options.retrigger) {
    result.command = {
      command: "editor.action.triggerSuggest",
      title: "Re-trigger completions",
    };
  }
  return result;
}

function rangeBefore(position: vscode.Position, length: number): vscode.Range {
  return new vscode.Range(position.translate(0, -length), position);
}

async function readDirectory(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
