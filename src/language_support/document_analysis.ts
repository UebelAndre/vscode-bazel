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
  Identifier,
  LoadStmt,
  LoadSymbol,
  Module,
  Stmt,
  StringLiteral,
  calleeName,
  parseModule,
  stmtExprs,
  walkExpr,
  walkStmts,
} from "../starlark";
import { assignedIdents } from "../index/file_models";

/** A string literal under the cursor. */
export interface StringAt {
  kind: "string";
  literal: StringLiteral;
  /** The `load()` statement when the string is its module or a symbol. */
  load?: LoadStmt;
  /** The load symbol when the cursor is on a symbol of a `load()`. */
  loadSymbol?: LoadSymbol;
  /** The innermost call containing the string, if any. */
  call?: CallExpr;
  /** The keyword argument the string belongs to, if any. */
  argName?: string;
}

/** An identifier under the cursor. */
export interface IdentAt {
  kind: "ident";
  ident: Identifier;
  /** True when the identifier is the callee of a call. */
  isCallee: boolean;
  /** The local name of a `load()` symbol written as `local = "orig"`. */
  loadSymbol?: LoadSymbol;
  load?: LoadStmt;
}

export type NodeAt = StringAt | IdentAt;

/** Parsed form of a document, cached per version by providers. */
export interface AnalyzedDocument {
  text: string;
  module: Module;
}

export function analyzeDocument(text: string): AnalyzedDocument {
  return { text, module: parseModule(text) };
}

function contains(span: { start: number; end: number }, offset: number) {
  return span.start <= offset && offset <= span.end;
}

/** Finds the string or identifier at an offset, with its syntactic role. */
export function nodeAt(
  doc: AnalyzedDocument,
  offset: number,
): NodeAt | undefined {
  let result: NodeAt | undefined;

  const visitStmt = (stmt: Stmt): boolean | void => {
    if (!contains(stmt, offset)) {
      return false;
    }
    if (stmt.kind === "load") {
      if (contains(stmt.module, offset)) {
        result = { kind: "string", literal: stmt.module, load: stmt };
        return false;
      }
      for (const sym of stmt.symbols) {
        if (contains(sym.originalLiteral, offset)) {
          result = {
            kind: "string",
            literal: sym.originalLiteral,
            load: stmt,
            loadSymbol: sym,
          };
          return false;
        }
        if (contains(sym.localSpan, offset)) {
          result = {
            kind: "ident",
            ident: {
              kind: "ident",
              name: sym.local,
              start: sym.localSpan.start,
              end: sym.localSpan.end,
            },
            isCallee: false,
            loadSymbol: sym,
            load: stmt,
          };
          return false;
        }
      }
      return false;
    }
    if (stmt.kind === "def") {
      // Parameters and the name aren't navigable; descend into defaults and
      // the body only.
      for (const p of stmt.params) {
        if (p.default && contains(p.default, offset)) {
          findInExpr(p.default, []);
          return false;
        }
      }
      return true;
    }
    for (const expr of stmtExprs(stmt)) {
      if (contains(expr, offset)) {
        findInExpr(expr, []);
        return false;
      }
    }
    return true;
  };

  const findInExpr = (root: Expr, callStack: CallExpr[]) => {
    const calls: CallExpr[] = [...callStack];
    walkExpr(root, (e) => {
      if (!contains(e, offset)) {
        return false;
      }
      if (e.kind === "call") {
        calls.push(e);
        if (e.func.kind === "ident" && contains(e.func, offset)) {
          result = { kind: "ident", ident: e.func, isCallee: true };
          return false;
        }
        return true;
      }
      if (e.kind === "string") {
        const call = innermostCall(calls, e);
        result = {
          kind: "string",
          literal: e,
          call,
          argName: call ? argNameFor(call, e) : undefined,
        };
        return false;
      }
      if (e.kind === "ident") {
        result = { kind: "ident", ident: e, isCallee: false };
        return false;
      }
      return true;
    });
  };

  walkStmts(doc.module.stmts, visitStmt);
  return result;
}

function innermostCall(calls: CallExpr[], node: Expr): CallExpr | undefined {
  for (let i = calls.length - 1; i >= 0; i--) {
    if (contains(calls[i], node.start)) {
      return calls[i];
    }
  }
  return undefined;
}

function argNameFor(call: CallExpr, node: Expr): string | undefined {
  for (const arg of call.args) {
    if (contains(arg.value, node.start)) {
      return arg.name;
    }
  }
  return undefined;
}

/** Finds the `load()` statement binding `name` in the module, if any. */
export function loadBinding(
  module: Module,
  name: string,
): { load: LoadStmt; symbol: LoadSymbol } | undefined {
  for (const stmt of module.stmts) {
    if (stmt.kind !== "load") {
      continue;
    }
    const symbol = stmt.symbols.find((s) => s.local === name);
    if (symbol) {
      return { load: stmt, symbol };
    }
  }
  return undefined;
}

