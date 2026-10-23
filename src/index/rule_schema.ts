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

/**
 * Static evaluation of Starlark rule, macro, struct and provider definitions
 * into "schemas" that drive keyword and member completion.
 *
 * This is deliberately not a Starlark interpreter. It understands the shapes
 * rulesets actually use to assemble `attrs` dictionaries: literal dicts,
 * named top-level dicts (also from loaded files), `a | b` unions,
 * `dict(a, **b)`, `dict(a.items())`, subscripts such as `OTHER["key"]`,
 * dict comprehensions that filter a few keys, attribute factories like
 * `def _stamp_attribute(d): return attr.int(...)`, aliases such as
 * `_label_list = attr.string_list`, and helper functions that copy a dict
 * and assign or update a few entries. Anything else evaluates to "unknown"
 * and is skipped rather than guessed.
 */

import {
  AssignStmt,
  CallExpr,
  DefStmt,
  Expr,
  Stmt,
  calleeName,
} from "../starlark";
import { Binding, BindingResolver, ModuleLoader } from "./bindings";
import { BzlFileModel, boolLiteral, findKeyword } from "./file_models";

/** One attribute (or macro parameter) a callable accepts. */
export interface AttrSchema {
  name: string;
  /** `label_list`, `string`, ... for attributes; `param` for parameters. */
  type: string;
  doc?: string;
  mandatory: boolean;
  /** Source text of the default value, abbreviated. */
  default?: string;
  /** Implicit attributes every rule has (`name`, `visibility`, ...). */
  implicit: boolean;
}

export type CallableKind =
  | "rule"
  | "macro"
  | "symbolic_macro"
  | "repository_rule"
  | "tag_class"
  | "aspect"
  | "function";

/** What can be passed to a rule or macro call. */
export interface CallableSchema {
  name: string;
  kind: CallableKind;
  doc?: string;
  /** File defining the rule or macro. */
  file: string;
  /** Attributes or parameters, in declaration order. */
  attrs: AttrSchema[];
  /** True for `def` macros with `**kwargs` whose target could not be found. */
  openEnded: boolean;
  /** For rules: the `test` and `executable` flags of the `rule()` call. */
  test?: boolean;
  executable?: boolean;
}

/** Fields of a struct or provider, for member completion. */
export interface MemberSchema {
  name: string;
  doc?: string;
  /** True when the field's value is a function. */
  callable: boolean;
}

// ---------------------------------------------------------------------------
// Values

type Value =
  | { kind: "dict"; entries: Map<string, Value> }
  | { kind: "attr"; attr: AttrSchema }
  | { kind: "string"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "list"; items: Value[] }
  | { kind: "items"; of: Map<string, Value> }
  | { kind: "function"; def: DefStmt; file: string }
  | { kind: "attrConstructor"; type: string }
  | { kind: "struct"; fields: Map<string, { expr: Expr; scope: Scope }> }
  | { kind: "tagClass"; call: CallExpr; scope: Scope }
  | { kind: "unknown" };

const UNKNOWN: Value = { kind: "unknown" };

interface Scope {
  file: string;
  model: BzlFileModel;
  locals?: Map<string, Value>;
}

const MAX_DEPTH = 24;

function implicitAttr(name: string, type: string, doc: string): AttrSchema {
  return { name, type, doc, mandatory: false, implicit: true };
}

/** Attributes Bazel adds to every rule. */
const COMMON_ATTRS: AttrSchema[] = [
  implicitAttr("name", "name", "A unique name for this target."),
  implicitAttr(
    "visibility",
    "label_list",
    "The visibility of this target: which packages may depend on it.",
  ),
  implicitAttr("tags", "string_list", "Tags such as `manual` or `no-remote`."),
  implicitAttr("testonly", "bool", "Only testonly targets may depend on it."),
  implicitAttr("deprecation", "string", "Warning printed when depended on."),
  implicitAttr("features", "string_list", "Feature flags for this target."),
  implicitAttr(
    "compatible_with",
    "label_list",
    "Environments this target can be built for.",
  ),
  implicitAttr(
    "target_compatible_with",
    "label_list",
    "Constraints the target platform must satisfy.",
  ),
  implicitAttr(
    "exec_compatible_with",
    "label_list",
    "Constraints the execution platform must satisfy.",
  ),
  implicitAttr(
    "exec_properties",
    "string_dict",
    "Properties added to the execution platform.",
  ),
  implicitAttr(
    "toolchains",
    "label_list",
    "Toolchains whose make variables are visible.",
  ),
  implicitAttr(
    "restricted_to",
    "label_list",
    "Environments this target may be built for.",
  ),
  implicitAttr(
    "aspect_hints",
    "label_list",
    "Arbitrary labels exposed to aspects as hints.",
  ),
  implicitAttr(
    "package_metadata",
    "label_list",
    "Metadata such as license declarations for this target.",
  ),
];

/** Attributes of executable rules in addition to {@link COMMON_ATTRS}. */
const BINARY_ATTRS: AttrSchema[] = [
  implicitAttr(
    "args",
    "string_list",
    "Command line arguments passed when run.",
  ),
  implicitAttr("env", "string_dict", "Environment variables set when run."),
  implicitAttr(
    "output_licenses",
    "string_list",
    "Licenses of the output files of this binary.",
  ),
];

