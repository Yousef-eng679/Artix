import { describe, it, expect } from 'vitest';
import { readSSELines, readOpenAICompatibleDeltas } from '@/lib/ai/streaming';

// Helper to create a mock Response with a ReadableStream of strings
function createMockStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(stream);
}

describe('AI Streaming (readSSELines & readOpenAICompatibleDeltas)', () => {
  describe('readSSELines', () => {
    it('should split incoming lines on LF and CRLF', async () => {
      const response = createMockStreamResponse(['line 1\nline 2\r\nline 3\n']);
      const lines: string[] = [];

      for await (const line of readSSELines(response)) {
        lines.push(line);
      }

      expect(lines).toEqual(['line 1', 'line 2', 'line 3']);
    });

    it('should correctly assemble lines split across chunk boundaries', async () => {
      const response = createMockStreamResponse(['data: {"mes', 'sage": "hel', 'lo"}\n\n']);
      const lines: string[] = [];

      for await (const line of readSSELines(response)) {
        lines.push(line);
      }

      expect(lines).toEqual(['data: {"message": "hello"}']);
    });

    it('should handle responses with empty or missing body', async () => {
      const response = new Response(null);
      const lines: string[] = [];

      for await (const line of readSSELines(response)) {
        lines.push(line);
      }

      expect(lines).toEqual([]);
    });
  });

  describe('readOpenAICompatibleDeltas', () => {
    it('should parse content deltas from valid SSE stream', async () => {
      const mockStream = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n',
        'data: {"choices":[{"delta":{"content":"!"}}]}\n',
        'data: [DONE]\n',
      ];
      const response = createMockStreamResponse(mockStream);
      const deltas: string[] = [];

      for await (const delta of readOpenAICompatibleDeltas(response)) {
        deltas.push(delta);
      }

      expect(deltas.join('')).toBe('Hello world!');
    });

    it('should gracefully ignore malformed JSON chunks without aborting the stream', async () => {
      const mockStream = [
        'data: {"choices":[{"delta":{"content":"Valid 1"}}]}\n',
        'data: {corrupted json invalid syntax}\n',
        'data: {"choices":[{"delta":{"content":" Valid 2"}}]}\n',
        'data: [DONE]\n',
      ];
      const response = createMockStreamResponse(mockStream);
      const deltas: string[] = [];

      for await (const delta of readOpenAICompatibleDeltas(response)) {
        deltas.push(delta);
      }

      expect(deltas).toEqual(['Valid 1', ' Valid 2']);
    });

    it('should skip non-data lines and empty deltas', async () => {
      const mockStream = [
        ': ping heartbeat comment\n',
        'event: message\n',
        'data: {"choices":[{"delta":{}}]}\n', // empty delta
        'data: {"choices":[{"delta":{"content":"Real Token"}}]}\n',
        'data: [DONE]\n',
      ];
      const response = createMockStreamResponse(mockStream);
      const deltas: string[] = [];

      for await (const delta of readOpenAICompatibleDeltas(response)) {
        deltas.push(delta);
      }

      expect(deltas).toEqual(['Real Token']);
    });
  });
});
