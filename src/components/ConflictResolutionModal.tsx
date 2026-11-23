import { useCallback, useEffect, useMemo, useState } from 'react';
import { liveQuery } from 'dexie';
import { GitMerge } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useUserSyncRuntime } from '@/contexts/UserSyncRuntimeContext';
import { ConflictRepository, ConflictStrategy } from '@/lib/repositories/conflictRepository';
import { ConflictResolver } from '@/lib/sync/conflictResolver';
import type { ConflictRecord, EntityType } from '@/lib/local/types';

const ENTITY_LABELS: Record<EntityType, string> = {
  project: 'Project',
  document: 'Document',
  system_design: 'System design',
  workspace_folder: 'Folder',
};

const CONFLICT_MARKER = /^(<{7}|={7}|>{7})/m;

function payloadName(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const name = p.title ?? p.name;
  return typeof name === 'string' && name.trim() ? name : null;
}

function payloadContent(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const content = (payload as Record<string, unknown>).content;
  return typeof content === 'string' ? content : null;
}

function isRemoteDeleted(conflict: ConflictRecord): boolean {
  return conflict.reason === 'remote_deleted' || (conflict.remotePayload as any)?.deleted === true;
}

function isLocalDeleted(conflict: ConflictRecord): boolean {
  return (conflict.localPayload as any)?.deleted === true;
}

/**
 * Amendment D: the conflict UI is driven by unresolved rows in `db.conflicts`
 * (`resolvedAt` empty), observed live across tabs — not by `sync_metadata.syncState`.
 */
function useUnresolvedConflicts(): ConflictRecord[] {
  const runtime = useUserSyncRuntime();
  const db = runtime?.db ?? null;
  const userId = runtime?.runtime?.userId;
  const [conflicts, setConflicts] = useState<ConflictRecord[]>([]);

  useEffect(() => {
    if (!db) {
      setConflicts([]);
      return;
    }
    const subscription = liveQuery(() =>
      db.conflicts
        .filter((c) => !c.resolvedAt && (!userId || c.userId === userId))
        .toArray()
    ).subscribe({
      next: (rows) => setConflicts([...rows].sort((a, b) => a.detectedAt - b.detectedAt)),
      error: (err) => console.warn('[ConflictResolutionCenter] live conflict query failed:', err),
    });
    return () => subscription.unsubscribe();
  }, [db, userId]);

  return conflicts;
}

