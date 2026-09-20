/**
 * autosave.ts
 * ───────────
 * React hook for debounced auto-save with:
 *  - Two-tier caching (localStorage draft → DB write)
 *  - Tab close protection (sendBeacon / keepalive flush)
 *  - Dirty-state tracking for beforeunload
 *
 * The hook's public API is unchanged from the original:
 *   { status, triggerSave, cancelSave }
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createDebouncedSaver, DebouncedSaver } from './cache/debouncedSave';
import { createTabCloseGuard, TabCloseGuard } from './cache/tabCloseGuard';
import { createSaveQueue, SaveQueue } from './cache/saveQueue';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface UseAutoSaveOptions {
  /** Debounce delay in ms before firing the DB save. Default 1500. */
  delay?: number;
  /** The save callback (writes to Supabase). */
  onSave: (content: string) => Promise<void>;
  /** Document ID — enables localStorage draft caching. */
  documentId?: string;
}

/**
 * Endpoint used by the tab-close guard to flush dirty content.
 * In the current architecture the guard's sendBeacon call acts as a
 * best-effort fire-and-forget; the Supabase client SDK handles the
 * real persistence. We use a no-op endpoint here — the guard's main
 * value is the dirty-state tracking which triggers the save via
 * flushSync before the page unloads.
 */
const SAVE_ENDPOINT = '/api/save';

export function useAutoSave({ delay = 1500, onSave, documentId }: UseAutoSaveOptions) {
  const [status, setStatus] = useState<SaveStatus>('idle');

  // Keep onSave in a ref so the debounced saver doesn't re-create on
  // every render when the callback identity changes.
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  // --- Debounced saver ---
  const saverRef = useRef<DebouncedSaver | null>(null);

  // --- Serial save queue ---
  const queueRef = useRef<SaveQueue | null>(null);

  // --- Tab close guard ---
  const guardRef = useRef<TabCloseGuard | null>(null);

  useEffect(() => {
    const guard = createTabCloseGuard(SAVE_ENDPOINT);
    guardRef.current = guard;

    const queue = createSaveQueue(async (payload) => {
      const res = await onSaveRef.current(payload.content);
      return {
        updated_at: (res as any)?.updated_at || new Date().toISOString(),
      };
    });
    queueRef.current = queue;

    const wrappedSave = async (content: string) => {
      try {
        setStatus('saving');
        await queue.enqueue({ id: documentId || 'current-doc', content });
        // Mark clean — DB save succeeded
        if (documentId) guard.markClean(documentId);
        setStatus('saved');
        setTimeout(() => setStatus('idle'), 2000);
      } catch (error) {
        console.error('Auto-save failed:', error);
        setStatus('error');
      }
    };

    const saver = createDebouncedSaver(wrappedSave, delay, documentId);
    saverRef.current = saver;

    // Wire beforeunload to flush pending saves
    const onBeforeUnload = () => {
      saver.flushSync();
      guard.handleBeforeUnload();
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      saver.cancel();
      guard.destroy();
    };
  }, [delay, documentId]);

  const triggerSave = useCallback(
    (content: string) => {
      // Mark dirty in the tab-close guard
      if (documentId && guardRef.current) {
        guardRef.current.markDirty(documentId, content);
      }
      saverRef.current?.save(content);
    },
    [documentId],
  );

  const cancelSave = useCallback(() => {
    saverRef.current?.cancel();
  }, []);

  const getVersion = useCallback(
    (id?: string) => queueRef.current?.getVersion(id || documentId || 'current-doc'),
    [documentId],
  );

  return { status, triggerSave, cancelSave, getVersion };
}
