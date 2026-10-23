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

import * as child_process from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as util from "util";
import * as vscode from "vscode";
import { BazelInfo } from "../bazel/bazel_info";
import {
  getBazelExecutablePath,
  getStartupOptions,
} from "../extension/configuration";
import { ILogger } from "../extension/logger";

const execFile = util.promisify(child_process.execFile);

/** Apparent repository name to canonical name, as Bazel reports it. */
export type RepoMapping = Record<string, string>;

/** How long `bazel mod` may take before navigation gives up on it. */
const MOD_TIMEOUT_MS = 60_000;

/** Result of resolving a repository name to a directory on disk. */
export interface RepoResolution {
  /** Canonical repository name; empty for the main repository. */
  canonical: string;
  /** Root directory of the repository, if it exists on disk. */
  dir?: string;
  /**
   * Why `dir` is missing: `unfetched` when the canonical name is known but
   * the repository has not been fetched; `unknown` when the apparent name is
   * not visible from the requesting repository.
   */
  missing?: "unfetched" | "unknown";
}

/**
 * Resolves external repository names to directories without relying on
 * Bazel wherever possible.
 *
 * The output base is derived from the `bazel-<workspace>` convenience
 * symlink. Apparent repository names are first matched against the fetched
 * repositories by naming convention; only when that fails does the resolver
 * ask Bazel for the repository mapping, and the answer is cached until the
 * module files change. Callers say whether Bazel may be run at all: hover
 * and completion must never wait on the Bazel server lock.
 */
export class ExternalRepoResolver {
  private outputBase: Promise<string | undefined> | undefined;
  /**
   * Repository mappings by canonical repository, most recently used last.
   * The main module's mapping (key `""`) is kept; others are bounded since a
   * large workspace can have thousands of repositories.
   */
  private readonly mappings = new Map<
    string,
    Promise<RepoMapping | undefined>
  >();
  /** Mappings that have arrived, for synchronous use. */
  private readonly known = new Map<string, RepoMapping>();
  /** Bumped by {@link invalidate} so that superseded dumps are dropped. */
  private epoch = 0;
  private listing: { at: number; names: string[] } | undefined;

  constructor(
    public readonly root: string,
    private readonly logger: ILogger,
  ) {}

  /**
   * Forgets cached mappings, e.g. after MODULE.bazel changed. The output
   * base stays: module files do not move it.
   */
  public invalidate() {
    this.epoch++;
    this.mappings.clear();
    this.known.clear();
    this.listing = undefined;
  }

  /**
   * Returns the output base of the workspace, if it can be determined.
   *
   * @param runBazel Whether `bazel info` may be run when the workspace has
   * no convenience symlinks yet.
   */
  public async getOutputBase(runBazel = true): Promise<string | undefined> {
    const cached = await this.outputBase;
    if (cached && fs.existsSync(cached)) {
      return cached;
    }
    const fromSymlink = this.outputBaseFromSymlinks();
    if (fromSymlink || !runBazel) {
      this.outputBase = Promise.resolve(fromSymlink);
      return fromSymlink;
    }
    this.outputBase = this.outputBaseFromBazel().catch((err): undefined => {
      this.logger.logDebug("Could not determine output base", false, err);
      return undefined;
    });
    return this.outputBase;
  }

  private async outputBaseFromBazel(): Promise<string | undefined> {
    this.logBazel(["info", "output_base"]);
    const value = await new BazelInfo(
      getBazelExecutablePath(),
      this.root,
    ).getOne("output_base");
    return value && fs.existsSync(value) ? value : undefined;
  }

