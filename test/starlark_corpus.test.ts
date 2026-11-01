import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { parseModule } from "../src/starlark";

/**
 * The test directory, found both in Bazel's runfiles (data files are copied
 * next to the compiled tests) and in the VS Code test layout (dist/test).
 */
function findTestDir(): string {
  for (const dir of [__dirname, path.join(__dirname, "..", "..", "test")]) {
    if (fs.existsSync(path.join(dir, "starlark_corpus"))) {
      return dir;
    }
  }
  throw new Error(`test directory not found near ${__dirname}`);
}

/**
 * One case of the spec corpus. The corpus was written from the Starlark spec
 * and cross-checked against starlark-rust, so its verdicts are the spec's:
 * `error` cases must be rejected, `clean` cases must parse without errors.
 * `accepted` marks input the spec rejects but this parser deliberately
 * tolerates; Bazel reports those errors itself, and an editor is more useful
 * with a tree than without one.
 */
interface CorpusCase {
  file: string;
  title: string;
  input: string;
  expect: "clean" | "error" | "accepted";
}

/**
 * Reads the fixtures: a case is a title between two rule lines, optionally
 * followed by `:error` or `:accepted`, then the input up to the next rule.
 */
function readCorpus(dir: string): CorpusCase[] {
  const cases: CorpusCase[] = [];
  const isRule = (line: string) => /^=+$/.test(line);
  for (const file of fs.readdirSync(dir).sort()) {
    const lines = fs.readFileSync(path.join(dir, file), "utf8").split("\n");
    let i = 0;
    while (i < lines.length) {
      if (!isRule(lines[i])) {
        i++;
        continue;
      }
      const title = lines[++i];
      let expect: CorpusCase["expect"] = "clean";
      while (lines[++i].startsWith(":")) {
        if (lines[i] === ":error") {
          expect = "error";
        } else if (lines[i] === ":accepted") {
          expect = "accepted";
        } else {
          throw new Error(`${file}: unknown attribute ${lines[i]}`);
        }
      }
      assert.ok(isRule(lines[i]), `${file}: malformed header for ${title}`);
      const start = ++i;
      while (i < lines.length && !isRule(lines[i])) {
        i++;
      }
      const input = lines.slice(start, i).join("\n").trim() + "\n";
      cases.push({ file, title, input, expect });
    }
  }
  return cases;
}

describe("Starlark parser against the spec corpus", () => {
  const cases = readCorpus(path.join(findTestDir(), "starlark_corpus"));

  it("finds the corpus", () => {
    assert.ok(cases.length >= 60, `only ${cases.length} cases`);
  });

  for (const c of cases) {
    it(`${c.file}: ${c.title}`, () => {
      const module = parseModule(c.input);
      const found = module.errors
        .map((e) => `${e.message} at offset ${e.start}`)
        .join("; ");
      if (c.expect === "error") {
        assert.ok(module.errors.length > 0, "expected a syntax error");
      } else {
        assert.strictEqual(found, "", `unexpected syntax error: ${found}`);
      }
      // Recovery never drops the whole module.
      assert.ok(Array.isArray(module.stmts));
    });
  }
});

describe("Starlark parser on the fixture workspace", () => {
  it("parses every Starlark file without errors", () => {
    const root = path.join(findTestDir(), "bazel_workspace");
    const isStarlark = (name: string) =>
      /\.(bzl|bazel|star)$/.test(name) ||
      /^(BUILD|WORKSPACE|MODULE\.bazel|WORKSPACE\.bzlmod)$/.test(name);
    const failures: string[] = [];
    let files = 0;
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith("bazel-")) {
          continue;
        }
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p);
        } else if (entry.isFile() && isStarlark(entry.name)) {
          files++;
          const module = parseModule(fs.readFileSync(p, "utf8"));
          for (const e of module.errors) {
            failures.push(`${path.relative(root, p)}: ${e.message}`);
          }
        }
      }
    };
    walk(root);
    assert.ok(files > 0, `no Starlark files found under ${root}`);
    assert.deepStrictEqual(failures, []);
  });
});