/** Finds a top-level `def` or assignment binding `name` in the module. */
export function topLevelBinding(
  module: Module,
  name: string,
): { start: number; end: number } | undefined {
  for (const stmt of module.stmts) {
    if (stmt.kind === "def" && stmt.name === name) {
      return stmt.nameSpan;
    }
    if (stmt.kind === "assign") {
      const t = assignedIdents(stmt.target).find((e) => e.name === name);
      if (t) {
        return { start: t.start, end: t.end };
      }
    }
  }
  return undefined;
}

/** Where the cursor sits relative to a call's argument list. */
export interface CallContext {
  /** Name of the callee as written, e.g. `rust_binary` or `native.foo`. */
  callee: string;
  /** Keywords already supplied in the call. */
  existingKeywords: Set<string>;
  /** True when the cursor is inside an argument value (after `=`). */
  inValue: boolean;
  /** The keyword whose value the cursor is in, if any. */
  activeKeyword?: string;
  /** Partial keyword typed at the cursor (empty when between arguments). */
  prefix: string;
  /** Offset where `prefix` starts. */
  prefixStart: number;
  /** End of the keyword name when the cursor is inside an existing one. */
  keywordEnd?: number;
}

function callContextFromAst(
  doc: AnalyzedDocument,
  offset: number,
): CallContext | undefined {
  let innermost: CallExpr | undefined;
  const visitExpr = (root: Expr) => {
    walkExpr(root, (e) => {
      if (!contains(e, offset)) {
        return false;
      }
      if (e.kind === "call" && e.lparen < offset && offset < e.end) {
        innermost = e;
      }
      return true;
    });
  };
  walkStmts(doc.module.stmts, (stmt) => {
    if (!contains(stmt, offset)) {
      return false;
    }
    for (const expr of stmtExprs(stmt)) {
      if (contains(expr, offset)) {
        visitExpr(expr);
      }
    }
    return true;
  });
  if (!innermost) {
    return undefined;
  }
  const call: CallExpr = innermost;
  const callee = calleeName(call.func);
  if (!callee) {
    return undefined;
  }
  const existingKeywords = new Set(
    call.args.flatMap((a) => (a.name ? [a.name] : [])),
  );
  for (const arg of call.args) {
    if (arg.name && arg.nameSpan && contains(arg.nameSpan, offset)) {
      existingKeywords.delete(arg.name);
      return {
        callee,
        existingKeywords,
        inValue: false,
        prefix: doc.text.slice(arg.nameSpan.start, offset),
        prefixStart: arg.nameSpan.start,
        keywordEnd: arg.nameSpan.end,
      };
    }
    if (contains(arg.value, offset) && offset > arg.value.start) {
      if (!arg.name && !arg.star && arg.value.kind === "ident") {
        return {
          callee,
          existingKeywords,
          inValue: false,
          prefix: doc.text.slice(arg.value.start, offset),
          prefixStart: arg.value.start,
        };
      }
      return {
        callee,
        existingKeywords,
        inValue: true,
        activeKeyword: arg.name,
        prefix: "",
        prefixStart: offset,
      };
    }
  }
  return {
    callee,
    existingKeywords,
    inValue: false,
    prefix: "",
    prefixStart: offset,
  };
}

/**
 * Textual fallback for documents that do not parse around the cursor, e.g.
 * while a call is still being typed: scans back to the unmatched `(`.
 */
function callContextFromText(
  text: string,
  offset: number,
): CallContext | undefined {
  let depth = 0;
  let i = offset - 1;
  let quote: string | undefined;
  for (; i >= 0; i--) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") {
        quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      // Scanning backwards we cannot tell opening from closing quotes
      // reliably; assume balanced strings and skip to the matching one.
      quote = ch;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth++;
    } else if (ch === "[" || ch === "{") {
      // An unclosed list or dict before the cursor: still inside the call.
      if (depth > 0) {
        depth--;
      }
    } else if (ch === "(") {
      if (depth === 0) {
        break;
      }
      depth--;
    }
  }
  if (i < 0) {
    return undefined;
  }
  const before = text.slice(0, i);
  const calleeMatch = /([A-Za-z_][\w.]*)\s*$/.exec(before);
  if (!calleeMatch || /\bdef\s+$/.test(before.slice(0, calleeMatch.index))) {
    // No callee, or a function being defined rather than called.
    return undefined;
  }
  const inside = text.slice(i + 1, offset);
  // Forward scan of the argument text: collect the keywords of top-level
  // arguments, find the start of the current argument (last top-level
  // comma) and whether a bracket is still open.
  const existingKeywords = new Set<string>();
  const noteKeyword = (argument: string) => {
    const m = /^\s*([A-Za-z_]\w*)\s*=(?!=)/.exec(argument);
    if (m) {
      existingKeywords.add(m[1]);
    }
  };
  let nesting = 0;
  let argStart = 0;
  let firstOpen = -1;
  let inQuote: string | undefined;
  for (let j = 0; j < inside.length; j++) {
    const ch = inside[j];
    if (inQuote) {
      if (ch === "\\") {
        j++;
      } else if (ch === inQuote) {
        inQuote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === "(" || ch === "[" || ch === "{") {
      if (nesting === 0) {
        firstOpen = j;
      }
      nesting++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      nesting = Math.max(0, nesting - 1);
      if (nesting === 0) {
        firstOpen = -1;
      }
    } else if (ch === "," && nesting === 0) {
      noteKeyword(inside.slice(argStart, j));
      argStart = j + 1;
    }
  }
  noteKeyword(inside.slice(argStart));
  const callee = calleeMatch[1];
  const current =
    nesting > 0 ? inside.slice(argStart, firstOpen) : inside.slice(argStart);
  const eq = current.indexOf("=");
  if (nesting > 0 || eq !== -1) {
    const keywordText = eq === -1 ? current : current.slice(0, eq);
    const keyword = /([A-Za-z_]\w*)\s*$/.exec(keywordText)?.[1];
    return {
      callee,
      existingKeywords,
      inValue: true,
      activeKeyword: keyword,
      prefix: "",
      prefixStart: offset,
    };
  }
  const prefix = /([A-Za-z_]\w*)$/.exec(current)?.[1] ?? "";
  return {
    callee,
    existingKeywords,
    inValue: false,
    prefix,
    prefixStart: offset - prefix.length,
  };
}

