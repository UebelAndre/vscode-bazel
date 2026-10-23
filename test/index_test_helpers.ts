import * as path from "path";
import * as vscode from "vscode";
import { IndexManager, WorkspaceIndex } from "../src/index";

/** Absolute path of the fixture workspace opened by the test runner. */
export const fixtureWorkspacePath = path.join(
  __dirname,
  "..",
  "..",
  "test",
  "bazel_workspace",
);

/** Returns the index for a repository root once its initial scan is done. */
export async function readyIndex(
  root: string = fixtureWorkspacePath,
): Promise<WorkspaceIndex> {
  const manager = IndexManager.get();
  if (!manager) {
    throw new Error("The extension's index manager is not available");
  }
  let index = manager.getIndex(root);
  const deadline = Date.now() + 10000;
  while (!index && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    index = manager.getIndex(root);
  }
  if (!index) {
    throw new Error(`No index for ${root}`);
  }
  await index.ready;
  return index;
}

/** Polls until `predicate` holds for the index or the timeout elapses. */
export async function waitForIndex(
  index: WorkspaceIndex,
  predicate: (index: WorkspaceIndex) => boolean,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate(index)) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the index to update");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Opens a fixture document without showing it. */
export async function openFixture(
  ...segments: string[]
): Promise<vscode.TextDocument> {
  return vscode.workspace.openTextDocument(
    vscode.Uri.file(path.join(fixtureWorkspacePath, ...segments)),
  );
}

/** Finds the position of the first occurrence of `needle` in a document. */
export function positionOf(
  document: vscode.TextDocument,
  needle: string,
  offsetInNeedle = 1,
): vscode.Position {
  const index = document.getText().indexOf(needle);
  if (index === -1) {
    throw new Error(`"${needle}" not found in ${document.uri.fsPath}`);
  }
  return document.positionAt(index + offsetInNeedle);
}
