import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Architectural Boundary: Full-src Network & Offline Write Enforcement (Phase 0 + TASK-03 / TASK-26B)', () => {
  const syncableTables = ['projects', 'documents', 'system_designs', 'workspace_folders'];
  const srcRoot = path.resolve(process.cwd(), 'src');

  function getSourceFiles(dir: string, fileList: string[] = []): string[] {
    if (!fs.existsSync(dir)) return fileList;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'test' || entry.name === '__tests__') continue;
        getSourceFiles(fullPath, fileList);
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
        fileList.push(fullPath);
      }
    }
    return fileList;
  }

  function toPosixRelative(fullPath: string): string {
    return path.relative(process.cwd(), fullPath).split(path.sep).join('/');
  }

  it('prohibits direct Supabase mutations on synced workspace tables across ALL of src/ outside src/lib/sync/adapters/', () => {
    const allSrcFiles = getSourceFiles(srcRoot);
    const allowedAdapterPrefix = 'src/lib/sync/adapters/';

    for (const file of allSrcFiles) {
      const rel = toPosixRelative(file);
      if (rel.startsWith(allowedAdapterPrefix)) continue;

      const content = fs.readFileSync(file, 'utf-8');
      for (const table of syncableTables) {
        const regex = new RegExp(`\\.from\\(['"\`]${table}['"\`]\\)\\s*\\.\\s*(insert|update|delete|upsert)`, 'g');
        const matches = content.match(regex);
        expect(
          matches,
          `Forbidden direct Supabase mutation on table '${table}' in ${rel}. All mutations must route through Dexie repositories & Outbox!`
        ).toBeNull();
      }
    }
  });

  it('prohibits apply_sync_mutation RPC calls outside src/lib/sync/adapters/idempotency.ts', () => {
    const allSrcFiles = getSourceFiles(srcRoot);
    const rpcRegex = /\.rpc\s*\(\s*['"`]apply_sync_mutation['"`]/;

    for (const file of allSrcFiles) {
      const rel = toPosixRelative(file);
      if (rel === 'src/lib/sync/adapters/idempotency.ts') continue;

      const content = fs.readFileSync(file, 'utf-8');
      expect(
        rpcRegex.test(content),
        `Forbidden direct apply_sync_mutation RPC usage in ${rel}`
      ).toBe(false);
    }
  });

  it('prohibits dead /api/save endpoints and navigator.sendBeacon draft leaks across ALL of src/ (OF-14)', () => {
    const allSrcFiles = getSourceFiles(srcRoot);

    for (const file of allSrcFiles) {
      const rel = toPosixRelative(file);
      const content = fs.readFileSync(file, 'utf-8');

      expect(
        content.includes('/api/save'),
        `Forbidden dead '/api/save' network endpoint reference in ${rel}`
      ).toBe(false);

      expect(
        content.includes('sendBeacon('),
        `Forbidden navigator.sendBeacon call in ${rel}; unload persistence must stay local`
      ).toBe(false);
    }
  });

  it('verifies that the target authorized network push adapters exist with bounded transport timeouts and zero entity upserts', () => {
    const syncEnginePath = path.resolve(process.cwd(), 'src/lib/sync/syncEngine.ts');
    expect(fs.existsSync(syncEnginePath)).toBe(true);

    const content = fs.readFileSync(syncEnginePath, 'utf-8');
    expect(content).toContain('pushMutationToCloud');
    expect(content).toContain('withTimeout');
    expect(content).toContain('TRANSPORT_TIMEOUT_MS');

    const projectAdapter = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/sync/adapters/projectPushAdapter.ts'), 'utf-8');
    const folderAdapter = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/sync/adapters/folderPushAdapter.ts'), 'utf-8');
    const docAdapter = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/sync/adapters/documentPushAdapter.ts'), 'utf-8');
    const designAdapter = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/sync/adapters/systemDesignPushAdapter.ts'), 'utf-8');

    expect(projectAdapter).toContain(".from('projects')");
    expect(docAdapter).toContain(".from('documents')");
    expect(designAdapter).toContain(".from('system_designs')");
    expect(folderAdapter).toContain(".from('workspace_folders')");
    expect(projectAdapter).toContain('withTimeout');
    expect(docAdapter).toContain('withTimeout');
    expect(designAdapter).toContain('withTimeout');
    expect(folderAdapter).toContain('withTimeout');
    expect(projectAdapter).not.toContain('.upsert(');
    expect(docAdapter).not.toContain('.upsert(');
    expect(designAdapter).not.toContain('.upsert(');
    expect(folderAdapter).not.toContain('.upsert(');

    expect(projectAdapter).toContain('executeAtomicMutation');
    expect(docAdapter).toContain('executeAtomicMutation');
    expect(designAdapter).toContain('executeAtomicMutation');
    expect(folderAdapter).toContain('executeAtomicMutation');

    const idempotencyHelper = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/sync/adapters/idempotency.ts'),
      'utf-8'
    );
    expect(idempotencyHelper).toContain("rpc('apply_sync_mutation'");
    expect(idempotencyHelper).toContain('withTimeout');
  });

  it('prohibits direct Supabase reads in core workspace entity hooks (Phase C4 Cutover Enforced)', () => {
    const workspaceHookFiles = [
      'src/hooks/useDocuments.tsx',
      'src/hooks/useSystemDesigns.tsx',
      'src/hooks/useWorkspaceFolders.tsx',
    ];

    for (const relPath of workspaceHookFiles) {
      const fullPath = path.resolve(process.cwd(), relPath);
      expect(fs.existsSync(fullPath)).toBe(true);
      const content = fs.readFileSync(fullPath, 'utf-8');

      expect(
        content.includes("from('@/integrations/supabase/client')") ||
        content.includes('from("@/integrations/supabase/client")') ||
        content.includes('supabase.from('),
        `Forbidden direct Supabase usage in ${relPath}. Workspace hooks must query IndexedDB repositories exclusively!`
      ).toBe(false);
    }
  });
});
