// Copyright 2018 The Bazel Authors. All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as vscode from "vscode";
import { BazelWorkspaceInfo } from "../bazel";
import { CodeLensCommandAdapter } from "./code_lens_command_adapter";

/** A target as seen by the CodeLens builder. */
export interface CodeLensTarget {
  /** Full label, e.g. `//pkg:name`. */
  label: string;
  /** 0-based line of the rule call in the BUILD file. */
  line: number;
  isTest: boolean;
  isExecutable: boolean;
}

/**
 * Groups of Bazel targets organized by the actions they support.
 */
interface ActionGroups {
  copy: string[];
  build: string[];
  test: string[];
  run: string[];
}

/**
 * Builds CodeLens items for Bazel targets.
 */
export class CodeLensBuilder {
  /**
   * Takes the targets defined in a package and returns a list of CodeLens
   * for the BUILD file in that package.
   *
   * @param bazelWorkspaceInfo The Bazel workspace information containing workspace path and context
   * @param targets The targets of the BUILD file
   * @returns A new array of CodeLens objects for the BUILD file
   */
  buildCodeLenses(
    bazelWorkspaceInfo: BazelWorkspaceInfo,
    targets: CodeLensTarget[],
  ): vscode.CodeLens[] {
    const result: vscode.CodeLens[] = [];

    // Sort targets alphabetically
    const sortedTargets = [...targets].sort((a, b) =>
      a.label.localeCompare(b.label),
    );

    // Group targets by line number to handle multiple targets on same line
    const targetsByLine = new Map<number, CodeLensTarget[]>();
    for (const target of sortedTargets) {
      const list = targetsByLine.get(target.line);
      if (list) {
        list.push(target);
      } else {
        targetsByLine.set(target.line, [target]);
      }
    }

    for (const [line, lineTargets] of [...targetsByLine].sort(
      (a, b) => a[0] - b[0],
    )) {
      this.createCodeLensesForTargetsOnSameLine(
        line,
        lineTargets,
        bazelWorkspaceInfo,
        result,
      );
    }

    return result;
  }

  /**
   * Creates CodeLens objects for targets on the same line.
   */
  private createCodeLensesForTargetsOnSameLine(
    line: number,
    targets: CodeLensTarget[],
    bazelWorkspaceInfo: BazelWorkspaceInfo,
    result: vscode.CodeLens[],
  ): void {
    const range = new vscode.Range(line, 0, line, 0);
    const actionGroups = this.groupTargetsByAction(targets);

    this.createCodeLens(
      "Copy",
      "bazel.copyLabelToClipboard",
      actionGroups.copy,
      range,
      bazelWorkspaceInfo,
      result,
    );
    this.createCodeLens(
      "Build",
      "bazel.buildTarget",
      actionGroups.build,
      range,
      bazelWorkspaceInfo,
      result,
    );
    this.createCodeLens(
      "Test",
      "bazel.testTarget",
      actionGroups.test,
      range,
      bazelWorkspaceInfo,
      result,
    );
    this.createCodeLens(
      "Run",
      "bazel.runTarget",
      actionGroups.run,
      range,
      bazelWorkspaceInfo,
      result,
    );
  }

  /**
   * Groups targets by the actions they support.
   */
  private groupTargetsByAction(targets: CodeLensTarget[]): ActionGroups {
    const groups: ActionGroups = { copy: [], build: [], test: [], run: [] };
    for (const target of targets) {
      groups.copy.push(target.label);
      groups.build.push(target.label);
      if (target.isTest) {
        groups.test.push(target.label);
      }
      if (target.isExecutable) {
        groups.run.push(target.label);
      }
    }
    return groups;
  }

  /**
   * Creates a CodeLens for a specific action type if targets are available.
   * Title shows action name with count for multiple targets.
   */
  private createCodeLens(
    actionName: string,
    command: string,
    targets: string[],
    range: vscode.Range,
    bazelWorkspaceInfo: BazelWorkspaceInfo,
    result: vscode.CodeLens[],
  ): void {
    if (targets.length === 0) {
      return;
    }

    const title =
      targets.length === 1 ? actionName : `${actionName} (${targets.length})`;

    result.push(
      new vscode.CodeLens(range, {
        arguments: [new CodeLensCommandAdapter(bazelWorkspaceInfo, targets)],
        command,
        title,
        tooltip: `${actionName} target - ${targets.length} targets available`,
      }),
    );
  }
}
