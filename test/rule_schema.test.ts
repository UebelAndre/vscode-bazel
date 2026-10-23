import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { extractBzlModel } from "../src/index/file_models";
import { ModuleLoader } from "../src/index/bindings";
import { parseLabel } from "../src/index/label";
import {
  CallableSchema,
  SchemaResolver,
  parseArgsSection,
} from "../src/index/rule_schema";

/** The fixture package holding the vendored rules_rust-shaped definitions. */
function fixturePackage(): string {
  const candidates = [
    path.join(__dirname, "bazel_workspace", "pkg3"),
    path.join(__dirname, "..", "..", "test", "bazel_workspace", "pkg3"),
    ...(process.env.VSCODE_BAZEL_FIXTURE_ROOT
      ? [path.join(process.env.VSCODE_BAZEL_FIXTURE_ROOT, "pkg3")]
      : []),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "vendored_rules.bzl"))) {
      return candidate;
    }
  }
  throw new Error(`fixture package not found near ${__dirname}`);
}

const PKG = fixturePackage();
const ROOT = path.dirname(PKG);
const RULES = path.join(PKG, "vendored_rules.bzl");
const DEFS = path.join(PKG, "vendored_defs.bzl");
const BUILD = path.join(PKG, "BUILD");

/** Loads `.bzl` files from the fixture on disk, resolving labels textually. */
function fixtureLoader(): ModuleLoader {
  const models = new Map<string, ReturnType<typeof extractBzlModel>>();
  return {
    resolveModule: async (label, fromFile) => {
      const pkg = path
        .relative(ROOT, path.dirname(fromFile))
        .split(path.sep)
        .join("/");
      const parsed = parseLabel(label, pkg);
      if (!parsed) {
        return undefined;
      }
      const file = path.join(ROOT, ...parsed.pkg.split("/"), parsed.name);
      return fs.existsSync(file) ? file : undefined;
    },
    getModel: (file) => {
      let model = models.get(file);
      if (!model) {
        if (!fs.existsSync(file)) {
          return undefined;
        }
        model = extractBzlModel(file, fs.readFileSync(file, "utf8"));
        models.set(file, model);
      }
      return model;
    },
  };
}

function names(schema: CallableSchema | undefined, explicitOnly = true) {
  assert.ok(schema, "expected a schema");
  return schema.attrs
    .filter((a) => !explicitOnly || !a.implicit)
    .map((a) => a.name);
}

