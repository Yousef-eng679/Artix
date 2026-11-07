export interface Document3WayMergeResult {
  mergedText: string;
  hasConflicts: boolean;
  conflictBlocksCount: number;
}

export interface DesignConflictResult {
  conflictCopyName: string;
  localPayload: unknown;
  remotePayload: unknown;
}

const UNRESOLVED_MARKER_START = /^<{7}(?:\s.*)?$/m;
const UNRESOLVED_MARKER_END = /^>{7}(?:\s.*)?$/m;

function linesEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Computes a strictly monotonic 1-to-1 Longest Common Subsequence (LCS) mapping
 * from `base` line indices to `target` line indices (`map[baseIdx] = targetIdx` or `-1`).
 * Strips common prefixes and suffixes in O(N) before running compact Int32Array DP
 * on the interior diff window.
 */
function computeLcsMapping(base: readonly string[], target: readonly string[]): Int32Array {
  const n = base.length;
  const m = target.length;
  const mapping = new Int32Array(n).fill(-1);

  let prefix = 0;
  while (prefix < n && prefix < m && base[prefix] === target[prefix]) {
    mapping[prefix] = prefix;
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < n - prefix &&
    suffix < m - prefix &&
    base[n - 1 - suffix] === target[m - 1 - suffix]
  ) {
    mapping[n - 1 - suffix] = m - 1 - suffix;
    suffix++;
  }

  const bLen = n - prefix - suffix;
  const tLen = m - prefix - suffix;
  if (bLen <= 0 || tLen <= 0) {
    return mapping;
  }

  const cols = tLen + 1;
  const dp = new Int32Array((bLen + 1) * cols);

  for (let i = bLen - 1; i >= 0; i--) {
    const bLine = base[prefix + i];
    const rowOffset = i * cols;
    const nextRowOffset = (i + 1) * cols;
    for (let j = tLen - 1; j >= 0; j--) {
      if (bLine === target[prefix + j]) {
        dp[rowOffset + j] = dp[nextRowOffset + j + 1] + 1;
      } else {
        const down = dp[nextRowOffset + j];
        const right = dp[rowOffset + j + 1];
        dp[rowOffset + j] = down >= right ? down : right;
      }
    }
  }

  let i = 0;
  let j = 0;
  while (i < bLen && j < tLen) {
    if (base[prefix + i] === target[prefix + j]) {
      mapping[prefix + i] = prefix + j;
      i++;
      j++;
    } else if (dp[(i + 1) * cols + j] >= dp[i * cols + j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  return mapping;
}

export class ConflictResolver {
  /**
   * Returns `true` when `content` contains unresolved Git/diff3 conflict markers
   * (`<<<<<<< ...` or `>>>>>>> ...`). Avoids false positives on Markdown Setext H1
   * `=======` headings when no conflict boundary markers are present.
   */
  static hasUnresolvedConflictMarkers(content: string): boolean {
    if (!content) return false;
    return UNRESOLVED_MARKER_START.test(content) || UNRESOLVED_MARKER_END.test(content);
  }

  /**
   * Performs a true LCS-aligned 3-way `diff3` text merge (Khanna-Kunal-Pierce model):
   * - Non-overlapping insertions, deletions, and edits merge cleanly even when line
   *   numbers shift across the document.
   * - Identical concurrent edits (false conflicts) converge cleanly.
   * - Overlapping divergent hunks emit standard conflict markers:
   *     <<<<<<< LOCAL
   *     ...
   *     =======
   *     ...
   *     >>>>>>> REMOTE
   */
  static mergeDocumentText(
    baseText: string,
    localText: string,
    remoteText: string,
  ): Document3WayMergeResult {
    if (localText === remoteText) {
      return { mergedText: localText, hasConflicts: false, conflictBlocksCount: 0 };
    }
    if (baseText === localText) {
      return { mergedText: remoteText, hasConflicts: false, conflictBlocksCount: 0 };
    }
    if (baseText === remoteText) {
      return { mergedText: localText, hasConflicts: false, conflictBlocksCount: 0 };
    }

    const baseLines = baseText.split('\n');
    const localLines = localText.split('\n');
    const remoteLines = remoteText.split('\n');

    const mapLocal = computeLcsMapping(baseLines, localLines);
    const mapRemote = computeLcsMapping(baseLines, remoteLines);

    const merged: string[] = [];
    let hasConflicts = false;
    let conflictBlocksCount = 0;

    let o = 0;
    let a = 0;
    let b = 0;

    while (o < baseLines.length || a < localLines.length || b < remoteLines.length) {
      // Stable synchronized anchor line with zero preceding insertions on either side
      if (o < baseLines.length && mapLocal[o] === a && mapRemote[o] === b) {
        merged.push(baseLines[o]);
        o++;
        a++;
        b++;
        continue;
      }

      // Find the next common anchor line in `base` preserved by BOTH `local` and `remote`
      let oSync = baseLines.length;
      let aSync = localLines.length;
      let bSync = remoteLines.length;

      for (let k = o; k < baseLines.length; k++) {
        const lk = mapLocal[k];
        const rk = mapRemote[k];
        if (lk >= a && rk >= b) {
          oSync = k;
          aSync = lk;
          bSync = rk;
          break;
        }
      }

      const baseHunk = baseLines.slice(o, oSync);
      const localHunk = localLines.slice(a, aSync);
      const remoteHunk = remoteLines.slice(b, bSync);

      if (linesEqual(localHunk, remoteHunk)) {
        merged.push(...localHunk);
      } else if (linesEqual(baseHunk, localHunk)) {
        merged.push(...remoteHunk);
      } else if (linesEqual(baseHunk, remoteHunk)) {
        merged.push(...localHunk);
      } else {
        hasConflicts = true;
        conflictBlocksCount++;
        merged.push('<<<<<<< LOCAL');
        merged.push(...localHunk);
        merged.push('=======');
        merged.push(...remoteHunk);
        merged.push('>>>>>>> REMOTE');
      }

      o = oSync;
      a = aSync;
      b = bSync;
    }

    return {
      mergedText: merged.join('\n'),
      hasConflicts,
      conflictBlocksCount,
    };
  }

  /**
   * Generates a safe non-destructive conflict copy name for system designs.
   */
  static resolveSystemDesignConflict(
    designName: string,
    localPayload: unknown,
    remotePayload: unknown,
  ): DesignConflictResult {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const conflictCopyName = `${designName} (Conflict Copy - ${timestamp})`;

    return {
      conflictCopyName,
      localPayload,
      remotePayload,
    };
  }

  /**
   * Normalizes a folder name using canonical Unicode normalization (NFKC),
   * trimming extraneous whitespace, and providing a safe default.
   */
  static normalizeFolderName(rawName: string): string {
    if (!rawName) return 'Untitled Folder';
    const normalized = rawName.normalize('NFKC').trim();
    return normalized.length > 0 ? normalized : 'Untitled Folder';
  }

  /**
   * Generates a conflict copy name for a folder avoiding collisions.
   */
  static resolveFolderConflictName(baseName: string, existingNames: string[] = []): string {
    const cleanBase = this.normalizeFolderName(baseName);
    const candidate = `${cleanBase} (Conflict Copy)`;
    if (!existingNames.includes(candidate)) {
      return candidate;
    }

    let counter = 2;
    while (existingNames.includes(`${cleanBase} (Conflict Copy ${counter})`)) {
      counter++;
    }
    return `${cleanBase} (Conflict Copy ${counter})`;
  }
}
