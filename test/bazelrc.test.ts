import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { configNameAt } from "../src/bazelrc/bazelrc_definition_provider";
import {
  configNames,
  contextAt,
  logicalLineAt,
  resolveImportPath,
} from "../src/bazelrc/bazelrc_document";
import {
  FlagIndex,
  docToMarkdown,
  selectCatalogue,
} from "../src/bazelrc/flag_index";
import {
  FlagCollection,
  FlagInfo,
  decodeFlagCollection,
} from "../src/bazelrc/flags_proto";

/** Minimal protobuf writer, enough to round-trip the decoder. */
function varint(n: number): Buffer {
  const bytes: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) {
      byte += 128;
    }
    bytes.push(byte);
  } while (n > 0);
  return Buffer.from(bytes);
}
function field(fieldNumber: number, value: string | number | Buffer): Buffer {
  if (typeof value === "number") {
    return Buffer.concat([varint(fieldNumber * 8), varint(value)]);
  }
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return Buffer.concat([
    varint(fieldNumber * 8 + 2),
    varint(bytes.length),
    bytes,
  ]);
}

describe("decodeFlagCollection", () => {
  it("decodes the fields of bazel help flags-as-proto", () => {
    const flag = Buffer.concat([
      field(1, "keep_going"),
      field(2, 1),
      field(3, "Continue as <code>much</code> as possible."),
      field(4, "build"),
      field(4, "test"),
      field(5, "k"),
      field(6, 0),
      field(7, "EXECUTION"),
      field(8, "EXPERIMENTAL"),
      field(9, "EXECUTION_STRATEGY"),
      field(10, 0),
      field(13, "false"),
      field(15, "Boolean"),
      field(16, "yes"),
      field(16, "no"),
      field(99, "future field"),
    ]);
    const collection = Buffer.concat([
      field(1, flag),
      field(1, field(1, "jobs")),
    ]);
    const flags = decodeFlagCollection(collection.toString("base64"));
    assert.strictEqual(flags.length, 2);
    const [keepGoing, jobs] = flags;
    assert.deepStrictEqual(keepGoing, {
      name: "keep_going",
      negatable: true,
      doc: "Continue as <code>much</code> as possible.",
      commands: ["build", "test"],
      abbreviation: "k",
      allowsMultiple: false,
      requiresValue: false,
      metadataTags: ["EXPERIMENTAL"],
      category: "EXECUTION_STRATEGY",
      defaultValue: "false",
      type: "Boolean",
      allowedValues: ["yes", "no"],
    } as FlagInfo);
    assert.strictEqual(jobs.name, "jobs");
  });
});

describe("FlagIndex", () => {
  const collection: FlagCollection = {
    bazelVersion: "test",
    flags: [
      {
        name: "keep_going",
        negatable: true,
        doc: "",
        commands: ["build", "test"],
        abbreviation: "k",
        allowsMultiple: false,
        requiresValue: false,
      },
      {
        name: "output_base",
        negatable: false,
        doc: "",
        commands: ["startup"],
        allowsMultiple: false,
        requiresValue: true,
      },
      {
        name: "new_name",
        negatable: false,
        doc: "",
        commands: ["build"],
        allowsMultiple: false,
        requiresValue: true,
        oldName: "old_name",
      },
    ],
  };
  const index = new FlagIndex(collection);

  it("filters flags by command; common means every build-time flag", () => {
    assert.deepStrictEqual(
      index.flagsFor("test").map((f) => f.name),
      ["keep_going"],
    );
    assert.deepStrictEqual(
      index.flagsFor("startup").map((f) => f.name),
      ["output_base"],
    );
    assert.deepStrictEqual(
      index.flagsFor("common").map((f) => f.name),
      ["keep_going", "new_name"],
    );
    assert.deepStrictEqual(index.commands(), [
      "always",
      "build",
      "common",
      "startup",
      "test",
    ]);
  });

  it("finds flags by name, negation, abbreviation and old name", () => {
    assert.strictEqual(index.find("keep_going")?.name, "keep_going");
    assert.strictEqual(index.find("nokeep_going")?.name, "keep_going");
    assert.strictEqual(index.find("k")?.name, "keep_going");
    assert.strictEqual(index.find("old_name")?.name, "new_name");
    assert.strictEqual(index.find("nooutput_base"), undefined);
  });

  it("loads the shipped catalogues of every LTS line", () => {
    const dirs = [
      path.join(__dirname, "..", "..", "data"),
      path.join(__dirname, "..", "data"),
      ...(process.env.VSCODE_BAZEL_REPO_ROOT
        ? [path.join(process.env.VSCODE_BAZEL_REPO_ROOT, "data")]
        : []),
    ];
    const dir = dirs.find((d) =>
      fs.existsSync(path.join(d, "bazelrc_flags-8.json")),
    );
    assert.ok(dir, `catalogues not found near ${__dirname}`);
    for (const major of ["7", "8", "9"]) {
      const file = path.join(dir, `bazelrc_flags-${major}.json`);
      const shippedLine = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.ok(
        shippedLine.bazelVersion.startsWith(`${major}.`),
        shippedLine.bazelVersion,
      );
      assert.ok(shippedLine.flags.length > 500, `${file} is too small`);
    }
    const shipped = new FlagIndex(
      JSON.parse(
        fs.readFileSync(path.join(dir, "bazelrc_flags-8.json"), "utf8"),
      ),
    );
    const keepGoing = shipped.find("keep_going")!;
    assert.strictEqual(keepGoing.abbreviation, "k");
    assert.ok(keepGoing.commands.includes("build"));
    assert.ok(
      shipped
        .find("test_output")!
        .allowedValues!.map((v) => v.toLowerCase())
        .includes("errors"),
    );
    assert.ok(
      shipped.flagsFor("startup").some((f) => f.name === "output_base"),
    );
  });
});