/** Attributes of test rules in addition to {@link COMMON_ATTRS}. */
const TEST_ATTRS: AttrSchema[] = [
  implicitAttr(
    "args",
    "string_list",
    "Command line arguments passed to the test.",
  ),
  implicitAttr("env", "string_dict", "Environment variables set for the test."),
  implicitAttr(
    "env_inherit",
    "string_list",
    "Environment variables inherited from the invoking shell.",
  ),
  implicitAttr("size", "string", "`small`, `medium`, `large` or `enormous`."),
  implicitAttr(
    "timeout",
    "string",
    "`short`, `moderate`, `long` or `eternal`.",
  ),
  implicitAttr("flaky", "bool", "Retry the test up to three times."),
  implicitAttr("shard_count", "int", "Number of parallel shards."),
  implicitAttr("local", "bool", "Run without sandboxing or remote execution."),
];

const RULE_CALLEES = new Map<string, CallableKind>([
  ["rule", "rule"],
  ["repository_rule", "repository_rule"],
  ["macro", "symbolic_macro"],
  ["tag_class", "tag_class"],
  ["aspect", "aspect"],
]);

/**
 * Resolves names in `.bzl` files to the schemas of the callables and
 * structs they denote.
 */
export class SchemaResolver {
  private readonly cache = new Map<
    string,
    Promise<CallableSchema | undefined>
  >();
  private readonly memberCache = new Map<
    string,
    Promise<MemberSchema[] | undefined>
  >();

  /**
   * @param loader Reaches other files.
   * @param bindings Name resolution across files; shared with navigation so
   * that both follow the same loads and aliases.
   */
  constructor(
    private readonly loader: ModuleLoader,
    private readonly bindings = new BindingResolver(loader),
  ) {}

  /**
   * Drops cached results: everything after `.bzl` files changed, or only
   * what was asked from one file (whose `load()`s may have changed).
   */
  public clear(file?: string) {
    if (file === undefined) {
      this.cache.clear();
      this.memberCache.clear();
    } else {
      const prefix = `${file}\u0000`;
      for (const cache of [this.cache, this.memberCache]) {
        for (const key of cache.keys()) {
          if (key.startsWith(prefix)) {
            cache.delete(key);
          }
        }
      }
    }
    this.bindings.clear(file);
  }

  /**
   * Returns the schema of the callable bound to `name` in `file`, following
   * loads and aliases to the defining `rule()` or `def`.
   */
  public schemaFor(
    name: string,
    file: string,
  ): Promise<CallableSchema | undefined> {
    const key = `${file}\u0000${name}`;
    let cached = this.cache.get(key);
    if (cached === undefined) {
      cached = this.computeSchema(name, file, 0).catch(
        (): undefined => undefined,
      );
      this.cache.set(key, cached);
    }
    return cached;
  }

  /**
   * Returns the fields of the struct or provider that `path` denotes in
   * `file`, e.g. `["rust_common", "crate_info"]` for `rust_common.crate_info`.
   */
  public membersFor(
    path: string[],
    file: string,
  ): Promise<MemberSchema[] | undefined> {
    const key = `${file}\u0000${path.join(".")}`;
    let cached = this.memberCache.get(key);
    if (cached === undefined) {
      cached = this.computeMembers(path, file, 0).catch(
        (): undefined => undefined,
      );
      this.memberCache.set(key, cached);
    }
    return cached;
  }

  // -------------------------------------------------------------------------
  // Callables

  private async computeSchema(
    name: string,
    file: string,
    depth: number,
  ): Promise<CallableSchema | undefined> {
    if (depth > MAX_DEPTH) {
      return undefined;
    }
    // `native.foo` in a macro names the same rule as `foo` in a BUILD file.
    const bare = name.startsWith("native.")
      ? name.slice("native.".length)
      : name;
    const dot = bare.indexOf(".");
    if (dot !== -1) {
      return this.memberSchema(
        bare.slice(0, dot),
        bare.slice(dot + 1),
        file,
        depth,
      );
    }
    const binding = await this.bindings.bindingFor(bare, file);
    if (!binding) {
      return undefined;
    }
    const scope: Scope = { file: binding.file, model: binding.model };
    if (binding.stmt.kind === "def") {
      return this.macroSchema(binding.stmt, scope, depth);
    }
    const value = binding.stmt.value;
    if (value.kind !== "call") {
      return undefined;
    }
    const callee = calleeName(value.func);
    const kind = callee ? RULE_CALLEES.get(callee) : undefined;
    if (!kind) {
      return undefined;
    }
    return this.ruleSchema(name, value, kind, scope, depth);
  }

  /** Schema of `base.member(...)`: a function field of a struct. */
  private async memberSchema(
    base: string,
    member: string,
    file: string,
    depth: number,
  ): Promise<CallableSchema | undefined> {
    const binding = await this.bindings.bindingFor(base, file);
    if (!binding || binding.stmt.kind !== "assign") {
      return undefined;
    }
    const value = binding.stmt.value;
    const scope: Scope = { file: binding.file, model: binding.model };
    const object = await this.evalExpr(value, scope, depth + 1);
    const field = await this.structField(object, member, depth + 1);
    if (field.kind === "function") {
      const model = this.loader.getModel(field.file);
      return model
        ? this.macroSchema(field.def, { file: field.file, model }, depth + 1)
        : undefined;
    }
    return undefined;
  }