describe("SchemaResolver", () => {
  const resolver = new SchemaResolver(fixtureLoader());

  it("evaluates a literal dict unioned with a loaded common dict", async () => {
    const schema = await resolver.schemaFor("vendored_library", RULES);
    assert.deepStrictEqual(names(schema), [
      "crate_name",
      "deps",
      "edition",
      "extra",
      "srcs",
      "stamp",
      "_process_wrapper",
      "rustc_flags",
      "disable_pipelining",
    ]);
    assert.strictEqual(schema!.kind, "rule");
    assert.strictEqual(
      schema!.doc?.split("\n")[0],
      "Builds a vendored library crate.",
    );
    const srcs = schema!.attrs.find((a) => a.name === "srcs")!;
    assert.strictEqual(srcs.type, "label_list");
    assert.strictEqual(srcs.mandatory, true);
    assert.strictEqual(
      srcs.doc,
      "List of `.rs` source files used to build the library.",
    );
  });

  it("unwraps dedent(), concatenation and .format() in docs", async () => {
    const schema = await resolver.schemaFor("vendored_library", RULES);
    const attr = (n: string) => schema!.attrs.find((a) => a.name === n)!;
    assert.ok(
      attr("rustc_flags").doc!.includes(
        "List of compiler flags passed to `rustc`.",
      ),
    );
    assert.strictEqual(
      attr("crate_name").doc,
      "Crate name to use for this target. Defaults to the target name.",
    );
    assert.strictEqual(
      attr("edition").doc,
      "The rust edition to use for this crate. Allowed: {}",
    );
  });

  it("evaluates attribute factories and constructor aliases", async () => {
    const schema = await resolver.schemaFor("vendored_library", RULES);
    const stamp = schema!.attrs.find((a) => a.name === "stamp")!;
    assert.strictEqual(stamp.type, "int");
    assert.strictEqual(
      stamp.doc,
      "Whether to encode build information into the output.",
    );
    assert.strictEqual(stamp.default, "default_value");
    const extra = schema!.attrs.find((a) => a.name === "extra")!;
    assert.strictEqual(extra.type, "string_list");
    assert.strictEqual(extra.doc, "Extra things.");
  });

  it("adds implicit attributes by rule kind", async () => {
    const library = await resolver.schemaFor("vendored_library", RULES);
    const binary = await resolver.schemaFor("vendored_binary", RULES);
    const test = await resolver.schemaFor("vendored_test", RULES);
    const implicitNames = (s: CallableSchema | undefined) =>
      s!.attrs.filter((a) => a.implicit).map((a) => a.name);
    assert.ok(implicitNames(library).includes("visibility"));
    assert.ok(!implicitNames(library).includes("args"));
    assert.ok(implicitNames(binary).includes("args"));
    assert.ok(!implicitNames(binary).includes("size"));
    assert.ok(implicitNames(test).includes("size"));
    // An explicit attribute wins over the implicit one of the same name.
    assert.strictEqual(test!.attrs.filter((a) => a.name === "env").length, 1);
    assert.strictEqual(
      test!.attrs.find((a) => a.name === "env")!.implicit,
      false,
    );
  });

  it("reads test and executable flags, evaluating constants", async () => {
    const test = await resolver.schemaFor("my_test", BUILD);
    assert.strictEqual(test?.test, true);
    const library = await resolver.schemaFor("vendored_library", RULES);
    assert.strictEqual(library?.test, false);
    assert.strictEqual(library?.executable, false);
    const binary = await resolver.schemaFor("vendored_binary", RULES);
    assert.strictEqual(binary?.executable, true);
  });

  it("follows helper functions that copy and extend a dict", async () => {
    const binary = await resolver.schemaFor(
      "vendored_binary_without_process_wrapper",
      RULES,
    );
    assert.ok(names(binary).includes("bootstrap"));
    assert.ok(names(binary).includes("linker_script"));
    assert.ok(names(binary).includes("crate_name"));
    const viaItems = await resolver.schemaFor(
      "vendored_library_without_process_wrapper",
      RULES,
    );
    assert.ok(names(viaItems).includes("bootstrap"));
    const test = await resolver.schemaFor(
      "vendored_without_process_wrapper_test",
      RULES,
    );
    assert.ok(names(test).includes("crate_root"));
    assert.ok(names(test).includes("use_libtest_harness"));
  });

  it("evaluates dict(...) wrappers and unions", async () => {
    const clippy = await resolver.schemaFor("vendored_lint_test", RULES);
    assert.deepStrictEqual(names(clippy), ["wrapperless", "targets"]);
    const prost = await resolver.schemaFor("vendored_prost_library", RULES);
    assert.deepStrictEqual(names(prost), ["compile_well_known_types"]);
  });

  it("evaluates a filtering dict comprehension", async () => {
    const schema = await resolver.schemaFor("vendored_proc_macro", RULES);
    assert.ok(!names(schema).includes("deps"));
    assert.ok(names(schema).includes("srcs"));
  });

  it("evaluates subscripts of loaded dicts in tag_class attrs", async () => {
    const schema = await resolver.schemaFor("vendored_tag", RULES);
    assert.strictEqual(schema!.kind, "tag_class");
    assert.deepStrictEqual(names(schema), [
      "cargo_lockfile",
      "manifests",
      "pinned",
    ]);
    assert.strictEqual(
      schema!.attrs.find((a) => a.name === "manifests")!.type,
      "label_list",
    );
    assert.strictEqual(
      schema!.attrs.find((a) => a.name === "pinned")!.type,
      "string_list",
    );
  });

  it("resolves re-exports from a BUILD file through defs.bzl", async () => {
    const schema = await resolver.schemaFor("vendored_binary", BUILD);
    assert.ok(schema);
    assert.strictEqual(schema.file, RULES);
    assert.ok(names(schema).includes("out_binary"));
    assert.ok(schema.attrs.some((a) => a.name === "args" && a.implicit));
  });

  it("merges macro parameters with the rule receiving **kwargs", async () => {
    const schema = await resolver.schemaFor("vendored_test_suite", DEFS);
    assert.ok(schema);
    assert.strictEqual(schema.kind, "macro");
    assert.strictEqual(schema.openEnded, false);
    assert.strictEqual(
      schema.doc,
      "Generates a test target for each source file.",
    );
    const params = schema.attrs.slice(0, 3);
    assert.deepStrictEqual(
      params.map((a) => [a.name, a.mandatory, a.default]),
      [
        ["name", true, undefined],
        ["srcs", true, undefined],
        ["shared_srcs", false, "[]"],
      ],
    );
    assert.strictEqual(
      params[1].doc,
      'All test sources, typically `glob(["tests/**/*.rs"])`.',
    );
    assert.strictEqual(
      schema.attrs.find((a) => a.name === "kwargs"),
      undefined,
    );
    const forwarded = schema.attrs.slice(3).map((a) => a.name);
    // Attributes the macro sets itself are not offered again.
    assert.ok(!forwarded.includes("tags"));
    assert.ok(forwarded.includes("crate"));
    assert.ok(forwarded.includes("size"));
  });

  it("lists struct and provider members, across re-exports", async () => {
    const members = await resolver.membersFor(["vendored_common"], DEFS);
    assert.deepStrictEqual(
      members!.map((m) => [m.name, m.callable]),
      [
        ["crate_info", false],
        ["create_crate_info", true],
        ["default_version", false],
      ],
    );
    const fields = await resolver.membersFor(["VendoredInfo"], DEFS);
    assert.deepStrictEqual(
      fields!.map((m) => m.name),
      ["aliases", "name", "root"],
    );
    assert.strictEqual(
      fields![1].doc,
      "str: The name of this crate, which may differ from the target name.",
    );
    // Nested: a struct field that names a provider.
    const nested = await resolver.membersFor(
      ["vendored_common", "crate_info"],
      DEFS,
    );
    assert.deepStrictEqual(
      nested!.map((m) => m.name),
      ["aliases", "name", "root"],
    );
  });

  describe("rules_cc shapes", () => {
    const CC = path.join(PKG, "vendored_cc.bzl");

    it("follows a **attrs wrapper through a proxy to the rule", async () => {
      const schema = await resolver.schemaFor("vendored_cc_binary", CC);
      assert.ok(schema);
      assert.strictEqual(schema.kind, "macro");
      assert.strictEqual(schema.openEnded, false);
      assert.strictEqual(schema.executable, true);
      assert.strictEqual(schema.doc, "Produces a vendored binary.");
      const attrs = names(schema);
      // From the literal dict, the semantics struct, the helper call, the
      // top-level `.update()` and the rule's own union, respectively.
      for (const expected of [
        "srcs",
        "allowlisted_extra",
        "postmark_enabled",
        "dynamic_deps",
        "_impl_delegate",
        "deps",
        "stamp",
      ]) {
        assert.ok(attrs.includes(expected), `expected ${expected} in ${attrs}`);
      }
    });

    it("keeps docs built from a string and a struct field", async () => {
      const schema = await resolver.schemaFor("vendored_cc_binary", CC);
      const stamp = schema!.attrs.find((a) => a.name === "stamp")!;
      assert.strictEqual(
        stamp.doc,
        "Whether to encode build information into the binary.\n" +
          " Extra documentation appended by semantics.",
      );
      const extra = schema!.attrs.find((a) => a.name === "allowlisted_extra")!;
      assert.strictEqual(extra.doc, "Comes from the semantics struct.");
    });

    it("inherits the test flag through a **kwargs wrapper", async () => {
      const schema = await resolver.schemaFor("vendored_cc_test", CC);
      assert.strictEqual(schema?.kind, "macro");
      assert.strictEqual(schema?.test, true);
      assert.ok(schema!.attrs.some((a) => a.name === "size" && a.implicit));
    });

    it("interprets a *args union helper exposed on a struct", async () => {
      const schema = await resolver.schemaFor("vendored_objc_library", CC);
      assert.ok(schema);
      // Reached through `rule(**KWARGS)`; `enable_modules` is behind a
      // semantics flag that is on, `module_map` behind one that is off.
      assert.deepStrictEqual(names(schema), [
        "data",
        "copts",
        "defines",
        "enable_modules",
        "conlyopts",
        "licenses",
      ]);
      assert.strictEqual(
        schema.doc,
        "Produces a vendored Objective-C library.",
      );
    });

    it("applies keyword and call forms of .update() to a copy", async () => {
      const schema = await resolver.schemaFor("vendored_cc_test", CC);
      const attrs = names(schema);
      for (const expected of [
        "linkstatic",
        "_is_test",
        "licenses",
        "srcs",
        "dynamic_deps",
      ]) {
        assert.ok(attrs.includes(expected), `expected ${expected} in ${attrs}`);
      }
      // The copy must not leak back into cc_binary_attrs.
      const binary = await resolver.schemaFor("vendored_cc_binary", CC);
      assert.ok(!names(binary).includes("linkstatic"));
      // A ternary attribute keeps the first branch's type.
      const licenses = schema!.attrs.find((a) => a.name === "licenses")!;
      assert.strictEqual(licenses.type, "license");
    });

    it("binds providers declared with tuple unpacking", async () => {
      const members = await resolver.membersFor(
        ["VendoredCcInfo"],
        path.join(PKG, "vendored_cc_rules.bzl"),
      );
      assert.deepStrictEqual(
        members!.map((m) => m.name),
        ["compilation_context", "linking_context"],
      );
    });

    it("evaluates a plain alias through the proxy", async () => {
      const schema = await resolver.schemaFor("vendored_cc_library", CC);
      assert.strictEqual(schema?.kind, "rule");
      assert.deepStrictEqual(names(schema), [
        "srcs",
        "hdrs",
        "_semantics_tool",
        "allowlisted_extra",
        "alwayslink",
      ]);
    });

    it("lists struct members including functions", async () => {
      const members = await resolver.membersFor(
        ["semantics"],
        path.join(PKG, "vendored_cc_attrs.bzl"),
      );
      assert.deepStrictEqual(
        members!.map((m) => [m.name, m.callable]),
        [
          ["allowlist_attrs", false],
          ["stamp_extra_docs", false],
          ["get_stl", true],
          ["get_licenses_attr", true],
          ["ALLOWED_RULES_IN_DEPS", false],
          ["is_enable_modules_attr_allowed", false],
          ["is_module_map_attr_allowed", false],
        ],
      );
    });
  });

  it("returns nothing for names it cannot resolve", async () => {
    assert.strictEqual(
      await resolver.schemaFor("cc_library", BUILD),
      undefined,
    );
    assert.strictEqual(await resolver.membersFor(["nope"], DEFS), undefined);
  });
});

describe("parseArgsSection", () => {
  it("parses Google-style Args sections with continuation lines", () => {
    const doc = [
      "Summary line.",
      "",
      "Args:",
      "    name: The name.",
      "    srcs (list): Sources, continued",
      "        on the next line.",
      "    **kwargs: Extra.",
      "",
      "Returns:",
      "    nothing: really.",
    ].join("\n");
    const args = parseArgsSection(doc);
    assert.deepStrictEqual(
      [...args.entries()],
      [
        ["name", "The name."],
        ["srcs", "Sources, continued on the next line."],
        ["kwargs", "Extra."],
      ],
    );
  });
});
