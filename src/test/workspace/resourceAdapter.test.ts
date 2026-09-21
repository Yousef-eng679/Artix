import { describe, it, expect } from 'vitest';
import {
  toWorkspaceResources,
  AdaptableDocument,
  AdaptableDesign,
} from '@/lib/workspace/resourceAdapter';
import { filterWorkspaceResources } from '@/lib/workspace/filterResources';
import { WorkspaceResource } from '@/types/workspace';

describe('Phase 1: Workspace Resource Adapter & Filtering', () => {
  const projectId = 'proj-alpha-123';

  describe('toWorkspaceResources (Pure Adapter)', () => {
    it('returns an empty array when given empty collections', () => {
      const result = toWorkspaceResources([], [], projectId);
      expect(result).toEqual([]);
    });

    it('returns an empty array if projectId is empty', () => {
      const docs: AdaptableDocument[] = [
        { id: 'd1', project_id: projectId, title: 'Doc 1', updated_at: '2026-09-01T10:00:00Z' },
      ];
      const result = toWorkspaceResources(docs, [], '');
      expect(result).toEqual([]);
    });

    it('filters out resources belonging to different projects (Cross-Project Isolation)', () => {
      const docs: AdaptableDocument[] = [
        { id: 'd1', project_id: projectId, title: 'Project Alpha Doc', updated_at: '2026-09-01T10:00:00Z' },
        { id: 'd2', project_id: 'proj-other-456', title: 'Foreign Doc', updated_at: '2026-09-01T11:00:00Z' },
        { id: 'd3', project_id: null, title: 'Unassigned Doc', updated_at: '2026-09-01T12:00:00Z' },
      ];
      const designs: AdaptableDesign[] = [
        { id: 'des1', project_id: projectId, name: 'Project Alpha Design', updated_at: '2026-09-01T09:00:00Z' },
        { id: 'des2', project_id: 'proj-other-456', name: 'Foreign Design', updated_at: '2026-09-01T13:00:00Z' },
      ];

      const result = toWorkspaceResources(docs, designs, projectId);
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.id)).toEqual(['d1', 'des1']);
      expect(result.every((r) => r.projectId === projectId)).toBe(true);
    });

    it('normalizes document and design properties accurately', () => {
      const docs: AdaptableDocument[] = [
        {
          id: 'doc-1',
          project_id: projectId,
          title: 'Architecture RFC',
          updated_at: '2026-09-01T10:00:00Z',
          created_at: '2026-08-01T10:00:00Z',
          format: 'markdown',
        },
      ];
      const designs: AdaptableDesign[] = [
        {
          id: 'des-1',
          project_id: projectId,
          name: 'Microservices Topology',
          updated_at: '2026-09-02T10:00:00Z',
          created_at: '2026-08-02T10:00:00Z',
          board_state: {
            nodes: [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }],
          },
        },
      ];

      const result = toWorkspaceResources(docs, designs, projectId);

      expect(result).toHaveLength(2);

      const designRes = result.find((r) => r.kind === 'design');
      expect(designRes).toBeDefined();
      expect(designRes?.title).toBe('Microservices Topology');
      expect(designRes?.meta?.nodeCount).toBe(3);

      const docRes = result.find((r) => r.kind === 'document');
      expect(docRes).toBeDefined();
      expect(docRes?.title).toBe('Architecture RFC');
      expect(docRes?.meta?.format).toBe('markdown');
    });

    it('handles missing or malformed title and board_state gracefully', () => {
      const docs: AdaptableDocument[] = [
        { id: 'doc-empty', project_id: projectId, title: '', updated_at: '2026-09-01T10:00:00Z' },
      ];
      const designs: AdaptableDesign[] = [
        { id: 'des-empty', project_id: projectId, name: '', updated_at: '2026-09-01T09:00:00Z', board_state: undefined },
      ];

      const result = toWorkspaceResources(docs, designs, projectId);
      expect(result[0].title).toBe('Untitled Document');
      expect(result[1].title).toBe('Untitled Design');
      expect(result[1].meta?.nodeCount).toBe(0);
    });

    describe('4-Tier Deterministic Sorting', () => {
      it('Tier 1: sorts primarily by updatedAt descending (newest first)', () => {
        const docs: AdaptableDocument[] = [
          { id: 'doc-old', project_id: projectId, title: 'A Old', updated_at: '2026-01-01T00:00:00Z' },
          { id: 'doc-new', project_id: projectId, title: 'Z New', updated_at: '2026-09-01T00:00:00Z' },
        ];
        const result = toWorkspaceResources(docs, [], projectId);
        expect(result.map((r) => r.id)).toEqual(['doc-new', 'doc-old']);
      });

      it('Tier 2: sorts by normalized lowercase title ascending when timestamps are identical', () => {
        const timestamp = '2026-09-01T12:00:00Z';
        const docs: AdaptableDocument[] = [
          { id: 'doc-z', project_id: projectId, title: 'zebra', updated_at: timestamp },
          { id: 'doc-a', project_id: projectId, title: 'apple', updated_at: timestamp },
          { id: 'doc-m', project_id: projectId, title: 'mango', updated_at: timestamp },
        ];
        const result = toWorkspaceResources(docs, [], projectId);
        expect(result.map((r) => r.id)).toEqual(['doc-a', 'doc-m', 'doc-z']);
      });

      it('Tier 3: sorts by case-sensitive title ascending when lowercase titles match', () => {
        const timestamp = '2026-09-01T12:00:00Z';
        const docs: AdaptableDocument[] = [
          { id: 'doc-lower', project_id: projectId, title: 'beta', updated_at: timestamp },
          { id: 'doc-upper', project_id: projectId, title: 'Beta', updated_at: timestamp },
        ];
        const result = toWorkspaceResources(docs, [], projectId);
        // 'Beta' (uppercase) comes before 'beta' in standard case-sensitive localeCompare
        expect(result.map((r) => r.title)).toEqual(['Beta', 'beta']);
      });

      it('Tier 4: sorts by id ascending as the final unbreakable tie-breaker', () => {
        const timestamp = '2026-09-01T12:00:00Z';
        const docs: AdaptableDocument[] = [
          { id: 'id-999', project_id: projectId, title: 'Same Title', updated_at: timestamp },
          { id: 'id-111', project_id: projectId, title: 'Same Title', updated_at: timestamp },
          { id: 'id-555', project_id: projectId, title: 'Same Title', updated_at: timestamp },
        ];
        const result = toWorkspaceResources(docs, [], projectId);
        expect(result.map((r) => r.id)).toEqual(['id-111', 'id-555', 'id-999']);
      });
    });
  });

  describe('filterWorkspaceResources (Pure Search & Filter)', () => {
    const mockResources: WorkspaceResource[] = [
      { id: '1', projectId, title: 'Authentication PRD', kind: 'document', updatedAt: '2026-09-01T00:00:00Z' },
      { id: '2', projectId, title: 'Auth Service Architecture', kind: 'design', updatedAt: '2026-09-01T00:00:00Z' },
      { id: '3', projectId, title: 'Database Schema', kind: 'document', updatedAt: '2026-09-01T00:00:00Z' },
      { id: '4', projectId, title: 'Payment Gateway Diagram', kind: 'design', updatedAt: '2026-09-01T00:00:00Z' },
    ];

    it('preserves array reference identity when query is empty and filterKind is "all"', () => {
      const result = filterWorkspaceResources(mockResources, '', 'all');
      expect(result).toBe(mockResources);

      const resultWhitespace = filterWorkspaceResources(mockResources, '   ', 'all');
      expect(resultWhitespace).toBe(mockResources);
    });

    it('filters by case-insensitive substring matching', () => {
      const result = filterWorkspaceResources(mockResources, 'auth', 'all');
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.id)).toEqual(['1', '2']);

      const uppercaseResult = filterWorkspaceResources(mockResources, 'AUTH', 'all');
      expect(uppercaseResult.map((r) => r.id)).toEqual(['1', '2']);
    });

    it('filters by resource kind when filterKind is specified', () => {
      const docsOnly = filterWorkspaceResources(mockResources, '', 'document');
      expect(docsOnly).toHaveLength(2);
      expect(docsOnly.every((r) => r.kind === 'document')).toBe(true);

      const designsOnly = filterWorkspaceResources(mockResources, '', 'design');
      expect(designsOnly).toHaveLength(2);
      expect(designsOnly.every((r) => r.kind === 'design')).toBe(true);
    });

    it('combines text search with kind filtering correctly', () => {
      // Both match "auth", but only id '2' is a design
      const result = filterWorkspaceResources(mockResources, 'auth', 'design');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('2');
    });

    it('safely handles special regex characters without throwing', () => {
      const specialResources: WorkspaceResource[] = [
        { id: 's1', projectId, title: 'API [v1] (Draft)', kind: 'document', updatedAt: '2026-09-01T00:00:00Z' },
        { id: 's2', projectId, title: 'General Overview', kind: 'document', updatedAt: '2026-09-01T00:00:00Z' },
      ];

      expect(() => {
        const result = filterWorkspaceResources(specialResources, '[v1]', 'all');
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('s1');
      }).not.toThrow();

      expect(() => {
        const result = filterWorkspaceResources(specialResources, '(Draft)', 'all');
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('s1');
      }).not.toThrow();
    });

    it('returns empty array when no matches are found', () => {
      const result = filterWorkspaceResources(mockResources, 'nonexistent-query-xyz', 'all');
      expect(result).toEqual([]);
    });
  });
});