describe("selectCatalogue", () => {
  const shipped = [
    { file: "7.json", version: "7.7.1" },
    { file: "8.json", version: "8.8.1" },
    { file: "9.json", version: "9.3.0" },
  ];
  it("matches the LTS line of the wanted version", () => {
    assert.strictEqual(selectCatalogue("8.3.1", shipped)?.file, "8.json");
    assert.strictEqual(selectCatalogue("7.x", shipped)?.file, "7.json");
    assert.strictEqual(selectCatalogue("9.0.0rc2", shipped)?.file, "9.json");
  });
  it("prefers the nearest catalogue that is not newer than wanted", () => {
    const all = [...shipped, { file: "exact.json", version: "8.3.1" }];
    assert.strictEqual(selectCatalogue("8.3.1", all)?.file, "exact.json");
    assert.strictEqual(selectCatalogue("8.4.0", all)?.file, "exact.json");
    // A refreshed older catalogue must not shadow a newer shipped one.
    assert.strictEqual(selectCatalogue("8.8.1", all)?.file, "8.json");
    assert.strictEqual(selectCatalogue("8.9.0", all)?.file, "8.json");
  });
  it("falls back sensibly for unknown versions", () => {
    assert.strictEqual(selectCatalogue("rolling", shipped)?.file, "9.json");
    assert.strictEqual(selectCatalogue(undefined, shipped)?.file, "9.json");
    assert.strictEqual(selectCatalogue("12.0.0", shipped)?.file, "9.json");
    assert.strictEqual(selectCatalogue("6.5.0", shipped)?.file, "9.json");
    assert.strictEqual(selectCatalogue("8", []), undefined);
  });
});

describe("bazelrc line analysis", () => {
  it("classifies the cursor position", () => {
    assert.deepStrictEqual(contextAt("bui"), {
      kind: "command",
      prefix: "bui",
    });
    assert.deepStrictEqual(contextAt("build:c"), {
      kind: "config",
      command: "build",
      prefix: "c",
    });
    assert.deepStrictEqual(contextAt("build --keep"), {
      kind: "flag",
      command: "build",
      prefix: "keep",
    });
    assert.deepStrictEqual(contextAt("build:ci --jobs=8 -"), {
      kind: "flag",
      command: "build",
      prefix: "",
    });
    assert.deepStrictEqual(contextAt("test --test_output=err"), {
      kind: "value",
      command: "test",
      flag: "test_output",
      prefix: "err",
      separator: "=",
    });
    assert.deepStrictEqual(contextAt("build --config=c"), {
      kind: "value",
      command: "build",
      flag: "config",
      prefix: "c",
      separator: "=",
    });
    assert.deepStrictEqual(contextAt("build --jobs 1"), {
      kind: "value",
      command: "build",
      flag: "jobs",
      prefix: "1",
      separator: " ",
    });
    assert.deepStrictEqual(contextAt("try-import %workspace%/us"), {
      kind: "import",
      prefix: "%workspace%/us",
    });
  });

  it("collects config names and joins continued lines", () => {
    const text = [
      "build:ci --keep_going",
      "test:ci --test_output=errors # comment",
      "common --announce_rc \\",
      "  --color=yes",
      "build --disk_cache=/tmp",
    ].join("\n");
    assert.deepStrictEqual([...configNames(text)], ["ci"]);
    const lines = text.split("\n");
    const joined = logicalLineAt(lines, 3);
    assert.strictEqual(joined.startLine, 2);
    assert.strictEqual(
      joined.text.replace(/\s+/g, " "),
      "common --announce_rc --color=yes",
    );
    assert.deepStrictEqual(
      logicalLineAt(lines, 4).text,
      "build --disk_cache=/tmp",
    );
  });
});

describe("bazelrc navigation helpers", () => {
  it("finds the config name under the cursor", () => {
    const line = "build:ci --config=shared --jobs=4";
    assert.strictEqual(configNameAt(line, 7), "ci");
    assert.strictEqual(configNameAt(line, 20), "shared");
    assert.strictEqual(configNameAt(line, 30), undefined);
    assert.strictEqual(configNameAt("build --keep_going", 3), undefined);
  });

  it("resolves import paths relative to the rc file or the workspace", () => {
    assert.strictEqual(
      resolveImportPath("%workspace%/tools/x.bazelrc", "/ws/.bazelrc", "/ws"),
      path.join("/ws", "tools", "x.bazelrc"),
    );
    assert.strictEqual(
      resolveImportPath("user.bazelrc", "/ws/sub/.bazelrc", "/ws"),
      path.join("/ws", "sub", "user.bazelrc"),
    );
    assert.strictEqual(
      resolveImportPath("%workspace%/x", "/elsewhere/.bazelrc", undefined),
      undefined,
    );
  });
});

describe("docToMarkdown", () => {
  it("rewrites the HTML Bazel uses in flag docs", () => {
    assert.strictEqual(
      docToMarkdown(
        "Use <code>--foo</code>.<br>" +
          'See <a href="https://x">docs</a>.' +
          "<ul><li>a</li><li>b</li></ul>&lt;x&gt;",
      ),
      "Use `--foo`.\nSee [docs](https://x).\n- a\n- b<x>",
    );
  });
});
