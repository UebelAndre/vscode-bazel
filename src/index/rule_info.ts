// Copyright 2026 The Bazel Authors. All rights reserved.
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

import { IndexedTarget } from "./file_models";

/** What the index knows about the rule or macro behind a target. */
export interface RuleInfo {
  /** Rule or macro name as written at the call site. */
  kind: string;
  isTest: boolean;
  isExecutable: boolean;
}

/** Rules built into Bazel whose names don't follow the usual suffixes. */
const NATIVE_TESTS = new Set(["test_suite"]);

/**
 * Well-known rules that are never runnable. Anything else that is not a
 * library is offered a "Run" action, since without the rule definition we
 * cannot tell whether a macro produces an executable.
 */
const KNOWN_NON_EXECUTABLES = new Set([
  "alias",
  "bool_flag",
  "bool_setting",
  "cc_import",
  "cc_toolchain",
  "cc_toolchain_suite",
  "config_setting",
  "constraint_setting",
  "constraint_value",
  "exports_files",
  "filegroup",
  "genquery",
  "genrule",
  "int_flag",
  "int_setting",
  "java_import",
  "label_flag",
  "label_setting",
  "package_group",
  "platform",
  "py_runtime",
  "py_runtime_pair",
  "string_flag",
  "string_list_flag",
  "string_setting",
  "toolchain",
  "toolchain_type",
]);

/** Classifies a rule purely by its name. */
export function heuristicRuleInfo(kind: string): RuleInfo {
  const isTest = kind.endsWith("_test") || NATIVE_TESTS.has(kind);
  const isExecutable =
    isTest ||
    kind.endsWith("_binary") ||
    (!kind.endsWith("_library") &&
      !kind.endsWith("_import") &&
      !KNOWN_NON_EXECUTABLES.has(kind));
  return { kind, isTest, isExecutable };
}

/**
 * Classifies a target. Rule definitions are not consulted yet; an explicit
 * `executable = True` (e.g. on a genrule) is honoured.
 */
export function ruleInfoFor(target: IndexedTarget): RuleInfo {
  const info = heuristicRuleInfo(target.kind);
  if (target.executable === undefined) {
    return info;
  }
  return { ...info, isExecutable: info.isTest || target.executable };
}
