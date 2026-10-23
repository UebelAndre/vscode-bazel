import * as path from "path";
import * as vscode from "vscode";
import * as assert from "assert";
import * as sinon from "sinon";
import { getWorkspaceTreeProviderForTesting } from "../src/extension/extension";
import * as fs from "fs";
import { BazelQuery } from "../src/bazel";
import { ILogger } from "../src/extension/logger";
import { Resources } from "../src/extension/resources";
import { blaze_query } from "../src/protos";
import { IndexManager } from "../src/index";
import { readyIndex, waitForIndex } from "./index_test_helpers";
import {
  BazelWorkspaceTreeProvider,
  IBazelTreeItem,
} from "../src/workspace-tree";

describe("Bazel Workspace Tree", function (this: Mocha.Suite) {
  // These integration tests issue several sequential Bazel queries. Allow
  // enough time for Bazel server startup on slower CI runners.
  this.timeout(30000);
  const extensionPath: string = path.join(__dirname, "..", "..");
  const workspacePath = path.join(extensionPath, "test", "bazel_workspace");
  const rootBuildFilePath = path.join(workspacePath, "BUILD");
  const workspaceTreeProvider: BazelWorkspaceTreeProvider =
    getWorkspaceTreeProviderForTesting()!;
  type ExpectedNodes = {
    [key: string]: ExpectedNodes | Record<string, never>;
  };

  /**
   * Recursively verifies that the actual tree structure matches the expected structure.
   *
   * This function compares a tree of IBazelTreeItem nodes against an expected structure
   * defined by the ExpectedNodes type. It checks:
   * 1. That the number of children matches the expected count
   * 2. That each node's label matches the expected label at the same position
   * 3. Recursively verifies the structure of child nodes
   */
  async function verifyTreeStructure(
    expectedNodes: ExpectedNodes,
    actualChildren: IBazelTreeItem[],
  ): Promise<void> {
    assert.strictEqual(
      actualChildren.length,
      Object.keys(expectedNodes).length,
    );

    for (let i = 0; i < actualChildren.length; i++) {
      const expectedNode = Object.keys(expectedNodes)[i];
      const actualNode = actualChildren[i];
      assert.strictEqual(actualNode.getLabel(), expectedNode);
      if (Object.keys(expectedNodes[expectedNode]).length > 0) {
        const actualGrandchildren = await actualNode.getChildren();
        await verifyTreeStructure(
          expectedNodes[expectedNode],
          actualGrandchildren,
        );
      }
    }
  }

  async function openSourceFile(sourceFile: string) {
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(sourceFile),
    );
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One, false);
  }

  before(async () => {
    if (!workspaceTreeProvider) {
      throw new Error("Failed to get workspace tree provider from extension");
    }
  });

  afterEach(async () => {
    // Close all editors
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    // Clean up test files
    try {
      await fs.promises.unlink(rootBuildFilePath);
    } catch (e) {
      // ignore since not every test creates the file
    }

    await vscode.workspace
      .getConfiguration("bazel.workspace")
      .update("path", undefined, vscode.ConfigurationTarget.Workspace);
  });

  it("should match workspace structure", async () => {
    await verifyTreeStructure(
      {
        "//buildifier": {},
        "//nested_module": {},
        "//pkg1": {
          ":foo  (filegroup)": {},
          ":main  (py_binary)": {},
          ":pkg1  (py_library)": {},
          ":src_files  (filegroup)": {},
        },
        "//pkg2": {
          "sub-pkg": {
            ":foobar  (filegroup)": {},
          },
        },
        "//pkg3": {
          ":custom_test  (my_test)": {},
          ":data  (my_macro)": {},
        },
      },
      await workspaceTreeProvider.getChildren(),
    );
  });

  it("should update tree when BUILD file is added", async () => {
    // WHEN
    await fs.promises.writeFile(
      rootBuildFilePath,
      'filegroup(name="bar",srcs=["non-pkg/bar.txt"])',
    );
    // The index picks the new file up through the file watcher.
    const index = await readyIndex(workspacePath);
    await waitForIndex(index, (i) => i.getPackage("") !== undefined);

    // THEN
    await verifyTreeStructure(
      {
        "//buildifier": {},
        "//nested_module": {},
        "//pkg1": {
          ":foo  (filegroup)": {},
          ":main  (py_binary)": {},
          ":pkg1  (py_library)": {},
          ":src_files  (filegroup)": {},
        },
        "//pkg2": {
          "sub-pkg": {
            ":foobar  (filegroup)": {},
          },
        },
        "//pkg3": {
          ":custom_test  (my_test)": {},
          ":data  (my_macro)": {},
        },
        ":bar  (filegroup)": {},
      },
      await workspaceTreeProvider.getChildren(),
    );
  });

  it("should remove the package when its BUILD file is deleted", async () => {
    await fs.promises.writeFile(
      rootBuildFilePath,
      'filegroup(name="bar",srcs=["non-pkg/bar.txt"])',
    );
    const index = await readyIndex(workspacePath);
    await waitForIndex(index, (i) => i.getPackage("") !== undefined);

    await fs.promises.unlink(rootBuildFilePath);
    await waitForIndex(index, (i) => i.getPackage("") === undefined);

    const children = await workspaceTreeProvider.getChildren();
    assert.ok(
      !children.some((c) => c.getLabel() === ":bar  (filegroup)"),
      "root target should be gone",
    );
  });

  describe("queryExpression scoping", () => {
    afterEach(async () => {
      await vscode.workspace
        .getConfiguration("bazel.commandLine")
        .update(
          "queryExpression",
          undefined,
          vscode.ConfigurationTarget.Workspace,
        );
    });

    it("narrows the tree to a subtree expression", async () => {
      await vscode.workspace
        .getConfiguration("bazel.commandLine")
        .update(
          "queryExpression",
          "//pkg2/...:*",
          vscode.ConfigurationTarget.Workspace,
        );

      await verifyTreeStructure(
        {
          "//pkg2": {
            "sub-pkg": {
              ":foobar  (filegroup)": {},
            },
          },
        },
        await workspaceTreeProvider.getChildren(),
      );
    });

    it("ignores query functions the parser cannot evaluate", async () => {
      await vscode.workspace
        .getConfiguration("bazel.commandLine")
        .update(
          "queryExpression",
          "kind('py_.*', //...)",
          vscode.ConfigurationTarget.Workspace,
        );

      const children = await workspaceTreeProvider.getChildren();
      assert.deepStrictEqual(
        children.map((c) => c.getLabel()),
        ["//buildifier", "//nested_module", "//pkg1", "//pkg2", "//pkg3"],
      );
    });
  });

  it("indexes a nested Bazel root without querying", async () => {
    await vscode.workspace
      .getConfiguration("bazel.workspace")
      .update("path", "nested_module", vscode.ConfigurationTarget.Workspace);

    const sandbox = sinon.createSandbox();
    const queryPackages = sandbox
      .stub(BazelQuery.prototype, "queryPackages")
      .resolves([]);
    const queryTargets = sandbox
      .stub(BazelQuery.prototype, "queryTargets")
      .resolves(blaze_query.QueryResult.create());
    const logger: ILogger = {
      logDebug: sandbox.stub(),
      logInfo: sandbox.stub(),
      logWarn: sandbox.stub(),
      logError: sandbox.stub(),
    };
    const manager = IndexManager.get()!;
    const provider = new BazelWorkspaceTreeProvider(
      new Resources(extensionPath),
      logger,
      manager,
    );

    try {
      const configuredRoot = path.join(workspacePath, "nested_module");
      const index = await readyIndex(configuredRoot);
      const children = await provider.getChildren();

      assert.strictEqual(provider.workspaceFolderTreeItems?.length, 1);
      assert.strictEqual(
        provider.workspaceFolderTreeItems?.[0].getWorkspaceInfo()
          .bazelWorkspacePath,
        configuredRoot,
      );
      // The nested module's BUILD file is empty: one package, no targets.
      assert.deepStrictEqual(index.getPackages(), [""]);
      assert.deepStrictEqual(children, []);
      assert.strictEqual(queryPackages.callCount, 0);
      assert.strictEqual(queryTargets.callCount, 0);
    } finally {
      provider.dispose();
      sandbox.restore();
    }
  });

  it("does not select tree item when bazel view is hidden", async () => {
    // GIVEN another view is active (Search) instead of the Explorer
    await vscode.commands.executeCommand("workbench.view.search");
    assert.strictEqual(
      workspaceTreeProvider.lastRevealedTreeItem?.getLabel(),
      undefined,
    );

    // WHEN opening a file in the workspace
    await openSourceFile(path.join(workspacePath, "pkg1", "BUILD"));

    // THEN the Bazel workspace tree selection should not change
    assert.strictEqual(
      workspaceTreeProvider.lastRevealedTreeItem?.getLabel(),
      undefined,
    );
  });
});