  /** Schema of a `rule(...)`, `tag_class(...)` or similar call. */
  private async ruleSchema(
    name: string,
    value: CallExpr,
    kind: CallableKind,
    scope: Scope,
    depth: number,
  ): Promise<CallableSchema> {
    // Arguments may arrive through `rule(**KWARGS)` where KWARGS is a dict.
    const splatted = new Map<string, Value>();
    for (const arg of value.args) {
      if (arg.star === "**") {
        const kwargs = await this.evalExpr(arg.value, scope, depth + 1);
        if (kwargs.kind === "dict") {
          for (const [k, v] of kwargs.entries) {
            splatted.set(k, v);
          }
        }
      }
    }
    const attrsExpr = findKeyword(value, "attrs");
    const attrs: AttrSchema[] = [];
    const dict = attrsExpr
      ? await this.evalExpr(attrsExpr, scope, depth + 1)
      : (splatted.get("attrs") ?? UNKNOWN);
    if (dict.kind === "dict") {
      for (const [attrName, entry] of dict.entries) {
        if (entry.kind === "attr") {
          attrs.push({ ...entry.attr, name: attrName });
        } else {
          attrs.push({
            name: attrName,
            type: "attr",
            mandatory: false,
            implicit: false,
          });
        }
      }
    }
    const splattedDoc = splatted.get("doc");
    const doc = cleanDoc(
      (await this.evalString(findKeyword(value, "doc"), scope, depth + 1)) ??
        (splattedDoc?.kind === "string" ? splattedDoc.value : undefined),
    );
    const splattedBool = (key: string) => {
      const v = splatted.get(key);
      return v?.kind === "bool" ? v.value : undefined;
    };
    // A flag that is not given is false; one we cannot evaluate is unknown.
    const flag = async (key: string): Promise<boolean | undefined> => {
      const expr = findKeyword(value, key);
      if (!expr) {
        return splattedBool(key) ?? false;
      }
      const evaluated = await this.evalExpr(expr, scope, depth + 1);
      return evaluated.kind === "bool" ? evaluated.value : undefined;
    };
    const isTest = await flag("test");
    const isExecutable = await flag("executable");
    let implicit: AttrSchema[] = [];
    switch (kind) {
      case "rule":
        implicit = [
          ...COMMON_ATTRS,
          ...(isTest ? TEST_ATTRS : isExecutable ? BINARY_ATTRS : []),
        ];
        break;
      case "symbolic_macro":
        implicit = COMMON_ATTRS.slice(0, 2);
        break;
      case "repository_rule":
        implicit = [COMMON_ATTRS[0]];
        break;
      default:
        break;
    }
    const explicitNames = new Set(attrs.map((a) => a.name));
    return {
      name,
      kind,
      doc,
      file: scope.file,
      attrs: [...attrs, ...implicit.filter((a) => !explicitNames.has(a.name))],
      openEnded: false,
      test: isTest,
      executable: isExecutable,
    };
  }

  /** Builds the schema of a legacy `def` macro. */
  private async macroSchema(
    def: DefStmt,
    scope: Scope,
    depth: number,
  ): Promise<CallableSchema> {
    const paramDocs = parseArgsSection(def.docstring);
    const attrs: AttrSchema[] = [];
    let kwargsName: string | undefined;
    for (const param of def.params) {
      if (param.star === "**") {
        kwargsName = param.name;
        continue;
      }
      if (param.star === "*" || param.name === "*") {
        continue;
      }
      attrs.push({
        name: param.name,
        type: "param",
        doc: paramDocs.get(param.name),
        mandatory: param.default === undefined,
        default: param.default
          ? abbreviate(
              scope.model.text.slice(param.default.start, param.default.end),
            )
          : undefined,
        implicit: false,
      });
    }
    // Follow `**kwargs` to the rule or macro it is forwarded to; the macro
    // then accepts that callable's attributes and inherits its flags.
    const forwarded =
      kwargsName === undefined
        ? undefined
        : await this.forwardedSchema(def, kwargsName, scope, depth);
    if (forwarded) {
      const have = new Set(attrs.map((a) => a.name));
      for (const attr of forwarded.attrs) {
        if (!have.has(attr.name)) {
          attrs.push(attr);
        }
      }
    }
    return {
      name: def.name,
      kind: "macro",
      doc: summaryOf(def.docstring) ?? forwarded?.doc,
      file: scope.file,
      attrs,
      openEnded: kwargsName !== undefined && !forwarded,
      test: forwarded?.test,
      executable: forwarded?.executable,
    };
  }

