// In-memory backend for every contract endpoint (docs/study-app/CONTRACT.md). Answers when the real
// `/study` module is missing (404 on the probe) or when Settings forces mock mode. Read-mostly data
// comes from `./seed`; what the user creates (notebook pages, questions, MCP keys,
// the Canvas connection) is kept in localStorage so a reload does not lose it.
import type { SseFrame, StudyTransport } from '../http';
import type {
  AttemptInput,
  AttemptStep,
  AttemptVerdict,
  CanvasStatus,
  Exam,
  ExamResult,
  ExamRow,
  Item,
  Lecture,
  McpConnection,
  McpKey,
  Page,
  Question,
  SearchResult,
  StudyClass,
  Today,
  TranscriptSegment,
  VideoTranscript,
  VideoTranscriptUpload,
} from '../types';
import type { MockSeed } from './seed';

import { StudyApiError } from '../errors';

// The A-plan feature owns its own mock routes (grade plan / a-plan / targetLetter) and the extra
// Today fields; imported from its mock module, not its index (which pulls in React).

import { mapClassIdInPath, mapClassIds, toFixtureClassId } from './class-map';
import { pcmMockRoute } from './pcm';
import { loadMockSeed } from './seed';
import { delay, streamFrames, streamText } from './sse';
import { getMockBlobStore } from './store';

import { aplanMockRoutes, withAPlanToday } from '@/features/aplan/mock';
// Concept Map Studio owns every /concept-maps route (JSON + SSE); undefined = not its path.
import { conceptMapMockRoutes } from '@/features/conceptmaps/mock';
import { notesDigestMockSse, slideTermsMockSse } from '@/features/conceptmaps/notes/mock';
// My handwriting glyph bank: /handwriting/bank (GET/PUT with a version check); undefined = not its path.
import { handwritingMockRoutes } from '@/features/handwriting/mock';
// Phone inbox: /inbox (items) and /inbox/tokens (drop tokens); undefined = not its path.
import { inboxMockRoutes } from '@/features/inbox/mock';
// Class meetings + the lecture-note fields on Page (week / moduleId / lecture, PATCH /pages/:id).
import {
  pageLectureFields,
  pageMatchesLecture,
  patchClassMeetings,
  patchPageFields,
  withClassMeetings,
} from '@/features/lecturenotes/mock';
// Sharing: /share (demo classmates + make a copy through this transport); undefined = not its path.
import { shareMockRoutes } from '@/features/share/mock';
// Perf telemetry: /telemetry/perf (POST batches, GET the owner read); undefined = not its path.
import { perfMockRoutes } from '@/lib/perf/mock';
// Auto-colour cloud classifier: /ai/ink-classify; undefined = not its path.
import { inkMockRoutes } from '@/lib/ink/mock';
// The tutor owns /ai/ask, /ai/conversations and /board-ai/* (JSON + SSE); undefined = not its path.
import { tutorMockRoutes } from '@/features/tutor/mock';

/* ------------------------------------------------------------------ persisted state */

interface PersistedState {
  pages: Page[];
  /** pageId → { version, json } — the "B2 object" of each notebook page. */
  pageContents: Record<string, { version: number; json: string }>;
  createdQuestions: Question[];
  questionPatches: Record<string, Partial<Question>>;
  deletedQuestionIds: string[];
  mcpKeys: McpKey[];
  /** Absent in states saved before connections existed — seeded on first read. */
  mcpConnections?: McpConnection[];
  canvas: CanvasStatus;
  lectures: Lecture[];
  exams: Exam[];
  seenItemIds: string[];
  videoTranscripts: Record<string, VideoTranscript>;
}

const STATE_KEY = 'study_mock_state';
const DAY = 86_400_000;
const nowIso = () => new Date().toISOString();
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const uid = (prefix: string) =>
  `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;

function defaultCanvas(): CanvasStatus {
  return {
    connected: true,
    baseUrl: 'https://canvas.example.edu',
    canvasUser: { id: 1, name: 'Mock Student' },
    tokenExpiresAt: iso(45 * DAY),
    lastSyncAt: iso(-25 * 60_000),
    syncing: false,
    lastError: null,
  };
}

function emptyState(): PersistedState {
  return {
    pages: [],
    pageContents: {},
    createdQuestions: [],
    questionPatches: {},
    deletedQuestionIds: [],
    mcpKeys: [],
    canvas: defaultCanvas(),
    lectures: [],
    exams: [],
    seenItemIds: [],
    videoTranscripts: {},
  };
}

function loadState(): PersistedState {
  if (typeof window === 'undefined') return emptyState();

  try {
    const raw = window.localStorage.getItem(STATE_KEY);

    if (!raw) return emptyState();

    return { ...emptyState(), ...(JSON.parse(raw) as Partial<PersistedState>) };
  } catch {
    return emptyState();
  }
}

function saveState(state: PersistedState): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // quota — the session still works from memory
  }
}

/* ------------------------------------------------------------------ helpers */

const notFound = (what: string) => new StudyApiError(404, `${what} not found`, 'NOT_FOUND');
const badRequest = (message: string) => new StudyApiError(400, message, 'BAD_REQUEST');

function parsePath(path: string): { segments: string[]; query: URLSearchParams } {
  const [pathname, search = ''] = path.split('?');

  return {
    segments: pathname.split('/').filter(Boolean).map(decodeURIComponent),
    query: new URLSearchParams(search),
  };
}

/**
 * Page images for the Study MCP (`/pages/:id/renders`) + Claude's annotations, in memory only (blobs
 * don't survive a reload anyway). `window.__studyMockRenders` lets a browser test inspect / seed it.
 */
const mockRenders = (() => {
  const renders = new Map<string, Map<number, { hash: string; version: number; boardPageId: string; size: number; type: string }>>();
  const commits = new Map<string, { version: number; pageCount: number }>();
  const notes = new Map<string, { id: string; page: number; markdown: string; author: string; createdAt: string }[]>();
  const images = new Map<string, Blob>();
  const of = (pageId: string) => renders.get(pageId) ?? renders.set(pageId, new Map()).get(pageId)!;
  const api = {
    renders,
    commits,
    notes,
    images,
    list: (pageId: string) => ({
      version: commits.get(pageId)?.version ?? 0,
      pageCount: commits.get(pageId)?.pageCount ?? null,
      renders: [...of(pageId).entries()].map(([index, entry]) => ({ index, ...entry })),
    }),
    put(pageId: string, index: number, blob: Blob, query: URLSearchParams) {
      if (blob.size > 8 * 1024 * 1024) throw new StudyApiError(413, 'Too large', 'PAYLOAD_TOO_LARGE');
      const entry = {
        hash: query.get('hash') ?? '',
        version: Number(query.get('version')),
        boardPageId: query.get('boardPageId') ?? '',
        size: blob.size,
        type: blob.type,
      };

      of(pageId).set(index, entry);
      images.set(`${pageId}/${index}`, blob);

      return { index, ...entry };
    },
    commit(pageId: string, version: number, pageCount: number) {
      if (!Number.isFinite(version)) throw badRequest('version is required');
      if (version < (commits.get(pageId)?.version ?? 0)) throw new StudyApiError(409, 'Stale', 'STALE_VERSION');
      commits.set(pageId, { version, pageCount });
      for (const index of of(pageId).keys()) if (index >= pageCount) of(pageId).delete(index);

      return api.list(pageId);
    },
    annotations: (pageId: string) => notes.get(pageId) ?? [],
    deleteAnnotation(pageId: string, id: string) {
      notes.set(pageId, api.annotations(pageId).filter((note) => note.id !== id));
    },
  };

  if (typeof window !== 'undefined') (window as unknown as { __studyMockRenders: typeof api }).__studyMockRenders = api;

  return api;
})();

const pageContentUrl = (pageId: string, version: number) => `mock://pages/${pageId}/v${version}`;

