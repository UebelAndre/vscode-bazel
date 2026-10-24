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

/**
 * Textual analysis of `.bazelrc` files. The format is line based: an
 * optional command with an optional `:config` suffix, followed by options,
 * with `#` comments, `\` line continuations, and `import`/`try-import`
 * lines naming other rc files.
 */

import * as fs from "fs";
import * as path from "path";

/** Where the cursor is on a `.bazelrc` line. */
export type RcContext =
  | { kind: "command"; prefix: string }
  | { kind: "config"; command: string; prefix: string }
  | { kind: "flag"; command: string; prefix: string }
  | {
      kind: "value";
      command: string;
      flag: string;
      prefix: string;
      /** `=` for `--flag=value`, a space for `--flag value`. */
      separator: "=" | " ";
    }
  | { kind: "import"; prefix: string };

/** An `import`/`try-import` line; group 1 is the target. */
export const IMPORT_LINE = /^\s*(?:try-)?import\s+(\S+)/;
/** The `cmd:config` head of a line; group 1 is the config name. */
export const CONFIG_HEAD = /^\s*[a-z-]+:([A-Za-z0-9_.-]+)/;

/** Joins `\`-continued lines so that a logical line can be inspected. */
export function logicalLineAt(
  lines: string[],
  lineNumber: number,
): { text: string; startLine: number } {
  let start = lineNumber;
  while (start > 0 && /\\\s*$/.test(stripComment(lines[start - 1]))) {
    start--;
  }
  let end = lineNumber;
  while (end < lines.length - 1 && /\\\s*$/.test(stripComment(lines[end]))) {
    end++;
  }
  const text = lines
    .slice(start, end + 1)
    .map((l) => stripComment(l).replace(/\\\s*$/, " "))
    .join("");
  return { text, startLine: start };
}

/** Removes a `#` comment from a line. */
export function stripComment(line: string): string {
  const hash = line.indexOf("#");
  return hash === -1 ? line : line.slice(0, hash);
}

/**
 * Determines what is being typed at `column` of a line, given the text of
 * the logical line up to the cursor.
 */
export function contextAt(beforeCursor: string): RcContext | undefined {
  const text = beforeCursor.replace(/^\s+/, "");
  const firstSpace = text.search(/\s/);
  if (firstSpace === -1) {
    // Still typing the first word: a command, possibly with `:config`.
    const colon = text.indexOf(":");
    if (colon === -1) {
      return { kind: "command", prefix: text };
    }
    return {
      kind: "config",
      command: text.slice(0, colon),
      prefix: text.slice(colon + 1),
    };
  }
  const head = text.slice(0, firstSpace);
  const rest = text.slice(firstSpace);
  if (head === "import" || head === "try-import") {
    return { kind: "import", prefix: rest.trim() };
  }
  const command = head.split(":")[0];
  // The current word is everything after the last unquoted whitespace.
  const match = /(?:^|\s)(\S*)$/.exec(rest);
  const word = match ? match[1] : "";
  const eq = word.indexOf("=");
  if (word.startsWith("-") && eq !== -1) {
    return {
      kind: "value",
      command,
      flag: word.slice(0, eq).replace(/^--?/, ""),
      prefix: word.slice(eq + 1),
      separator: "=",
    };
  }
  // Possibly a space-separated value after a flag: `--jobs 4`. Whether the
  // flag takes one is for the caller, who knows the flag, to decide.
  const previous = /(\S+)\s+\S*$/.exec(rest)?.[1];
  if (previous && /^--?[^=]+$/.test(previous) && !word.startsWith("-")) {
    return {
      kind: "value",
      command,
      flag: previous.replace(/^--?/, ""),
      prefix: word,
      separator: " ",
    };
  }
  return { kind: "flag", command, prefix: word.replace(/^--?/, "") };
}

/** Collects the `cmd:config` names defined in rc text. */
export function configNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = CONFIG_HEAD.exec(stripComment(line));
    if (match) {
      names.add(match[1]);
    }
  }
  return names;
}

/**
 * Resolves the path named by an `import`/`try-import` line, expanding
 * `%workspace%`. Returns undefined when `%workspace%` is used outside a
 * workspace.
 */
export function resolveImportPath(
  target: string,
  rcPath: string,
  workspaceRoot: string | undefined,
): string | undefined {
  let resolved = target.replace(/^"|"$/g, "");
  if (resolved.includes("%workspace%")) {
    if (!workspaceRoot) {
      return undefined;
    }
    resolved = resolved.replace("%workspace%", workspaceRoot);
  }
  return path.isAbsolute(resolved)
    ? resolved
    : path.join(path.dirname(rcPath), resolved);
}

/**
 * Resolves the `import`/`try-import` targets of an rc file and returns
 * their text when readable.
 */
export function importedRcFiles(
  text: string,
  rcPath: string,
  workspaceRoot: string | undefined,
): { file: string; text: string }[] {
  const results: { file: string; text: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = IMPORT_LINE.exec(stripComment(line));
    if (!match) {
      continue;
    }
    const file = resolveImportPath(match[1], rcPath, workspaceRoot);
    if (!file) {
      continue;
    }
    try {
      results.push({ file, text: fs.readFileSync(file, "utf8") });
    } catch {
      // try-import of a missing file is fine; plain import would be a
      // Bazel error we don't need to replicate here.
    }
  }
  return results;
}
