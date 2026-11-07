import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ArtixDB } from '@/lib/local/db';
import { ConflictResolver } from '@/lib/sync/conflictResolver';
import { ConflictRepository } from '@/lib/repositories/conflictRepository';
import { DocumentPushAdapter } from '@/lib/sync/adapters/documentPushAdapter';
import { classifySyncError } from '@/lib/sync/errorTaxonomy';
import * as cryptoModule from '@/lib/ai/crypto';

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

function resolveRelativeImport(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.normalize(candidate);
    }
  }
  return null;
}

describe('TASK-22: No Circular Sync Imports, True diff3 Merge, Conflict-Marker Guard & BYOK Crypto v2', () => {
  let db: ArtixDB;

  beforeEach(async () => {
    db = new ArtixDB(`artix_task22_${crypto.randomUUID()}`);
    await db.open();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    db.close();
    await db.delete();
  });

  it('1. enforces zero circular imports across src/lib/sync/**', () => {
    const syncDir = path.resolve(process.cwd(), 'src/lib/sync');
    const files = collectTsFiles(syncDir).map((f) => path.normalize(f));
    const fileSet = new Set(files);

    const graph = new Map<string, string[]>();
    const importRegex =
      /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"](\.\.?\/[^'"]+)['"]/g;

    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const edges: string[] = [];
      let match: RegExpExecArray | null;
      while ((match = importRegex.exec(src)) !== null) {
        // Ignore pure `import type` / `export type` statements at runtime
        if (/^(?:import|export)\s+type\b/.test(match[0])) {
          continue;
        }
        const target = resolveRelativeImport(file, match[1]);
        if (target && fileSet.has(target)) {
          edges.push(target);
        }
      }
      graph.set(file, edges);
    }

    const cycles: string[] = [];
    const state = new Map<string, 'visiting' | 'visited'>();
    const stack: string[] = [];

    function dfs(node: string) {
      state.set(node, 'visiting');
      stack.push(node);
      for (const next of graph.get(node) ?? []) {
        const nextState = state.get(next);
        if (nextState === 'visiting') {
          const cycleStart = stack.indexOf(next);
          const cycleNodes = [...stack.slice(cycleStart), next].map((p) =>
            path.relative(syncDir, p).replace(/\\/g, '/'),
          );
          cycles.push(cycleNodes.join(' -> '));
        } else if (!nextState) {
          dfs(next);
        }
      }
      stack.pop();
      state.set(node, 'visited');
    }

    for (const file of files) {
      if (!state.has(file)) {
        dfs(file);
      }
    }

    expect(cycles).toEqual([]);
  });

  it('2. merges shifted non-overlapping insertions/deletions cleanly via diff3 and wires automatic merge_document', async () => {
    const base = ['# Spec', 'Intro line', 'Keep A', 'Obsolete line', 'Keep B', 'Footer v1'].join(
      '\n',
    );
    // Local inserts 2 header lines at the top (shifting every line index by +2!)
    const local = [
      '---',
      'author: alice',
      '# Spec',
      'Intro line',
      'Keep A',
      'Obsolete line',
      'Keep B',
      'Footer v1',
    ].join('\n');
    // Remote deletes 'Obsolete line' in the middle AND updates 'Footer v1' at the bottom
    const remote = ['# Spec', 'Intro line', 'Keep A', 'Keep B', 'Footer v2 (remote)'].join('\n');

    const merged = ConflictResolver.mergeDocumentText(base, local, remote);
    expect(merged.hasConflicts).toBe(false);
    expect(merged.conflictBlocksCount).toBe(0);
    expect(merged.mergedText).toBe(
      ['---', 'author: alice', '# Spec', 'Intro line', 'Keep A', 'Keep B', 'Footer v2 (remote)'].join(
        '\n',
      ),
    );

    // Delete-vs-modify overlap produces exactly 1 conflict block while keeping surrounding lines intact
    const overlap = ConflictResolver.mergeDocumentText(
      'Header\nTarget line\nFooter',
      'Header\nFooter',
      'Header\nTarget modified remotely\nFooter',
    );
    expect(overlap.hasConflicts).toBe(true);
    expect(overlap.conflictBlocksCount).toBe(1);
    expect(overlap.mergedText).toContain('Header\n<<<<<<< LOCAL');
    expect(overlap.mergedText).toContain('>>>>>>> REMOTE\nFooter');

    // ConflictRepository.resolveConflict('merge_document') computes diff3 automatically when mergedContent is omitted
    const userId = 'user-diff3-1';
    const docId = 'doc-diff3-1';
    const now = '2026-11-01T00:00:00.000Z';
    await db.documents.put({
      id: docId,
      projectId: 'proj-1',
      userId,
      folderId: null,
      title: 'Architecture Spec',
      content: local,
      format: 'markdown',
      createdAt: now,
      updatedAt: now,
      localRevision: 2,
      isDeleted: false,
    });

    const conflictRepo = new ConflictRepository(db);
    const conflict = await conflictRepo.recordConflict({
      entityType: 'document',
      entityId: docId,
      userId,
      basePayload: { title: 'Architecture Spec', content: base },
      localPayload: { title: 'Architecture Spec', content: local },
      remotePayload: { title: 'Architecture Spec', content: remote, updated_at: now },
      remoteVersion: '3',
    });

    await conflictRepo.resolveConflict({
      conflictId: conflict.id,
      strategy: 'merge_document',
    });

    const resolvedDoc = await db.documents.get(docId);
    expect(resolvedDoc?.content).toBe(merged.mergedText);

    // Rejects finalizing merge_document if conflict markers remain unresolved
    const markerConflict = await conflictRepo.recordConflict({
      entityType: 'document',
      entityId: docId,
      userId,
      basePayload: { content: 'A' },
      localPayload: { content: 'B' },
      remotePayload: { content: 'C', updated_at: now },
      remoteVersion: '4',
    });

    await expect(
      conflictRepo.resolveConflict({
        conflictId: markerConflict.id,
        strategy: 'merge_document',
        mergedContent: '<<<<<<< LOCAL\nB\n=======\nC\n>>>>>>> REMOTE',
      }),
    ).rejects.toThrow(/conflict markers/i);
  });

  it('3. blocks DocumentPushAdapter from ever pushing unresolved conflict markers to Supabase', async () => {
    const adapter = new DocumentPushAdapter();
    const rpcSpy = vi.fn();
    const fromSpy = vi.fn();
    const fakeSupabase = { rpc: rpcSpy, from: fromSpy };

    const badEntry = {
      id: 'outbox-bad-1',
      mutationId: crypto.randomUUID(),
      userId: 'user-1',
      projectId: 'proj-1',
      entityType: 'document' as const,
      entityId: 'doc-1',
      operation: 'update' as const,
      payload: {
        title: 'Spec',
        content: '# Intro\n<<<<<<< LOCAL\nmine\n=======\ntheirs\n>>>>>>> REMOTE\n',
        format: 'markdown',
      },
      localRevision: 3,
      baseServerVersion: '2',
      state: 'in_flight' as const,
      dispatched: false,
      attemptCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    let caughtError: unknown = null;
    try {
      await adapter.push(badEntry, fakeSupabase);
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeTruthy();
    expect(rpcSpy).not.toHaveBeenCalled();
    expect(fromSpy).not.toHaveBeenCalled();

    const classified = classifySyncError(caughtError);
    expect(classified.code).toBe('UNRESOLVED_CONFLICT_MARKERS');
    expect(classified.category).toBe('UNRESOLVED_CONFLICT_MARKERS');
    expect(classified.retryable).toBe(false);
  });

  it('4. encrypts new BYOK vaults as v: 2 (600,000 PBKDF2 iterations) while decrypting legacy v: 1 (250,000) seamlessly', async () => {
    const deriveSpy = vi.spyOn(crypto.subtle, 'deriveKey');

    // Encrypt new payload -> must produce v: 2 with 600,000 iterations
    const v2Blob = await cryptoModule.encryptJSON(
      { primary: { provider: 'openai', apiKey: 'sk-v2-secret' } },
      'correct-horse-battery-staple',
    );
    expect(v2Blob.v).toBe(2);
    expect((deriveSpy.mock.calls[0]?.[0] as Pbkdf2Params)?.iterations).toBe(600_000);

    const v2Plain = await cryptoModule.decryptJSON<{ primary: { apiKey: string } }>(
      v2Blob,
      'correct-horse-battery-staple',
    );
    expect(v2Plain.primary.apiKey).toBe('sk-v2-secret');

    // Construct a genuine legacy v: 1 ciphertext (250,000 iterations) and verify backward-compatible decryption
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      'raw',
      enc.encode('legacy-v1-passphrase') as BufferSource,
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    const v1Key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt as BufferSource, iterations: 250_000, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    );
    const v1Ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        v1Key,
        enc.encode(JSON.stringify({ primary: { apiKey: 'sk-legacy-v1' } })) as BufferSource,
      ),
    );
    const toB64 = (bytes: Uint8Array) =>
      btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));

    const legacyBlob: cryptoModule.EncryptedBlob = {
      v: 1,
      salt: toB64(salt),
      iv: toB64(iv),
      ct: toB64(v1Ct),
    };

    deriveSpy.mockClear();
    const v1Decrypted = await cryptoModule.decryptJSON<{ primary: { apiKey: string } }>(
      legacyBlob,
      'legacy-v1-passphrase',
    );
    expect(v1Decrypted.primary.apiKey).toBe('sk-legacy-v1');
    expect((deriveSpy.mock.calls[0]?.[0] as Pbkdf2Params)?.iterations).toBe(250_000);
  });

  it('5. aligns SECURITY.md, README.md, and docs/ PBKDF2 iteration documentation (no stale 100k claims)', () => {
    const docPaths = [
      'README.md',
      'SECURITY.md',
      'docs/README.md',
      'docs/architecture/CODE_ORGANIZATION.md',
      'docs/architecture/SYSTEM.md',
      'docs/reference/PROJECT_STATUS.md',
      'docs/reference/TRUTH_RECONCILIATION.md',
      'docs/security/CLIENT_KEY_STORAGE.md',
      'docs/security/SECURITY_MODEL.md',
    ];

    for (const relPath of docPaths) {
      const content = fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf8');
      expect(content, `Stale 100k PBKDF2 claim in ${relPath}`).not.toMatch(
        /100,000\s*(?:iterations|rounds)|PBKDF2\s*100k/i,
      );
    }

    const securityMd = fs.readFileSync(path.resolve(process.cwd(), 'SECURITY.md'), 'utf8');
    expect(securityMd).toMatch(/600[_,]000/);
  });
});