  /**
   * Reads the `bazel-*` convenience symlinks in the workspace root. They point
   * into `<output_base>/execroot/...`, which gives the output base without
   * starting a Bazel server.
   */
  private outputBaseFromSymlinks(): string | undefined {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      if (!entry.isSymbolicLink() || !entry.name.startsWith("bazel-")) {
        continue;
      }
      let target: string;
      try {
        target = fs.realpathSync(path.join(this.root, entry.name));
      } catch {
        // Dangling symlink (output base was expunged).
        continue;
      }
      const marker = `${path.sep}execroot${path.sep}`;
      const idx = target.indexOf(marker);
      if (idx === -1) {
        continue;
      }
      const candidate = target.slice(0, idx);
      if (fs.existsSync(path.join(candidate, "external"))) {
        return candidate;
      }
    }
    return undefined;
  }

  /** Lists the canonical names of fetched repositories. */
  public async listFetchedRepos(): Promise<string[]> {
    const now = Date.now();
    if (this.listing && now - this.listing.at < 15_000) {
      return this.listing.names;
    }
    const outputBase = await this.getOutputBase(false);
    let names: string[] = [];
    if (outputBase) {
      try {
        names = (
          await fs.promises.readdir(path.join(outputBase, "external"), {
            withFileTypes: true,
          })
        )
          .filter((d) => d.isDirectory() || d.isSymbolicLink())
          .map((d) => d.name);
      } catch {
        names = [];
      }
    }
    this.listing = { at: now, names };
    return names;
  }

  /**
   * Returns the canonical repository containing `fsPath`, or the empty string
   * for the main repository, or undefined if the path belongs to neither.
   */
  public async repoForPath(
    fsPath: string,
  ): Promise<{ canonical: string; dir: string } | undefined> {
    if (isWithin(this.root, fsPath)) {
      return { canonical: "", dir: this.root };
    }
    const outputBase = await this.getOutputBase(false);
    if (!outputBase) {
      return undefined;
    }
    const external = path.join(outputBase, "external");
    // The editor may spell the output base through a symlink (e.g.
    // /private/var vs /var); compare real paths as a fallback.
    const rel =
      relativeWithin(external, fsPath) ??
      relativeWithin(realpathOr(external), realpathOr(fsPath));
    if (rel === undefined) {
      return undefined;
    }
    const canonical = rel.split(path.sep)[0];
    return { canonical, dir: path.join(external, canonical) };
  }

  /**
   * The apparent repository names visible from a repository, if its mapping
   * has already been loaded. Never runs Bazel.
   */
  public knownRepoNames(fromCanonical: string): string[] | undefined {
    const mapping = this.known.get(fromCanonical);
    return mapping && Object.keys(mapping).filter((name) => name !== "");
  }

  /**
   * Resolves a repository name as written in a label.
   *
   * @param name Repository name without `@`.
   * @param canonical Whether `name` was written with `@@`.
   * @param fromCanonical Canonical name of the repository containing the file
   * with the label; empty for the main repository.
   * @param runBazel Whether Bazel may be asked for the repository mapping
   * when naming conventions and cached mappings do not answer.
   */
  public async resolveRepo(
    name: string,
    canonical: boolean,
    fromCanonical = "",
    runBazel = true,
  ): Promise<RepoResolution> {
    if (name === "") {
      return { canonical: "", dir: this.root };
    }
    if (canonical) {
      return this.resolutionFor(name, runBazel);
    }
    let mapping = this.known.get(fromCanonical);
    if (mapping === undefined && fromCanonical === "") {
      // Try naming conventions before asking Bazel.
      const guess = guessCanonicalName(name, await this.listFetchedRepos());
      if (guess !== undefined) {
        return this.resolutionFor(guess, runBazel);
      }
    }
    if (mapping === undefined && runBazel) {
      mapping = await this.getRepoMapping(fromCanonical);
    }
    if (mapping === undefined) {
      // No mapping: Bazel was not consulted, or the workspace has no bzlmod
      // (then apparent names are canonical and `fetch` accepts them).
      return runBazel
        ? { canonical: name, missing: "unfetched" }
        : { canonical: name, missing: "unknown" };
    }
    const mapped = mapping[name];
    if (mapped === undefined) {
      return { canonical: name, missing: "unknown" };
    }
    if (mapped === "") {
      return { canonical: "", dir: this.root };
    }
    return this.resolutionFor(mapped, runBazel);
  }

  private async resolutionFor(
    canonical: string,
    runBazel: boolean,
  ): Promise<RepoResolution> {
    const outputBase = await this.getOutputBase(runBazel);
    if (!outputBase) {
      return { canonical, missing: "unfetched" };
    }
    const dir = path.join(outputBase, "external", canonical);
    if (fs.existsSync(dir)) {
      return { canonical, dir: preferredRepoDir(dir) };
    }
    return { canonical, missing: "unfetched" };
  }

  /**
   * Returns the apparent-to-canonical repository mapping as seen from the
   * given repository, via `bazel mod dump_repo_mapping`.
   */
  public getRepoMapping(
    fromCanonical: string,
  ): Promise<RepoMapping | undefined> {
    let cached = this.mappings.get(fromCanonical);
    if (cached === undefined) {
      const epoch = this.epoch;
      cached = this.dumpRepoMapping(fromCanonical).then(
        (mapping) => {
          if (mapping && epoch === this.epoch) {
            this.known.set(fromCanonical, mapping);
          }
          return mapping;
        },
        (err): undefined => {
          this.logger.logInfo(
            `Could not dump repo mapping for '${fromCanonical || "<main>"}'`,
            false,
            err,
          );
          return undefined;
        },
      );
      this.mappings.set(fromCanonical, cached);
      this.trimMappings();
    } else {
      // Refresh recency.
      this.mappings.delete(fromCanonical);
      this.mappings.set(fromCanonical, cached);
    }
    return cached;
  }

  private trimMappings() {
    const limit = 32;
    for (const key of this.mappings.keys()) {
      if (this.mappings.size <= limit) {
        break;
      }
      if (key !== "") {
        this.mappings.delete(key);
      }
    }
  }

  private async dumpRepoMapping(
    fromCanonical: string,
  ): Promise<RepoMapping | undefined> {
    const { stdout } = await this.runBazel(
      ["mod", "dump_repo_mapping", fromCanonical],
      MOD_TIMEOUT_MS,
    );
    const parsed: unknown = JSON.parse(stdout.trim());
    if (parsed && typeof parsed === "object") {
      return parsed as RepoMapping;
    }
    return undefined;
  }

  /**
   * Fetches a repository so that it exists on disk.
   *
   * @param canonical The canonical repository name. Apparent names would
   * only work for repositories visible from the main module, which excludes
   * the common case of a label inside another fetched repository.
   */
  public async fetchRepo(canonical: string): Promise<void> {
    await this.runBazel(["fetch", `--repo=@@${canonical}`]);
    this.listing = undefined;
  }

  /** @param timeout Milliseconds after which the command is killed. */
  private runBazel(args: string[], timeout?: number) {
    const fullArgs = [...getStartupOptions(), ...args];
    this.logBazel(fullArgs);
    return execFile(getBazelExecutablePath(), fullArgs, {
      cwd: this.root,
      maxBuffer: 64 * 1024 * 1024,
      timeout,
    });
  }

  private logBazel(args: string[]) {
    // Logged at info level on purpose: these are the only Bazel invocations
    // navigation ever makes, and users should be able to see them.
    this.logger.logInfo(
      `Running ${getBazelExecutablePath()} ${args.join(" ")} in ${this.root}`,
    );
  }
}

