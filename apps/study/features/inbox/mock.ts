// In-memory phone inbox for mock mode (the backend's `/inbox` routes are not live yet). The shell's
// mock transport calls `inboxMockRoutes.json` before its own switch; `undefined` = not this path.
// Multipart upload and the GET stream do not go through the JSON transport — `api.ts` calls
// `mockInboxUpload` / `mockInboxStream` directly. Everything here is made up and marked `__sample`
// by the transport (and by `api.ts` for the non-JSON paths).
import type { DropToken, DropTokenCreated, InboxItem } from './types';

import { StudyApiError } from '@/lib/api/errors';

type Body = Record<string, unknown> | undefined;

const STATE_KEY = 'study_mock_inbox';
const MINUTE = 60_000;
const uid = (prefix: string) =>
  `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;

interface MockInboxState {
  tokens: DropToken[];
  items: InboxItem[];
}

/* ------------------------------------------------------------------ sample «photos» */

interface SamplePhoto {
  title: string;
  lines: string[];
  paper: string;
  ink: string;
  note: string | null;
}

const PHOTOS: SamplePhoto[] = [
  {
    title: 'EAS 102 — Lab 3: mineral ID',
    lines: ['quartz: H 7, conchoidal fracture', 'feldspar: H 6, 2 cleavages @ 90°', 'calcite: fizzes in HCl, H 3'],
    paper: '#fbf7ec',
    ink: '#1f3a8a',
    note: 'Lab sheet from today',
  },
  {
    title: 'MATH 101 — §7.3 trig substitution',
    lines: ['∫ dx / √(9 − x²)', 'x = 3 sin θ, dx = 3 cos θ dθ', '= arcsin(x/3) + C'],
    paper: '#ffffff',
    ink: '#111827',
    note: null,
  },
  {
    title: 'CS 101 — whiteboard: pointers',
    lines: ['int *p = &x;', '*p = 5;  // x is now 5', 'p++ moves by sizeof(int)'],
    paper: '#eef6f2',
    ink: '#065f46',
    note: 'Prof’s board after class',
  },
];

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A «photo» of a notebook page as an SVG data URL (no DOM needed, so it works in tests too). */
export function samplePhotoDataUrl(photo: SamplePhoto, width = 1200, height = 900): string {
  const rules = Array.from({ length: 14 }, (_, i) => {
    const y = 150 + i * 52;

    return `<line x1="60" x2="${width - 60}" y1="${y}" y2="${y}" stroke="#93c5fd" stroke-opacity=".55" stroke-width="2"/>`;
  }).join('');
  const text = photo.lines
    .map(
      (line, i) =>
        `<text x="96" y="${246 + i * 104}" fill="${photo.ink}" font-family="'Segoe Print','Bradley Hand',cursive" font-size="44">${esc(line)}</text>`,
    )
    .join('');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="#d6d3d1"/>` +
    `<rect x="30" y="24" width="${width - 60}" height="${height - 48}" rx="10" fill="${photo.paper}" transform="rotate(-1.2 ${width / 2} ${height / 2})"/>` +
    `<line x1="120" x2="120" y1="40" y2="${height - 40}" stroke="#f87171" stroke-opacity=".6" stroke-width="2"/>` +
    rules +
    `<text x="96" y="118" fill="${photo.ink}" font-family="'Segoe Print','Bradley Hand',cursive" font-size="52" font-weight="700">${esc(photo.title)}</text>` +
    text +
    `<path d="M96 ${height - 150} q 140 -60 280 0 t 280 0" fill="none" stroke="${photo.ink}" stroke-width="5" stroke-linecap="round"/>` +
    `</svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function sampleItem(index: number, createdAt: string, usedAt: string | null = null): InboxItem {
  const photo = PHOTOS[index % PHOTOS.length];
  const url = samplePhotoDataUrl(photo);

  return {
    id: uid('inb'),
    kind: 'image',
    url,
    thumbUrl: url,
    width: 1200,
    height: 900,
    bytes: 184_000 + index * 23_417,
    note: photo.note,
    classId: null,
    createdAt,
    usedAt,
  };
}

function seedState(now = Date.now()): MockInboxState {
  return {
    tokens: [
      {
        id: uid('tok'),
        label: 'iPhone',
        createdAt: new Date(now - 3 * 86_400_000).toISOString(),
        prefix: 'sk_drop_k3',
      },
    ],
    items: [
      sampleItem(0, new Date(now - 42 * MINUTE).toISOString()),
      sampleItem(1, new Date(now - 5 * 60 * MINUTE).toISOString(), new Date(now - 4 * 60 * MINUTE).toISOString()),
      sampleItem(2, new Date(now - 26 * 60 * MINUTE).toISOString()),
    ],
  };
}

/* ------------------------------------------------------------------ state */

let memory: MockInboxState | null = null;

function load(): MockInboxState {
  if (memory) return memory;
  if (typeof window !== 'undefined') {
    try {
      const raw = window.localStorage.getItem(STATE_KEY);

      if (raw) memory = JSON.parse(raw) as MockInboxState;
    } catch {
      // corrupt — reseed
    }
  }
  memory ??= seedState();
  save();

  return memory;
}

function save(): void {
  if (typeof window === 'undefined' || !memory) return;

  try {
    window.localStorage.setItem(STATE_KEY, JSON.stringify(memory));
  } catch {
    // quota (a real photo as a data URL) — the session keeps it in memory
  }
}

/** Test hook. */
export function resetMockInbox(state: MockInboxState | null = null): void {
  memory = state;
}

/* ------------------------------------------------------------------ live arrivals */

const listeners = new Set<(item: InboxItem) => void>();

function addItem(item: InboxItem): InboxItem {
  const state = load();

  state.items = [item, ...state.items].slice(0, 50);
  save();
  listeners.forEach((listener) => listener(item));

  return item;
}

/** A photo «from the iPhone» — force-mock demo of the arrival toast. */
export function simulateMockArrival(): InboxItem {
  const index = Math.floor(Math.random() * PHOTOS.length);

  return addItem(sampleItem(index, new Date().toISOString()));
}

const SIMULATED_KEY = 'study_mock_inbox_simulated';

export const SIMULATED_ARRIVAL_MS = 6_000;

/** Once per browser session, not once per page load (a reload must not keep adding photos). */
function simulationDone(): boolean {
  try {
    return !!window.sessionStorage.getItem(SIMULATED_KEY);
  } catch {
    return true;
  }
}

function simulateOnce(): void {
  if (simulationDone()) return;
  try {
    window.sessionStorage.setItem(SIMULATED_KEY, '1');
  } catch {
    // checked above — storage works
  }
  simulateMockArrival();
}

/**
 * Stand-in for `GET /inbox/stream`: opens at once, emits every mock upload, and (with `simulate`)
 * one made-up arrival a few seconds into the session. Settles when `signal` aborts.
 */
export function mockInboxStream(
  handlers: { onOpen: () => void; onItem: (item: InboxItem) => void },
  signal: AbortSignal,
  { simulate = false }: { simulate?: boolean } = {},
): Promise<void> {
  return new Promise((resolve) => {
    listeners.add(handlers.onItem);
    handlers.onOpen();
    const timer =
      simulate && typeof window !== 'undefined' && !simulationDone()
        ? setTimeout(simulateOnce, SIMULATED_ARRIVAL_MS)
        : null;

    signal.addEventListener(
      'abort',
      () => {
        listeners.delete(handlers.onItem);
        if (timer) clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

const readAsDataUrl = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });

/** Stand-in for the multipart `POST /inbox`. */
export async function mockInboxUpload(
  file: Blob,
  fields: { note?: string; classId?: string } = {},
): Promise<InboxItem> {
  const url = await readAsDataUrl(file);
  const pdf = file.type === 'application/pdf';

  return addItem({
    id: uid('inb'),
    kind: pdf ? 'pdf' : 'image',
    url,
    thumbUrl: pdf ? null : url,
    width: null,
    height: null,
    bytes: file.size,
    note: fields.note?.trim() || null,
    classId: fields.classId ?? null,
    createdAt: new Date().toISOString(),
    usedAt: null,
  });
}

/* ------------------------------------------------------------------ JSON routes */

function parse(path: string): { segments: string[]; query: URLSearchParams } {
  const [pathname, search = ''] = path.split('?');

  return { segments: pathname.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(search) };
}

const notFound = (what: string) => new StudyApiError(404, `${what} not found`, 'NOT_FOUND');

function route(method: string, path: string, body: Body): { value: unknown } | undefined {
  const { segments, query } = parse(path);
  const [head, a, b] = segments;

  if (head !== 'inbox') return undefined;
  const state = load();

  if (a === 'tokens') {
    if (!b && method === 'GET') return { value: state.tokens };
    if (!b && method === 'POST') {
      const label = String(body?.label ?? '').trim() || 'iPhone';
      const secret = `sk_drop_${Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('')}`;
      const token: DropTokenCreated = {
        id: uid('tok'),
        label,
        createdAt: new Date().toISOString(),
        prefix: secret.slice(0, 10),
        token: secret,
      };
      const listed: DropToken = { id: token.id, label: token.label, createdAt: token.createdAt, prefix: token.prefix };

      state.tokens = [listed, ...state.tokens];
      save();

      return { value: token };
    }
    if (b && method === 'DELETE') {
      if (!state.tokens.some((token) => token.id === b)) throw notFound('Token');
      state.tokens = state.tokens.filter((token) => token.id !== b);
      save();

      return { value: undefined };
    }

    return undefined;
  }

  if (!a && method === 'GET') {
    const pageId = query.get('pageId');

    // A note page's queue: every unused item filed into it, newest first, not capped.
    if (pageId) return { value: state.items.filter((item) => item.pageId === pageId && !item.usedAt) };
    const since = query.get('since');
    const after = since ? Date.parse(since) : -Infinity;

    return { value: state.items.filter((item) => Date.parse(item.createdAt) > after).slice(0, 50) };
  }

  if (a && a !== 'stream') {
    const item = state.items.find((candidate) => candidate.id === a);

    if (!item) throw notFound('Inbox item');
    if (!b && method === 'GET') return { value: item };
    if (method === 'DELETE') {
      state.items = state.items.filter((candidate) => candidate.id !== a);
      save();

      return { value: undefined };
    }
    if (b === 'to-page' && method === 'POST') {
      if (item.kind !== 'pdf') throw new StudyApiError(400, 'Only PDFs become notebook pages', 'NOT_PDF');

      throw new StudyApiError(501, 'Turning a PDF into a note needs the live backend', 'MOCK_UNSUPPORTED');
    }
    if (method === 'PATCH') {
      if ('usedAt' in (body ?? {})) item.usedAt = (body?.usedAt as string | null) ?? null;
      if (typeof body?.note === 'string') item.note = body.note;
      if ('pageId' in (body ?? {})) item.pageId = (body?.pageId as string | null) ?? null;
      save();

      return { value: item };
    }
  }

  return undefined;
}

export const inboxMockRoutes = {
  /** `undefined` = not an inbox path; otherwise the answer (or a thrown StudyApiError). */
  json(method: string, path: string, body?: Body): { value: unknown } | undefined {
    return route(method, path, body);
  },
};
