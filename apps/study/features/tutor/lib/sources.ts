// Where a source chip goes. Routes are the shell's query-param pages (`/item/?id=`, `/notebook/?id=`).
import type { TutorSource } from '../types';

const enc = encodeURIComponent;

export function sourceHref(source: TutorSource, classId?: string | null): string {
  switch (source.kind) {
    case 'item':
      return `/item/?id=${enc(source.id)}`;
    case 'transcript':
      // The id is a video item's OR a recorded lecture's — the wire does not say which. This is the
      // item guess (the link's href); a click resolves it first (`transcriptHref` + SourceChips).
      return transcriptHref('item', source.id, source.t);
    case 'page':
      return `/notebook/?id=${enc(source.id)}${classId ? `&classId=${enc(classId)}` : ''}`;
    case 'library':
    case 'guide':
      // The class page's own tab (a guide source's id IS the class id).
      return classId || source.kind === 'guide'
        ? `/class/?id=${enc(classId || source.id)}&tab=${source.kind}`
        : '/classes/';
    default:
      return classId ? `/class/?id=${enc(classId)}` : '/classes/';
  }
}

/** `t` seeks on open: VideoStudy reads `/item/?t=`, LecturePlayback `/lectures/?t=`. */
export function transcriptHref(target: 'item' | 'lecture', id: string, t?: number): string {
  const at = typeof t === 'number' && Number.isFinite(t) ? `&t=${Math.max(0, Math.floor(t))}` : '';

  return target === 'item' ? `/item/?id=${enc(id)}${at}` : `/lectures/?id=${enc(id)}${at}`;
}

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);

  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export const SOURCE_KIND_LABEL: Record<TutorSource['kind'], string> = {
  library: 'Library',
  item: 'Canvas',
  transcript: 'Transcript',
  page: 'Notebook',
  guide: 'Guide',
};
