// Integration tests that put a real Bazel in the loop. They run under plain
// node with a stub of the VS Code API (see hook_vscode.js), copy the fixture
// workspace to a temporary directory, and use a private output base so that
// "not fetched yet" is deterministic. Nothing here needs a display.
import * as assert from "assert";
import * as child_process from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { BazelQuery } from "../../src/bazel/bazel_query";
import { QueryLocation } from "../../src/bazel/query_location";
import { ILogger } from "../../src/extension/logger";
import { IndexManager, WorkspaceIndex } from "../../src/index";
import { blaze_query } from "../../src/protos";

interface StubHooks {
  setWorkspaceFolders(folders: string[]): void;
  setConfig(key: string, value: unknown): void;
  clearConfig(): void;
  /** Messages the extension tried to show the user. */
  messages: { level: string; message: string }[];
}
const stub = (vscode as unknown as { __stub: StubHooks }).__stub;

const logger: ILogger = {
  logDebug: () => undefined,
  logInfo: () => undefined,
  logWarn: (message, _show, ...args) =>
    process.stderr.write(`[warn] ${message} ${args.join(" ")}\n`),
  logError: (message, _show, ...args) =>
    process.stderr.write(`[error] ${message} ${args.join(" ")}\n`),
};

/**
 * Finds a Bazel launcher that honors the fixture's `.bazelversion`.
 *
 * When this suite itself runs under `bazel test`, bazelisk puts the outer
 * build's Bazel binary first on PATH; using it would ignore the fixture's
 * pinned version. Prefer `bazelisk`, then any `bazel` that is not one of
 * bazelisk's downloaded binaries.
 */
function findBazel(): string {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const name of ["bazelisk", "bazel"]) {
    for (const dir of dirs) {
      if (!dir || /bazelisk[/\\]downloads/.test(dir)) {
        continue;
      }
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return "bazel";
}
const bazelExecutable = findBazel();

/** Locates the checked-in fixture from either the Bazel or the npm layout. */
function fixtureSource(): string {
  const candidates = [
    path.join(__dirname, "..", "bazel_workspace"),
    path.join(__dirname, "..", "..", "..", "test", "bazel_workspace"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "MODULE.bazel"))) {
      return candidate;
    }
  }
  throw new Error(`fixture workspace not found near ${__dirname}`);
}

function copyFixture(destination: string) {
  fs.cpSync(fixtureSource(), destination, {
    recursive: true,
    dereference: false,
    filter: (source) => {
      const name = path.basename(source);
      return !name.startsWith("bazel-") && name !== ".vscode";
    },
  });
}

function attribute(rule: blaze_query.IRule, name: string): string | undefined {
  return rule.attribute?.find((a) => a.name === name)?.stringValue ?? undefined;
}

