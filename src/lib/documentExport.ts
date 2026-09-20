import { DocumentFormat } from '@/components/Editor/languageMap';

export type ExportFormat = 'pdf' | 'html' | 'native';

interface ExportOptions {
  title: string;
  content: string;
  format: DocumentFormat;
  exportAs: ExportFormat;
}

// Convert markdown to HTML (simple implementation)
export function markdownToHtml(markdown: string): string {
  let html = markdown
    // Headers
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    // Bold
    .replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.*?)\*/gim, '<em>$1</em>')
    // Code blocks
    .replace(/```([\s\S]*?)```/gim, '<pre><code>$1</code></pre>')
    // Inline code
    .replace(/`(.*?)`/gim, '<code>$1</code>')
    // Links
    .replace(/\[(.*?)\]\((.*?)\)/gim, '<a href="$2">$1</a>')
    // Unordered lists
    .replace(/^\s*[-*] (.*$)/gim, '<li>$1</li>')
    // Line breaks
    .replace(/\n\n/gim, '</p><p>')
    .replace(/\n/gim, '<br>');
  
  // Wrap list items
  html = html.replace(/(<li>.*<\/li>)/gis, '<ul>$1</ul>');
  
  return `<p>${html}</p>`;
}

export function getHtmlDocument(title: string, content: string, format: DocumentFormat): string {
  let bodyContent: string;
  
  if (format === 'markdown') {
    bodyContent = markdownToHtml(content);
  } else if (format === 'xml') {
    bodyContent = `<pre><code>${escapeHtml(content)}</code></pre>`;
  } else {
    bodyContent = `<pre>${escapeHtml(content)}</pre>`;
  }
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      line-height: 1.6;
      max-width: 800px;
      margin: 0 auto;
      padding: 2rem;
      color: #1a1a1a;
    }
    h1, h2, h3 { margin-top: 1.5em; margin-bottom: 0.5em; }
    h1 { font-size: 2em; border-bottom: 2px solid #eee; padding-bottom: 0.3em; }
    h2 { font-size: 1.5em; }
    h3 { font-size: 1.25em; }
    code { 
      background: #f4f4f4; 
      padding: 0.2em 0.4em; 
      border-radius: 3px; 
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 0.9em;
    }
    pre { 
      background: #1e1e1e; 
      color: #d4d4d4;
      padding: 1rem; 
      border-radius: 8px; 
      overflow-x: auto;
    }
    pre code { background: none; padding: 0; color: inherit; }
    a { color: #0066cc; }
    ul { padding-left: 1.5em; }
    li { margin: 0.25em 0; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${bodyContent}
</body>
</html>`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getFileExtension(format: DocumentFormat): string {
  switch (format) {
    case 'markdown': return 'md';
    case 'xml': return 'xml';
    case 'text': return 'txt';
    default: return 'txt';
  }
}

function getMimeType(format: DocumentFormat): string {
  switch (format) {
    case 'markdown': return 'text/markdown';
    case 'xml': return 'application/xml';
    case 'text': return 'text/plain';
    default: return 'text/plain';
  }
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export async function exportDocument({ title, content, format, exportAs }: ExportOptions): Promise<void> {
  const sanitizedTitle = title.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'document';
  
  if (exportAs === 'native') {
    const extension = getFileExtension(format);
    const mimeType = getMimeType(format);
    const blob = new Blob([content], { type: mimeType });
    downloadBlob(blob, `${sanitizedTitle}.${extension}`);
    return;
  }
  
  if (exportAs === 'html') {
    const htmlContent = getHtmlDocument(title, content, format);
    const blob = new Blob([htmlContent], { type: 'text/html' });
    downloadBlob(blob, `${sanitizedTitle}.html`);
    return;
  }
  
  if (exportAs === 'pdf') {
    const htmlContent = getHtmlDocument(title, content, format);
    // Use the browser's native print-to-PDF to avoid bundling vulnerable PDF libs.
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      throw new Error('Unable to open print window. Please allow popups for this site.');
    }
    printWindow.document.open();
    printWindow.document.write(htmlContent);
    printWindow.document.close();
    // Give the new document a tick to render before printing.
    await new Promise((resolve) => setTimeout(resolve, 250));
    printWindow.focus();
    printWindow.print();
  }

}
