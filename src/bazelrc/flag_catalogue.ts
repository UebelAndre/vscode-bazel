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

import { getBazelWorkspaceFolder } from "../bazel/bazel_utils";
import {
  getBazelExecutablePath,
  getStartupOptions,
} from "../extension/configuration";
import { BazelCommand } from "../bazel/bazel_command";
import { ILogger } from "../extension/logger";
import {
  CATALOGUE_PREFIX,
  CatalogueCandidate,
  FlagIndex,
  docToMarkdown,
  selectCatalogue,
} from "./flag_index";
import { FlagCollection, FlagInfo, decodeFlagCollection } from "./flags_proto";

const execFile = util.promisify(child_process.execFile);

/**
 * Flag catalogues per workspace, chosen by the workspace's Bazel version.
 *
 * The extension ships one catalogue per LTS line. A workspace is assumed to
 * be on the latest of them unless its `.bazelversion` says otherwise. The
 * refresh command adds exact-version catalogues from the workspace's own
 * Bazel to global storage, which take precedence when they match.
 */
export class FlagCatalogues {
  private readonly byRoot = new Map<string, Promise<FlagIndex | undefined>>();
  private readonly loaded = new Map<string, Promise<FlagIndex>>();

  constructor(
    private readonly extensionPath: string,
    private readonly storagePath: string | undefined,
    private readonly logger: ILogger,
  ) {}

  /** The catalogue for a document, by the Bazel version of its workspace. */
  public forDocument(
    document: vscode.TextDocument,
  ): Promise<FlagIndex | undefined> {
    const root =
      document.uri.scheme === "file"
        ? getBazelWorkspaceFolder(document.uri.fsPath)
        : undefined;
    return this.forRoot(root);
  }

  /** The catalogue for a workspace root (or the newest one for none). */
  public forRoot(root: string | undefined): Promise<FlagIndex | undefined> {
    const key = root ?? "";
    let pending = this.byRoot.get(key);
    if (pending === undefined) {
      pending = this.choose(root).catch((err): undefined => {
        this.logger.logError(
          "Could not load a .bazelrc flag catalogue",
          false,
          err,
        );
        return undefined;
      });
      this.byRoot.set(key, pending);
    }
    return pending;
  }

  /** Forgets the choice for a root, e.g. after `.bazelversion` changed. */
  public invalidate(root?: string) {
    if (root === undefined) {
      this.byRoot.clear();
    } else {
      this.byRoot.delete(root);
    }
  }

  private async choose(
    root: string | undefined,
  ): Promise<FlagIndex | undefined> {
    const wanted = root ? await this.wantedVersion(root) : undefined;
    const candidate = selectCatalogue(wanted, await this.candidates());
    if (!candidate) {
      return undefined;
    }
    const index = await this.load(candidate.file);
    this.logger.logInfo(
      `Using the flags of Bazel ${index.collection.bazelVersion} for ${root ?? "files outside a workspace"} (wanted ${wanted ?? "any"})`,
    );
    return index;
  }

