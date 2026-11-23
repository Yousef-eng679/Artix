import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { loader } from '@monaco-editor/react';
import { languageMap } from '@/components/Editor/languageMap';
import '@/components/Editor/Editor';

describe('OF-05 / TASK-17: Local Monaco Bundle, Languages, Worker & Zero CDN Dependency', () => {
  const rootDir = process.cwd();

  it('bundles monaco-editor in package.json and removes cdn.jsdelivr.net from vercel.json CSP', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.['monaco-editor']).toBeTruthy();

    const vercel = JSON.parse(fs.readFileSync(path.join(rootDir, 'vercel.json'), 'utf-8')) as {
      headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
    };
    const globalRule = vercel.headers.find((h) => h.source === '/(.*)');
    const csp = globalRule?.headers.find((h) => h.key === 'Content-Security-Policy')?.value ?? '';
    expect(csp).not.toContain('cdn.jsdelivr.net');
  });

  it('registers local Monaco instance, worker factory, and markdown/xml/plaintext languages without injecting jsDelivr script tags', async () => {
    const preRegistered = loader.__getMonacoInstance();
    expect(preRegistered).toBeTruthy();

    const monacoInstance = await Promise.race([
      loader.init(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('loader.init() hung waiting for remote CDN script')), 1000),
      ),
    ]);

    const cdnScripts = Array.from(document.querySelectorAll('script')).filter((s) =>
      /jsdelivr|monaco/i.test(s.src),
    );
    expect(cdnScripts).toHaveLength(0);

    const registeredLanguageIds = (monacoInstance as any).languages
      .getLanguages()
      .map((lang: { id: string }) => lang.id);

    for (const cfg of Object.values(languageMap)) {
      expect(registeredLanguageIds).toContain(cfg.monacoLanguage);
    }

    const env = (globalThis as unknown as { MonacoEnvironment?: { getWorker?: unknown } })
      .MonacoEnvironment;
    expect(typeof env?.getWorker).toBe('function');
  });

  it('route-splits ProjectWorkspace via lazy() and isolates monaco-editor into a dedicated precached chunk', () => {
    const appSrc = fs.readFileSync(path.join(rootDir, 'src/App.tsx'), 'utf-8');
    const viteConfig = fs.readFileSync(path.join(rootDir, 'vite.config.ts'), 'utf-8');
    expect(appSrc).toMatch(/lazy\(\s*\(\)\s*=>\s*import\(['"]\.\/pages\/ProjectWorkspace['"]\)\)/);
    expect(viteConfig).toContain('node_modules/monaco-editor');
  });
});