/**
 * Describes the call the cursor is in, if any. The textual fallback is
 * only consulted when the document did not parse cleanly, i.e. while the
 * call is still being typed.
 */
export function callContextAt(
  doc: AnalyzedDocument,
  offset: number,
): CallContext | undefined {
  const fromAst = callContextFromAst(doc, offset);
  if (fromAst || doc.module.errors.length === 0) {
    return fromAst;
  }
  return callContextFromText(doc.text, offset);
}

/**
 * Detects `foo.bar.` member access before the cursor and returns the path
 * and the partially typed member name.
 */
export function memberAccessAt(
  text: string,
  offset: number,
): { path: string[]; prefix: string; prefixStart: number } | undefined {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const before = text.slice(lineStart, offset);
  const match = /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.([A-Za-z_]\w*)?$/.exec(
    before,
  );
  if (!match) {
    return undefined;
  }
  const prefix = match[2] ?? "";
  return {
    path: match[1].split("."),
    prefix,
    prefixStart: offset - prefix.length,
  };
}

/** Whether the cursor is inside a string literal on its line. */
export function insideString(text: string, offset: number): boolean {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const before = text.slice(lineStart, offset);
  let quote: string | undefined;
  for (let i = 0; i < before.length; i++) {
    const ch = before[i];
    if (quote) {
      if (ch === "\\") {
        i++;
      } else if (ch === quote) {
        quote = undefined;
      }
    } else if (ch === "#") {
      return false;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    }
  }
  return quote !== undefined;
}

/**
 * The cursor is inside a string argument of `load()`, or of the
 * MODULE.bazel functions that name a .bzl file and a symbol in it:
 * `use_extension()` and `use_repo_rule()`.
 */
export interface LoadContext {
  /** `load`, `use_extension` or `use_repo_rule`. */
  callee: string;
  /** `module` for the first argument, `symbol` for the following ones. */
  kind: "module" | "symbol";
  /** The module label (first argument), when already written. */
  module?: string;
  /** Symbols already named in this call. */
  existing: string[];
}

const LOADING_CALLEES = ["load", "use_extension", "use_repo_rule"];

/**
 * Detects whether the string at the cursor belongs to a loading call and
 * which argument it is. Works on unfinished statements, since the string
 * being typed is usually not yet closed.
 */
export function loadContextAt(
  text: string,
  offset: number,
): LoadContext | undefined {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const line = text.slice(lineStart, offset);
  const quote = Math.max(line.lastIndexOf('"'), line.lastIndexOf("'"));
  if (quote === -1) {
    return undefined;
  }
  const stringStart = lineStart + quote;
  // Find the unmatched `(` before the string.
  let depth = 0;
  let i = stringStart - 1;
  let inQuote: string | undefined;
  for (; i >= 0; i--) {
    const ch = text[i];
    if (inQuote) {
      if (ch === inQuote && text[i - 1] !== "\\") {
        inQuote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth++;
    } else if (ch === "(" || ch === "[" || ch === "{") {
      if (depth === 0) {
        break;
      }
      depth--;
    }
  }
  if (i < 0 || text[i] !== "(") {
    return undefined;
  }
  const callee = /(?:^|[^\w.])([A-Za-z_]\w*)\s*$/.exec(text.slice(0, i))?.[1];
  if (!callee || !LOADING_CALLEES.includes(callee)) {
    return undefined;
  }
  const inside = text.slice(i + 1, stringStart);
  const strings = [
    ...inside.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g),
  ].map((m) => m[1] ?? m[2]);
  if (!/,\s*(?:[A-Za-z_]\w*\s*=\s*)?$/.test(inside) && strings.length === 0) {
    return { callee, kind: "module", existing: [] };
  }
  return {
    callee,
    kind: "symbol",
    module: strings[0],
    existing: strings.slice(1),
  };
}
