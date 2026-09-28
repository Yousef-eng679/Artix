import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Architectural Boundary: Direct Network Write Enforcement (Phase 0)', () => {
  const syncableTables = ['documents', 'system_designs', 'workspace_folders'];

  // Recursively collect all .ts and .tsx files in a directory
  function getSourceFiles(dir: string, fileList: string[] = []): string[] {
    if (!fs.existsSync(dir)) return fileList;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        getSourceFiles(fullPath, fileList);
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
        fileList.push(fullPath);
      }
    }
    return fileList;
  }

  it('prohibits direct Supabase mutations in all UI components under src/components/', () => {
    const componentFiles = getSourceFiles(path.resolve(process.cwd(), 'src/components'));

    for (const file of componentFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      for (const table of syncableTables) {
        const regex = new RegExp(`\\.from\\(['"\`]${table}['"\`]\\)\\s*\\.\\s*(insert|update|delete|upsert)`, 'g');
        const matches = content.match(regex);
        expect(
          matches,
          `Forbidden direct Supabase mutation on table '${table}' in component: ${path.relative(process.cwd(), file)}`
        ).toBeNull();
      }
    }
  });

  it('prohibits direct Supabase mutations in all React hooks under src/hooks/ (Phase 1 Cutover Enforced)', () => {
    const hookFiles = getSourceFiles(path.resolve(process.cwd(), 'src/hooks'));

    for (const file of hookFiles) {
      const relativePath = path.normalize(path.relative(process.cwd(), file));
      const content = fs.readFileSync(file, 'utf-8');
      for (const table of syncableTables) {
        const regex = new RegExp(`\\.from\\(['"\`]${table}['"\`]\\)\\s*\\.\\s*(insert|update|delete|upsert)`, 'g');
        const matches = content.match(regex);
        expect(
          matches,
          `Forbidden direct Supabase mutation on table '${table}' in hook: ${relativePath}. All mutations must go through local Dexie repositories & Outbox!`
        ).toBeNull();
      }
    }
  });

  it('verifies that the target authorized network push adapters exist with bounded transport timeouts', () => {
    const syncEnginePath = path.resolve(process.cwd(), 'src/lib/sync/syncEngine.ts');
    expect(fs.existsSync(syncEnginePath)).toBe(true);

    const content = fs.readFileSync(syncEnginePath, 'utf-8');
    expect(content).toContain('pushMutationToCloud');
    expect(content).toContain('withTimeout');
    expect(content).toContain('TRANSPORT_TIMEOUT_MS');

    // Check that structured push adapters exist and encapsulate bounded table pushes
    const folderAdapter = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/sync/adapters/folderPushAdapter.ts'), 'utf-8');
    const docAdapter = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/sync/adapters/documentPushAdapter.ts'), 'utf-8');
    const designAdapter = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/sync/adapters/systemDesignPushAdapter.ts'), 'utf-8');

    expect(docAdapter).toContain(".from('documents')");
    expect(designAdapter).toContain(".from('system_designs')");
    expect(folderAdapter).toContain(".from('workspace_folders')");
    expect(docAdapter).toContain('withTimeout');
    expect(designAdapter).toContain('withTimeout');
    expect(folderAdapter).toContain('withTimeout');
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
