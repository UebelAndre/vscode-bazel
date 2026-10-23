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

/** The cursor is inside a string argument of a `load()` statement. */
export interface LoadContext {
  /** The call the string belongs to, currently always `load`. */
  callee: string;
  /** `module` for the first argument, `symbol` for the following ones. */
  kind: "module" | "symbol";
  /** The module label (first argument), when already written. */
  module?: string;
  /** Symbols already named in this call. */
  existing: string[];
}

const LOADING_CALLEES = ["load"];

/**
 * Detects whether the string at the cursor belongs to a `load()` call and
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
