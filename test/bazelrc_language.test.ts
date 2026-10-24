import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import {
  completionLabelsAt,
  fixtureWorkspacePath,
  openFixture,
  positionOf,
} from "./index_test_helpers";

describe(".bazelrc language features", function (this: Mocha.Suite) {
  this.timeout(20000);

  afterEach(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("completes flags of the line's command", async () => {
    const document = await openFixture(".bazelrc");
    assert.strictEqual(document.languageId, "bazelrc");
    const labels = await completionLabelsAt(
      document,
      positionOf(document, "build:ci --keep_going", "build:ci --".length),
    );
    assert.ok(
      labels.includes("--keep_going"),
      `expected --keep_going in ${labels.length} items`,
    );
    assert.ok(labels.includes("--nokeep_going"), "negated form offered");
    assert.ok(
      !labels.includes("--output_base"),
      "startup flags are not build flags",
    );
  });

  it("completes config names and flag values", async () => {
    const document = await openFixture(".bazelrc");
    const editor = await vscode.window.showTextDocument(document);
    const end = document.lineAt(document.lineCount - 1).range.end;
    await editor.edit((edit) => edit.insert(end, "\nbuild:"));
    let position = document.lineAt(document.lineCount - 1).range.end;
    assert.deepStrictEqual(await completionLabelsAt(document, position), [
      "ci",
      "shared",
    ]);

    await editor.edit((edit) => edit.insert(position, "ci --config="));
    position = document.lineAt(document.lineCount - 1).range.end;
    assert.deepStrictEqual(await completionLabelsAt(document, position), [
      "ci",
      "shared",
    ]);

    await editor.edit((edit) => edit.insert(position, "ci --test_output="));
    position = document.lineAt(document.lineCount - 1).range.end;
    const values = await completionLabelsAt(document, position);
    assert.ok(values.includes("errors"), `expected errors in ${values}`);
  });

  it("jumps to imported rc files and config definitions", async () => {
    const document = await openFixture(".bazelrc");
    const definitionsAt = async (position: vscode.Position) =>
      (
        await vscode.commands.executeCommand<vscode.Location[]>(
          "vscode.executeDefinitionProvider",
          document.uri,
          position,
        )
      ).map((l) => ({
        file: path.relative(fixtureWorkspacePath, l.uri.fsPath),
        line: l.range.start.line,
      }));

    assert.deepStrictEqual(
      await definitionsAt(
        positionOf(document, "%workspace%/tools/shared.bazelrc", 3),
      ),
      [{ file: path.join("tools", "shared.bazelrc"), line: 0 }],
    );
    // try-import of a missing file has nowhere to go.
    assert.deepStrictEqual(
      await definitionsAt(positionOf(document, "%workspace%/user.bazelrc", 3)),
      [],
    );
    assert.deepStrictEqual(
      await definitionsAt(
        positionOf(document, "--config=ci", "--config=".length),
      ),
      [{ file: ".bazelrc", line: positionOf(document, "build:ci").line }],
    );
    assert.deepStrictEqual(
      await definitionsAt(
        positionOf(document, "--config=shared", "--config=".length),
      ),
      [{ file: path.join("tools", "shared.bazelrc"), line: 1 }],
    );
  });

  it("shows flag documentation on hover", async () => {
    const document = await openFixture(".bazelrc");
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      document.uri,
      positionOf(document, "--keep_going", 4),
    );
    const text = hovers
      .flatMap((h) => h.contents)
      .map((c) => (typeof c === "string" ? c : c.value))
      .join("\n");
    assert.ok(text.includes("--keep_going (-k)"), text);
    assert.ok(
      text.includes("Continue as much as possible after an error"),
      text,
    );
  });
});