/**
 * Picks the fetched repository matching an apparent name by naming
 * convention: WORKSPACE repositories keep their name, bzlmod modules are
 * `name+` (Bazel 8) or `name~version` (Bazel 7).
 */
export function guessCanonicalName(
  apparent: string,
  fetched: string[],
): string | undefined {
  if (fetched.includes(apparent)) {
    return apparent;
  }
  if (fetched.includes(`${apparent}+`)) {
    return `${apparent}+`;
  }
  const tilde = fetched.filter((n) => n.startsWith(`${apparent}~`));
  if (tilde.length === 1) {
    return tilde[0];
  }
  return undefined;
}

function isWithin(parent: string, child: string): boolean {
  return relativeWithin(parent, child) !== undefined;
}

/** The path of `child` relative to `parent`, if it lies inside. */
function relativeWithin(parent: string, child: string): string | undefined {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
    ? rel
    : undefined;
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Chooses the path under which to open files of a fetched repository.
 *
 * Repositories backed by a local directory (`local_path_override`,
 * `local_repository`) are symlinks; when the real directory is inside an
 * open VS Code folder, use it so that edits happen in the user's checkout.
 * Otherwise keep the `external/<repo>` path, which is readable, stable, and
 * lets files be attributed back to their repository.
 */
function preferredRepoDir(dir: string): string {
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return dir;
  }
  if (real === dir) {
    return dir;
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (isWithin(folder.uri.fsPath, real)) {
      return real;
    }
  }
  return dir;
}
