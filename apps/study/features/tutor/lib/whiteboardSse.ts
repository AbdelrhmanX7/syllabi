/**
 * `text/event-stream` body → parsed `data:` frames. One JSON object per `data:` line, blank lines
 * between events, `: ping` keep-alives ignored. Ends quietly when the body ends or `signal` aborts.
 * Same wire format as apps/ai's reader and the backend's `/ai/chat` + `/whiteboard/ai/*` routes.
 */
export async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<{ type: string; data?: unknown }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const onAbort = () => {
    reader.cancel().catch(() => undefined);
  };

  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');

      buffer = lines.pop() ?? '';

      for (const raw of lines) {
        const frame = parseLine(raw);

        if (frame) yield frame;
      }
    }

    const tail = parseLine(buffer + decoder.decode());

    if (tail) yield tail;
  } catch (error) {
    if (signal?.aborted) return;

    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);

    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

function parseLine(raw: string): { type: string; data?: unknown } | null {
  const line = raw.trim();

  if (!line.startsWith('data:')) return null;

  const payload = line.slice(5).trim();

  if (!payload || payload === '[DONE]') return null;

  try {
    const parsed = JSON.parse(payload) as { type?: unknown; data?: unknown };

    return parsed && typeof parsed.type === 'string' ? { type: parsed.type, data: parsed.data } : null;
  } catch {
    return null;
  }
}