interface ConflictResolutionModalProps {
  conflicts: ConflictRecord[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ConflictResolutionModal({ conflicts, open, onOpenChange }: ConflictResolutionModalProps) {
  const runtime = useUserSyncRuntime();
  const db = runtime?.db ?? null;
  const syncEngine = runtime?.syncEngine ?? null;
  const userId = runtime?.runtime?.userId;
  const conflictRepo = useMemo<ConflictRepository | null>(
    () => runtime?.runtime?.conflictRepo ?? (db ? new ConflictRepository(db) : null),
    [runtime?.runtime?.conflictRepo, db]
  );

  const conflict = conflicts[0] ?? null;
  const [localName, setLocalName] = useState<string | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mergeText, setMergeText] = useState<string | null>(null);

  // Resolve a human-readable name (outbox payloads for updates may be partial)
  useEffect(() => {
    setMergeText(null);
    setError(null);
    setLocalName(null);
    if (!conflict || !db) return;
    let cancelled = false;
    const tableByType = {
      project: db.projects,
      document: db.documents,
      system_design: db.system_designs,
      workspace_folder: db.workspace_folders,
    } as const;
    const table = tableByType[conflict.entityType];
    table
      ?.get(conflict.entityId)
      .then((row: any) => {
        if (!cancelled) setLocalName(row?.title ?? row?.name ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conflict?.id, db]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open && conflicts.length === 0) onOpenChange(false);
  }, [open, conflicts.length, onOpenChange]);

  const resolve = useCallback(
    async (strategy: ConflictStrategy, mergedContent?: string) => {
      if (!conflict || !conflictRepo) return;
      setIsWorking(true);
      setError(null);
      try {
        await conflictRepo.resolveConflict({ conflictId: conflict.id, strategy, mergedContent });
        setMergeText(null);
        syncEngine?.triggerSync(userId ?? conflict.userId).catch(() => {
          /* sync failures surface through the sync status banner */
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to resolve conflict');
      } finally {
        setIsWorking(false);
      }
    },
    [conflict, conflictRepo, syncEngine, userId]
  );

  if (!conflict) return null;

  const label = ENTITY_LABELS[conflict.entityType] ?? 'Item';
  const name =
    payloadName(conflict.localPayload) ?? localName ?? payloadName(conflict.remotePayload) ?? `Untitled ${label.toLowerCase()}`;
  const remoteDeleted = isRemoteDeleted(conflict);
  const localDeleted = isLocalDeleted(conflict);

  const baseContent = payloadContent(conflict.basePayload);
  const localContent = payloadContent(conflict.localPayload);
  const remoteContent = payloadContent(conflict.remotePayload);
  const canMerge =
    conflict.entityType === 'document' &&
    !remoteDeleted &&
    !localDeleted &&
    localContent !== null &&
    remoteContent !== null;

  const description = remoteDeleted
    ? 'This item was deleted on another device, but you have unsynced changes here.'
    : localDeleted
      ? 'You deleted this item here, but it was changed on another device.'
      : 'This item was changed on another device while you had unsynced edits here.';

  const startMerge = () => {
    const suggestion = ConflictResolver.mergeDocumentText(
      baseContent ?? '',
      localContent ?? '',
      remoteContent ?? ''
    );
    setMergeText(suggestion.mergedText);
  };

  const mergeHasMarkers =
    mergeText !== null && ConflictResolver.hasUnresolvedConflictMarkers(mergeText);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="conflict-modal" className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            Sync conflict{conflicts.length > 1 ? ` (1 of ${conflicts.length})` : ''}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm">
          <span className="text-muted-foreground">{label}: </span>
          <span className="font-medium" data-testid="conflict-entity-name">{name}</span>
        </div>

        {mergeText !== null && (
          <div className="space-y-2">
            <Textarea
              data-testid="conflict-merge-textarea"
              value={mergeText}
              onChange={(e) => setMergeText(e.target.value)}
              className="min-h-[200px] font-mono text-xs"
            />
            {mergeHasMarkers && (
              <p className="text-xs text-amber-600">
                Remove all conflict markers (&lt;&lt;&lt;&lt;&lt;&lt;&lt;, =======, &gt;&gt;&gt;&gt;&gt;&gt;&gt;) before saving.
              </p>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter className="flex-wrap gap-2 sm:justify-start">
          {mergeText !== null ? (
            <>
              <Button
                data-testid="conflict-save-merge-btn"
                disabled={isWorking || mergeHasMarkers}
                onClick={() => resolve('merge_document', mergeText)}
              >
                Save merged version
              </Button>
              <Button variant="ghost" disabled={isWorking} onClick={() => setMergeText(null)}>
                Cancel merge
              </Button>
            </>
          ) : (
            <>
              <Button data-testid="conflict-keep-local-btn" disabled={isWorking} onClick={() => resolve('keep_local')}>
                {remoteDeleted ? 'Restore my version' : localDeleted ? 'Keep it deleted' : 'Keep mine'}
              </Button>
              <Button
                data-testid="conflict-keep-remote-btn"
                variant="outline"
                disabled={isWorking}
                onClick={() => resolve('keep_remote')}
              >
                {remoteDeleted ? 'Accept deletion' : 'Keep server version'}
              </Button>
              {!localDeleted && (
                <Button
                  data-testid="conflict-create-copy-btn"
                  variant="outline"
                  disabled={isWorking}
                  onClick={() => resolve('create_copy')}
                >
                  Save mine as a copy
                </Button>
              )}
              {canMerge && (
                <Button data-testid="conflict-merge-btn" variant="secondary" disabled={isWorking} onClick={startMerge}>
                  <GitMerge className="h-4 w-4 mr-1.5" aria-hidden="true" />
                  Merge
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Banner + modal entry point. Renders nothing while there are no unresolved conflicts.
 */
export function ConflictResolutionCenter() {
  const conflicts = useUnresolvedConflicts();
  const [open, setOpen] = useState(false);

  if (conflicts.length === 0) return null;

  const count = conflicts.length;
  return (
    <>
      <div
        role="status"
        data-testid="conflict-banner"
        className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm border-b border-destructive/30 bg-destructive/10"
      >
        <GitMerge className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="flex-1 min-w-0">
          {count} sync {count === 1 ? 'conflict needs' : 'conflicts need'} your attention. Nothing has been lost.
        </span>
        <Button size="sm" variant="secondary" data-testid="review-conflicts-btn" onClick={() => setOpen(true)}>
          Review
        </Button>
      </div>
      <ConflictResolutionModal conflicts={conflicts} open={open} onOpenChange={setOpen} />
    </>
  );
}
