import { describe, it, expect } from 'vitest';
import { groupResourcesByFolder } from '@/lib/workspace/groupResourcesByFolder';
import { WorkspaceResource, WorkspaceFolder } from '@/types/workspace';

describe('groupResourcesByFolder Pure Utility', () => {
  const projectId = 'proj-test-123';

  const makeResource = (
    id: string,
    title: string,
    folderId: string | null = null,
    kind: 'document' | 'design' = 'document',
    updatedAt: string = '2026-09-01T00:00:00Z'
  ): WorkspaceResource => ({
    id,
    projectId,
    title,
    kind,
    updatedAt,
    folderId,
  });

  const makeFolder = (
    id: string,
    name: string,
    updatedAt: string = '2026-09-01T00:00:00Z'
  ): WorkspaceFolder => ({
    id,
    projectId,
    name,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt,
  });

  it('returns a single root group when both resources and folders are empty', () => {
    const result = groupResourcesByFolder([], []);
    expect(result).toHaveLength(1);
    expect(result[0].folder).toBeNull();
    expect(result[0].resources).toEqual([]);
  });

  it('places resources with folderId === null into the root group', () => {
    const r1 = makeResource('r1', 'Root Doc 1', null);
    const r2 = makeResource('r2', 'Root Design 1', null, 'design');

    const result = groupResourcesByFolder([r1, r2], []);
    expect(result).toHaveLength(1);
    expect(result[0].folder).toBeNull();
    expect(result[0].resources).toEqual([r1, r2]);
  });

  it('groups resources into their corresponding folder', () => {
    const folder = makeFolder('f1', 'Authentication');
    const r1 = makeResource('r1', 'Auth Spec', 'f1');
    const r2 = makeResource('r2', 'Auth Flow', 'f1', 'design');
    const rRoot = makeResource('r3', 'Global Notes', null);

    const result = groupResourcesByFolder([r1, r2, rRoot], [folder]);

    expect(result).toHaveLength(2);
    expect(result[0].folder?.name).toBe('Authentication');
    expect(result[0].resources).toEqual([r1, r2]);
    expect(result[1].folder).toBeNull();
    expect(result[1].resources).toEqual([rRoot]);
  });

  it('includes empty folders with an empty resources array', () => {
    const fEmpty = makeFolder('f-empty', 'Deployment');
    const rRoot = makeResource('r1', 'Project Architecture', null);

    const result = groupResourcesByFolder([rRoot], [fEmpty]);

    expect(result).toHaveLength(2);
    expect(result[0].folder?.id).toBe('f-empty');
    expect(result[0].resources).toEqual([]);
    expect(result[1].folder).toBeNull();
    expect(result[1].resources).toEqual([rRoot]);
  });

  it('gracefully routes orphan resources (non-existent folderId) to root', () => {
    const f1 = makeFolder('f1', 'Security');
    const rNormal = makeResource('r1', 'Security PRD', 'f1');
    const rOrphan = makeResource('r2', 'Ghost Resource', 'f-deleted-999');

    const result = groupResourcesByFolder([rNormal, rOrphan], [f1]);

    expect(result).toHaveLength(2);
    expect(result[0].folder?.id).toBe('f1');
    expect(result[0].resources).toEqual([rNormal]);
    expect(result[1].folder).toBeNull();
    expect(result[1].resources).toEqual([rOrphan]);
  });

  it('sorts folders deterministically: name ASC, then id ASC', () => {
    const fZ = makeFolder('f-z', 'Zebra Subsystem');
    const fA2 = makeFolder('f-a2', 'Alpha Gateway');
    const fA1 = makeFolder('f-a1', 'Alpha Gateway');
    const fM = makeFolder('f-m', 'Monitoring');

    const result = groupResourcesByFolder([], [fZ, fA2, fA1, fM]);

    expect(result).toHaveLength(5); // 4 folders + 1 root
    expect(result.map((g) => g.folder?.id)).toEqual(['f-a1', 'f-a2', 'f-m', 'f-z', undefined]);
    expect(result[4].folder).toBeNull();
  });

  it('preserves the order of resources within each group', () => {
    const f1 = makeFolder('f1', 'Services');
    const r1 = makeResource('r1', 'First Spec', 'f1', 'document', '2026-09-02T00:00:00Z');
    const r2 = makeResource('r2', 'Second Spec', 'f1', 'document', '2026-09-01T00:00:00Z');

    const result = groupResourcesByFolder([r1, r2], [f1]);
    expect(result[0].resources).toEqual([r1, r2]);
  });

  it('ensures every resource appears exactly once (dedup / completeness check)', () => {
    const f1 = makeFolder('f1', 'Folder A');
    const f2 = makeFolder('f2', 'Folder B');
    const resources = [
      makeResource('r1', 'Doc 1', 'f1'),
      makeResource('r2', 'Doc 2', 'f2'),
      makeResource('r3', 'Doc 3', null),
      makeResource('r4', 'Doc 4', 'unknown-folder'),
    ];

    const result = groupResourcesByFolder(resources, [f1, f2]);

    const collectedResourceIds = result.flatMap((g) => g.resources.map((r) => r.id));
    expect(collectedResourceIds.sort()).toEqual(['r1', 'r2', 'r3', 'r4'].sort());
    expect(new Set(collectedResourceIds).size).toBe(4);
  });

  it('handles a large volume (50 resources across 10 folders) efficiently', () => {
    const folders = Array.from({ length: 10 }, (_, i) =>
      makeFolder(`f-${i}`, `Module ${String(i).padStart(2, '0')}`)
    );
    const resources = Array.from({ length: 50 }, (_, i) =>
      makeResource(
        `r-${i}`,
        `Resource ${i}`,
        i < 40 ? `f-${i % 10}` : null
      )
    );

    const result = groupResourcesByFolder(resources, folders);

    expect(result).toHaveLength(11); // 10 folders + root
    const totalResourcesInGroups = result.reduce((acc, g) => acc + g.resources.length, 0);
    expect(totalResourcesInGroups).toBe(50);
    expect(result[10].folder).toBeNull();
    expect(result[10].resources).toHaveLength(10); // 10 root resources
  });

  it('does not mutate input resources or folders arrays', () => {
    const f = Object.freeze([makeFolder('f1', 'Freeze Folder')]);
    const r = Object.freeze([makeResource('r1', 'Freeze Doc', 'f1')]);

    expect(() => groupResourcesByFolder(r as any, f as any)).not.toThrow();
  });
});
