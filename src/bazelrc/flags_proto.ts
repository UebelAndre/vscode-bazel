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
 * Decoder for the output of `bazel help flags-as-proto`: a base64-encoded
 * `FlagCollection` message (src/main/protobuf/bazel_flags.proto). The
 * message is simple enough that a small wire-format reader is clearer than
 * generated code, and it tolerates fields added by newer Bazel versions.
 */

/** One command-line flag as Bazel describes it. */
export interface FlagInfo {
  name: string;
  /** True when `--no<name>` is accepted. */
  negatable: boolean;
  /** Documentation; may contain simple HTML. */
  doc: string;
  /** Commands the flag applies to, e.g. `build`, `startup`. */
  commands: string[];
  /** Single-letter form, e.g. `k` for `--keep_going`. */
  abbreviation?: string;
  allowsMultiple: boolean;
  requiresValue: boolean;
  /** Previous name of a renamed flag, still accepted. */
  oldName?: string;
  /** Set for deprecated flags. */
  deprecationWarning?: string;
  defaultValue?: string;
  /** Flags an expansion flag stands for. */
  expandsTo?: string[];
  /** Value type name, e.g. `Boolean`, `String`, `RegexFilter`. */
  type?: string;
  /** Accepted values of enum-like flags. */
  allowedValues?: string[];
  /** Documentation category, e.g. `EXECUTION_STRATEGY`. */
  category?: string;
  /** Tags such as `EXPERIMENTAL`, `INCOMPATIBLE_CHANGE`, `DEPRECATED`. */
  metadataTags?: string[];
}

/** The catalogue as stored in data/bazelrc_flags.json. */
export interface FlagCollection {
  /** Output of `bazel --version` the catalogue was generated from. */
  bazelVersion: string;
  flags: FlagInfo[];
}

/** Decodes the base64 text printed by `bazel help flags-as-proto`. */
export function decodeFlagCollection(base64: string): FlagInfo[] {
  const buffer = Buffer.from(base64.trim(), "base64");
  const flags: FlagInfo[] = [];
  for (const field of readFields(buffer)) {
    if (field.fieldNumber === 1 && field.bytes) {
      flags.push(decodeFlagInfo(field.bytes));
    }
  }
  return flags;
}

interface Field {
  fieldNumber: number;
  /** Varint value for wire type 0. */
  varint?: number;
  /** Payload for wire type 2. */
  bytes?: Buffer;
}

function* readFields(buffer: Buffer): Generator<Field> {
  let pos = 0;
  const varint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (pos >= buffer.length) {
        throw new Error("truncated varint");
      }
      const byte = buffer[pos++];
      result += (byte % 128) * 2 ** shift;
      if (byte < 128) {
        return result;
      }
      shift += 7;
    }
  };
  while (pos < buffer.length) {
    const key = varint();
    const fieldNumber = Math.floor(key / 8);
    const wireType = key % 8;
    switch (wireType) {
      case 0:
        yield { fieldNumber, varint: varint() };
        break;
      case 2: {
        const length = varint();
        yield { fieldNumber, bytes: buffer.subarray(pos, pos + length) };
        pos += length;
        break;
      }
      case 1:
        pos += 8;
        break;
      case 5:
        pos += 4;
        break;
      default:
        throw new Error(`unsupported wire type ${wireType}`);
    }
  }
}

function decodeFlagInfo(buffer: Buffer): FlagInfo {
  const flag: FlagInfo = {
    name: "",
    negatable: false,
    doc: "",
    commands: [],
    allowsMultiple: false,
    requiresValue: false,
  };
  const text = (f: Field) => f.bytes?.toString("utf8") ?? "";
  const push = (list: string[] | undefined, value: string) => {
    const result = list ?? [];
    result.push(value);
    return result;
  };
  for (const field of readFields(buffer)) {
    switch (field.fieldNumber) {
      case 1:
        flag.name = text(field);
        break;
      case 2:
        flag.negatable = field.varint === 1;
        break;
      case 3:
        flag.doc = text(field);
        break;
      case 4:
        flag.commands.push(text(field));
        break;
      case 5:
        flag.abbreviation = text(field);
        break;
      case 6:
        flag.allowsMultiple = field.varint === 1;
        break;
      case 8:
        flag.metadataTags = push(flag.metadataTags, text(field));
        break;
      case 9:
        flag.category = text(field);
        break;
      case 10:
        flag.requiresValue = field.varint === 1;
        break;
      case 11:
        flag.oldName = text(field);
        break;
      case 12:
        flag.deprecationWarning = text(field);
        break;
      case 13:
        flag.defaultValue = text(field);
        break;
      case 14:
        flag.expandsTo = push(flag.expandsTo, text(field));
        break;
      case 15:
        flag.type = text(field);
        break;
      case 16:
        flag.allowedValues = push(flag.allowedValues, text(field));
        break;
      default:
        break; // effect tags (7) and unknown newer fields
    }
  }
  return flag;
}