  /**
   * Finds the call inside a macro body that receives `**kwargs` and returns
   * the schema of its callee, minus the keywords the macro sets itself.
   */
  private async forwardedSchema(
    def: DefStmt,
    kwargsName: string,
    scope: Scope,
    depth: number,
  ): Promise<CallableSchema | undefined> {
    if (depth > MAX_DEPTH) {
      return undefined;
    }
    let found: CallExpr | undefined;
    const visit = (stmts: Stmt[]) => {
      for (const stmt of stmts) {
        if (found) {
          return;
        }
        if (stmt.kind === "expr" && stmt.expr.kind === "call") {
          if (forwardsKwargs(stmt.expr, kwargsName)) {
            found = stmt.expr;
            return;
          }
        } else if (stmt.kind === "assign" && stmt.value.kind === "call") {
          if (forwardsKwargs(stmt.value, kwargsName)) {
            found = stmt.value;
            return;
          }
        } else if (stmt.kind === "return" && stmt.value?.kind === "call") {
          if (forwardsKwargs(stmt.value, kwargsName)) {
            found = stmt.value;
            return;
          }
        } else if (stmt.kind === "if") {
          visit(stmt.then);
          visit(stmt.else);
        } else if (stmt.kind === "for" || stmt.kind === "while") {
          visit(stmt.body);
        }
      }
    };
    visit(def.body);
    if (!found) {
      return undefined;
    }
    const callee = calleeName(found.func);
    if (!callee) {
      return undefined;
    }
    const target = await this.computeSchema(callee, scope.file, depth + 1);
    if (!target) {
      return undefined;
    }
    const setByMacro = new Set(
      found.args.flatMap((a) => (a.name ? [a.name] : [])),
    );
    return {
      ...target,
      attrs: target.attrs.filter((a) => !setByMacro.has(a.name)),
    };
  }

  // -------------------------------------------------------------------------
  // Members

