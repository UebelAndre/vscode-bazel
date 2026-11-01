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

/** Converts between offsets and (line, column) pairs for a source text. */
export class LineIndex {
  private readonly lineStarts: number[] = [0];

  constructor(text: string) {
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10 /* \n */) {
        this.lineStarts.push(i + 1);
      }
    }
  }

  /** Returns the 0-based line and column for an offset. */
  public position(offset: number): { line: number; column: number } {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (this.lineStarts[mid] <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return { line: lo, column: offset - this.lineStarts[lo] };
  }

  /** Returns the offset of the start of a 0-based line. */
  public offsetOfLine(line: number): number {
    if (line < 0) {
      return 0;
    }
    if (line >= this.lineStarts.length) {
      return this.lineStarts[this.lineStarts.length - 1];
    }
    return this.lineStarts[line];
  }

  public get lineCount(): number {
    return this.lineStarts.length;
  }
}
