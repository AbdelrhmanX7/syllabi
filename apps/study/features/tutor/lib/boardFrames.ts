// Study SSE frames (`{event, data}`) → the board editor's `BoardAiStreamEvent`s. The Study routes
// speak the whiteboard teacher pipeline's vocabulary (status · text · result · done) under the study
// transport's envelope; `kind` says what a `result` frame IS for the method that asked.
import type { BoardAiBlock, BoardAiStreamEvent } from '@repo/whiteboard-react';
import type { SseFrame } from '@/lib/api/http';

export type BoardResultKind = 'blocks' | 'analysis' | 'concept' | 'conceptGenerate' | 'layout' | 'termsMap';

function textOf(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const body = data as { text?: unknown; delta?: unknown; content?: unknown };

    if (typeof body.text === 'string') return body.text;
    if (typeof body.delta === 'string') return body.delta;
    if (typeof body.content === 'string') return body.content;
  }

  return null;
}

/** Null = nothing for the panel (meta, sources, keep-alives). */
export function toBoardAiEvent(frame: SseFrame, kind: BoardResultKind): BoardAiStreamEvent | null {
  switch (frame.event) {
    case 'status': {
      const text = textOf(frame.data);

      return text ? { type: 'status', data: text } : null;
    }
    case 'thinking':
      return { type: 'thinking' };
    case 'transcript': {
      const text = textOf(frame.data);

      return text && text.trim() ? { type: 'transcript', data: text } : null;
    }
    case 'delta':
    case 'text': {
      const text = textOf(frame.data);

      return text !== null ? { type: 'text', data: text } : null;
    }
    case 'result':
      return resultEvent((frame.data ?? {}) as Record<string, unknown>, kind);
    case 'analysis':
      return { type: 'analysis', data: frame.data as never };
    case 'concept_map':
      return { type: 'concept_map', data: frame.data as never };
    case 'layout':
      return { type: 'layout', data: frame.data };
    case 'terms_map':
      return { type: 'terms_map', data: frame.data };
    case 'done':
      return { type: 'done' };
    case 'error': {
      const message =
        typeof frame.data === 'string' ? frame.data : (frame.data as { message?: unknown } | null)?.message;

      return { type: 'error', data: typeof message === 'string' && message ? message : 'The tutor could not answer.' };
    }
    default:
      return null;
  }
}

function resultEvent(data: Record<string, unknown>, kind: BoardResultKind): BoardAiStreamEvent | null {
  switch (kind) {
    case 'blocks':
      return Array.isArray(data.blocks) ? { type: 'result', data: { blocks: data.blocks as BoardAiBlock[] } } : null;
    case 'analysis':
      return { type: 'analysis', data: data as never };
    case 'concept':
      return { type: 'concept_map', data: data as never };
    case 'conceptGenerate':
      // A generated map's node boxes are a ready layout — the editor places them as they are.
      return { type: 'concept_map', data: { ...data, serverLayout: true } as never };
    case 'layout':
      return { type: 'layout', data };
    case 'termsMap':
      // Structure only ({direction, nodes[{id,text,clusterIds,level}], edges, extra}); the board
      // validates it against the clusters it sent and draws it in the owner's ink.
      return { type: 'terms_map', data: (data.termsMap ?? data.terms_map ?? data) as unknown };
    default:
      return null;
  }
}

/** The board's learned concept-map style → the wire `{direction, shape, palette}` the generate route takes. */
export function conceptStyleWire(
  style: { direction?: string; shape?: string; nodeColors?: string[] } | undefined,
): { direction?: string; shape?: string; palette?: string[] } | undefined {
  if (!style) return undefined;
  const direction = style.direction
    ? ({ tb: 'TB', ltr: 'LR', rtl: 'RL', radial: 'radial' } as Record<string, string>)[style.direction]
    : undefined;
  const wire = {
    ...(direction ? { direction } : {}),
    ...(style.shape && style.shape !== 'diamond' ? { shape: style.shape } : {}),
    ...(style.nodeColors?.length ? { palette: style.nodeColors } : {}),
  };

  return Object.keys(wire).length ? wire : undefined;
}
