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

import { AssignStmt, DefStmt } from "../starlark";
import { BzlFileModel, assignedIdents } from "./file_models";

/** How name resolution reaches other files. */
export interface ModuleLoader {
  /** Resolves a `load()` module label as seen from `fromFile` to a path. */
  resolveModule(
    moduleLabel: string,
    fromFile: string,
  ): Promise<string | undefined>;
  /** Returns the parsed model of a Starlark file. */
  getModel(file: string): BzlFileModel | undefined;
}

/** What a top-level name is bound to, after following loads and aliases. */
export interface Binding {
  file: string;
  model: BzlFileModel;
  stmt: AssignStmt | DefStmt;
  /** The name of the binding in `file` (differs from the query across aliases). */
  name: string;
}

const MAX_DEPTH = 24;

/**
 * Resolves top-level names across Starlark files: a `def`, an assignment,
 * a `load()` of another file, or an alias such as `foo = _foo`, followed
 * until the defining statement is found. Results are cached per file and
 * name until {@link clear} is called.
 */
export class BindingResolver {
  private readonly cache = new Map<string, Promise<Binding | undefined>>();

  constructor(private readonly loader: ModuleLoader) {}

  /** Drops cached results: all of them, or those asked from one file. */
  public clear(file?: string) {
    if (file === undefined) {
      this.cache.clear();
      return;
    }
    const prefix = `${file}\u0000`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /** Finds what `name` is bound to in `file`. */
  public bindingFor(name: string, file: string): Promise<Binding | undefined> {
    const key = `${file}\u0000${name}`;
    let cached = this.cache.get(key);
    if (cached === undefined) {
      cached = this.resolve(name, file, 0).catch((): undefined => undefined);
      this.cache.set(key, cached);
    }
    return cached;
  }

  private async resolve(
    name: string,
    file: string,
    depth: number,
  ): Promise<Binding | undefined> {
    if (depth > MAX_DEPTH) {
      return undefined;
    }
    const model = this.loader.getModel(file);
    if (!model) {
      return undefined;
    }
    for (const stmt of model.module.stmts) {
      if (stmt.kind === "def" && stmt.name === name) {
        return { file, model, stmt, name };
      }
      if (stmt.kind === "assign" && stmt.op === "=") {
        // `CcInfo, _ = provider(...)`: every element names the same value.
        if (!assignedIdents(stmt.target).some((e) => e.name === name)) {
          continue;
        }
        if (
          stmt.target.kind === "ident" &&
          stmt.value.kind === "ident" &&
          stmt.value.name !== name
        ) {
          // `foo = _foo`: follow the alias.
          const aliased = await this.resolve(stmt.value.name, file, depth + 1);
          return aliased ?? { file, model, stmt, name };
        }
        return { file, model, stmt, name };
      }
    }
    for (const load of model.loads) {
      const symbol = load.symbols.find((s) => s.local === name);
      if (!symbol) {
        continue;
      }
      const target = await this.loader.resolveModule(load.module, file);
      return target
        ? this.resolve(symbol.original, target, depth + 1)
        : undefined;
    }
    return undefined;
  }
}
