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

import {
  CallExpr,
  Expr,
  LineIndex,
  LoadStmt,
  Module,
  Span,
  Stmt,
  calleeName,
  parseModule,
  Identifier,
} from "../starlark";

/** A 0-based position in a document. */
export interface SourcePosition {
  line: number;
  character: number;
}

/** A 0-based range in a document. */
export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
}

/** A target defined in a BUILD file. */
export interface IndexedTarget {
  /** The label without repository, e.g. `//pkg:name`. */
  label: string;
  name: string;
  pkg: string;
  /** The rule or macro name as written, e.g. `py_binary`. */
  kind: string;
  /** Absolute path of the BUILD file. */
  file: string;
  /** Range of the whole rule call. */
  range: SourceRange;
  /** Range of the `name` string literal (including quotes). */
  nameRange: SourceRange;
  /** The literal `executable = True/False` argument, when there is one. */
  executable?: boolean;
  /** Set for targets discovered through `bazel query` rather than parsing. */
  generated?: {
    generatorName: string;
    generatorFunction: string;
  };
}

/** A top-level call in a BUILD file that did not yield a named target. */
export interface CallSite {
  callee: string;
  range: SourceRange;
  /**
   * True when the call has a `name` argument that is not a string literal, or
   * the call sits inside a loop, so its targets cannot be known statically.
   */
  dynamic: boolean;
}

export interface LoadedSymbol {
  /** Name bound in the loading file. */
  local: string;
  /** Name exported by the loaded module. */
  original: string;
  /** Range of the local name as written. */
  range: SourceRange;
  /** Range of the string literal naming the original symbol. */
  originalRange: SourceRange;
}

export interface LoadInfo {
  /** The module label as written, e.g. `@rules_python//python:defs.bzl`. */
  module: string;
  moduleRange: SourceRange;
  symbols: LoadedSymbol[];
  range: SourceRange;
}

export interface BuildFileModel {
  file: string;
  pkg: string;
  loads: LoadInfo[];
  targets: IndexedTarget[];
  calls: CallSite[];
  /** Number of syntax errors encountered while parsing. */
  errorCount: number;
}

export type BzlDefinitionKind =
  | "function"
  | "rule"
  | "macro"
  | "provider"
  | "aspect"
  | "repository_rule"
  | "module_extension"
  | "tag_class"
  | "variable";

export interface BzlDefinition {
  name: string;
  kind: BzlDefinitionKind;
  range: SourceRange;
  nameRange: SourceRange;
  /** Docstring or literal `doc =` argument, if present. */
  doc?: string;
}

export interface BzlFileModel {
  file: string;
  loads: LoadInfo[];
  definitions: Map<string, BzlDefinition>;
  errorCount: number;
  /** The parsed file, kept for on-demand evaluation of rule schemas. */
  module: Module;
  /** The source text the module was parsed from. */
  text: string;
}

export interface ModuleFileModel {
  file: string;
  /** Apparent repository names visible from the module, best effort. */
  repoNames: string[];
  /**
   * Names under which the repository refers to itself: `module(name)`,
   * `module(repo_name)` or `workspace(name)`.
   */
  selfNames: string[];
}

const RULE_LIKE_CALLEES = new Set<BzlDefinitionKind>([
  "rule",
  "macro",
  "provider",
  "aspect",
  "repository_rule",
  "module_extension",
  "tag_class",
]);

function toRange(index: LineIndex, span: Span): SourceRange {
  const s = index.position(span.start);
  const e = index.position(span.end);
  return {
    start: { line: s.line, character: s.column },
    end: { line: e.line, character: e.column },
  };
}

/** Strips a `native.` prefix from a callee name. */
function ruleKindFromCallee(callee: string): string {
  return callee.startsWith("native.") ? callee.slice("native.".length) : callee;
}

/** The value of the keyword argument `name` of a call, if given. */
export function findKeyword(call: CallExpr, name: string): Expr | undefined {
  return call.args.find((a) => a.name === name)?.value;
}

/** The value of a literal `True`/`False` expression. */
export function boolLiteral(expr: Expr | undefined): boolean | undefined {
  if (expr?.kind !== "ident") {
    return undefined;
  }
  return expr.name === "True"
    ? true
    : expr.name === "False"
      ? false
      : undefined;
}

/**
 * The identifiers an assignment binds: `x`, `a, b` or `(a, b)` on the left
 * of `=`. Elements that are not plain names (e.g. `a[0]`) are skipped.
 */
export function assignedIdents(target: Expr): Identifier[] {
  const elements =
    target.kind === "tuple"
      ? target.elements
      : target.kind === "paren" && target.inner.kind === "tuple"
        ? target.inner.elements
        : [target];
  return elements.filter((e): e is Identifier => e.kind === "ident");
}

function extractLoads(module: Module, index: LineIndex): LoadInfo[] {
  const loads: LoadInfo[] = [];
  for (const stmt of module.stmts) {
    if (stmt.kind !== "load") {
      continue;
    }
    loads.push(loadInfo(stmt, index));
  }
  return loads;
}

function loadInfo(stmt: LoadStmt, index: LineIndex): LoadInfo {
  return {
    module: stmt.module.value,
    moduleRange: toRange(index, stmt.module),
    symbols: stmt.symbols.map((s) => ({
      local: s.local,
      original: s.original,
      range: toRange(index, s.localSpan),
      originalRange: toRange(index, s.originalLiteral),
    })),
    range: toRange(index, stmt),
  };
}

/**
 * Builds the model of a BUILD file from its text.
 *
 * @param file Absolute path of the BUILD file.
 * @param pkg Package path of the BUILD file relative to its repository root.
 * @param text The file contents.
 */