function splitLabel(label: string): { pkg: string; name: string } {
  const local = label.replace(/^@@?\/\//, "//");
  const colon = local.lastIndexOf(":");
  return { pkg: local.slice(2, colon), name: local.slice(colon + 1) };
}

describe("index with Bazel in the loop", function (this: Mocha.Suite) {
  this.timeout(15 * 60 * 1000);

  let tmp: string;
  let workspace: string;
  let outputBase: string;
  let manager: IndexManager;
  let index: WorkspaceIndex;

  const runBazel = (args: string[]) =>
    child_process.execFileSync(
      bazelExecutable,
      [`--output_base=${outputBase}`, ...args],
      { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] },
    );

  before(async () => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "vscode-bazel-integration-")),
    );
    workspace = path.join(tmp, "bazel_workspace");
    outputBase = path.join(tmp, "output_base");
    copyFixture(workspace);

    stub.setWorkspaceFolders([workspace]);
    stub.setConfig("bazel.executable", bazelExecutable);
    stub.setConfig("bazel.commandLine.startupOptions", [
      `--output_base=${outputBase}`,
    ]);

    manager = new IndexManager(logger);
    const found = manager.getIndex(workspace);
    if (!found) {
      throw new Error(`no index was created for ${workspace}`);
    }
    index = found;
    await index.ready;
  });

  after(() => {
    manager?.dispose();
    stub.clearConfig();
    try {
      runBazel(["shutdown"]);
    } catch {
      // The server may not have started.
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("indexes the fixture without invoking Bazel", () => {
    assert.ok(index.packageCount > 0, "expected packages");
    assert.ok(
      !fs.existsSync(outputBase),
      "indexing must not start a Bazel server",
    );
  });

  it("treats a module under an ignored directory as its own root", async () => {
    assert.strictEqual(index.getPackage("ignored"), undefined);
    const innerBuild = path.join(workspace, "ignored", "BUILD");
    const inner = manager.getIndexForPath(innerBuild);
    assert.ok(inner, "expected a derived index");
    assert.notStrictEqual(inner, index);
    assert.strictEqual(inner.root, path.join(workspace, "ignored"));
    await inner.ready;
    assert.deepStrictEqual(inner.getPackages(), [""]);
    assert.ok(inner.findTarget("", "inner"));
    const ctx = await manager.labels.contextFor(innerBuild);
    assert.strictEqual(ctx?.repoRoot, inner.root);
    assert.strictEqual(ctx?.pkg, "");
  });

  it("agrees with bazel query on named targets and locations", async () => {
    let result: blaze_query.QueryResult;
    try {
      result = await new BazelQuery(bazelExecutable, workspace).queryTargets(
        "kind(rule, //...)",
        { ruleAttributes: ["generator_name", "generator_function"] },
      );
    } catch (err) {
      // BazelQuery reports failures through the UI, which the stub swallows;
      // rerun the query directly to surface Bazel's stderr.
      const rerun = child_process.spawnSync(
        bazelExecutable,
        [
          `--output_base=${outputBase}`,
          "query",
          "kind(rule, //...)",
          "--output=label_kind",
        ],
        { cwd: workspace, encoding: "utf8" },
      );
      throw new Error(
        `bazel query failed (${String(err)}); rerun exited ${rerun.status}:` +
          `
${rerun.stderr}
${rerun.stdout.slice(-2000)}`,
      );
    }
    assert.ok(result.target.length > 0, "query returned no rules");

    // Bazel's view: targets written by hand (or the primary target of a
    // macro, whose generator_name equals its own name) versus targets a
    // macro created under a different name.
    const expectedNamed = new Map<string, Map<string, blaze_query.IRule>>();
    const expectedGenerated = new Map<string, Set<string>>();
    for (const target of result.target) {
      const rule = target.rule;
      if (!rule?.name) {
        continue;
      }
      const { pkg, name } = splitLabel(rule.name);
      const generatorFunction = attribute(rule, "generator_function");
      const generatorName = attribute(rule, "generator_name");
      if (!generatorFunction || generatorName === name) {
        let byName = expectedNamed.get(pkg);
        if (!byName) {
          byName = new Map();
          expectedNamed.set(pkg, byName);
        }
        byName.set(name, rule);
      } else {
        let names = expectedGenerated.get(pkg);
        if (!names) {
          names = new Set();
          expectedGenerated.set(pkg, names);
        }
        names.add(name);
      }
    }

    const packages = new Set([...expectedNamed.keys(), ...index.getPackages()]);
    for (const pkg of [...packages].sort()) {
      const parsed = index.getPackage(pkg)?.model.targets ?? [];
      const expected = expectedNamed.get(pkg) ?? new Map();
      assert.deepStrictEqual(
        parsed.map((t) => t.name).sort(),
        [...expected.keys()].sort(),
        `named targets of //${pkg} differ from bazel query`,
      );
      for (const target of parsed) {
        const rule = expected.get(target.name)!;
        const location = new QueryLocation(rule.location!);
        assert.strictEqual(
          fs.realpathSync(location.path),
          fs.realpathSync(target.file),
          `file of ${target.label}`,
        );
        assert.strictEqual(
          location.line,
          target.range.start.line + 1,
          `line of ${target.label}`,
        );
        // Generated targets must never masquerade as parsed ones.
        assert.ok(
          !expectedGenerated.get(pkg)?.has(target.name),
          `${target.label} is macro-generated but was parsed as named`,
        );
      }
    }

    // The fixture must actually exercise the macro case.
    assert.ok(
      expectedGenerated.get("pkg3")?.has("data_gen"),
      "fixture should contain a macro-generated target",
    );
  });
});
