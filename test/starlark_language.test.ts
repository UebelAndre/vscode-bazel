import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import { parseLabel } from "../src/index";
import {
  completionItemsAt,
  fixtureWorkspacePath,
  openFixture,
  positionOf,
  readyIndex,
} from "./index_test_helpers";

async function definitionsAt(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<{ file: string; line: number }[]> {
  const result = await vscode.commands.executeCommand<
    (vscode.Location | vscode.LocationLink)[]
  >("vscode.executeDefinitionProvider", document.uri, position);
  return result.map((item) =>
    "targetUri" in item
      ? { file: item.targetUri.fsPath, line: item.targetRange.start.line }
      : { file: item.uri.fsPath, line: item.range.start.line },
  );
}

function fixture(...segments: string[]) {
  return path.join(fixtureWorkspacePath, ...segments);
}

describe("parseLabel", () => {
  it("parses absolute labels", () => {
    assert.deepStrictEqual(parseLabel("//pkg:target", "cur"), {
      repo: undefined,
      canonical: false,
      pkg: "pkg",
      name: "target",
      absolute: true,
    });
  });

  it("defaults the target name to the last package component", () => {
    assert.deepStrictEqual(parseLabel("//pkg/sub", "cur")?.name, "sub");
    assert.deepStrictEqual(parseLabel("//pkg/sub", "cur")?.pkg, "pkg/sub");
  });

  it("parses external repository labels", () => {
    const label = parseLabel("@repo//pkg:target", "cur");
    assert.deepStrictEqual(label, {
      repo: "repo",
      canonical: false,
      pkg: "pkg",
      name: "target",
      absolute: true,
    });
  });

  it("parses canonical repository labels", () => {
    const label = parseLabel("@@rules_go+//go:def.bzl", "cur");
    assert.strictEqual(label?.repo, "rules_go+");
    assert.strictEqual(label?.canonical, true);
    assert.strictEqual(label?.name, "def.bzl");
  });

  it("expands a bare repository name", () => {
    assert.deepStrictEqual(parseLabel("@foo", "cur"), {
      repo: "foo",
      canonical: false,
      pkg: "",
      name: "foo",
      absolute: true,
    });
  });

  it("resolves package-relative labels against the current package", () => {
    assert.strictEqual(parseLabel(":lib", "a/b")?.pkg, "a/b");
    assert.strictEqual(parseLabel(":lib", "a/b")?.name, "lib");
    assert.strictEqual(parseLabel("sub/file.txt", "a/b")?.pkg, "a/b");
    assert.strictEqual(parseLabel("sub/file.txt", "a/b")?.name, "sub/file.txt");
    assert.strictEqual(parseLabel("sub/file.txt", "a/b")?.absolute, false);
  });

  it("parses a root-package label", () => {
    assert.strictEqual(parseLabel("//:target", "cur")?.pkg, "");
  });

  it("rejects strings that cannot be labels", () => {
    assert.strictEqual(parseLabel("not a label", "cur"), undefined);
    assert.strictEqual(parseLabel("//pkg:", "cur"), undefined);
    assert.strictEqual(parseLabel("//...", "cur"), undefined);
    assert.strictEqual(parseLabel("", "cur"), undefined);
  });
});

describe("Starlark language features", function (this: Mocha.Suite) {
  this.timeout(20000);

  before(async () => {
    await readyIndex();
  });

  afterEach(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  describe("go to definition", () => {
    it("jumps from a package label to the target", async () => {
      const document = await openFixture("pkg1", "BUILD");
      const defs = await definitionsAt(
        document,
        positionOf(document, 'deps=["//pkg1"]', 'deps=["//p'.length),
      );
      assert.deepStrictEqual(defs, [
        {
          file: fixture("pkg1", "BUILD"),
          line: positionOf(document, 'name="pkg1"', 'name="'.length).line,
        },
      ]);
    });

    it("jumps from a relative target label to the target", async () => {
      const document = await openFixture("pkg1", "BUILD");
      const defs = await definitionsAt(
        document,
        positionOf(document, '":src_files"', 2),
      );
      assert.strictEqual(defs.length, 1);
      assert.strictEqual(defs[0].file, fixture("pkg1", "BUILD"));
      assert.strictEqual(
        defs[0].line,
        positionOf(document, 'name="src_files"').line,
      );
    });

    it("jumps from a file label to the file", async () => {
      const document = await openFixture("pkg1", "BUILD");
      const defs = await definitionsAt(
        document,
        positionOf(document, '"main.py"', 2),
      );
      assert.deepStrictEqual(defs, [
        { file: fixture("pkg1", "main.py"), line: 0 },
      ]);
    });

    it("jumps from a load() module string to the .bzl file", async () => {
      const document = await openFixture("pkg3", "BUILD");
      const defs = await definitionsAt(
        document,
        positionOf(document, '":defs.bzl"', 2),
      );
      assert.deepStrictEqual(defs, [
        { file: fixture("pkg3", "defs.bzl"), line: 0 },
      ]);
    });

    it("jumps from a load() symbol to its definition", async () => {
      const document = await openFixture("pkg3", "BUILD");
      const bzl = await openFixture("pkg3", "defs.bzl");
      const defs = await definitionsAt(
        document,
        positionOf(document, '"my_macro"', 2),
      );
      assert.deepStrictEqual(defs, [
        {
          file: fixture("pkg3", "defs.bzl"),
          line: positionOf(bzl, "def my_macro(", 4).line,
        },
      ]);
    });

    it("jumps from a rule call to the rule definition", async () => {
      const document = await openFixture("pkg3", "BUILD");
      const bzl = await openFixture("pkg3", "defs.bzl");
      const defs = await definitionsAt(
        document,
        positionOf(document, 'my_test(name = "custom_test")', 2),
      );
      assert.deepStrictEqual(defs, [
        {
          file: fixture("pkg3", "defs.bzl"),
          line: positionOf(bzl, "my_test = rule(", 0).line,
        },
      ]);
    });

    it("does not resolve visibility labels", async () => {
      const document = await openFixture("pkg1", "BUILD");
      const defs = await definitionsAt(
        document,
        positionOf(document, '"//visibility:public"', 4),
      );
      assert.deepStrictEqual(defs, []);
    });
  });

  describe("hover", () => {
    it("shows the documentation of a loaded rule", async () => {
      const document = await openFixture("pkg3", "BUILD");
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        document.uri,
        positionOf(document, 'my_test(name = "custom_test")', 2),
      );
      const text = hovers
        .flatMap((h) => h.contents)
        .map((c) => (typeof c === "string" ? c : c.value))
        .join("\n");
      assert.ok(
        text.includes("A test rule used by the extension's tests."),
        `unexpected hover: ${text}`,
      );
    });
  });

  describe("document symbols", () => {
    it("lists the targets of a BUILD file", async () => {
      const document = await openFixture("pkg1", "BUILD");
      const symbols = await vscode.commands.executeCommand<
        vscode.DocumentSymbol[]
      >("vscode.executeDocumentSymbolProvider", document.uri);
      assert.deepStrictEqual(
        symbols.map((s) => s.name),
        ["pkg1", "src_files", "main", "foo"],
      );
      assert.strictEqual(symbols[2].detail, "py_binary");
    });

    it("lists the definitions of a .bzl file", async () => {
      const document = await openFixture("pkg3", "defs.bzl");
      const symbols = await vscode.commands.executeCommand<
        vscode.DocumentSymbol[]
      >("vscode.executeDocumentSymbolProvider", document.uri);
      assert.deepStrictEqual(
        symbols.map((s) => s.name),
        ["_my_test_impl", "my_test", "my_macro"],
      );
      assert.strictEqual(symbols[1].detail, "rule");
    });
  });

  describe("keyword completion", () => {
    it("offers attributes of a rule defined through re-exports", async () => {
      const document = await openFixture("pkg3", "BUILD");
      const editor = await vscode.window.showTextDocument(document);
      // Inside `vendored_binary(` after the existing arguments.
      const anchor = positionOf(
        document,
        '    srcs = ["data.txt"],\n)',
        '    srcs = ["data.txt"],\n'.length,
      );
      await editor.edit((edit) => edit.insert(anchor, "    \n"));
      const items = await completionItemsAt(document, anchor.translate(0, 4));
      const labels = items.map((i) =>
        typeof i.label === "string" ? i.label : i.label.label,
      );
      for (const expected of [
        "deps",
        "edition",
        "linker_script",
        "out_binary",
        "visibility",
        "args",
      ]) {
        assert.ok(
          labels.includes(expected),
          `expected ${expected} in ${labels}`,
        );
      }
      // Already supplied and private attributes are not offered.
      assert.ok(!labels.includes("name"), "name is already set");
      assert.ok(!labels.includes("srcs"), "srcs is already set");
      assert.ok(
        !labels.includes("_process_wrapper"),
        "private attrs are hidden",
      );
      const deps = items.find((i) => i.label === "deps")!;
      assert.strictEqual(deps.detail, "label_list");
      assert.ok(
        (deps.documentation as vscode.MarkdownString).value.includes(
          "List of other libraries to be linked to this library target.",
        ),
      );
      assert.strictEqual(
        (deps.insertText as vscode.SnippetString).value,
        "deps = $0",
      );
    });

    it("offers struct fields after a dot", async () => {
      const document = await openFixture("pkg3", "vendored_rules.bzl");
      const editor = await vscode.window.showTextDocument(document);
      const end = document.lineAt(document.lineCount - 1).range.end;
      await editor.edit((edit) => edit.insert(end, "\nx = vendored_common."));
      const items = await completionItemsAt(
        document,
        document.lineAt(document.lineCount - 1).range.end,
      );
      const labels = items.map((i) =>
        typeof i.label === "string" ? i.label : i.label.label,
      );
      assert.deepStrictEqual(labels, [
        "crate_info",
        "create_crate_info",
        "default_version",
      ]);
      assert.strictEqual(
        items.find((i) => i.label === "create_crate_info")!.kind,
        vscode.CompletionItemKind.Function,
      );
    });

    it("offers provider fields across re-exports", async () => {
      const document = await openFixture("pkg3", "vendored_defs.bzl");
      const editor = await vscode.window.showTextDocument(document);
      const end = document.lineAt(document.lineCount - 1).range.end;
      await editor.edit((edit) => edit.insert(end, "\nx = VendoredInfo."));
      const items = await completionItemsAt(
        document,
        document.lineAt(document.lineCount - 1).range.end,
      );
      const labels = items.map((i) =>
        typeof i.label === "string" ? i.label : i.label.label,
      );
      assert.deepStrictEqual(labels, ["aliases", "name", "root"]);
    });

    it("offers .bzl files and exported symbols inside load()", async () => {
      const document = await openFixture("pkg3", "BUILD");
      const editor = await vscode.window.showTextDocument(document);
      const end = document.lineAt(document.lineCount - 1).range.end;
      await editor.edit((edit) => edit.insert(end, '\nload(":'));
      let position = document.lineAt(document.lineCount - 1).range.end;
      let items = await completionItemsAt(document, position);
      let labels = items.map((i) =>
        typeof i.label === "string" ? i.label : i.label.label,
      );
      assert.ok(labels.includes("defs.bzl"), `expected defs.bzl in ${labels}`);
      assert.ok(!labels.includes("data.txt"), "only .bzl files are offered");
      assert.ok(!labels.includes("custom_test"), "no targets in load()");

      await editor.edit((edit) => edit.insert(position, 'defs.bzl", "my_'));
      position = document.lineAt(document.lineCount - 1).range.end;
      items = await completionItemsAt(document, position);
      labels = items.map((i) =>
        typeof i.label === "string" ? i.label : i.label.label,
      );
      assert.deepStrictEqual(labels.sort(), ["my_macro", "my_test"]);
    });

    it("shows signature help for a rule call", async () => {
      const document = await openFixture("pkg3", "BUILD");
      const help = await vscode.commands.executeCommand<vscode.SignatureHelp>(
        "vscode.executeSignatureHelpProvider",
        document.uri,
        positionOf(
          document,
          '    srcs = ["data.txt"],',
          '    srcs = ["'.length,
        ),
      );
      assert.ok(help, "expected signature help");
      const signature = help.signatures[help.activeSignature];
      assert.ok(
        signature.label.startsWith("vendored_binary("),
        signature.label,
      );
      const parameters = signature.parameters.map((p) =>
        typeof p.label === "string"
          ? p.label
          : signature.label.slice(p.label[0], p.label[1]),
      );
      assert.strictEqual(parameters[help.activeParameter], "srcs");
      assert.ok(
        (signature.documentation as vscode.MarkdownString).value.includes(
          "Builds a vendored binary crate.",
        ),
      );
    });
  });

  describe("code lenses", () => {
    it("offers Test for a custom rule declared with test = True", async () => {
      const document = await openFixture("pkg3", "BUILD");
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
        "vscode.executeCodeLensProvider",
        document.uri,
      );
      const testLine = positionOf(
        document,
        'my_test(name = "custom_test")',
      ).line;
      const titles = lenses
        .filter((l) => l.range.start.line === testLine)
        .map((l) => l.command?.title);
      assert.ok(titles.includes("Test"), `lenses: ${titles}`);
      const macroLine = positionOf(document, "my_macro(").line;
      const macroTitles = lenses
        .filter((l) => l.range.start.line === macroLine)
        .map((l) => l.command?.title);
      // A macro's definition says nothing about executability, so "Run" is
      // offered as for any rule that is not a library.
      assert.deepStrictEqual(macroTitles, ["Copy", "Build", "Run"]);
    });
  });
});