export function extractBuildModel(
  file: string,
  pkg: string,
  text: string,
): BuildFileModel {
  const module = parseModule(text);
  const index = new LineIndex(text);
  const targets: IndexedTarget[] = [];
  const calls: CallSite[] = [];
  const seen = new Set<string>();

  const visitCall = (call: CallExpr, dynamicContext: boolean) => {
    const callee = calleeName(call.func);
    if (callee === undefined) {
      return;
    }
    const range = toRange(index, call);
    const nameExpr = findKeyword(call, "name");
    if (nameExpr?.kind === "string" && !dynamicContext) {
      const name = nameExpr.value;
      if (!name || seen.has(name)) {
        calls.push({ callee, range, dynamic: false });
        return;
      }
      seen.add(name);
      const target: IndexedTarget = {
        label: `//${pkg}:${name}`,
        name,
        pkg,
        kind: ruleKindFromCallee(callee),
        file,
        range,
        nameRange: toRange(index, nameExpr),
      };
      const executable = boolLiteral(findKeyword(call, "executable"));
      if (executable !== undefined) {
        target.executable = executable;
      }
      targets.push(target);
      return;
    }
    calls.push({
      callee,
      range,
      dynamic: dynamicContext || nameExpr !== undefined,
    });
  };

  const visitStmts = (stmts: Stmt[], dynamicContext: boolean) => {
    for (const stmt of stmts) {
      switch (stmt.kind) {
        case "expr":
          if (stmt.expr.kind === "call") {
            visitCall(stmt.expr, dynamicContext);
          }
          break;
        case "assign":
          if (stmt.value.kind === "call") {
            // `x = some_macro(name = "y")` still defines targets.
            visitCall(stmt.value, dynamicContext);
          }
          break;
        case "if":
          visitStmts(stmt.then, dynamicContext);
          visitStmts(stmt.else, dynamicContext);
          break;
        case "for":
        case "while":
          visitStmts(stmt.body, true);
          break;
        case "def":
          // Not legal in BUILD files, but harmless to ignore.
          break;
        default:
          break;
      }
    }
  };
  visitStmts(module.stmts, false);

  return {
    file,
    pkg,
    loads: extractLoads(module, index),
    targets,
    calls,
    errorCount: module.errors.length,
  };
}

function stringArg(call: CallExpr, name: string): string | undefined {
  const value = findKeyword(call, name);
  return value?.kind === "string" ? value.value : undefined;
}

/**
 * Builds the model of a .bzl file from its text.
 *
 * @param file Absolute path of the file.
 * @param text The file contents.
 */
export function extractBzlModel(file: string, text: string): BzlFileModel {
  const module = parseModule(text);
  const index = new LineIndex(text);
  const definitions = new Map<string, BzlDefinition>();

  const define = (def: BzlDefinition) => {
    if (!definitions.has(def.name)) {
      definitions.set(def.name, def);
    }
  };

  for (const stmt of module.stmts) {
    if (stmt.kind === "def") {
      define({
        name: stmt.name,
        kind: "function",
        range: toRange(index, stmt),
        nameRange: toRange(index, stmt.nameSpan),
        doc: stmt.docstring,
      });
      continue;
    }
    if (stmt.kind !== "assign" || stmt.op !== "=") {
      continue;
    }
    const range = toRange(index, stmt);
    const targets = assignedIdents(stmt.target);
    const value = stmt.value;
    const callee = value.kind === "call" ? calleeName(value.func) : undefined;
    const base = callee ? ruleKindFromCallee(callee) : undefined;
    targets.forEach((target, i) => {
      const isRuleLike =
        i === 0 &&
        base !== undefined &&
        RULE_LIKE_CALLEES.has(base as BzlDefinitionKind);
      define({
        name: target.name,
        kind: isRuleLike ? (base as BzlDefinitionKind) : "variable",
        range,
        nameRange: toRange(index, target),
        doc:
          isRuleLike && value.kind === "call"
            ? stringArg(value, "doc")
            : undefined,
      });
    });
  }

  return {
    file,
    loads: extractLoads(module, index),
    definitions,
    errorCount: module.errors.length,
    module,
    text,
  };
}

/**
 * Extracts the apparent repository names declared by a MODULE.bazel or
 * WORKSPACE file. This is a best-effort textual scan used for completion.
 */
export function extractModuleModel(
  file: string,
  text: string,
): ModuleFileModel {
  const module = parseModule(text);
  const names = new Set<string>();
  const selfNames = new Set<string>();
  for (const stmt of module.stmts) {
    let call: CallExpr | undefined;
    if (stmt.kind === "expr" && stmt.expr.kind === "call") {
      call = stmt.expr;
    } else if (stmt.kind === "assign" && stmt.value.kind === "call") {
      call = stmt.value;
    }
    if (!call) {
      continue;
    }
    const callee = calleeName(call.func);
    if (callee === "use_repo") {
      call.args.forEach((arg, i) => {
        if (i === 0) {
          return;
        }
        if (arg.name) {
          names.add(arg.name);
        } else if (arg.value.kind === "string") {
          names.add(arg.value.value);
        }
      });
      continue;
    }
    if (callee === "bazel_dep") {
      const repoName = stringArg(call, "repo_name") ?? stringArg(call, "name");
      if (repoName) {
        names.add(repoName);
      }
      continue;
    }
    if (callee === "module" || callee === "workspace") {
      for (const key of ["name", "repo_name"]) {
        const value = stringArg(call, key);
        if (value) {
          names.add(value);
          selfNames.add(value);
        }
      }
      continue;
    }
    // WORKSPACE-style repository rules.
    const name = stringArg(call, "name");
    if (name) {
      names.add(name);
    }
  }
  return {
    file,
    repoNames: [...names].sort(),
    selfNames: [...selfNames].sort(),
  };
}
