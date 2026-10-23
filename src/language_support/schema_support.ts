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

import * as vscode from "vscode";

import { AttrSchema, CallableSchema } from "../index";

/** Attributes worth offering: everything not private. */
export function offeredAttrs(schema: CallableSchema): AttrSchema[] {
  return schema.attrs.filter((a) => !a.name.startsWith("_"));
}

/** Markdown describing an attribute, for completion and signature help. */
export function attrMarkdown(attr: AttrSchema): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  const facts: string[] = [];
  if (attr.type !== "param") {
    facts.push(attr.type);
  }
  if (attr.mandatory) {
    facts.push("required");
  } else if (attr.default !== undefined) {
    facts.push(`default: \`${attr.default}\``);
  }
  if (attr.implicit) {
    facts.push("common attribute");
  }
  if (facts.length) {
    md.appendMarkdown(`*${facts.join(", ")}*\n\n`);
  }
  if (attr.doc) {
    md.appendMarkdown(attr.doc);
  }
  return md;
}

/** A one-line summary of what is being called, for titles. */
export function schemaTitle(schema: CallableSchema): string {
  switch (schema.kind) {
    case "macro":
      return `macro ${schema.name}`;
    case "symbolic_macro":
      return `symbolic macro ${schema.name}`;
    case "repository_rule":
      return `repository rule ${schema.name}`;
    case "tag_class":
      return `tag class ${schema.name}`;
    default:
      return `${schema.kind} ${schema.name}`;
  }
}
