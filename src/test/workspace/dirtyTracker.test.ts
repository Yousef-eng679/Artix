import { describe, it, expect, beforeEach, vi } from 'vitest';
import { dirtyTracker } from '@/lib/workspace/dirtyTracker';

describe('dirtyTracker', () => {
  beforeEach(() => {
    localStorage.clear();
    dirtyTracker.clear();
  });

  it('marks a resource dirty and clean in memory', () => {
    expect(dirtyTracker.isDirty('doc-1')).toBe(false);

    dirtyTracker.markDirty('doc-1');
    expect(dirtyTracker.isDirty('doc-1')).toBe(true);

    dirtyTracker.markClean('doc-1');
    expect(dirtyTracker.isDirty('doc-1')).toBe(false);
  });

  it('notifies subscribers on status changes', () => {
    const listener = vi.fn();
    const unsubscribe = dirtyTracker.subscribe(listener);

    dirtyTracker.markDirty('doc-1');
    expect(listener).toHaveBeenCalledTimes(1);

    // Idempotent: marking same doc dirty again should not fire extra notify
    dirtyTracker.markDirty('doc-1');
    expect(listener).toHaveBeenCalledTimes(1);

    dirtyTracker.markClean('doc-1');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    dirtyTracker.markDirty('doc-2');
    expect(listener).toHaveBeenCalledTimes(2); // no further calls after unsubscribe
  });

  it('detects dirty state from uncommitted localStorage document drafts', () => {
    expect(dirtyTracker.isDirty('doc-recovered', 'document')).toBe(false);

    // Simulate an uncommitted draft in localStorage
    localStorage.setItem('artix.draft.doc-recovered', 'uncommitted text');

    expect(dirtyTracker.isDirty('doc-recovered', 'document')).toBe(true);

    // Remove draft
    localStorage.removeItem('artix.draft.doc-recovered');
    expect(dirtyTracker.isDirty('doc-recovered', 'document')).toBe(false);
  });

  it('detects dirty state from uncommitted localStorage design drafts', () => {
    expect(dirtyTracker.isDirty('des-recovered', 'design')).toBe(false);

    localStorage.setItem('artix.draft.design-des-recovered', '{"nodes":[],"edges":[]}');

    expect(dirtyTracker.isDirty('des-recovered', 'design')).toBe(true);

    localStorage.removeItem('artix.draft.design-des-recovered');
    expect(dirtyTracker.isDirty('des-recovered', 'design')).toBe(false);
  });

  it('handles empty resourceId gracefully', () => {
    expect(dirtyTracker.isDirty('')).toBe(false);
    dirtyTracker.markDirty('');
    expect(dirtyTracker.isDirty('')).toBe(false);
    dirtyTracker.markClean('');
  });

  it('clears all tracked dirty IDs on clear()', () => {
    dirtyTracker.markDirty('doc-1');
    dirtyTracker.markDirty('doc-2');
    expect(dirtyTracker.isDirty('doc-1')).toBe(true);
    expect(dirtyTracker.isDirty('doc-2')).toBe(true);

    dirtyTracker.clear();

    expect(dirtyTracker.isDirty('doc-1')).toBe(false);
    expect(dirtyTracker.isDirty('doc-2')).toBe(false);
  });
});
