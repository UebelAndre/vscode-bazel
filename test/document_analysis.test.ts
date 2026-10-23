import * as assert from "assert";
import {
  analyzeDocument,
  callContextAt,
  insideString,
  loadContextAt,
  memberAccessAt,
} from "../src/language_support/document_analysis";

function at(text: string): { text: string; offset: number } {
  const offset = text.indexOf("|");
  assert.notStrictEqual(offset, -1, "marker missing");
  return { text: text.replace("|", ""), offset };
}

describe("callContextAt", () => {
  it("finds the call and existing keywords between arguments", () => {
    const { text, offset } = at(
      'rust_binary(\n    name = "x",\n    srcs = ["a.rs"],\n    |\n)\n',
    );
    const ctx = callContextAt(analyzeDocument(text), offset)!;
    assert.strictEqual(ctx.callee, "rust_binary");
    assert.deepStrictEqual([...ctx.existingKeywords].sort(), ["name", "srcs"]);
    assert.strictEqual(ctx.inValue, false);
    assert.strictEqual(ctx.prefix, "");
  });

  it("reports a partially typed keyword as the prefix", () => {
    const { text, offset } = at('rust_binary(\n    name = "x",\n    sr|\n)\n');
    const ctx = callContextAt(analyzeDocument(text), offset)!;
    assert.strictEqual(ctx.prefix, "sr");
    assert.strictEqual(ctx.prefixStart, offset - 2);
    assert.strictEqual(ctx.inValue, false);
  });

  it("knows when the cursor is inside a value", () => {
    const { text, offset } = at(
      'rust_binary(\n    name = "x",\n    srcs = [|],\n)\n',
    );
    const ctx = callContextAt(analyzeDocument(text), offset)!;
    assert.strictEqual(ctx.inValue, true);
    assert.strictEqual(ctx.activeKeyword, "srcs");
  });

  it("picks the innermost call", () => {
    const { text, offset } = at("outer(\n    inner(na|),\n)\n");
    const ctx = callContextAt(analyzeDocument(text), offset)!;
    assert.strictEqual(ctx.callee, "inner");
    assert.strictEqual(ctx.prefix, "na");
  });

  it("falls back to text scanning while a call is unfinished", () => {
    const { text, offset } = at(
      'load(":defs.bzl", "my_rule")\nmy_rule(name = "x", de|',
    );
    const ctx = callContextAt(analyzeDocument(text), offset)!;
    assert.strictEqual(ctx.callee, "my_rule");
    assert.strictEqual(ctx.prefix, "de");
    assert.deepStrictEqual([...ctx.existingKeywords], ["name"]);
    assert.strictEqual(ctx.inValue, false);
  });

  it("falls back to text scanning inside an unfinished value", () => {
    const { text, offset } = at('my_rule(name = "x", deps = [":a", |');
    const ctx = callContextAt(analyzeDocument(text), offset)!;
    assert.strictEqual(ctx.callee, "my_rule");
    assert.strictEqual(ctx.inValue, true);
    assert.strictEqual(ctx.activeKeyword, "deps");
  });

  it("returns nothing outside of calls", () => {
    const { text, offset } = at("x = 1\n|\n");
    assert.strictEqual(callContextAt(analyzeDocument(text), offset), undefined);
  });

  it("does not mistake a parameter list for a call", () => {
    const clean = at("def my_macro(name, |):\n    pass\n");
    assert.strictEqual(
      callContextAt(analyzeDocument(clean.text), clean.offset),
      undefined,
    );
    const unfinished = at("def my_macro(name, |");
    assert.strictEqual(
      callContextAt(analyzeDocument(unfinished.text), unfinished.offset),
      undefined,
    );
  });

  it("only counts top-level keywords in the textual fallback", () => {
    const { text, offset } = at(
      'my_rule(name = "x", srcs = glob(include = ["*.rs"]), cmd = "a = b", |',
    );
    const ctx = callContextAt(analyzeDocument(text), offset)!;
    assert.deepStrictEqual([...ctx.existingKeywords].sort(), [
      "cmd",
      "name",
      "srcs",
    ]);
  });

  it("reports the extent of an existing keyword under the cursor", () => {
    const { text, offset } = at('my_rule(na|me = "x")\n');
    const ctx = callContextAt(analyzeDocument(text), offset)!;
    assert.strictEqual(ctx.prefix, "na");
    assert.strictEqual(ctx.keywordEnd, offset + 2);
    assert.ok(!ctx.existingKeywords.has("name"));
  });
});

describe("memberAccessAt", () => {
  it("parses dotted paths and the typed prefix", () => {
    const { text, offset } = at("    deps = rust_common.cra|");
    assert.deepStrictEqual(memberAccessAt(text, offset), {
      path: ["rust_common"],
      prefix: "cra",
      prefixStart: offset - 3,
    });
    const nested = at("x = a.b.|");
    assert.deepStrictEqual(memberAccessAt(nested.text, nested.offset)?.path, [
      "a",
      "b",
    ]);
  });

  it("ignores other positions", () => {
    const { text, offset } = at("x = foo|");
    assert.strictEqual(memberAccessAt(text, offset), undefined);
  });
});

describe("insideString", () => {
  it("detects open string literals on the current line", () => {
    const open = at('    srcs = ["//pkg|');
    assert.strictEqual(insideString(open.text, open.offset), true);
    const closed = at('    srcs = ["//pkg:a"], |');
    assert.strictEqual(insideString(closed.text, closed.offset), false);
    const escaped = at('    x = "a\\"b|');
    assert.strictEqual(insideString(escaped.text, escaped.offset), true);
    const comment = at('    x = 1  # "not| a string');
    assert.strictEqual(insideString(comment.text, comment.offset), false);
  });
});

describe("loadContextAt", () => {
  it("recognizes the module argument", () => {
    const { text, offset } = at('load("//rust:de|');
    assert.deepStrictEqual(loadContextAt(text, offset), {
      callee: "load",
      kind: "module",
      existing: [],
    });
  });

  it("treats use_extension and use_repo_rule like load", () => {
    const ext = at('python = use_extension("//python:ext.bzl", "py|');
    assert.deepStrictEqual(loadContextAt(ext.text, ext.offset), {
      callee: "use_extension",
      kind: "symbol",
      module: "//python:ext.bzl",
      existing: [],
    });
    const repo = at(
      'http_archive = use_repo_rule("@bazel_tools//tools:http.bzl", "|',
    );
    assert.strictEqual(
      loadContextAt(repo.text, repo.offset)?.callee,
      "use_repo_rule",
    );
  });

  it("recognizes symbol arguments and what is already loaded", () => {
    const { text, offset } = at(
      'load("//rust:defs.bzl", "rust_binary", lib = "rust_library", "ru|',
    );
    assert.deepStrictEqual(loadContextAt(text, offset), {
      callee: "load",
      kind: "symbol",
      module: "//rust:defs.bzl",
      existing: ["rust_binary", "rust_library"],
    });
  });

  it("handles multi-line load statements", () => {
    const { text, offset } = at(
      'load(\n    "//rust:defs.bzl",\n    "rust_binary",\n    "|',
    );
    assert.strictEqual(loadContextAt(text, offset)?.kind, "symbol");
  });

  it("ignores strings in other calls", () => {
    const { text, offset } = at('cc_library(name = "fo|');
    assert.strictEqual(loadContextAt(text, offset), undefined);
    const nested = at('load_data(srcs = ["//pkg:|');
    assert.strictEqual(loadContextAt(nested.text, nested.offset), undefined);
  });
});
