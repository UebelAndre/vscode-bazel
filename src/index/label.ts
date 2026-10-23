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
 * A Bazel label split into its parts.
 *
 * Repository names are stored without the leading `@`. The main repository
 * is the empty string. `repo === undefined` means the label did not name a
 * repository and therefore refers to the repository of the file it appears
 * in.
 */
export interface ParsedLabel {
  repo?: string;
  /** True when written with `@@`, i.e. `repo` is a canonical name. */
  canonical: boolean;
  /** Package path with `/` separators; empty for the root package. */
  pkg: string;
  /** Target name, possibly containing `/` for files in subdirectories. */
  name: string;
  /** True when the label started with `@` or `//` (not package-relative). */
  absolute: boolean;
}

const INVALID_LABEL_CHARS = /[\s"'`<>|;*?\\]/;

/**
 * Parses label text as it appears in a BUILD or .bzl file.
 *
 * @param text The label text without surrounding quotes.
 * @param currentPkg The package of the file the label appears in, used to
 * resolve package-relative labels such as `:foo` or `foo.cc`.
 * @returns The parsed label, or undefined if the text cannot be a label.
 */
export function parseLabel(
  text: string,
  currentPkg: string,
): ParsedLabel | undefined {
  if (!text || INVALID_LABEL_CHARS.test(text) || text.includes("...")) {
    return undefined;
  }

  let repo: string | undefined;
  let canonical = false;
  let rest = text;
  let absolute = false;

  if (rest.startsWith("@")) {
    absolute = true;
    canonical = rest.startsWith("@@");
    rest = rest.slice(canonical ? 2 : 1);
    const slash = rest.indexOf("//");
    if (slash === -1) {
      // `@repo` is shorthand for `@repo//:repo`.
      if (!rest || rest.includes(":") || rest.includes("/")) {
        return undefined;
      }
      return { repo: rest, canonical, pkg: "", name: rest, absolute };
    }
    repo = rest.slice(0, slash);
    rest = rest.slice(slash);
    if (repo.includes(":") || repo.includes("/")) {
      return undefined;
    }
  }

  if (rest.startsWith("//")) {
    absolute = true;
    rest = rest.slice(2);
    const colon = rest.indexOf(":");
    let pkg: string;
    let name: string;
    if (colon === -1) {
      pkg = rest;
      const lastSlash = pkg.lastIndexOf("/");
      name = lastSlash === -1 ? pkg : pkg.slice(lastSlash + 1);
      if (!name) {
        // `//` or `@repo//` alone names the root package's default target,
        // which is only valid as `@repo//:repo`; treat `//` as invalid.
        return undefined;
      }
    } else {
      pkg = rest.slice(0, colon);
      name = rest.slice(colon + 1);
      if (!name || name.includes(":")) {
        return undefined;
      }
    }
    if (
      pkg.startsWith("/") ||
      pkg.endsWith("/") ||
      pkg.includes("//") ||
      hasDotSegment(pkg) ||
      hasDotSegment(name)
    ) {
      return undefined;
    }
    return { repo, canonical, pkg, name, absolute };
  }

  if (repo !== undefined) {
    return undefined;
  }

  // Package-relative forms.
  if (rest.startsWith(":")) {
    const name = rest.slice(1);
    if (!name || name.includes(":")) {
      return undefined;
    }
    return { canonical, pkg: currentPkg, name, absolute: false };
  }
  if (rest.includes(":") || rest.startsWith("/") || hasDotSegment(rest)) {
    return undefined;
  }
  return { canonical, pkg: currentPkg, name: rest, absolute: false };
}

/** Bazel rejects `.` and `..` path segments; so must we, to stay in the repo. */
function hasDotSegment(p: string): boolean {
  return p.split("/").some((segment) => segment === "." || segment === "..");
}

/**
 * Returns the shortest conventional spelling of a label for display, e.g.
 * `//foo/bar` for `//foo/bar:bar`.
 */
export function shortLabel(pkg: string, name: string): string {
  const lastSlash = pkg.lastIndexOf("/");
  const lastComponent = lastSlash === -1 ? pkg : pkg.slice(lastSlash + 1);
  if (pkg && lastComponent === name) {
    return `//${pkg}`;
  }
  return `//${pkg}:${name}`;
}

/**
 * Whether a string plausibly refers to a label or a file rather than being
 * arbitrary text. Used to avoid resolving every string literal.
 */
export function looksLikeLabel(text: string): boolean {
  if (!text || INVALID_LABEL_CHARS.test(text)) {
    return false;
  }
  return (
    text.startsWith("@") ||
    text.startsWith("//") ||
    text.startsWith(":") ||
    /^[\w.+\-~]+(\/[\w.+\-~]+)*(:[\w.+\-~/]+)?$/.test(text)
  );
}
