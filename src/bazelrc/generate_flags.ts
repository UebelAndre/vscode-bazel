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
 * Generates the catalogues of Bazel flags behind `.bazelrc` completion, one
 * per supported LTS line, from `bazel help flags-as-proto`. Run it with
 * `bazel run //:update_bazelrc_flags` (or `npm run update-bazelrc-flags`).
 * Each LTS line is resolved through bazelisk (`USE_BAZEL_VERSION=8.x`), so
 * bazelisk must be on PATH or named by `$BAZELISK`. Under `bazel run` the
 * output goes to the source tree (`BUILD_WORKSPACE_DIRECTORY`). No VS Code
 * dependency, so this runs under plain node.
 */

import * as child_process from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { CATALOGUE_PREFIX, LTS_MAJORS } from "./flag_index";
import { FlagCollection, decodeFlagCollection } from "./flags_proto";

/** Finds bazelisk, skipping the Bazel binaries bazelisk itself puts on PATH. */
function findBazelisk(): string {
  if (process.env.BAZELISK) {
    return process.env.BAZELISK;
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir || /bazelisk[/\\]downloads/.test(dir)) {
      continue;
    }
    for (const name of ["bazelisk", "bazelisk.exe"]) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  throw new Error(
    "bazelisk not found on PATH; install it or set BAZELISK=/path/to/bazelisk",
  );
}

function generate(
  bazelisk: string,
  major: string,
  cwd: string,
): FlagCollection {
  const env = { ...process.env, USE_BAZEL_VERSION: `${major}.x` };
  const run = (args: string[]) =>
    child_process.execFileSync(bazelisk, args, {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    });
  const version = run(["--version"])
    .trim()
    .replace(/^bazel\s+/, "");
  if (!version.startsWith(`${major}.`)) {
    throw new Error(`asked bazelisk for ${major}.x but got ${version}`);
  }
  const flags = decodeFlagCollection(run(["help", "flags-as-proto"])).sort(
    (a, b) => a.name.localeCompare(b.name),
  );
  return { bazelVersion: version, flags };
}

function main() {
  // Usage: [--out=<dir>] [<major>...]; defaults to data/ and every LTS line.
  const args = process.argv.slice(2);
  const workspace = process.env.BUILD_WORKSPACE_DIRECTORY ?? process.cwd();
  const outDir =
    args.find((a) => a.startsWith("--out="))?.slice("--out=".length) ??
    path.join(workspace, "data");
  const requested = args.filter((a) => !a.startsWith("--"));
  const majors = requested.length ? requested : LTS_MAJORS;
  const bazelisk = findBazelisk();
  // `bazel help` needs no workspace. Running elsewhere keeps the three
  // Bazel versions away from this repository's server and rc files.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bazelrc-flags-"));
  fs.mkdirSync(outDir, { recursive: true });
  for (const major of majors) {
    const collection = generate(bazelisk, major, scratch);
    const out = path.join(outDir, `${CATALOGUE_PREFIX}${major}.json`);
    fs.writeFileSync(out, JSON.stringify(collection) + "\n");
    process.stdout.write(
      `Wrote ${collection.flags.length} flags of Bazel ${collection.bazelVersion} to ${out}\n`,
    );
  }
}

main();
