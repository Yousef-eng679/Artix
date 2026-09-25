import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ArtixDB, deleteArtixDB } from '@/lib/local/db';
import { SystemDesignRepository } from '@/lib/repositories/systemDesignRepository';
import { BoardState } from '@/hooks/useSystemDesigns';

describe('SystemDesignRepository', () => {
  const testDbName = 'ArtixDB_test_design_repo';
  let db: ArtixDB;
  let repo: SystemDesignRepository;

  beforeEach(async () => {
    await deleteArtixDB(testDbName);
    db = new ArtixDB(testDbName);
    repo = new SystemDesignRepository(db);
  });

  afterEach(async () => {
    await deleteArtixDB(testDbName);
  });

  it('creates and persists system design with structured boardState', async () => {
    const boardState: BoardState = {
      nodes: [
        { id: 'node-1', type: 'service', position: { x: 100, y: 150 }, data: { label: 'Auth Service' } },
        { id: 'node-2', type: 'database', position: { x: 300, y: 150 }, data: { label: 'PostgreSQL' } },
      ],
      edges: [
        { id: 'edge-1', source: 'node-1', target: 'node-2', label: 'writes to' },
      ],
      strokes: [
        { points: [{ x: 10, y: 10 }, { x: 20, y: 20 }], color: '#ff0000', width: 2 },
      ],
    };

    const design = await repo.create({
      userId: 'user-1',
      projectId: 'proj-1',
      name: 'Microservices Topology',
      boardState,
    });

    expect(design.id).toBeDefined();
    expect(design.name).toBe('Microservices Topology');
    expect(design.boardState.nodes).toHaveLength(2);
    expect(design.boardState.edges).toHaveLength(1);
    expect(design.boardState.strokes).toHaveLength(1);
    expect(design.localRevision).toBe(1);

    const fetched = await repo.getById(design.id);
    expect(fetched).toEqual(design);
  });

  it('updates boardState without losing complex canvas data', async () => {
    const design = await repo.create({
      userId: 'user-1',
      projectId: 'proj-1',
      name: 'Initial Diagram',
    });

    const newBoardState: BoardState = {
      nodes: [
        { id: 'node-99', type: 'gateway', position: { x: 50, y: 50 }, data: { label: 'API Gateway' } },
      ],
      edges: [],
    };

    const updated = await repo.update(design.id, {
      name: 'Updated Diagram',
      boardState: newBoardState,
    });

    expect(updated.localRevision).toBe(2);
    expect(updated.name).toBe('Updated Diagram');
    expect(updated.boardState.nodes[0].data.label).toBe('API Gateway');

    const fetched = await repo.getById(design.id);
    expect(fetched?.boardState.nodes).toHaveLength(1);
  });

  it('supports soft delete and restore', async () => {
    const design = await repo.create({
      userId: 'user-1',
      projectId: 'proj-1',
      name: 'Scratch Board',
    });

    await repo.delete(design.id);
    expect(await repo.getById(design.id)).toBeNull();

    const restored = await repo.restore(design.id);
    expect(restored.isDeleted).toBe(false);
    expect(restored.localRevision).toBe(3);
  });
});
