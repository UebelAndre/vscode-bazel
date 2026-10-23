import * as assert from "assert";
import * as vscode from "vscode";
import { openFixture, readyIndex } from "./index_test_helpers";

describe("Starlark language features", function (this: Mocha.Suite) {
  this.timeout(20000);

  before(async () => {
    await readyIndex();
  });

  afterEach(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
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
});
