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

    it('fast paths when local equals remote', () => {
      const text = 'identical content\nacross all';
      const result = ConflictResolver.mergeDocumentText('different base', text, text);
      expect(result.hasConflicts).toBe(false);
      expect(result.mergedText).toBe(text);
      expect(result.conflictBlocksCount).toBe(0);
    });

    it('fast paths when local has not changed from base', () => {
      const base = 'original base';
      const remote = 'updated remote';
      const result = ConflictResolver.mergeDocumentText(base, base, remote);
      expect(result.hasConflicts).toBe(false);
      expect(result.mergedText).toBe(remote);
    });

    it('fast paths when remote has not changed from base', () => {
      const base = 'original base';
      const local = 'updated local';
      const result = ConflictResolver.mergeDocumentText(base, local, base);
      expect(result.hasConflicts).toBe(false);
      expect(result.mergedText).toBe(local);
    });

    it('handles multiple separate conflict blocks across document', () => {
      const base = 'section 1\ncommon text\nsection 2';
      const local = 'section 1 - local edit\ncommon text\nsection 2 - local edit';
      const remote = 'section 1 - remote edit\ncommon text\nsection 2 - remote edit';

      const result = ConflictResolver.mergeDocumentText(base, local, remote);
      expect(result.hasConflicts).toBe(true);
      expect(result.conflictBlocksCount).toBe(2);
      expect(result.mergedText).toContain('common text');
      expect(result.mergedText.split('<<<<<<< LOCAL').length - 1).toBe(2);
    });

    it('handles empty base with conflicting initial additions', () => {
      const base = '';
      const local = 'Initial content by Alice';
      const remote = 'Initial content by Bob';

      const result = ConflictResolver.mergeDocumentText(base, local, remote);
      expect(result.hasConflicts).toBe(true);
      expect(result.conflictBlocksCount).toBe(1);
      expect(result.mergedText).toContain('Alice');
      expect(result.mergedText).toContain('Bob');
    });

    it('handles clean append when one side adds lines at the end', () => {
      const base = 'line 1\nline 2';
      const local = 'line 1\nline 2\nline 3 appended';
      const remote = 'line 1\nline 2';

      const result = ConflictResolver.mergeDocumentText(base, local, remote);
      expect(result.hasConflicts).toBe(false);
      expect(result.mergedText).toBe('line 1\nline 2\nline 3 appended');
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

    it('handles complex nested boardState structures safely', () => {
      const localBoard = {
        nodes: [{ id: 'n1', data: { label: 'Auth' } }],
        edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
        strokes: [{ points: [{ x: 0, y: 0 }] }],
      };
      const remoteBoard = {
        nodes: [{ id: 'n1', data: { label: 'Auth V2' } }],
        edges: [],
      };

      const result = ConflictResolver.resolveSystemDesignConflict(
        'Network Topology',
        localBoard,
        remoteBoard
      );

      expect(result.conflictCopyName).toContain('Network Topology (Conflict Copy');
      expect(result.localPayload).toBe(localBoard);
      expect(result.remotePayload).toBe(remoteBoard);
    });
  });
});