  private async computeMembers(
    path: string[],
    file: string,
    depth: number,
  ): Promise<MemberSchema[] | undefined> {
    if (path.length === 0 || depth > MAX_DEPTH) {
      return undefined;
    }
    const binding = await this.bindings.bindingFor(path[0], file);
    if (!binding || binding.stmt.kind !== "assign") {
      return undefined;
    }
    let expr: Expr = binding.stmt.value;
    let scope: Scope = { file: binding.file, model: binding.model };
    for (let i = 1; i < path.length; i++) {
      if (expr.kind !== "call" || calleeName(expr.func) !== "struct") {
        return undefined;
      }
      const field = expr.args.find((a) => a.name === path[i]);
      if (!field) {
        return undefined;
      }
      if (field.value.kind === "ident") {
        const next = await this.bindings.bindingFor(
          field.value.name,
          scope.file,
        );
        if (!next || next.stmt.kind !== "assign") {
          return undefined;
        }
        expr = next.stmt.value;
        scope = { file: next.file, model: next.model };
      } else {
        expr = field.value;
      }
    }
    if (expr.kind !== "call") {
      return undefined;
    }
    const callee = calleeName(expr.func);
    if (callee === "struct") {
      const members: MemberSchema[] = [];
      for (const arg of expr.args) {
        if (!arg.name) {
          continue;
        }
        let callable = arg.value.kind === "lambda";
        if (arg.value.kind === "ident") {
          const target = await this.bindings.bindingFor(
            arg.value.name,
            scope.file,
          );
          callable = target?.stmt.kind === "def";
        }
        members.push({ name: arg.name, callable });
      }
      return members;
    }
    if (callee === "provider") {
      const fields = findKeyword(expr, "fields");
      if (!fields) {
        return [];
      }
      if (fields.kind === "list") {
        return fields.elements.flatMap((e) =>
          e.kind === "string" ? [{ name: e.value, callable: false }] : [],
        );
      }
      if (fields.kind === "dict") {
        const members: MemberSchema[] = [];
        for (const entry of fields.entries) {
          if (entry.key.kind !== "string") {
            continue;
          }
          members.push({
            name: entry.key.value,
            doc: cleanDoc(await this.evalString(entry.value, scope, depth + 1)),
            callable: false,
          });
        }
        return members;
      }
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Expression evaluation

  private async evalString(
    expr: Expr | undefined,
    scope: Scope,
    depth: number,
  ): Promise<string | undefined> {
    if (!expr) {
      return undefined;
    }
    const value = await this.evalExpr(expr, scope, depth);
    return value.kind === "string" ? value.value : undefined;
  }

  private async evalExpr(
    expr: Expr,
    scope: Scope,
    depth: number,
  ): Promise<Value> {
    if (depth > MAX_DEPTH) {
      return UNKNOWN;
    }
    switch (expr.kind) {
      case "string":
        return { kind: "string", value: expr.value };
      case "paren":
        return this.evalExpr(expr.inner, scope, depth);
      case "ident":
        return this.evalIdent(expr.name, scope, depth);
      case "list": {
        const items: Value[] = [];
        for (const e of expr.elements) {
          items.push(await this.evalExpr(e, scope, depth + 1));
        }
        return { kind: "list", items };
      }
      case "dict": {
        const entries = new Map<string, Value>();
        for (const entry of expr.entries) {
          const key = await this.evalExpr(entry.key, scope, depth + 1);
          if (key.kind !== "string") {
            continue;
          }
          entries.set(
            key.value,
            await this.evalExpr(entry.value, scope, depth + 1),
          );
        }
        return { kind: "dict", entries };
      }
      case "binary":
        return this.evalBinary(expr.op, expr.left, expr.right, scope, depth);
      case "unary": {
        if (expr.op !== "not") {
          return UNKNOWN;
        }
        const operand = await this.evalExpr(expr.operand, scope, depth + 1);
        return operand.kind === "bool"
          ? { kind: "bool", value: !operand.value }
          : UNKNOWN;
      }
      case "index": {
        const object = await this.evalExpr(expr.object, scope, depth + 1);
        const key = await this.evalExpr(expr.index, scope, depth + 1);
        if (object.kind === "dict" && key.kind === "string") {
          return object.entries.get(key.value) ?? UNKNOWN;
        }
        return UNKNOWN;
      }
      case "call":
        return this.evalCall(expr, scope, depth);
      case "comprehension":
        return this.evalComprehension(expr, scope, depth);
      case "conditional": {
        // `attr.license() if hasattr(attr, "license") else attr.string_list()`
        const test = await this.evalExpr(expr.test, scope, depth + 1);
        if (test.kind === "bool") {
          return this.evalExpr(
            test.value ? expr.then : expr.else,
            scope,
            depth + 1,
          );
        }
        const then = await this.evalExpr(expr.then, scope, depth + 1);
        return then.kind === "unknown"
          ? this.evalExpr(expr.else, scope, depth + 1)
          : then;
      }
      case "attr": {
        // `attr.string_list` used as a value (constructor alias).
        const path = calleeName(expr);
        if (path?.startsWith("attr.")) {
          return { kind: "attrConstructor", type: path.slice(5) };
        }
        // `semantics.allowlist_attrs`: a field of a struct.
        const object = await this.evalExpr(expr.object, scope, depth + 1);
        return this.structField(object, expr.name, depth);
      }
      default:
        return UNKNOWN;
    }
  }

  private async evalIdent(
    name: string,
    scope: Scope,
    depth: number,
  ): Promise<Value> {
    const local = scope.locals?.get(name);
    if (local) {
      return local;
    }
    if (name === "True") {
      return { kind: "bool", value: true };
    }
    if (name === "False") {
      return { kind: "bool", value: false };
    }
    const binding = await this.bindings.bindingFor(name, scope.file);
    if (!binding) {
      return UNKNOWN;
    }
    if (binding.stmt.kind === "def") {
      return { kind: "function", def: binding.stmt, file: binding.file };
    }
    const bindingScope: Scope = { file: binding.file, model: binding.model };
    const value = await this.evalExpr(
      binding.stmt.value,
      bindingScope,
      depth + 1,
    );
    return this.applyTopLevelMutations(binding, value, bindingScope, depth);
  }

  /**
   * Applies `NAME.update(...)` and `NAME["key"] = ...` statements that follow
   * a top-level dict assignment, e.g. `cc_binary_attrs.update(extra_attrs)`.
   */
  private async applyTopLevelMutations(
    binding: Binding,
    value: Value,
    scope: Scope,
    depth: number,
  ): Promise<Value> {
    if (value.kind !== "dict") {
      return value;
    }
    const stmts = binding.model.module.stmts;
    const start = stmts.indexOf(binding.stmt) + 1;
    if (start <= 0) {
      return value;
    }
    let entries: Map<string, Value> | undefined;
    for (const stmt of stmts.slice(start)) {
      if (
        stmt.kind === "expr" &&
        stmt.expr.kind === "call" &&
        stmt.expr.func.kind === "attr" &&
        stmt.expr.func.name === "update" &&
        stmt.expr.func.object.kind === "ident" &&
        stmt.expr.func.object.name === binding.name
      ) {
        const source = await this.updateEntries(stmt.expr, scope, depth);
        if (source) {
          entries = entries ?? new Map(value.entries);
          for (const [k, v] of source) {
            entries.set(k, v);
          }
        }
      } else if (
        stmt.kind === "assign" &&
        stmt.op === "=" &&
        stmt.target.kind === "index" &&
        stmt.target.object.kind === "ident" &&
        stmt.target.object.name === binding.name
      ) {
        const key = await this.evalExpr(stmt.target.index, scope, depth + 1);
        if (key.kind === "string") {
          entries = entries ?? new Map(value.entries);
          entries.set(
            key.value,
            await this.evalExpr(stmt.value, scope, depth + 1),
          );
        }
      } else if (
        stmt.kind === "assign" &&
        stmt.target.kind === "ident" &&
        stmt.target.name === binding.name
      ) {
        break; // Rebound; later statements refer to a new value.
      }
    }
    return entries ? { kind: "dict", entries } : value;
  }

  /**
   * Evaluates the arguments of a `.update(...)` call into the entries to
   * merge: a positional dict and/or keyword arguments.
   */
  private async updateEntries(
    call: CallExpr,
    scope: Scope,
    depth: number,
  ): Promise<Map<string, Value> | undefined> {
    const entries = new Map<string, Value>();
    for (const arg of call.args) {
      const value = await this.evalExpr(arg.value, scope, depth + 1);
      if (arg.name) {
        entries.set(arg.name, value);
      } else if (value.kind === "dict") {
        for (const [k, v] of value.entries) {
          entries.set(k, v);
        }
      } else {
        return undefined;
      }
    }
    return entries;
  }

  /** Returns a field of a struct value, evaluating it on first use. */
  private async structField(
    object: Value,
    name: string,
    depth: number,
  ): Promise<Value> {
    if (object.kind !== "struct") {
      return UNKNOWN;
    }
    const field = object.fields.get(name);
    if (!field) {
      return UNKNOWN;
    }
    return this.evalExpr(field.expr, field.scope, depth + 1);
  }

  private async evalBinary(
    op: string,
    leftExpr: Expr,
    rightExpr: Expr,
    scope: Scope,
    depth: number,
  ): Promise<Value> {
    const left = await this.evalExpr(leftExpr, scope, depth + 1);
    const right = await this.evalExpr(rightExpr, scope, depth + 1);
    if (op === "|") {
      if (left.kind === "dict" && right.kind === "dict") {
        return {
          kind: "dict",
          entries: new Map([...left.entries, ...right.entries]),
        };
      }
      // One side could not be evaluated: keep what is known rather than
      // losing the whole dictionary.
      if (left.kind === "dict" || right.kind === "dict") {
        return left.kind === "dict" ? left : right;
      }
    }
    if (op === "+") {
      if (left.kind === "string" && right.kind === "string") {
        return { kind: "string", value: left.value + right.value };
      }
      if (left.kind === "string" && right.kind === "unknown") {
        return left;
      }
      if (left.kind === "unknown" && right.kind === "string") {
        return right;
      }
      if (left.kind === "list" && right.kind === "list") {
        return { kind: "list", items: [...left.items, ...right.items] };
      }
      if (left.kind === "items" && right.kind === "items") {
        return { kind: "items", of: new Map([...left.of, ...right.of]) };
      }
    }
    if (op === "%" && left.kind === "string") {
      return left;
    }
    return UNKNOWN;
  }

  private async evalCall(
    call: CallExpr,
    scope: Scope,
    depth: number,
  ): Promise<Value> {
    const path = calleeName(call.func);

    if (path?.startsWith("attr.")) {
      return {
        kind: "attr",
        attr: await this.attrSchema(path.slice(5), call, scope, depth),
      };
    }
    if (path === "dict") {
      return this.evalDictCall(call, scope, depth);
    }
    if (path === "tag_class") {
      return { kind: "tagClass", call, scope };
    }
    if (path === "struct") {
      const fields = new Map<string, { expr: Expr; scope: Scope }>();
      for (const arg of call.args) {
        if (arg.name) {
          fields.set(arg.name, { expr: arg.value, scope });
        }
      }
      return { kind: "struct", fields };
    }
    if (path === "provider") {
      return UNKNOWN;
    }

    // Method calls on evaluated receivers: `d.items()`, `"...".format()`,
    // and `semantics.get_stl()` where `semantics` is a struct.
    let callee: Value = UNKNOWN;
    if (call.func.kind === "attr") {
      const method = call.func.name;
      const receiver = await this.evalExpr(call.func.object, scope, depth + 1);
      if (receiver.kind === "dict" && method === "items") {
        return { kind: "items", of: receiver.entries };
      }
      if (
        receiver.kind === "string" &&
        (method === "format" || method === "strip")
      ) {
        return receiver;
      }
      if (receiver.kind === "struct") {
        callee = await this.structField(receiver, method, depth);
      }
    } else if (path) {
      // Calls of user functions: attribute factories, dict helpers, dedent.
      callee = await this.evalIdent(path, scope, depth + 1);
    }
    if (callee.kind === "attrConstructor") {
      return {
        kind: "attr",
        attr: await this.attrSchema(callee.type, call, scope, depth),
      };
    }
    if (callee.kind === "function") {
      const args: Value[] = [];
      for (const arg of call.args) {
        args.push(await this.evalExpr(arg.value, scope, depth + 1));
      }
      const result = await this.interpret(
        callee.def,
        callee.file,
        call,
        args,
        depth + 1,
      );
      if (result.kind !== "unknown") {
        return result;
      }
    }
    // Unknown single-string-argument functions such as `dedent(...)` are
    // treated as identity so that documentation still comes through.
    if (call.args.length === 1 && !call.args[0].name && !call.args[0].star) {
      const only = await this.evalExpr(call.args[0].value, scope, depth + 1);
      if (only.kind === "string") {
        return only;
      }
    }
    return UNKNOWN;
  }

  private async attrSchema(
    type: string,
    call: CallExpr,
    scope: Scope,
    depth: number,
  ): Promise<AttrSchema> {
    const defaultExpr = findKeyword(call, "default");
    return {
      name: "",
      type,
      doc: cleanDoc(
        await this.evalString(findKeyword(call, "doc"), scope, depth + 1),
      ),
      mandatory: boolLiteral(findKeyword(call, "mandatory")) === true,
      default: defaultExpr
        ? abbreviate(scope.model.text.slice(defaultExpr.start, defaultExpr.end))
        : undefined,
      implicit: false,
    };
  }

  /** `dict(x)`, `dict(x, **y)`, `dict(x.items())`, `dict(k = v)`. */
  private async evalDictCall(
    call: CallExpr,
    scope: Scope,
    depth: number,
  ): Promise<Value> {
    const entries = new Map<string, Value>();
    for (const arg of call.args) {
      const value = await this.evalExpr(arg.value, scope, depth + 1);
      if (arg.name) {
        entries.set(arg.name, value);
        continue;
      }
      if (value.kind === "dict") {
        for (const [k, v] of value.entries) {
          entries.set(k, v);
        }
      } else if (value.kind === "items") {
        for (const [k, v] of value.of) {
          entries.set(k, v);
        }
      } else if (arg.star === undefined && call.args.length === 1) {
        return UNKNOWN;
      } else if (value.kind === "unknown") {
        return UNKNOWN;
      }
    }
    return { kind: "dict", entries };
  }

  /** `{k: v for k, v in d.items() if k != "x"}` and close variants. */
  private async evalComprehension(
    expr: Extract<Expr, { kind: "comprehension" }>,
    scope: Scope,
    depth: number,
  ): Promise<Value> {
    if (!expr.curly || "kind" in expr.body) {
      return UNKNOWN;
    }
    const forClauses = expr.clauses.filter((c) => c.kind === "forClause");
    if (forClauses.length !== 1 || forClauses[0].kind !== "forClause") {
      return UNKNOWN;
    }
    const clause = forClauses[0];
    const target = clause.target;
    if (
      target.kind !== "tuple" ||
      target.elements.length !== 2 ||
      target.elements[0].kind !== "ident" ||
      target.elements[1].kind !== "ident"
    ) {
      return UNKNOWN;
    }
    const keyName = target.elements[0].name;
    const valueName = target.elements[1].name;
    const body = expr.body;
    if (
      body.key.kind !== "ident" ||
      body.key.name !== keyName ||
      body.value.kind !== "ident" ||
      body.value.name !== valueName
    ) {
      return UNKNOWN;
    }
    const source = await this.evalExpr(clause.iter, scope, depth + 1);
    const source2 =
      source.kind === "items"
        ? source.of
        : source.kind === "dict"
          ? source.entries
          : undefined;
    if (!source2) {
      return UNKNOWN;
    }
    const entries = new Map<string, Value>();
    for (const [k, v] of source2) {
      let keep = true;
      for (const cond of expr.clauses) {
        if (cond.kind !== "ifClause") {
          continue;
        }
        const verdict = await this.evalKeyFilter(
          cond.test,
          keyName,
          k,
          scope,
          depth + 1,
        );
        if (verdict === undefined) {
          return UNKNOWN;
        }
        keep = keep && verdict;
      }
      if (keep) {
        entries.set(k, v);
      }
    }
    return { kind: "dict", entries };
  }

  /** Evaluates `key != "x"`, `key == "x"`, `key in [...]`, `key not in [...]`. */
  private async evalKeyFilter(
    test: Expr,
    keyName: string,
    key: string,
    scope: Scope,
    depth: number,
  ): Promise<boolean | undefined> {
    if (test.kind === "unary" && test.op === "not") {
      const inner = await this.evalKeyFilter(
        test.operand,
        keyName,
        key,
        scope,
        depth,
      );
      return inner === undefined ? undefined : !inner;
    }
    if (
      test.kind !== "binary" ||
      test.left.kind !== "ident" ||
      test.left.name !== keyName
    ) {
      return undefined;
    }
    const right = await this.evalExpr(test.right, scope, depth + 1);
    switch (test.op) {
      case "!=":
        return right.kind === "string" ? key !== right.value : undefined;
      case "==":
        return right.kind === "string" ? key === right.value : undefined;
      case "in":
      case "not in": {
        if (right.kind !== "list") {
          return undefined;
        }
        const members = right.items.flatMap((i) =>
          i.kind === "string" ? [i.value] : [],
        );
        const contained = members.includes(key);
        return test.op === "in" ? contained : !contained;
      }
      default:
        return undefined;
    }
  }

  /**
   * Interprets the body of a small helper function of the kind rulesets use
   * to derive one attribute dictionary from another: `new = dict(attrs)`,
   * then `new["key"] = attr.label(...)` or `new.update(other)`, then
   * `return new`. Supports assignments, subscript assignment with string
   * keys, `.update()`, and `return`. Any other statement aborts with
   * "unknown".
   */
  private async interpret(
    def: DefStmt,
    file: string,
    call: CallExpr,
    args: Value[],
    depth: number,
  ): Promise<Value> {
    const model = this.loader.getModel(file);
    if (!model || depth > MAX_DEPTH) {
      return UNKNOWN;
    }
    const locals = new Map<string, Value>();
    const scope: Scope = { file, model, locals };
    let positional = 0;
    for (const param of def.params) {
      if (param.star === "**") {
        continue;
      }
      if (param.star === "*") {
        // `*dictionaries`: the remaining positional arguments.
        const rest: Value[] = [];
        while (positional < call.args.length) {
          if (!call.args[positional].name) {
            rest.push(args[positional]);
          }
          positional++;
        }
        locals.set(param.name, { kind: "list", items: rest });
        continue;
      }
      const named = call.args.findIndex((a) => a.name === param.name);
      if (named !== -1) {
        locals.set(param.name, args[named]);
      } else if (positional < call.args.length && !call.args[positional].name) {
        locals.set(param.name, args[positional++]);
      } else if (param.default) {
        locals.set(
          param.name,
          await this.evalExpr(param.default, scope, depth + 1),
        );
      } else {
        locals.set(param.name, UNKNOWN);
      }
    }
    return (await this.execute(def.body, scope, depth)) ?? UNKNOWN;
  }

  /**
   * Executes the statements of a helper function. Returns the value of a
   * `return`, `undefined` when the block ends without returning, or
   * {@link UNKNOWN} when a statement is outside the supported subset.
   */
  private async execute(
    stmts: Stmt[],
    scope: Scope,
    depth: number,
  ): Promise<Value | undefined> {
    const locals = scope.locals!;
    for (const stmt of stmts) {
      switch (stmt.kind) {
        case "expr": {
          if (stmt.expr.kind === "string") {
            continue; // docstring
          }
          const call = stmt.expr;
          if (
            call.kind === "call" &&
            call.func.kind === "attr" &&
            call.func.name === "update" &&
            call.func.object.kind === "ident"
          ) {
            const target = locals.get(call.func.object.name);
            const source = await this.updateEntries(call, scope, depth);
            if (target?.kind === "dict" && source) {
              for (const [k, v] of source) {
                target.entries.set(k, v);
              }
              continue;
            }
          }
          return UNKNOWN;
        }
        case "assign": {
          if (stmt.op !== "=") {
            return UNKNOWN;
          }
          const value = await this.evalExpr(stmt.value, scope, depth + 1);
          if (stmt.target.kind === "ident") {
            // Copy dicts so that callers' values are never mutated.
            locals.set(
              stmt.target.name,
              value.kind === "dict"
                ? { kind: "dict", entries: new Map(value.entries) }
                : value,
            );
            continue;
          }
          if (
            stmt.target.kind === "index" &&
            stmt.target.object.kind === "ident"
          ) {
            const target = locals.get(stmt.target.object.name);
            const key = await this.evalExpr(
              stmt.target.index,
              scope,
              depth + 1,
            );
            if (target?.kind === "dict" && key.kind === "string") {
              target.entries.set(key.value, value);
              continue;
            }
          }
          return UNKNOWN;
        }
        case "for": {
          // `for d in dictionaries: result.update(d)`
          if (stmt.target.kind !== "ident") {
            return UNKNOWN;
          }
          const iterable = await this.evalExpr(stmt.iter, scope, depth + 1);
          if (iterable.kind !== "list") {
            return UNKNOWN;
          }
          for (const item of iterable.items) {
            locals.set(stmt.target.name, item);
            const result = await this.execute(stmt.body, scope, depth + 1);
            if (result !== undefined) {
              return result;
            }
          }
          continue;
        }
        case "if": {
          // `if semantics.flag: attrs["x"] = attr.bool(...)`
          const test = await this.evalExpr(stmt.test, scope, depth + 1);
          if (test.kind !== "bool") {
            return UNKNOWN;
          }
          const result = await this.execute(
            test.value ? stmt.then : stmt.else,
            scope,
            depth + 1,
          );
          if (result !== undefined) {
            return result;
          }
          continue;
        }
        case "return":
          return stmt.value
            ? this.evalExpr(stmt.value, scope, depth + 1)
            : UNKNOWN;
        case "pass":
          continue;
        default:
          return UNKNOWN;
      }
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Helpers

function forwardsKwargs(call: CallExpr, kwargsName: string): boolean {
  return call.args.some(
    (a) =>
      a.star === "**" &&
      a.value.kind === "ident" &&
      a.value.name === kwargsName,
  );
}

function abbreviate(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
}

/** Normalizes documentation written with `dedent("""...""")` or similar. */
export function cleanDoc(doc: string | undefined): string | undefined {
  if (doc === undefined) {
    return undefined;
  }
  const lines = doc.replace(/\r\n/g, "\n").split("\n");
  // Strip common indentation across all non-blank lines, including the
  // first, which is where `"""\` continuation docs start.
  let min = Infinity;
  for (const line of lines) {
    if (line.trim() !== "") {
      min = Math.min(min, line.length - line.trimStart().length);
    }
  }
  const stripped =
    isFinite(min) && min > 0 ? lines.map((l) => l.slice(min)) : lines;
  return stripped.join("\n").trim();
}

/** First paragraph of a docstring. */
export function summaryOf(doc: string | undefined): string | undefined {
  if (!doc) {
    return undefined;
  }
  const trimmed = dedentText(doc).trim();
  const end = trimmed.indexOf("\n\n");
  return end === -1 ? trimmed : trimmed.slice(0, end);
}

/**
 * Parses the `Args:` section of a Google-style docstring into parameter
 * documentation.
 */
export function parseArgsSection(doc: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!doc) {
    return result;
  }
  const lines = dedentText(doc).split("\n");
  let inArgs = false;
  let argsIndent = -1;
  let current: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inArgs) {
      if (/^(Args|Arguments|Attributes):\s*$/.test(trimmed)) {
        inArgs = true;
        argsIndent = line.length - line.trimStart().length;
      }
      continue;
    }
    if (trimmed === "") {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= argsIndent) {
      break; // next section
    }
    const match = /^(\*{0,2}[A-Za-z_]\w*)(?:\s*\([^)]*\))?:\s*(.*)$/.exec(
      trimmed,
    );
    if (
      match &&
      (current === undefined || indent <= firstArgIndent(lines, argsIndent))
    ) {
      current = match[1].replace(/^\*+/, "");
      result.set(current, match[2]);
    } else if (current !== undefined) {
      result.set(current, `${result.get(current) ?? ""} ${trimmed}`.trim());
    }
  }
  return result;
}

function firstArgIndent(lines: string[], argsIndent: number): number {
  let seen = false;
  for (const line of lines) {
    if (!seen) {
      seen = /^(Args|Arguments|Attributes):\s*$/.test(line.trim());
      continue;
    }
    if (line.trim() === "") {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent > argsIndent) {
      return indent;
    }
  }
  return argsIndent + 1;
}

function dedentText(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let min = Infinity;
  for (const line of lines.slice(1)) {
    if (line.trim() === "") {
      continue;
    }
    min = Math.min(min, line.length - line.trimStart().length);
  }
  if (!isFinite(min) || min === 0) {
    return text;
  }
  return [lines[0], ...lines.slice(1).map((l) => l.slice(min))].join("\n");
}
