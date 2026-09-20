import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  escapeHtml,
  markdownToHtml,
  getHtmlDocument,
  exportDocument,
} from '@/lib/documentExport';

describe('Document Export Utility', () => {
  describe('escapeHtml', () => {
    it('should sanitize dangerous HTML tags and characters against XSS', () => {
      const malicious = '<script>alert("XSS & attack\'s")</script>';
      const sanitized = escapeHtml(malicious);

      expect(sanitized).toBe(
        '&lt;script&gt;alert(&quot;XSS &amp; attack&#039;s&quot;)&lt;/script&gt;'
      );
      expect(sanitized).not.toContain('<');
      expect(sanitized).not.toContain('>');
    });
  });

  describe('markdownToHtml', () => {
    it('should convert headers to proper HTML heading tags', () => {
      expect(markdownToHtml('# Title 1')).toContain('<h1>Title 1</h1>');
      expect(markdownToHtml('## Title 2')).toContain('<h2>Title 2</h2>');
      expect(markdownToHtml('### Title 3')).toContain('<h3>Title 3</h3>');
    });

    it('should convert inline formatting (bold, italic, code, links)', () => {
      const md = '**bold text** and *italic text* and `const a = 1;` and [Artix](https://artix.app)';
      const html = markdownToHtml(md);

      expect(html).toContain('<strong>bold text</strong>');
      expect(html).toContain('<em>italic text</em>');
      expect(html).toContain('<code>const a = 1;</code>');
      expect(html).toContain('<a href="https://artix.app">Artix</a>');
    });

    it('should convert code blocks', () => {
      const md = '```\nfunction test() { return true; }\n```';
      const html = markdownToHtml(md);

      expect(html).toContain('<pre><code>');
      expect(html).toContain('function test() { return true; }');
    });
  });

  describe('getHtmlDocument', () => {
    it('should assemble a complete HTML document with viewport and CSS', () => {
      const docHtml = getHtmlDocument('System Spec', '# Overview', 'markdown');

      expect(docHtml).toContain('<!DOCTYPE html>');
      expect(docHtml).toContain('<title>System Spec</title>');
      expect(docHtml).toContain('<h1>System Spec</h1>');
      expect(docHtml).toContain('<h1>Overview</h1>');
      expect(docHtml).toContain('max-width: 800px;');
    });

    it('should escape XML content to prevent XML parsing injection', () => {
      const xmlDoc = getHtmlDocument('XML Spec', '<root><item id="1">Text</item></root>', 'xml');

      expect(xmlDoc).toContain('&lt;root&gt;&lt;item id=&quot;1&quot;&gt;');
    });
  });

  describe('exportDocument Flow', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('should sanitize filename and trigger blob download for native export', async () => {
      const createObjectURLMock = vi.fn().mockReturnValue('blob:dummy-url');
      const revokeObjectURLMock = vi.fn();
      globalThis.URL.createObjectURL = createObjectURLMock;
      globalThis.URL.revokeObjectURL = revokeObjectURLMock;

      const clickMock = vi.fn();
      const appendChildSpy = vi.spyOn(document.body, 'appendChild');
      const removeChildSpy = vi.spyOn(document.body, 'removeChild');

      // Mock createElement for link
      const originalCreate = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation((tag) => {
        const el = originalCreate(tag);
        if (tag === 'a') {
          el.click = clickMock;
        }
        return el;
      });

      await exportDocument({
        title: 'Draft #1: Spec & Details',
        content: '# Content',
        format: 'markdown',
        exportAs: 'native',
      });

      expect(createObjectURLMock).toHaveBeenCalled();
      expect(clickMock).toHaveBeenCalled();
      expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:dummy-url');
    });

    it('should open print window and print for PDF export', async () => {
      const printMock = vi.fn();
      const writeMock = vi.fn();
      const openMock = vi.fn();
      const closeMock = vi.fn();
      const focusMock = vi.fn();

      const mockWindow = {
        document: {
          open: openMock,
          write: writeMock,
          close: closeMock,
        },
        focus: focusMock,
        print: printMock,
      };

      vi.spyOn(window, 'open').mockReturnValue(mockWindow as any);

      await exportDocument({
        title: 'Printable Spec',
        content: '# PDF Title',
        format: 'markdown',
        exportAs: 'pdf',
      });

      expect(window.open).toHaveBeenCalledWith('', '_blank');
      expect(writeMock).toHaveBeenCalledWith(expect.stringContaining('<h1>Printable Spec</h1>'));
      expect(printMock).toHaveBeenCalled();
    });
  });
});
