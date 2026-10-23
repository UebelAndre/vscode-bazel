import * as assert from "assert";
import {
  extractBuildModel,
  extractBzlModel,
  extractModuleModel,
} from "../src/index/file_models";

describe("extractBuildModel", () => {
  it("collects named targets with their positions", () => {
    const text = [
      'load("//tools:defs.bzl", "my_rule")',
      "",
      "my_rule(",
      '    name = "first",',
      ")",
      'native.cc_library(name = "second")',
      "package(default_visibility = ['//visibility:public'])",
      "",
      "for i in range(3):",
      '    cc_library(name = "lib%d" % i)',
      "",
      "if True:",
      '    cc_library(name = "conditional")',
      "",
      'wrapped_macro(name = "a" + "b")',
      "",
      'cc_library(name = "first")',
    ].join("\n");
    const model = extractBuildModel("/ws/pkg/BUILD", "pkg", text);

    assert.deepStrictEqual(
      model.targets.map((t) => [t.label, t.kind, t.range.start.line]),
      [
        ["//pkg:first", "my_rule", 2],
        ["//pkg:second", "cc_library", 5],
        ["//pkg:conditional", "cc_library", 12],
      ],
    );
    assert.deepStrictEqual(model.targets[0].nameRange, {
      start: { line: 3, character: 11 },
      end: { line: 3, character: 18 },
    });
    assert.deepStrictEqual(
      model.calls.map((c) => [c.callee, c.dynamic]),
      [
        ["package", false],
        ["cc_library", true],
        ["wrapped_macro", true],
        // Duplicate name: not a second target.
        ["cc_library", false],
      ],
    );
    assert.strictEqual(model.loads.length, 1);
    assert.strictEqual(model.loads[0].module, "//tools:defs.bzl");
    assert.deepStrictEqual(
      model.loads[0].symbols.map((s) => s.local),
      ["my_rule"],
    );
    assert.strictEqual(model.errorCount, 0);
  });

  it("survives syntax errors and keeps the parseable targets", () => {
    const text = 'cc_library(name = "a"\ncc_library(name = "b")\n';
    const model = extractBuildModel("/ws/BUILD", "", text);
    assert.ok(model.errorCount > 0);
    assert.deepStrictEqual(
      model.targets.map((t) => t.name),
      ["b"],
    );
  });
});

describe("extractBzlModel", () => {
  it("classifies top-level definitions", () => {
    const text = [
      'load(":private.bzl", _impl = "impl")',
      "",
      "def helper(x, y = 2):",
      '    """Adds things."""',
      "    return x + y",
      "",
      "my_test = rule(",
      "    implementation = _impl,",
      '    doc = "Runs a test.",',
      "    test = True,",
      ")",
      "",
      "my_binary = rule(implementation = _impl, executable = True)",
      "MyInfo = provider(fields = ['a'])",
      "exported = helper",
      "VALUE = 3",
      "A, B = (1, 2)",
    ].join("\n");
    const model = extractBzlModel("/ws/defs.bzl", text);
    const kinds = [...model.definitions.values()].map((d) => [d.name, d.kind]);
    assert.deepStrictEqual(kinds, [
      ["helper", "function"],
      ["my_test", "rule"],
      ["my_binary", "rule"],
      ["MyInfo", "provider"],
      ["exported", "variable"],
      ["VALUE", "variable"],
      ["A", "variable"],
      ["B", "variable"],
    ]);
    assert.strictEqual(model.definitions.get("helper")!.doc, "Adds things.");
    assert.strictEqual(model.definitions.get("my_test")!.doc, "Runs a test.");
    assert.strictEqual(model.loads[0].symbols[0].local, "_impl");
    assert.strictEqual(model.loads[0].symbols[0].original, "impl");
  });
});

describe("extractModuleModel", () => {
  it("collects repository names visible from MODULE.bazel", () => {
    const text = [
      'module(name = "me")',
      'bazel_dep(name = "rules_python", version = "1.0")',
      'bazel_dep(name = "skylib", version = "1.0", repo_name = "bazel_skylib")',
      'ext = use_extension("//:ext.bzl", "ext")',
      'use_repo(ext, "hub", py = "python_3_11")',
    ].join("\n");
    const model = extractModuleModel("/ws/MODULE.bazel", text);
    assert.deepStrictEqual(model.repoNames, [
      "bazel_skylib",
      "hub",
      "me",
      "py",
      "rules_python",
    ]);
    assert.deepStrictEqual(model.selfNames, ["me"]);
  });

  it("records the names a repository gives itself", () => {
    const module = extractModuleModel(
      "/ws/MODULE.bazel",
      'module(name = "rules_x", repo_name = "x")',
    );
    assert.deepStrictEqual(module.selfNames, ["rules_x", "x"]);
    const workspace = extractModuleModel(
      "/ws/WORKSPACE",
      'workspace(name = "legacy")\nhttp_archive(name = "dep")',
    );
    assert.deepStrictEqual(workspace.selfNames, ["legacy"]);
    assert.deepStrictEqual(workspace.repoNames, ["dep", "legacy"]);
  });
});
