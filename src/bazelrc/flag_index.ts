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

import { FlagCollection, FlagInfo } from "./flags_proto";

/** Bazel LTS lines the extension ships flag catalogues for. */
export const LTS_MAJORS = ["7", "8", "9"];

/** File name prefix of catalogues: `bazelrc_flags-<version>.json`. */
export const CATALOGUE_PREFIX = "bazelrc_flags-";

/** Commands that accept the flags of every command. */
const ALL_COMMANDS = new Set(["common", "always"]);

/** Line keywords that are not Bazel commands. */
export const RC_KEYWORDS = ["import", "try-import"];

/** Lookup structure over a flag collection. No VS Code dependency. */
export class FlagIndex {
  private readonly byName = new Map<string, FlagInfo>();
  private readonly byAbbreviation = new Map<string, FlagInfo>();
  private readonly byOldName = new Map<string, FlagInfo>();
  private readonly commandNames: string[];

  constructor(public readonly collection: FlagCollection) {
    const commands = new Set<string>(ALL_COMMANDS);
    for (const flag of collection.flags) {
      this.byName.set(flag.name, flag);
      if (flag.abbreviation) {
        this.byAbbreviation.set(flag.abbreviation, flag);
      }
      if (flag.oldName) {
        this.byOldName.set(flag.oldName, flag);
      }
      for (const command of flag.commands) {
        commands.add(command);
      }
    }
    this.commandNames = [...commands].sort();
  }

  /** Command names flags are declared for, plus `common` and `always`. */
  public commands(): string[] {
    return this.commandNames;
  }

  /** Flags accepted by a command (all but startup flags for `common`). */
  public flagsFor(command: string): FlagInfo[] {
    if (ALL_COMMANDS.has(command)) {
      return this.collection.flags.filter(
        (f) => !f.commands.includes("startup"),
      );
    }
    return this.collection.flags.filter((f) => f.commands.includes(command));
  }

  /** Looks a flag up by name, `no` prefix, old name, or abbreviation. */
  public find(name: string): FlagInfo | undefined {
    const direct = this.byName.get(name);
    if (direct) {
      return direct;
    }
    if (name.length === 1) {
      return this.byAbbreviation.get(name);
    }
    if (name.startsWith("no")) {
      const positive = this.byName.get(name.slice(2));
      if (positive?.negatable) {
        return positive;
      }
    }
    return this.byOldName.get(name);
  }
}

/** A catalogue file and the Bazel version (or LTS line) it describes. */
export interface CatalogueCandidate {
  file: string;
  /** `8.3.1` for a refreshed catalogue, `8` for a shipped LTS catalogue. */
  version: string;
}

/** Leading integer of a version string such as `8.3.1` or `8.x`. */
export function majorOf(version: string | undefined): number | undefined {
  const match = /^\s*v?(\d+)/.exec(version ?? "");
  return match ? Number(match[1]) : undefined;
}

function versionKey(version: string): number[] {
  return version.split(".").map((part) => parseInt(part, 10) || 0);
}

function compareVersions(a: string, b: string): number {
  const ka = versionKey(a);
  const kb = versionKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (ka[i] ?? 0) - (kb[i] ?? 0);
    if (d !== 0) {
      return d;
    }
  }
  return 0;
}

/**
 * Chooses the catalogue for a wanted Bazel version: an exact match first,
 * then the most specific catalogue of the same LTS line, then the newest
 * available (for `rolling`, `latest`, or an LTS line newer than shipped).
 */
export function selectCatalogue(
  wanted: string | undefined,
  candidates: CatalogueCandidate[],
): CatalogueCandidate | undefined {
  if (!candidates.length) {
    return undefined;
  }
  const trimmed = wanted?.trim();
  if (trimmed) {
    const exact = candidates.find((c) => c.version === trimmed);
    if (exact) {
      return exact;
    }
    const major = majorOf(trimmed);
    if (major !== undefined) {
      // Within the LTS line, the nearest version that is not newer never
      // offers flags the workspace's Bazel lacks; failing that, the newest.
      const sameLine = candidates
        .filter((c) => majorOf(c.version) === major)
        .sort((a, b) => compareVersions(b.version, a.version));
      const notNewer = sameLine.find(
        (c) => compareVersions(c.version, trimmed) <= 0,
      );
      if (notNewer ?? sameLine.length) {
        return notNewer ?? sameLine[0];
      }
      // An LTS line we don't know: prefer the nearest one that is not
      // newer than it, since flags are mostly added over time.
      const older = candidates
        .filter((c) => (majorOf(c.version) ?? 0) < major)
        .sort((a, b) => compareVersions(b.version, a.version));
      if (older.length) {
        return older[0];
      }
    }
  }
  return [...candidates].sort((a, b) =>
    compareVersions(b.version, a.version),
  )[0];
}

/** Converts the simple HTML of flag documentation to Markdown. */
export function docToMarkdown(doc: string): string {
  return doc
    .replace(/<code>(.*?)<\/code>/gs, "`$1`")
    .replace(/<a\s+href="([^"]*)"[^>]*>(.*?)<\/a>/gs, "[$2]($1)")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<\/?p>/g, "\n\n")
    .replace(/<li>/g, "\n- ")
    .replace(/<\/?(ul|ol|li|pre|b|i|em|strong|tt|dl|dt|dd)>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
