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

export class ConflictResolver {
  /**
   * Performs a robust line-based 3-way text merge for documents.
   * Compares Base, Local, and Remote lines:
   * - If only Local changed -> apply Local
   * - If only Remote changed -> apply Remote
   * - If both made identical changes -> apply change cleanly
   * - If both made conflicting changes -> insert standard conflict markers:
   *   <<<<<<< LOCAL
   *   ...
   *   =======
   *   ...
   *   >>>>>>> REMOTE
   */
  static mergeDocumentText(
    baseText: string,
    localText: string,
    remoteText: string
  ): Document3WayMergeResult {
    // If identical, merge is trivial
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

    const merged: string[] = [];
    let hasConflicts = false;
    let conflictBlocksCount = 0;

    let bIdx = 0;
    let lIdx = 0;
    let rIdx = 0;

    while (lIdx < localLines.length || rIdx < remoteLines.length) {
      const bLine = bIdx < baseLines.length ? baseLines[bIdx] : undefined;
      const lLine = lIdx < localLines.length ? localLines[lIdx] : undefined;
      const rLine = rIdx < remoteLines.length ? remoteLines[rIdx] : undefined;

      // Both agree on the line
      if (lLine === rLine) {
        if (lLine !== undefined) merged.push(lLine);
        bIdx++;
        lIdx++;
        rIdx++;
        continue;
      }

      // Local line didn't change from base, but remote changed -> take remote
      if (lLine === bLine && rLine !== undefined) {
        merged.push(rLine);
        bIdx++;
        lIdx++;
        rIdx++;
        continue;
      }

      // Remote line didn't change from base, but local changed -> take local
      if (rLine === bLine && lLine !== undefined) {
        merged.push(lLine);
        bIdx++;
        lIdx++;
        rIdx++;
        continue;
      }

      // Both changed differently -> conflict block
      hasConflicts = true;
      conflictBlocksCount++;

      merged.push('<<<<<<< LOCAL');
      if (lLine !== undefined) merged.push(lLine);
      merged.push('=======');
      if (rLine !== undefined) merged.push(rLine);
      merged.push('>>>>>>> REMOTE');

      bIdx++;
      lIdx++;
      rIdx++;
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
    remotePayload: unknown
  ): DesignConflictResult {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const conflictCopyName = `${designName} (Conflict Copy - ${timestamp})`;

    return {
      conflictCopyName,
      localPayload,
      remotePayload,
    };
  }
}
