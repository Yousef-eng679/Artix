import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { MarkdownPreview } from '@/components/Editor/MarkdownPreview';

declare global {
  interface Window {
    __XSS_SCRIPT_EXECUTED__?: boolean;
    __XSS_IMG_EXECUTED__?: boolean;
  }
}

describe('MarkdownPreview XSS Rendering Test', () => {
  beforeEach(() => {
    delete window.__XSS_SCRIPT_EXECUTED__;
    delete window.__XSS_IMG_EXECUTED__;
  });

  it('safely excludes raw <script> tags from rendering and prevents code execution', () => {
    const maliciousPayload = `
# System Architecture Specification

Some preliminary text.

<script id="malicious-script">
  window.__XSS_SCRIPT_EXECUTED__ = true;
</script>

Normal markdown paragraph.
`;

    const { container } = render(<MarkdownPreview content={maliciousPayload} />);

    // 1. Assert the raw <script> element was NOT mounted into the DOM
    const scriptTag = container.querySelector('script#malicious-script');
    expect(scriptTag).toBeNull();
    expect(container.querySelectorAll('script').length).toBe(0);

    // 2. Assert script side-effect was never executed
    expect(window.__XSS_SCRIPT_EXECUTED__).toBeUndefined();

    // 3. Assert surrounding legitimate markdown rendered properly
    expect(screen.getByRole('heading', { level: 1, name: 'System Architecture Specification' })).toBeInTheDocument();
    expect(screen.getByText('Normal markdown paragraph.')).toBeInTheDocument();
  });

  it('safely neutralizes raw <img onerror=...> vector handlers in markdown content', () => {
    const maliciousImgPayload = `
### Database Topology

<img src="invalid-source.png" onerror="window.__XSS_IMG_EXECUTED__ = true;" />

Detailed description below.
`;

    const { container } = render(<MarkdownPreview content={maliciousImgPayload} />);

    // Assert no image with onerror attribute is rendered
    const imgWithOnerror = container.querySelector('img[onerror]');
    expect(imgWithOnerror).toBeNull();

    // Assert onerror handler never fired
    expect(window.__XSS_IMG_EXECUTED__).toBeUndefined();

    // Assert safe content rendered
    expect(screen.getByText('Detailed description below.')).toBeInTheDocument();
  });

  it('sanitizes javascript: scheme pseudo-protocols in markdown links', () => {
    const maliciousLinkPayload = `
[Malicious Link](javascript:alert('pwned'))
`;

    const { container } = render(<MarkdownPreview content={maliciousLinkPayload} />);

    // Assert the anchor element is created and not silently omitted
    const link = container.querySelector('a');
    expect(link).not.toBeNull();

    // Assert the href has been sanitized and does not contain the javascript: pseudo-protocol
    const href = link!.getAttribute('href');
    expect(href).not.toMatch(/^javascript:/i);
  });

  it('renders legitimate markdown elements faithfully without sanitization false-positives', () => {
    const legitimateContent = `
# API Gateway Spec

> Note: All endpoints require bearer authentication.

- Rate limit: 100 req/min
- Timeout: 5000ms

\`\`\`json
{ "status": "active" }
\`\`\`
`;

    render(<MarkdownPreview content={legitimateContent} />);

    expect(screen.getByRole('heading', { level: 1, name: 'API Gateway Spec' })).toBeInTheDocument();
    expect(screen.getByText(/All endpoints require bearer authentication/i)).toBeInTheDocument();
    expect(screen.getByText('Rate limit: 100 req/min')).toBeInTheDocument();
    expect(screen.getByText('{ "status": "active" }')).toBeInTheDocument();
  });
});
