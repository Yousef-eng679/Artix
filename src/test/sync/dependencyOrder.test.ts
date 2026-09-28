import { describe, it, expect } from 'vitest';
import { OutboxEntry } from '@/lib/local/types';
import { orderOutboxByDependency } from '@/lib/sync/dependencyOrder';

describe('Phase 4: Outbox Dependency Ordering', () => {
  const makeEntry = (
    id: string,
    entityType: OutboxEntry['entityType'],
    entityId: string,
    operation: OutboxEntry['operation'],
    payload: unknown,
    createdAt: number
  ): OutboxEntry => ({
    id,
    userId: 'user-1',
    projectId: 'proj-1',
    entityType,
    entityId,
    operation,
    payload,
    baseServerVersion: null,
    localRevision: 1,
    state: 'pending',
    attemptCount: 0,
    createdAt,
    updatedAt: createdAt,
  });

  it('orders parent folder creation before child folder creation', () => {
    // Child folder enqueued at t=100 referencing parent folder enqueued at t=200
    const childFolder = makeEntry(
      'outbox-child-f',
      'workspace_folder',
      'folder-child',
      'create',
      { name: 'Subfolder', parentFolderId: 'folder-parent' },
      100
    );

    const parentFolder = makeEntry(
      'outbox-parent-f',
      'workspace_folder',
      'folder-parent',
      'create',
      { name: 'Root Folder', parentFolderId: null },
      200
    );

    const sorted = orderOutboxByDependency([childFolder, parentFolder]);

    expect(sorted.map((e) => e.entityId)).toEqual(['folder-parent', 'folder-child']);
  });

  it('orders folder creation before documents and designs referencing that folder', () => {
    const doc1 = makeEntry(
      'outbox-doc-1',
      'document',
      'doc-1',
      'create',
      { title: 'Doc in Folder', folderId: 'folder-A' },
      100
    );

    const design1 = makeEntry(
      'outbox-design-1',
      'system_design',
      'design-1',
      'create',
      { name: 'Design in Folder', folderId: 'folder-A' },
      150
    );

    const folderA = makeEntry(
      'outbox-folder-A',
      'workspace_folder',
      'folder-A',
      'create',
      { name: 'Folder A' },
      200
    );

    const sorted = orderOutboxByDependency([doc1, design1, folderA]);

    // folder-A must be index 0
    expect(sorted[0].entityId).toBe('folder-A');
    // doc1 and design1 follow after folder-A
    expect(sorted.slice(1).map((e) => e.entityId)).toEqual(['doc-1', 'design-1']);
  });

  it('orders child entity deletion before parent folder deletion', () => {
    const folderDelete = makeEntry(
      'outbox-del-folder',
      'workspace_folder',
      'folder-X',
      'delete',
      null,
      100
    );

    const docDelete = makeEntry(
      'outbox-del-doc',
      'document',
      'doc-X',
      'delete',
      { folderId: 'folder-X' },
      200
    );

    const sorted = orderOutboxByDependency([folderDelete, docDelete]);

    // Child document delete must precede folder delete
    expect(sorted.map((e) => e.entityId)).toEqual(['doc-X', 'folder-X']);
  });

  it('preserves chronological FIFO ordering for independent mutations', () => {
    const docA = makeEntry('e1', 'document', 'd-1', 'create', { title: 'A' }, 10);
    const docB = makeEntry('e2', 'document', 'd-2', 'create', { title: 'B' }, 20);
    const docC = makeEntry('e3', 'document', 'd-3', 'create', { title: 'C' }, 30);

    const sorted = orderOutboxByDependency([docC, docA, docB]);

    expect(sorted.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('preserves strict chronological order for mutations on the exact same entity', () => {
    const createDoc = makeEntry('e1', 'document', 'd-same', 'create', { title: 'Initial' }, 10);
    const updateDoc1 = makeEntry('e2', 'document', 'd-same', 'update', { title: 'V2' }, 20);
    const updateDoc2 = makeEntry('e3', 'document', 'd-same', 'update', { title: 'V3' }, 30);

    const sorted = orderOutboxByDependency([updateDoc2, createDoc, updateDoc1]);

    expect(sorted.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
  });
});