function pickWords(text: string, max = 40): string {
  return text.replace(/\s+/g, ' ').trim().split(' ').slice(0, max).join(' ');
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_#$>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Replaces every integer in the stem with a nearby one — "same type/topic, new numbers". */
function renumber(text: string): string {
  return text.replace(/\b\d+\b/g, (match) => {
    const value = Number(match);

    if (value > 2030 || value === 0) return match;
    const delta = Math.max(1, Math.round(value * 0.3));
    const next = value + (Math.random() < 0.5 ? -delta : delta);

    return String(Math.max(1, next));
  });
}

/* ------------------------------------------------------------------ the mock */

class MockDb {
  seed!: MockSeed;
  state!: PersistedState;
  private ready: Promise<void> | null = null;

  init(): Promise<void> {
    if (!this.ready) {
      this.ready = loadMockSeed().then((seed) => {
        this.seed = seed;
        this.state = loadState();
        // Rehydrate the `mock://` blob store with persisted page JSON so content GETs resolve.
        for (const [pageId, entry] of Object.entries(this.state.pageContents)) {
          getMockBlobStore().set(
            pageContentUrl(pageId, entry.version),
            new Blob([entry.json], { type: 'application/json' }),
          );
        }
      });
    }

    return this.ready;
  }

  persist(): void {
    saveState(this.state);
  }

  /* ---- classes & items */

  classes(term: string | null): StudyClass[] {
    const all = this.seed.classes.map((cls) => withClassMeetings(this.withLiveCounts(cls)));

    if (term === 'all') return all;
    const current = all.find((cls) => cls.term)?.term;

    return term
      ? all.filter((cls) => cls.term === term)
      : all.filter((cls) => cls.source === 'manual' || !current || cls.term === current);
  }

  private withLiveCounts(cls: StudyClass): StudyClass {
    const seen = new Set(this.state.seenItemIds);
    const unseen = this.seed.items.filter(
      (item) => item.classId === cls.id && !item.seenAt && !seen.has(item.id),
    ).length;

    return { ...cls, counts: { ...cls.counts, unseen } };
  }

  item(id: string): Item {
    const found = this.seed.items.find((candidate) => candidate.id === id);

    if (!found) throw notFound('Item');
    // Fixture file URLs are placeholders (example.invalid): serve the bundled sample PDF instead so the
    // annotate flow (download → importPdfFile → board pages) runs end to end in mock mode.
    const item: Item =
      found.file && /example\.invalid/.test(found.file.url)
        ? { ...found, file: { ...found.file, url: '/mock/sample.pdf', expiresAt: iso(6 * 3_600_000) } }
        : found;

    return this.state.seenItemIds.includes(id) && !item.seenAt ? { ...item, seenAt: nowIso() } : item;
  }

  items(classId: string, type: string | null, q: string | null): Item[] {
    const needle = q?.trim().toLowerCase();

    return this.seed.items
      .filter((item) => item.classId === classId)
      .filter((item) => !type || item.type === type)
      .filter((item) => !needle || item.title.toLowerCase().includes(needle))
      .map((item) => this.item(item.id));
  }

  today(): Today {
    const base: Today = this.seed.today ?? {
      due: [],
      overdue: [],
      unseen: [],
      announcements: [],
      review: { dueCount: 0, newCount: 0 },
      weakTopics: [],
      classes: this.seed.classes,
    };
    const seen = new Set(this.state.seenItemIds);
    const due = this.allQuestions().filter((question) => new Date(question.srs.dueAt).getTime() <= Date.now()).length;

    return {
      ...base,
      unseen: base.unseen.filter((item) => !seen.has(item.id)),
      announcements: base.announcements.filter((item) => !seen.has(item.id)),
      review: { dueCount: due, newCount: this.state.createdQuestions.length },
      classes: this.classes(null),
    };
  }

  transcript(itemId: string): VideoTranscript {
    const uploaded = this.state.videoTranscripts[itemId];

    if (uploaded) return uploaded;
    const base = (segments: TranscriptSegment[], source: 'captions' | 'asr'): VideoTranscript => ({
      itemId,
      transcriptStatus: 'ready',
      segments,
      summary: null,
      keyPoints: [],
      source,
      lang: 'en',
      durationSec: segments.length ? segments[segments.length - 1].end : null,
      error: null,
      updatedAt: nowIso(),
    });
    const found = this.seed.transcriptsByItem[itemId];

    if (found) return { ...base(found.segments, 'captions'), summary: found.summary, keyPoints: found.keyPoints };
    const item = this.seed.items.find((candidate) => candidate.id === itemId);

    if (!item || item.type !== 'video') throw notFound('Transcript');

    return base(
      [
        { start: 0, end: 8, text: `This is a mock transcript for "${item.title}".` },
        { start: 8, end: 18, text: 'The real backend pulls YouTube captions first, then falls back to ASR.' },
      ],
      'asr',
    );
  }

  /** `PUT /videos/:itemId/transcript` — captions the device fetched from YouTube. */
  uploadTranscript(itemId: string, body: Partial<VideoTranscriptUpload>): VideoTranscript {
    const segments = Array.isArray(body.segments) ? body.segments : [];

    if (segments.length === 0) throw badRequest('segments are required');
    const transcript: VideoTranscript = {
      itemId,
      transcriptStatus: 'ready',
      segments,
      summary: null,
      keyPoints: [],
      source: 'captions',
      lang: body.lang ?? 'en',
      durationSec: body.durationSec ?? segments[segments.length - 1].end,
      error: null,
      updatedAt: nowIso(),
    };

    this.state.videoTranscripts[itemId] = transcript;
    this.persist();

    return transcript;
  }

  /* ---- pages */

  pages(
    classId: string | null,
    itemId: string | null,
    week: string | null = null,
    lectureKey: string | null = null,
  ): Page[] {
    return this.state.pages
      .map((page) => ({ ...pageLectureFields(page), ...page }))
      .filter((page) => !classId || page.classId === classId)
      .filter((page) => !itemId || page.itemId === itemId)
      .filter((page) => pageMatchesLecture(page, week, lectureKey))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  createPage(body: Partial<Page>): Page {
    if (!body.title || !body.kind) throw badRequest('title and kind are required');
    const page: Page = {
      id: uid('pg'),
      classId: body.classId ?? null,
      itemId: body.itemId ?? null,
      lectureId: body.lectureId ?? null,
      ...pageLectureFields(body),
      title: body.title,
      kind: body.kind,
      updatedAt: nowIso(),
      version: 0,
      thumbUrl: null,
      // A typed page (what MCP add_note_page creates): markdown text, empty board.
      ...(typeof body.markdown === 'string' && body.markdown ? { markdown: body.markdown } : {}),
    };

    this.state.pages.unshift(page);
    this.persist();

    return page;
  }

  page(id: string): Page {
    const page = this.state.pages.find((candidate) => candidate.id === id);

    if (!page) throw notFound('Page');

    return page;
  }

  pageContent(id: string): { url: string | null; version: number; expiresAt: string | null } {
    const page = this.page(id);
    const content = this.state.pageContents[id];

    // Never committed: an empty page, not an error (matches the live backend).
    if (!content) return { url: null, version: 0, expiresAt: null };

    return { url: pageContentUrl(page.id, content.version), version: content.version, expiresAt: iso(3_600_000) };
  }

  /** One-call save (`PUT content/blob?baseVersion=`): upload + commit. 409 STALE_VERSION carries `currentVersion`. */
  async putPageBlob(id: string, baseVersion: number, json: string): Promise<{ version: number; expiresAt: string }> {
    const page = this.page(id);

    if (baseVersion !== page.version) {
      throw Object.assign(new StudyApiError(409, `Stale version: server has ${page.version}`, 'STALE_VERSION'), {
        currentVersion: page.version,
      });
    }

    const version = page.version + 1;

    getMockBlobStore().set(pageContentUrl(page.id, version), new Blob([json], { type: 'application/json' }));
    await this.commitPage(id, version);

    return { version, expiresAt: iso(3_600_000) };
  }

  beginPageUpload(id: string, baseVersion: number): { uploadUrl: string; version: number } {
    const page = this.page(id);

    if (baseVersion !== page.version) {
      throw new StudyApiError(409, `Stale version: server has ${page.version}`, 'STALE_VERSION');
    }

    return { uploadUrl: pageContentUrl(page.id, page.version + 1), version: page.version + 1 };
  }

  async commitPage(id: string, version: number): Promise<Page> {
    const page = this.page(id);
    const blob = getMockBlobStore().get(pageContentUrl(page.id, version));

    if (!blob) throw badRequest('Nothing was uploaded for this version');
    const json = await blob.text();

    this.state.pageContents[page.id] = { version, json };
    page.version = version;
    page.updatedAt = nowIso();
    this.persist();

    return page;
  }

  deletePage(id: string): void {
    this.state.pages = this.state.pages.filter((page) => page.id !== id);
    delete this.state.pageContents[id];
    this.persist();
  }

  /* ---- questions */

  allQuestions(): Question[] {
    const deleted = new Set(this.state.deletedQuestionIds);

    return [...this.state.createdQuestions, ...this.seed.questions]
      .filter((question) => !deleted.has(question.id))
      .map((question) => ({ ...question, ...(this.state.questionPatches[question.id] ?? {}) }));
  }

  question(id: string): Question {
    const question = this.allQuestions().find((candidate) => candidate.id === id);

    if (!question) throw notFound('Question');

    return question;
  }

  upsertQuestionPatch(id: string, patch: Partial<Question>): Question {
    this.question(id);
    this.state.questionPatches[id] = { ...(this.state.questionPatches[id] ?? {}), ...patch, id };
    this.persist();

    return this.question(id);
  }

  createQuestions(drafts: Partial<Question>[]): Question[] {
    const existing = this.allQuestions();
    const created: Question[] = [];

    for (const draft of drafts) {
      const stem = (draft.stem ?? '').trim();

      if (!stem || !draft.classId) continue;
      // Dedupe: a near-identical stem merges into the existing question.
      const key = stripMarkdown(stem).toLowerCase().slice(0, 80);
      const duplicate = existing.find((question) => stripMarkdown(question.stem).toLowerCase().slice(0, 80) === key);

      if (duplicate) {
        created.push(duplicate);
        continue;
      }

      const question: Question = {
        id: uid('q'),
        classId: draft.classId,
        topic: draft.topic ?? 'General',
        subtopic: draft.subtopic ?? null,
        difficulty: draft.difficulty ?? 3,
        source: draft.source ?? { kind: 'manual', itemId: null, pageId: null, lectureId: null, ref: null },
        type: draft.type ?? 'free',
        stem,
        imageUrl: draft.imageUrl ?? null,
        choices: draft.choices,
        answer: draft.answer ?? '',
        solutionSteps: draft.solutionSteps ?? [],
        tags: draft.tags ?? [],
        stats: { attempts: 0, correct: 0, lastResult: null, mastery: 0 },
        srs: { dueAt: nowIso(), stability: 0, difficulty: 5, reps: 0, lapses: 0 },
        createdAt: nowIso(),
      };

      this.state.createdQuestions.unshift(question);
      created.push(question);
    }

    this.persist();

    return created;
  }

  deleteQuestion(id: string): void {
    this.state.deletedQuestionIds.push(id);
    this.state.createdQuestions = this.state.createdQuestions.filter((question) => question.id !== id);
    this.persist();
  }

  /** FSRS-ish: right → longer interval, wrong → tomorrow + lapse. */
  recordAttempt(id: string, result: AttemptVerdict['result'], rating?: 1 | 2 | 3 | 4): Question {
    const question = this.question(id);
    const attempts = question.stats.attempts + 1;
    const correct = question.stats.correct + (result === 'right' ? 1 : result === 'partial' ? 0.5 : 0);
    const mastery = Math.min(
      1,
      Math.max(0, question.stats.mastery * 0.7 + (result === 'right' ? 0.3 : result === 'partial' ? 0.15 : 0)),
    );
    const stability =
      result === 'right'
        ? Math.max(1, question.srs.stability * 2.2 + 1)
        : result === 'partial'
          ? Math.max(0.5, question.srs.stability)
          : 0.3;
    const srs = {
      dueAt: iso((rating === 4 ? stability * 1.6 : stability) * DAY),
      stability,
      difficulty: Math.min(10, Math.max(1, question.srs.difficulty + (result === 'right' ? -0.3 : 0.6))),
      reps: question.srs.reps + 1,
      lapses: question.srs.lapses + (result === 'wrong' ? 1 : 0),
    };

    return this.upsertQuestionPatch(id, { stats: { attempts, correct, lastResult: result, mastery }, srs });
  }

  mastery(classId: string | null): {
    topics: Question['topic'] extends string
      ? { topic: string; mastery: number; attempts: number; dueCount: number }[]
      : never;
  } {
    if (classId && this.seed.masteryByClass[classId]) return this.seed.masteryByClass[classId];
    const topics = new Map<string, { topic: string; mastery: number; attempts: number; dueCount: number; n: number }>();

    for (const question of this.allQuestions()) {
      if (classId && question.classId !== classId) continue;
      const entry = topics.get(question.topic) ?? { topic: question.topic, mastery: 0, attempts: 0, dueCount: 0, n: 0 };

      entry.mastery += question.stats.mastery;
      entry.attempts += question.stats.attempts;
      entry.dueCount += new Date(question.srs.dueAt).getTime() <= Date.now() ? 1 : 0;
      entry.n += 1;
      topics.set(question.topic, entry);
    }

    return {
      topics: Array.from(topics.values()).map(({ n, ...entry }) => ({ ...entry, mastery: n ? entry.mastery / n : 0 })),
    };
  }

  /* ---- exams */

  exam(id: string): Exam {
    const exam = this.state.exams.find((candidate) => candidate.id === id);

    if (!exam) throw notFound('Exam');

    return exam;
  }

  createExam(body: { classId: string; topics?: string[]; count: number; minutes: number }): Exam {
    const pool = this.allQuestions().filter(
      (question) => question.classId === body.classId && (!body.topics?.length || body.topics.includes(question.topic)),
    );
    const questions = [...pool].sort(() => Math.random() - 0.5).slice(0, Math.max(1, body.count || 10));
    const exam: Exam = {
      id: uid('ex'),
      classId: body.classId,
      topics: body.topics ?? [],
      count: Math.max(1, body.count || 10),
      questions,
      minutes: body.minutes || 30,
      startedAt: nowIso(),
      submittedAt: null,
      late: false,
      score: null,
    };

    this.state.exams.unshift(exam);
    this.persist();

    return exam;
  }

  /* ---- lectures */

  lecture(id: string): Lecture {
    const lecture = this.state.lectures.find((candidate) => candidate.id === id);

    if (!lecture) throw notFound('Lecture');

    return lecture;
  }

  /* ---- MCP keys */

  mcpConnections(): McpConnection[] {
    this.state.mcpConnections ??= [
      {
        id: 'conn_sample_claude',
        clientName: 'Claude',
        clientId: 'claude-ai',
        createdAt: iso(-12 * DAY),
        lastUsedAt: iso(-3 * 3_600_000),
        scopes: ['study:read', 'study:write'],
      },
    ];

    return this.state.mcpConnections;
  }

  createMcpKey(name: string): McpKey {
    const secret = `sk_study_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    const key: McpKey = {
      id: uid('key'),
      name: name || 'Claude',
      prefix: secret.slice(0, 14),
      createdAt: nowIso(),
      lastUsedAt: null,
    };

    this.state.mcpKeys.unshift(key);
    this.persist();

    return { ...key, secret };
  }

  /* ---- search */

  search(q: string): SearchResult {
    const needle = q.trim().toLowerCase();

    if (!needle) return { items: [], pages: [], questions: [], transcripts: [] };
    const items = this.seed.items.filter((item) => item.title.toLowerCase().includes(needle)).slice(0, 30);
    const pages = this.state.pages.filter((page) => page.title.toLowerCase().includes(needle)).slice(0, 30);
    const questions = this.allQuestions()
      .filter((question) => question.stem.toLowerCase().includes(needle))
      .slice(0, 30);
    const transcripts: SearchResult['transcripts'] = [];

    for (const [itemId, transcript] of Object.entries(this.seed.transcriptsByItem)) {
      for (const segment of transcript.segments) {
        if (segment.text.toLowerCase().includes(needle))
          transcripts.push({ itemId, lectureId: null, start: segment.start, text: segment.text });
      }
    }

    return { items, pages, questions, transcripts: transcripts.slice(0, 30) };
  }
}

const db = new MockDb();

/* ------------------------------------------------------------------ JSON routing */

type Body = Record<string, unknown> | undefined;

async function routeJson(method: string, path: string, body: Body, headers?: Record<string, string>): Promise<unknown> {
  await db.init();
  await delay(60 + Math.random() * 120);

  const { segments, query } = parsePath(path);
  const [head, a, b, c] = segments;
  const key = `${method} /${segments.map((segment, index) => (index % 2 === 1 ? ':' : segment)).join('/')}`;

  const tutor = tutorMockRoutes.json(method, path, body);

  if (tutor) return tutor;

  const conceptMaps = conceptMapMockRoutes.json(method, path, body);

  if (conceptMaps) return conceptMaps;

  const inbox = inboxMockRoutes.json(method, path, body);

  if (inbox) return inbox.value;

  const handwriting = handwritingMockRoutes.json(method, path, body, headers);

  if (handwriting) return handwriting.value;

  const share = shareMockRoutes.json(method, path, body);

  if (share) return share.value;

  const perf = perfMockRoutes.json(method, path, body);

  if (perf) return perf.value;

  const ink = inkMockRoutes.json(method, path, body);

  if (ink) return ink.value;

  // The class id is a PATH segment here (`/classes/:id/a-plan`), which the transport's edge mapping
  // (query `classId` + body) does not touch: hand the feature the fixture id or every live class
  // answers 404 «No syllabus». The reply's `classId` fields are mapped back to live ids by the edge.
  const aplan = aplanMockRoutes(
    method,
    head === 'classes' && a ? [head, toFixtureClassId(a), ...segments.slice(2)] : segments,
    body,
  );

  if (aplan) return aplan.value;

  // P-CM: library, guide, exam schedule + results (class ids are fixture ids here).
  const pcm = pcmMockRoute(
    method,
    head === 'classes' && a ? [head, toFixtureClassId(a), ...segments.slice(2)] : segments,
    query,
    body,
  );

  if (pcm) return pcm.value;

  switch (head) {
    case 'canvas': {
      if (a === 'connection' && method === 'GET') return db.state.canvas;
      if (a === 'connection' && method === 'PUT') {
        const token = String(body?.token ?? '').trim();

        if (!token) throw badRequest('Canvas token is required');
        db.state.canvas = {
          ...defaultCanvas(),
          baseUrl: String(body?.baseUrl ?? 'https://canvas.example.edu'),
          tokenExpiresAt: (body?.expiresAt as string | undefined) ?? iso(90 * DAY),
          lastSyncAt: nowIso(),
        };
        db.persist();

        return db.state.canvas;
      }
      if (a === 'connection' && method === 'DELETE') {
        db.state.canvas = {
          ...defaultCanvas(),
          connected: false,
          canvasUser: null,
          tokenExpiresAt: null,
          lastSyncAt: null,
        };
        db.persist();

        return undefined;
      }
      if (a === 'sync' && method === 'POST') {
        db.state.canvas = { ...db.state.canvas, syncing: true };
        setTimeout(() => {
          db.state.canvas = { ...db.state.canvas, syncing: false, lastSyncAt: nowIso(), lastError: null };
          db.persist();
        }, 2_500);

        return { started: true };
      }
      break;
    }
    case 'classes': {
      if (!a && method === 'GET') return db.classes(query.get('term'));
      // Manual classes: in memory only (a reload drops them) — the sample never pretends they persisted.
      if (!a && method === 'POST') {
        const input = (body ?? {}) as { name?: string; code?: string; color?: string };
        const cls: StudyClass = {
          id: `cls_manual_${Date.now()}`,
          canvasCourseId: -Date.now(),
          source: 'manual',
          name: String(input.name ?? 'Untitled'),
          code: String(input.code ?? ''),
          term: '',
          color: input.color ?? '#6B46C1',
          grade: { score: null, letter: null, trend: 0 },
          counts: { due: 0, overdue: 0, unseen: 0 },
        };

        db.seed.classes.push(cls);

        return cls;
      }
      if (a && !b && method === 'DELETE') {
        db.seed.classes = db.seed.classes.filter((row) => row.id !== a || row.source !== 'manual');

        return undefined;
      }
      if (a && !b && method === 'PATCH') {
        const cls = db.seed.classes.find((row) => row.id === a && row.source === 'manual');
        const patch = (body ?? {}) as Partial<Pick<StudyClass, 'name' | 'code' | 'color'>>;

        if (cls && (patch.name !== undefined || patch.code !== undefined || patch.color !== undefined)) {
          Object.assign(cls, patch);

          return cls;
        }
      }
      if (a && !b && method === 'PATCH') {
        const cls = db.seed.classes.find((row) => row.id === a || row.id === toFixtureClassId(a));
        const meetings = patchClassMeetings(cls, body);

        if (meetings) return meetings.value;
      }
      if (a && b === 'modules' && method === 'GET') return db.seed.modulesByClass[a] ?? [];
      if (a && b === 'items' && method === 'GET') return db.items(a, query.get('type'), query.get('q'));
      break;
    }
    case 'items': {
      if (a && !b && method === 'GET') return db.item(a);
      if (a && b === 'seen' && method === 'POST') {
        if (!db.state.seenItemIds.includes(a)) {
          db.state.seenItemIds.push(a);
          db.persist();
        }

        return undefined;
      }
      break;
    }
    case 'videos': {
      if (a && b === 'transcript' && method === 'GET') return db.transcript(a);
      if (a && b === 'transcript' && method === 'POST') return { queued: true };
      if (a && b === 'transcript' && method === 'PUT')
        return db.uploadTranscript(a, (body ?? {}) as Partial<VideoTranscriptUpload>);
      break;
    }
    case 'today': {
      if (method === 'GET') return withAPlanToday(db.today());
      break;
    }
    case 'pages': {
      if (!a && method === 'GET')
        return db.pages(query.get('classId'), query.get('itemId'), query.get('week'), query.get('lectureKey'));
      if (a && !b && method === 'PATCH') {
        const page = patchPageFields(db.page(a), body);

        db.persist();

        return page;
      }
      if (!a && method === 'POST') return db.createPage((body ?? {}) as Partial<Page>);
      if (a && !b && method === 'GET') return db.page(a);
      if (a && !b && method === 'DELETE') return db.deletePage(a);
      if (a && b === 'content' && !c && method === 'GET') return db.pageContent(a);
      if (a && b === 'content' && !c && method === 'PUT') return db.beginPageUpload(a, Number(body?.baseVersion ?? 0));
      if (a && b === 'content' && c === 'commit' && method === 'POST') return db.commitPage(a, Number(body?.version));
      if (a && b === 'content' && c === 'blob' && method === 'PUT') {
        return db.putPageBlob(a, Number(query.get('baseVersion') ?? 0), String(body?.__raw ?? ''));
      }
      if (a && b === 'ocr' && method === 'PUT') return undefined;
      if (a && b === 'renders' && !c && method === 'GET') return mockRenders.list(a);
      if (a && b === 'renders' && c === 'commit' && method === 'POST') {
        return mockRenders.commit(a, Number(body?.version), Number(body?.pageCount));
      }
      if (a && b === 'annotations' && !c && method === 'GET') return mockRenders.annotations(a);
      if (a && b === 'annotations' && c && method === 'DELETE') return mockRenders.deleteAnnotation(a, c);
      break;
    }
    case 'search': {
      if (method === 'GET') return db.search(query.get('q') ?? '');
      break;
    }
    case 'questions': {
      if (!a && method === 'GET') {
        const classId = query.get('classId');
        const topic = query.get('topic');
        const due = query.get('due') === '1' || query.get('due') === 'true';
        const source = query.get('source');
        const q = query.get('q')?.toLowerCase();
        const limit = Math.min(200, Number(query.get('limit') ?? 50) || 50);
        const cursor = Number(query.get('cursor') ?? 0) || 0;
        const all = db
          .allQuestions()
          .filter((question) => !classId || question.classId === classId)
          .filter((question) => !topic || question.topic === topic)
          .filter((question) => !due || new Date(question.srs.dueAt).getTime() <= Date.now())
          .filter((question) => !source || question.source.kind === source)
          .filter(
            (question) =>
              !q ||
              question.stem.toLowerCase().includes(q) ||
              question.topic.toLowerCase().includes(q) ||
              question.tags.some((tag) => tag.toLowerCase().includes(q)),
          );
        const items = all.slice(cursor, cursor + limit);

        return { items, next: cursor + limit < all.length ? String(cursor + limit) : null };
      }
      if (!a && method === 'POST') return db.createQuestions((body?.questions as Partial<Question>[]) ?? []);
      if (a && !b && method === 'PATCH') return db.upsertQuestionPatch(a, (body ?? {}) as Partial<Question>);
      if (a && !b && method === 'DELETE') return db.deleteQuestion(a);
      break;
    }
    case 'review': {
      if (a === 'next' && method === 'GET') {
        const classId = query.get('classId');
        const limit = Number(query.get('limit') ?? 20) || 20;
        const weak = new Map(db.mastery(classId).topics.map((topic) => [topic.topic, topic.mastery]));

        return db
          .allQuestions()
          .filter((question) => !classId || question.classId === classId)
          .sort((x, y) => {
            const dueX = new Date(x.srs.dueAt).getTime() <= Date.now() ? 0 : 1;
            const dueY = new Date(y.srs.dueAt).getTime() <= Date.now() ? 0 : 1;

            if (dueX !== dueY) return dueX - dueY;

            return (weak.get(x.topic) ?? 0) - (weak.get(y.topic) ?? 0);
          })
          .slice(0, limit);
      }
      break;
    }
    case 'mastery': {
      if (method === 'GET') return db.mastery(query.get('classId'));
      break;
    }
    case 'exams': {
      if (!a && method === 'GET') {
        const classId = query.get('classId');

        return db.state.exams
          .filter((exam) => !classId || exam.classId === classId)
          .map(
            (exam): ExamRow => ({
              id: exam.id,
              classId: exam.classId,
              topics: exam.topics ?? [],
              questionCount: exam.questions.length,
              minutes: exam.minutes,
              startedAt: exam.startedAt,
              submittedAt: exam.submittedAt,
              late: exam.late ?? false,
              score: exam.score ?? null,
            }),
          );
      }
      if (!a && method === 'POST')
        return db.createExam(body as { classId: string; topics?: string[]; count: number; minutes: number });
      if (a && !b && method === 'GET') return db.exam(a);
      break;
    }
    case 'lectures': {
      if (!a && method === 'GET') {
        const classId = query.get('classId');

        return db.state.lectures.filter((lecture) => !classId || lecture.classId === classId);
      }
      if (!a && method === 'POST') {
        const lecture: Lecture = {
          id: uid('lec'),
          classId: String(body?.classId ?? ''),
          title: String(body?.title ?? 'Lecture'),
          startedAt: String(body?.startedAt ?? nowIso()),
          durationSec: 0,
          pageIds: [],
          audio: null,
          status: 'recording',
          summary: null,
          keyPoints: [],
          questionCount: 0,
          error: null,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };

        db.state.lectures.unshift(lecture);
        db.persist();

        return { lecture, upload: { uploadId: uid('up') } };
      }
      if (a && b === 'chunks' && method === 'POST') {
        db.lecture(a);

        return { uploadUrl: `mock://lectures/${a}/chunk-${Number(body?.index ?? 0)}` };
      }
      if (a && b === 'finish' && method === 'POST') {
        const lecture = db.lecture(a);

        lecture.durationSec = Number(body?.durationSec ?? 0);
        lecture.status = 'processing';
        db.persist();
        setTimeout(() => {
          const chunks: Blob[] = [];

          for (let index = 0; index < Number(body?.chunks ?? 0); index += 1) {
            const chunk = getMockBlobStore().get(`mock://lectures/${a}/chunk-${index}`);

            if (chunk) chunks.push(chunk);
          }
          const audioUrl = `mock://lectures/${a}/audio`;

          getMockBlobStore().set(audioUrl, new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' }));
          lecture.audio = { url: audioUrl, expiresAt: iso(6 * 3_600_000), mime: chunks[0]?.type || 'audio/webm' };
          lecture.status = 'ready';
          lecture.transcript = {
            segments: [
              { start: 0, end: 9, text: 'Mock transcript: the real backend runs English ASR on the uploaded audio.' },
              {
                start: 9,
                end: 20,
                text: 'Strokes written during the lecture carry a timestamp so playback can scrub to them.',
              },
            ],
          };
          lecture.summary = 'A mock summary of the lecture.';
          lecture.keyPoints = ['Key point one', 'Key point two'];
          lecture.questionCount = 3;
          lecture.updatedAt = nowIso();
          db.persist();
        }, 4_000);

        return lecture;
      }
      if (a && !b && method === 'GET') return db.lecture(a);
      break;
    }
    case 'mcp': {
      if (a === 'connections' && !b && method === 'GET') return db.mcpConnections();
      if (a === 'connections' && b && method === 'DELETE') {
        db.state.mcpConnections = db.mcpConnections().filter((connection) => connection.id !== b);
        db.persist();

        return undefined;
      }
      if (a === 'keys' && !b && method === 'GET') return db.state.mcpKeys;
      if (a === 'keys' && !b && method === 'POST') return db.createMcpKey(String(body?.name ?? ''));
      if (a === 'keys' && b && method === 'DELETE') {
        db.state.mcpKeys = db.state.mcpKeys.filter((mcpKey) => mcpKey.id !== b);
        db.persist();

        return undefined;
      }
      break;
    }
    default:
      break;
  }

  throw new StudyApiError(404, `Mock has no route for ${key}`, 'MOCK_NO_ROUTE');
}

/* ------------------------------------------------------------------ SSE routing */

async function routeSse(
  path: string,
  body: Body,
  onFrame: (frame: SseFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  await db.init();
  // «Snap the slide» asks the tutor one fixed question; answered before the tutor's generic mock.
  const slideTermsSse = slideTermsMockSse(path, body, onFrame, signal);

  if (slideTermsSse) return slideTermsSse;

  const tutorSse = tutorMockRoutes.sse(path, body, onFrame, signal);

  if (tutorSse) return tutorSse;

  const notesDigestSse = notesDigestMockSse(path, onFrame, signal);

  if (notesDigestSse) return notesDigestSse;

  const conceptMapsSse = conceptMapMockRoutes.sse(path, body, onFrame, signal);

  if (conceptMapsSse) return conceptMapsSse;
  const { segments } = parsePath(path);
  const [head, a, b] = segments;

  if (head === 'questions' && a === 'extract') {
    const classId = String(body?.classId ?? db.seed.classes[0]?.id ?? '');
    const from = (body?.from ?? {}) as { itemId?: string; pageId?: string; lectureId?: string; imagePngB64?: string };
    const item = from.itemId ? db.seed.items.find((candidate) => candidate.id === from.itemId) : null;
    const topic = item?.title.replace(/\.(pdf|pptx?)$/i, '') ?? (from.imagePngB64 ? 'Photo' : 'Extracted');
    const drafts: Partial<Question>[] = [
      {
        classId,
        topic,
        type: 'free',
        difficulty: 2,
        stem: `Define the central idea introduced in "${topic}" in one sentence.`,
        answer: 'A concise definition, in your own words.',
        solutionSteps: ['Name the concept.', 'State what it does and why it matters.'],
      },
      {
        classId,
        topic,
        type: 'mcq',
        difficulty: 2,
        stem: `Which statement about "${topic}" is correct?`,
        choices: [
          'It is only used in theory.',
          'It applies the definition above.',
          'It contradicts the lecture.',
          'None of the above.',
        ],
        answer: 'It applies the definition above.',
        solutionSteps: [
          'Eliminate the two obviously wrong choices.',
          'Check the remaining two against the definition.',
        ],
      },
      {
        classId,
        topic,
        type: 'free',
        difficulty: 3,
        stem: `Work a short example that uses "${topic}" and explain each step.`,
        answer: 'Any correct worked example.',
        solutionSteps: ['Set up the example.', 'Apply the method.', 'Check the result.'],
      },
    ];
    const created = db.createQuestions(
      drafts.map((draft) => ({
        ...draft,
        source: {
          kind: from.imagePngB64 ? 'photo' : 'pdf',
          itemId: from.itemId ?? null,
          pageId: from.pageId ?? null,
          lectureId: from.lectureId ?? null,
          ref: null,
        },
      })),
    );

    await streamFrames(
      [
        ...created.map((question) => ({ event: 'question', data: question })),
        { event: 'done', data: { count: created.length } },
      ],
      onFrame,
      { gapMs: 650, signal },
    );

    return;
  }

  if (head === 'questions' && a && b === 'attempt') {
    const question = db.question(a);
    const input = (body ?? {}) as unknown as AttemptInput;
    const typed = (input.typed ?? '').trim();
    const chosen = typeof input.choice === 'number' && question.choices ? question.choices[input.choice] : null;
    const normalize = (text: string) => stripMarkdown(text).toLowerCase();
    let result: AttemptVerdict['result'];
    const self = input.selfRating;

    if (self === 1 || self === 2 || self === 3 || self === 4) {
      // Flashcards grade themselves: 1 Again → wrong, 2 Hard → partial, 3/4 → right.
      result = self === 1 ? 'wrong' : self === 2 ? 'partial' : 'right';
      await delay(150, signal);
      onFrame({
        event: 'verdict',
        data: { result, steps: [], firstErrorStep: null, hint: '', solution: null } satisfies AttemptVerdict,
      });
      const graded = db.recordAttempt(a, result, self);

      onFrame({ event: 'done', data: { stats: graded.stats, srs: graded.srs } });

      return;
    } else if (chosen !== null && chosen !== undefined) {
      result = normalize(chosen) === normalize(question.answer) ? 'right' : 'wrong';
    } else if (typed) {
      const expected = normalize(question.answer);
      const got = normalize(typed);

      result =
        got === expected || (expected.length > 3 && got.includes(expected))
          ? 'right'
          : got.length > 12
            ? 'partial'
            : 'wrong';
    } else if (input.code) {
      result = /return|cout|std::/.test(input.code) ? 'right' : 'partial';
    } else {
      // Handwriting: the mock cannot read ink — alternate so the UI's three states all get exercised.
      const roll = Math.random();

      result = roll < 0.55 ? 'right' : roll < 0.8 ? 'partial' : 'wrong';
    }

    const steps: AttemptStep[] = (
      question.solutionSteps.length ? question.solutionSteps : ['Set up', 'Solve', 'Check']
    ).map((step, index, all) => {
      const ok = result === 'right' || (result === 'partial' && index < all.length - 1);

      return {
        line: index + 1,
        latex: pickWords(step, 12),
        ok,
        note: ok ? '' : 'This step does not follow from the previous one.',
      };
    });
    const firstErrorStep = steps.find((step) => !step.ok)?.line ?? null;
    const reading = input.inkPngB64
      ? `(mock) read ${Math.max(1, steps.length)} line(s) of handwriting`
      : typed || chosen || input.code?.slice(0, 80) || '';
    const verdict: AttemptVerdict = {
      result,
      steps,
      firstErrorStep,
      hint:
        result === 'right'
          ? 'Clean. Next one is harder.'
          : `Look again at step ${firstErrorStep ?? 1}: ${pickWords(question.solutionSteps[0] ?? question.answer, 18)}`,
      solution: input.reveal ? question.answer : null,
    };

    // `reading` is what the AI read off the handwriting — only ink attempts get one.
    if (input.inkPngB64) {
      await delay(500, signal);
      onFrame({ event: 'reading', data: { text: reading } });
    }
    await delay(900, signal);
    onFrame({ event: 'verdict', data: verdict });
    const updated = db.recordAttempt(a, result);

    await delay(200, signal);
    onFrame({ event: 'done', data: { stats: updated.stats, srs: updated.srs } });

    return;
  }

  if (head === 'questions' && a && b === 'similar') {
    const source = db.question(a);
    const count = Math.min(3, Math.max(1, Number(body?.count ?? 1) || 1));
    const variants = db.createQuestions(
      Array.from({ length: count }, (_, index) => {
        const stem = renumber(source.stem);

        return {
          ...source,
          id: undefined,
          stem: stem === source.stem ? `${stem} (variant ${index + 1})` : stem,
          answer: renumber(source.answer),
          source: {
            kind: 'ai_similar',
            itemId: source.source.itemId,
            pageId: source.source.pageId,
            lectureId: source.source.lectureId,
            ref: source.id,
          },
          stats: undefined,
          srs: undefined,
          createdAt: undefined,
        } as Partial<Question>;
      }),
    );

    await streamFrames(
      [
        ...variants.map((question) => ({ event: 'question', data: question })),
        { event: 'done', data: { count: variants.length } },
      ],
      onFrame,
      { gapMs: 900, signal },
    );

    return;
  }

  if (head === 'exams' && a && b === 'submit') {
    const exam = db.exam(a);

    if (exam.submittedAt) throw new StudyApiError(409, 'This exam was already submitted', 'ALREADY_SUBMITTED');
    if (exam.questions.length === 0) throw new StudyApiError(400, 'This exam has no questions', 'NO_QUESTIONS');
    const results: ExamResult[] = [];
    const answers =
      (body?.answers as { questionId: string; typed?: string; choice?: number; code?: string; inkPngB64?: string }[]) ??
      [];
    const byTopic = new Map<string, { total: number; got: number }>();
    let got = 0;

    for (const question of exam.questions) {
      const answer = answers.find((candidate) => candidate.questionId === question.id);
      let result: AttemptVerdict['result'] = 'wrong';

      if (answer) {
        const chosen = typeof answer.choice === 'number' && question.choices ? question.choices[answer.choice] : null;

        if (chosen)
          result =
            stripMarkdown(chosen).toLowerCase() === stripMarkdown(question.answer).toLowerCase() ? 'right' : 'wrong';
        else if (answer.typed || answer.code || answer.inkPngB64) result = Math.random() < 0.6 ? 'right' : 'partial';
      }
      const score = result === 'right' ? 1 : result === 'partial' ? 0.5 : 0;
      const topic = byTopic.get(question.topic) ?? { total: 0, got: 0 };

      topic.total += 1;
      topic.got += score;
      byTopic.set(question.topic, topic);
      got += score;
      db.recordAttempt(question.id, result);
      const steps: AttemptStep[] = (
        question.solutionSteps.length ? question.solutionSteps : ['Set up', 'Solve', 'Check']
      ).map((step, index, all) => {
        const ok = result === 'right' || (result === 'partial' && index < all.length - 1);

        return {
          line: index + 1,
          latex: pickWords(step, 12),
          ok,
          note: ok ? '' : 'This step does not follow from the previous one.',
        };
      });
      const firstErrorStep = steps.find((step) => !step.ok)?.line ?? null;

      const graded: ExamResult = {
        questionId: question.id,
        result,
        steps,
        firstErrorStep,
        hint: result === 'right' ? 'Correct.' : `Look again at step ${firstErrorStep ?? 1}.`,
        solution: question.answer,
      };

      results.push(graded);
      await delay(400, signal);
      onFrame({ event: 'graded', data: graded });
    }

    const score = exam.questions.length ? Math.round((got / exam.questions.length) * 100) : 0;
    const byTopicScores = Array.from(byTopic.entries()).map(([topic, value]) => ({
      topic,
      score: Math.round((value.got / value.total) * 100),
    }));
    const deadline = exam.startedAt ? new Date(exam.startedAt).getTime() + exam.minutes * 60_000 : Infinity;

    exam.submittedAt = nowIso();
    exam.late = Date.now() > deadline;
    exam.score = score;
    exam.byTopic = byTopicScores;
    exam.results = results;
    db.persist();
    // Scores are 0–100 (the contract's percent), `late` says the clock had run out.
    onFrame({ event: 'done', data: { score, late: exam.late, byTopic: byTopicScores } });

    return;
  }

  if (head === 'ai' && a === 'flashcards') {
    const from = (body ?? {}) as {
      itemId?: string;
      lectureId?: string;
      pageId?: string;
      libraryId?: string;
      classId?: string;
      topic?: string;
    };
    const item = from.itemId ? db.seed.items.find((candidate) => candidate.id === from.itemId) : null;
    const classId = from.classId || item?.classId || db.seed.classes[0]?.id || '';
    const topic = (from.topic || item?.title || 'Flashcards').replace(/\.(pdf|pptx?)$/i, '');
    const created = db.createQuestions(
      ['Define the main term.', 'State the key formula or rule.', 'Give one example.', 'Name a common mistake.'].map(
        (prompt, index) => ({
          classId,
          topic,
          type: 'free' as const,
          difficulty: ((index % 3) + 1) as 1 | 2 | 3,
          stem: `${prompt} (${topic})`,
          answer: 'See your notes.',
          solutionSteps: [],
          tags: ['flashcard'],
          source: {
            kind: 'pdf' as const,
            itemId: from.itemId ?? null,
            pageId: from.pageId ?? null,
            lectureId: from.lectureId ?? null,
            ref: null,
          },
        }),
      ),
    );

    await streamFrames(
      [
        ...created.map((question) => ({ event: 'question', data: question })),
        { event: 'done', data: { count: created.length } },
      ],
      onFrame,
      {
        gapMs: 500,
        signal,
      },
    );

    return;
  }

  throw new StudyApiError(404, `Mock has no SSE route for POST /${segments.join('/')}`, 'MOCK_NO_ROUTE');
}

/**
 * The mock speaks fixture class ids (`cls_<canvasCourseId>`); in hybrid mode the app speaks the live
 * backend's. Rewrite `classId` inbound (path + body) and outbound (JSON + SSE frames) at the edge so
 * neither side knows about the other — see `class-map.ts`.
 */
export function createMockTransport(): StudyTransport {
  return {
    json: async <T>(method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
      const result = await routeJson(
        method,
        mapClassIdInPath(path, 'toFixture'),
        mapClassIds(body, 'toFixture') as Body,
        headers,
      );

      return mapClassIds(result, 'toLive') as T;
    },
    // Raw bodies (board JSON, audio chunks) ride through `routeJson` as `{ __raw }`; chunks land in the blob store.
    raw: async <T>(method: string, path: string, body: Blob | string, contentType: string) => {
      const [rawPath, rawQuery = ''] = path.split('?');
      const render = /^\/pages\/([^/]+)\/renders\/(\d+)$/.exec(rawPath);

      if (render && method === 'PUT') {
        const blob = typeof body === 'string' ? new Blob([body], { type: contentType }) : body;

        return mockRenders.put(render[1], Number(render[2]), blob, new URLSearchParams(rawQuery)) as T;
      }
      const chunk = /^\/lectures\/([^/]+)\/chunks\/(\d+)/.exec(path.split('?')[0]);

      if (chunk && method === 'PUT') {
        const blob = typeof body === 'string' ? new Blob([body], { type: contentType }) : body;

        getMockBlobStore().set(`mock://lectures/${chunk[1]}/chunk-${chunk[2]}`, blob);

        return { index: Number(chunk[2]), size: blob.size } as T;
      }

      const text = typeof body === 'string' ? body : await body.text();
      const result = await routeJson(method, mapClassIdInPath(path, 'toFixture'), { __raw: text });

      return mapClassIds(result, 'toLive') as T;
    },
    sse: (path, body, onFrame, signal) =>
      routeSse(
        mapClassIdInPath(path, 'toFixture'),
        mapClassIds(body, 'toFixture') as Body,
        (frame) => onFrame({ event: frame.event, data: mapClassIds(frame.data, 'toLive') }),
        signal,
      ),
  };
}

/** Test/dev hook: wipe everything the mock persisted. */
export function resetMockState(): void {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(STATE_KEY);
    } catch {
      // ignore
    }
  }
}
