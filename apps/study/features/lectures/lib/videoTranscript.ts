import type { Transcript } from '@/lib/api/types';
import type { VideoTranscriptDto } from './api';

/**
 * What VideoStudy does next with a video's transcript, decided from the latest `GET` answer.
 * The server can't reach YouTube on prod (`YOUTUBE_BLOCKED`), so the tablet fetches the captions
 * itself once and uploads them; the server is asked to transcribe only when the device can't.
 */
export type TranscriptAction =
  | { kind: 'show'; transcript: Transcript; pollForSummary: boolean }
  | { kind: 'wait' }
  | { kind: 'device' }
  | { kind: 'queue' }
  | { kind: 'unavailable'; message: string };

export interface TranscriptContext {
  deviceAvailable: boolean;
  triedDevice: boolean;
  queued: boolean;
  now: number;
  /** Keep polling for the summary until this time (set when segments first appear). */
  summaryUntil: number;
}

export const UNAVAILABLE_MESSAGE = 'Transcript unavailable for this video';

export function decideTranscript(dto: VideoTranscriptDto | null, ctx: TranscriptContext): TranscriptAction {
  if (dto && Array.isArray(dto.segments) && dto.segments.length > 0) {
    return {
      kind: 'show',
      transcript: { segments: dto.segments, summary: dto.summary ?? null, keyPoints: dto.keyPoints ?? [] },
      pollForSummary: (dto.summary ?? null) === null && ctx.now < ctx.summaryUntil,
    };
  }

  const status = dto?.transcriptStatus ?? 'none';

  if (status === 'pending') return { kind: 'wait' };
  if (status === 'ready') return { kind: 'unavailable', message: UNAVAILABLE_MESSAGE };
  if (ctx.deviceAvailable && !ctx.triedDevice) return { kind: 'device' };
  if (status === 'none' && !ctx.queued) return { kind: 'queue' };

  return { kind: 'unavailable', message: UNAVAILABLE_MESSAGE };
}
