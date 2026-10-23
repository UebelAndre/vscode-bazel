import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import {
  completionLabelsAt,
  fixtureWorkspacePath,
  openFixture,
  positionOf,
  readyIndex,
} from "./index_test_helpers";

describe("StarlarkCompletionProvider", function (this: Mocha.Suite) {
  this.timeout(20000);

  before(async () => {
    await readyIndex();
  });

  afterEach(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.workspace
      .getConfiguration("bazel.workspace")
      .update("path", undefined, vscode.ConfigurationTarget.Workspace);
  });

  it("completes targets of a package after ':'", async () => {
    const document = await openFixture("pkg1", "BUILD");
    // `deps=["//pkg1"]` — place the cursor right after the quote and type.
    const editor = await vscode.window.showTextDocument(document);
    const insertAt = positionOf(
      document,
      'deps=["//pkg1"]',
      'deps=["//pkg1'.length,
    );
    await editor.edit((edit) => edit.insert(insertAt, ":"));

    const labels = await completionLabelsAt(document, insertAt.translate(0, 1));

    assert.ok(labels.includes("main"), `expected main in ${labels}`);
    assert.ok(labels.includes("src_files"), `expected src_files in ${labels}`);
    assert.ok(labels.includes("foo"), `expected foo in ${labels}`);
  });

  it("completes sub-packages after '//'", async () => {
    const document = await openFixture("pkg1", "BUILD");
    const editor = await vscode.window.showTextDocument(document);
    const insertAt = positionOf(document, 'deps=["//pkg1"]', 'deps=["'.length);
    // Turn `//pkg1` into `//pkg2/pkg1` so the cursor sits after `//pkg2/`.
    await editor.edit((edit) => edit.insert(insertAt, "//pkg2/"));

    const labels = await completionLabelsAt(
      document,
      insertAt.translate(0, "//pkg2/".length),
    );

    assert.ok(labels.includes("sub-pkg"), `expected sub-pkg in ${labels}`);
  });

  it("completes top-level packages", async () => {
    const document = await openFixture("pkg1", "BUILD");
    const position = positionOf(
      document,
      'deps=["//pkg1"]',
      'deps=["//'.length,
    );

    const labels = await completionLabelsAt(document, position);

    for (const expected of ["pkg1", "pkg2", "pkg3", "buildifier"]) {
      assert.ok(labels.includes(expected), `expected ${expected} in ${labels}`);
    }
  });

  it("completes files of the current package for bare strings", async () => {
    const document = await openFixture("pkg1", "BUILD");
    const position = positionOf(document, 'srcs=["main.py"]', 'srcs=["'.length);

    const labels = await completionLabelsAt(document, position);

    assert.ok(labels.includes("main.py"), `expected main.py in ${labels}`);
    assert.ok(labels.includes("subfolder"), `expected subfolder in ${labels}`);
    // Targets of the package are offered too (inserted as `:name`).
    assert.ok(labels.includes("src_files"), `expected src_files in ${labels}`);
  });

  it("uses the pinned root in a nested module", async () => {
    await vscode.workspace
      .getConfiguration("bazel.workspace")
      .update(
        "path",
        fixtureWorkspacePath,
        vscode.ConfigurationTarget.Workspace,
      );
    const index = await readyIndex();
    assert.strictEqual(index.root, fixtureWorkspacePath);

    const document = await openFixture("nested_module", "BUILD");
    const editor = await vscode.window.showTextDocument(document);
    await editor.edit((edit) =>
      edit.insert(
        new vscode.Position(0, 0),
        'filegroup(name = "x", srcs = ["//pkg1:"])\n',
      ),
    );
    const position = positionOf(document, '"//pkg1:"', '"//pkg1:'.length);

    const labels = await completionLabelsAt(document, position);

    assert.ok(labels.includes("main"), `expected main in ${labels}`);
    assert.strictEqual(
      path.relative(fixtureWorkspacePath, document.uri.fsPath),
      path.join("nested_module", "BUILD"),
    );
  });
});
