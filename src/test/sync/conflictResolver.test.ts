import { describe, it, expect } from 'vitest';
import { ConflictResolver } from '../../lib/sync/conflictResolver';

describe('ConflictResolver', () => {
  describe('mergeDocumentText (3-Way Merge)', () => {
    it('returns clean merge when only local made changes', () => {
      const base = 'line 1\nline 2\nline 3';
      const local = 'line 1\nline 2 modified\nline 3';
      const remote = 'line 1\nline 2\nline 3';

      const result = ConflictResolver.mergeDocumentText(base, local, remote);
      expect(result.hasConflicts).toBe(false);
      expect(result.mergedText).toBe('line 1\nline 2 modified\nline 3');
    });

    it('returns clean merge when only remote made changes', () => {
      const base = 'line 1\nline 2\nline 3';
      const local = 'line 1\nline 2\nline 3';
      const remote = 'line 1\nline 2\nline 3 modified by cloud';

      const result = ConflictResolver.mergeDocumentText(base, local, remote);
      expect(result.hasConflicts).toBe(false);
      expect(result.mergedText).toBe('line 1\nline 2\nline 3 modified by cloud');
    });

    it('returns clean merge when both made changes in different non-overlapping sections', () => {
      const base = 'line 1\nline 2\nline 3';
      const local = 'line 1 modified by user\nline 2\nline 3';
      const remote = 'line 1\nline 2\nline 3 modified by collaborator';

      const result = ConflictResolver.mergeDocumentText(base, local, remote);
      expect(result.hasConflicts).toBe(false);
      expect(result.mergedText).toBe('line 1 modified by user\nline 2\nline 3 modified by collaborator');
    });

    it('inserts conflict markers when both changed the exact same line differently', () => {
      const base = 'line 1\nline 2\nline 3';
      const local = 'line 1\nline 2 - local rewrite\nline 3';
      const remote = 'line 1\nline 2 - remote rewrite\nline 3';

      const result = ConflictResolver.mergeDocumentText(base, local, remote);
      expect(result.hasConflicts).toBe(true);
      expect(result.conflictBlocksCount).toBe(1);
      expect(result.mergedText).toContain('<<<<<<< LOCAL');
      expect(result.mergedText).toContain('line 2 - local rewrite');
      expect(result.mergedText).toContain('=======');
      expect(result.mergedText).toContain('line 2 - remote rewrite');
      expect(result.mergedText).toContain('>>>>>>> REMOTE');
    });

    it('handles identical concurrent edits without conflict', () => {
      const base = 'line 1';
      const local = 'line 1 updated';
      const remote = 'line 1 updated';

      const result = ConflictResolver.mergeDocumentText(base, local, remote);
      expect(result.hasConflicts).toBe(false);
      expect(result.mergedText).toBe('line 1 updated');
    });
  });

  describe('resolveSystemDesignConflict', () => {
    it('creates a non-destructive conflict copy name preserving payloads', () => {
      const localPayload = { nodes: [{ id: '1' }] };
      const remotePayload = { nodes: [{ id: '2' }] };

      const result = ConflictResolver.resolveSystemDesignConflict(
        'Backend Architecture',
        localPayload,
        remotePayload
      );

      expect(result.conflictCopyName).toContain('Backend Architecture (Conflict Copy');
      expect(result.localPayload).toEqual(localPayload);
      expect(result.remotePayload).toEqual(remotePayload);
    });
  });
});