  /**
   * The Bazel version a workspace pins in `.bazelversion`. Without one the
   * workspace is assumed to be on the latest LTS line we ship flags for.
   */
  private async wantedVersion(root: string): Promise<string | undefined> {
    try {
      const text = await fs.promises.readFile(
        path.join(root, ".bazelversion"),
        "utf8",
      );
      return text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith("#"));
    } catch {
      return undefined;
    }
  }

  private async candidates(): Promise<CatalogueCandidate[]> {
    const result: CatalogueCandidate[] = [];
    for (const dir of [
      path.join(this.extensionPath, "data"),
      this.storagePath,
    ]) {
      if (!dir) {
        continue;
      }
      let entries: string[] = [];
      try {
        entries = await fs.promises.readdir(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const match = new RegExp(`^${CATALOGUE_PREFIX}(.+)\\.json$`).exec(
          entry,
        );
        if (match) {
          const file = path.join(dir, entry);
          result.push({
            file,
            version: (await catalogueVersion(file)) ?? match[1],
          });
        }
      }
    }
    return result;
  }

  private load(file: string): Promise<FlagIndex> {
    let pending = this.loaded.get(file);
    if (pending === undefined) {
      pending = fs.promises
        .readFile(file, "utf8")
        .then((text) => new FlagIndex(JSON.parse(text) as FlagCollection));
      this.loaded.set(file, pending);
    }
    return pending;
  }

  /**
   * Generates a catalogue from the Bazel of a workspace, stores it for its
   * exact version, and makes the workspace use it.
   */
  public async refreshFromBazel(root: string): Promise<FlagCollection> {
    const help = new BazelHelp(getBazelExecutablePath(), root);
    const version = (await help.version()).replace(/^bazel\s+/, "");
    this.logger.logInfo(
      `Running ${help.bazelExecutable} help flags-as-proto in ${root}`,
    );
    const stdout = await help.topic("flags-as-proto");
    const collection: FlagCollection = {
      bazelVersion: version,
      flags: decodeFlagCollection(stdout),
    };
    if (this.storagePath) {
      await fs.promises.mkdir(this.storagePath, { recursive: true });
      const file = path.join(
        this.storagePath,
        `${CATALOGUE_PREFIX}${version}.json`,
      );
      await fs.promises.writeFile(file, JSON.stringify(collection));
      this.loaded.delete(file);
    }
    this.invalidate();
    return collection;
  }
}

/** Markdown describing a flag, for completion and hover. */
export function flagMarkdown(flag: FlagInfo): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  const facts: string[] = [];
  if (flag.type) {
    facts.push(flag.type);
  }
  if (flag.defaultValue !== undefined && flag.defaultValue !== "") {
    facts.push(`default \`${flag.defaultValue}\``);
  }
  if (flag.allowsMultiple) {
    facts.push("may be repeated");
  }
  for (const tag of flag.metadataTags ?? []) {
    facts.push(tag.toLowerCase().replace(/_/g, " "));
  }
  if (facts.length) {
    md.appendMarkdown(`*${facts.join(", ")}*\n\n`);
  }
  if (flag.deprecationWarning) {
    md.appendMarkdown(
      `**Deprecated:** ${docToMarkdown(flag.deprecationWarning)}\n\n`,
    );
  }
  if (flag.doc) {
    md.appendMarkdown(`${docToMarkdown(flag.doc)}\n\n`);
  }
  if (flag.allowedValues?.length) {
    md.appendMarkdown(
      `Values: ${flag.allowedValues.map((v) => `\`${v.toLowerCase()}\``).join(", ")}\n\n`,
    );
  }
  if (flag.expandsTo?.length) {
    md.appendMarkdown(
      `Expands to: ${flag.expandsTo.map((v) => `\`${v}\``).join(" ")}\n\n`,
    );
  }
  if (flag.oldName) {
    md.appendMarkdown(`Formerly \`--${flag.oldName}\`.\n\n`);
  }
  md.appendMarkdown(`Applies to: ${flag.commands.join(", ")}`);
  return md;
}

/** `bazel help <topic>` and `bazel --version`, run like the other commands. */
class BazelHelp extends BazelCommand {
  protected bazelCommand(): string {
    return "help";
  }

  public async topic(name: string): Promise<string> {
    const { stdout } = await execFile(
      this.bazelExecutable,
      this.execArgs([name]),
      { cwd: this.workingDirectory, maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout;
  }

  public async version(): Promise<string> {
    const { stdout } = await execFile(
      this.bazelExecutable,
      [...getStartupOptions(), "--version"],
      { cwd: this.workingDirectory },
    );
    return stdout.trim();
  }
}

/**
 * The Bazel version recorded in a catalogue, read from the head of the
 * file: shipped catalogues are named by LTS line only.
 */
async function catalogueVersion(file: string): Promise<string | undefined> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, "r");
    const { buffer, bytesRead } = await handle.read(
      Buffer.alloc(256),
      0,
      256,
      0,
    );
    return /"bazelVersion"\s*:\s*"([^"]+)"/.exec(
      buffer.toString("utf8", 0, bytesRead),
    )?.[1];
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}
