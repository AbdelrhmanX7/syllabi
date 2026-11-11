// Mock answers for the P-CM routes (class library + search, library docs, guide, exam
// schedule, exam results) — live in Auto mode since the backend shipped them; this keeps Force-mock
// working. In-memory only: a reload resets edits. Class ids arrive as fixture ids (`cls_<course>`).
import type {
  ClassGuide,
  ClassExamResult,
  ExamScheduleEntry,
  LibraryDoc,
  LibraryDocDetail,
  LibraryHit,
} from '../types';

import { StudyApiError } from '../errors';

type Body = Record<string, unknown> | undefined;

const STAMP = '2026-09-28T10:00:00.000Z';

const svgPhoto = (label: string, hue: number) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="480" height="360" fill="hsl(${hue},30%,30%)"/><ellipse cx="240" cy="190" rx="150" ry="100" fill="hsl(${hue},40%,55%)"/><text x="240" y="60" font-family="sans-serif" font-size="28" fill="#fff" text-anchor="middle">${label}</text></svg>`,
  )}`;

const NOTE_MD = (title: string, week: number) =>
  [
    `# ${title}`,
    '',
    `Week ${week} notes (sample).`,
    '',
    '## Key ideas',
    '',
    '- **Plate tectonics**: the lithosphere is broken into plates that move over the asthenosphere.',
    '- Divergent, convergent and transform boundaries.',
    '- Seafloor spreading rate: $v = d / t$.',
    '',
    '$$\\rho_{crust} < \\rho_{mantle}$$',
  ].join('\n');

function docsFor(classId: string): LibraryDetailSeed[] {
  return [...seedDocsFor(classId), ...(uploads.get(classId) ?? [])];
}

function seedDocsFor(classId: string): LibraryDetailSeed[] {
  const code = classId.replace(/^cls_/, '');
  const lab = classId === 'cls_demo_lab';

  const base: LibraryDetailSeed[] = [1, 2, 3].flatMap((week) => [
    {
      id: `lib_${code}_n${week}`,
      title: lab ? `Lab ${week} — handout notes` : `Week ${week} lecture notes`,
      kind: 'note' as const,
      week,
      path: `week-${String(week).padStart(2, '0')}/notes.md`,
      updatedAt: STAMP,
    },
    {
      id: `lib_${code}_p${week}`,
      title: lab ? `Lab ${week} worksheet.pdf` : `Chapter ${week} slides.pdf`,
      kind: 'pdf' as const,
      week,
      path: `week-${String(week).padStart(2, '0')}/slides.pdf`,
      updatedAt: STAMP,
    },
  ]);

  base.push({
    id: `lib_${code}_textbook`,
    title: 'Textbook (text only)',
    kind: 'pdf',
    week: null,
    path: 'textbook.pdf',
    updatedAt: STAMP,
    textOnly: true,
  });
  if (lab) {
    base.push({
      id: `lib_${code}_img1`,
      title: 'Mineral kit tray.jpg',
      kind: 'image',
      week: 1,
      path: 'photos/kit.jpg',
      updatedAt: STAMP,
    });
  }

  return base;
}

interface LibraryDetailSeed extends LibraryDoc {
  textOnly?: boolean;
  /** A PDF uploaded in this session: its own file (an object url). */
  fileUrl?: string;
  size?: number;
}

/** PDFs uploaded to a class Library in demo mode (in memory, like the rest of this mock). */
const uploads = new Map<string, LibraryDetailSeed[]>();
let uploadSeq = 1;

/** Demo-mode «Upload PDF»: the file stays in this tab (an object url) so «Write on it» opens it. */
export function mockUploadLibraryPdf(classId: string, name: string, fileUrl: string, size: number): LibraryDoc {
  const title = name.replace(/\.pdf$/i, '').trim() || 'Uploaded PDF';
  const list = uploads.get(classId) ?? [];
  const doc: LibraryDetailSeed = {
    id: `lib_upload_${uploadSeq++}`,
    title,
    kind: 'pdf',
    week: null,
    path: `Uploaded/${title}.pdf`,
    updatedAt: new Date().toISOString(),
    fileUrl,
    size,
  };

  uploads.set(classId, [...list, doc]);
  const { fileUrl: _url, size: _size, ...row } = doc;

  return row;
}

const SAMPLE_PDF = 'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf';

function detail(seed: LibraryDetailSeed): LibraryDocDetail {
  const { textOnly, fileUrl, size, ...doc } = seed;

  if (fileUrl) return { ...doc, pages: null, fileStored: true, url: fileUrl, mime: 'application/pdf', size: size ?? 0 };

  if (doc.kind === 'note')
    return { ...doc, pages: 1, fileStored: false, markdown: NOTE_MD(doc.title, doc.week ?? 1), assets: {} };
  if (doc.kind === 'image')
    return { ...doc, pages: null, fileStored: true, url: svgPhoto(doc.title, 30), mime: 'image/svg+xml', size: 1024 };
  if (textOnly) return { ...doc, pages: 412, fileStored: false };

  return { ...doc, pages: 14, fileStored: true, url: SAMPLE_PDF, mime: 'application/pdf', size: 1_016_315 };
}

const guides = new Map<string, ClassGuide>();
const schedules = new Map<string, ExamScheduleEntry[]>();
const results = new Map<string, ClassExamResult[]>();
let resultSeq = 1;

function defaultSchedule(): ExamScheduleEntry[] {
  return [
    { name: 'Exam 1', week: 5, date: '2026-09-24', chapters: ['1', '2', '3'], topics: ['Minerals', 'Igneous rocks'] },
    {
      name: 'Exam 2',
      week: 10,
      date: '2026-10-29',
      chapters: ['4', '5', '6'],
      topics: ['Weathering', 'Sedimentary rocks'],
    },
  ];
}

const percent = (score: number, max: number) => (max > 0 ? Math.round((score / max) * 1000) / 10 : null);

function resultsFor(classId: string): ClassExamResult[] {
  let list = results.get(classId);

  if (!list) {
    list = [
      {
        id: `res_${resultSeq++}`,
        name: 'Exam 1',
        date: '2026-09-24',
        score: 82,
        maxScore: 100,
        percent: 82,
        chapters: ['1', '2', '3'],
        sections: [
          { name: 'Multiple choice', score: 52, max: 60 },
          { name: 'Short answer', score: 30, max: 40 },
        ],
      },
    ];
    results.set(classId, list);
  }

  return list;
}

function searchDocs(classId: string, q: string, week: number | null): LibraryHit[] {
  const words = q
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 2);

  return docsFor(classId)
    .filter((doc) => week === null || doc.week === week)
    .map((doc) => {
      const text =
        doc.kind === 'note' ? NOTE_MD(doc.title, doc.week ?? 1) : `${doc.title} — plate tectonics, minerals, rocks.`;
      const lower = text.toLowerCase();
      const score = words.length ? words.reduce((sum, word) => sum + (lower.includes(word) ? 1 : 0), 0) : 1;

      return {
        libraryId: doc.id,
        title: doc.title,
        kind: doc.kind,
        week: doc.week,
        page: 1,
        score,
        text: text.slice(0, 600),
      };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

const bad = (message: string) => new StudyApiError(400, message, 'VALIDATION_ERROR');

/** `undefined` = not a P-CM path; otherwise the answer (or a thrown StudyApiError). */
export function pcmMockRoute(
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: Body,
): { value: unknown } | undefined {
  const [head, id, sub, extra] = segments;

  if (head === 'library' && id && method === 'GET') {
    const doc = ['cls_demo_cs', 'cls_demo_earth', 'cls_demo_lab', 'cls_demo_math', ...uploads.keys()]
      .flatMap(docsFor)
      .find((candidate) => candidate.id === id);

    if (!doc) throw new StudyApiError(404, 'Library doc not found', 'NOT_FOUND');

    return { value: detail(doc) };
  }
  if (head !== 'classes' || !id) return undefined;

  if (sub === 'library' && method === 'GET') {
    if (extra === 'search') {
      const q = (query.get('q') ?? '').trim();
      const weekText = query.get('week');
      const week = weekText ? Number(weekText) : null;

      if (!q && week === null) throw bad('q or week is required');

      return { value: searchDocs(id, q, week) };
    }
    const kind = query.get('kind');
    const week = query.get('week');

    return {
      value: docsFor(id)
        .filter((doc) => (!kind || doc.kind === kind) && (!week || doc.week === Number(week)))
        .map(({ textOnly: _textOnly, fileUrl: _fileUrl, size: _size, ...doc }) => doc),
    };
  }
  if (sub === 'guide') {
    if (method === 'GET') return { value: guides.get(id) ?? { markdown: '', updatedAt: null } };
    if (method === 'PUT') {
      const markdown = body?.markdown;

      if (typeof markdown !== 'string' || markdown.length > 20_000) throw bad('markdown must be a string');
      const guide = { markdown, updatedAt: new Date().toISOString() };

      guides.set(id, guide);

      return { value: guide };
    }
  }
  if (sub === 'exams-schedule') {
    if (method === 'GET') return { value: schedules.get(id) ?? defaultSchedule() };
    if (method === 'PUT') {
      const list = Array.isArray(body) ? body : (body as { schedule?: unknown } | undefined)?.schedule;

      if (!Array.isArray(list)) throw bad('send an array of {name, week, date?, chapters[], topics[]}');
      schedules.set(id, list as ExamScheduleEntry[]);

      return { value: list };
    }
  }
  if (sub === 'exam-results') {
    const list = resultsFor(id);

    if (method === 'GET' && !extra) return { value: list };
    if (method === 'POST' && !extra) {
      const score = Number(body?.score);
      const maxScore = Number(body?.maxScore);

      if (typeof body?.name !== 'string' || !body.name.trim()) throw bad('name is required');
      if (!Number.isFinite(score) || !(maxScore > 0)) throw bad('score and maxScore must be numbers');
      const row: ClassExamResult = {
        id: `res_${resultSeq++}`,
        name: body.name.trim(),
        date: typeof body.date === 'string' ? body.date : null,
        score,
        maxScore,
        percent: percent(score, maxScore),
        chapters: Array.isArray(body.chapters) ? (body.chapters as string[]) : [],
        sections: Array.isArray(body.sections) ? (body.sections as ClassExamResult['sections']) : undefined,
        notes: typeof body.notes === 'string' ? body.notes : undefined,
      };

      list.push(row);

      return { value: row };
    }
    if (method === 'PATCH' && extra) {
      const index = list.findIndex((row) => row.id === extra);

      if (index < 0) throw new StudyApiError(404, 'Exam result not found', 'NOT_FOUND');
      const next = { ...list[index]!, ...(body as Partial<ClassExamResult>) };

      next.percent = percent(next.score, next.maxScore);
      list[index] = next;

      return { value: next };
    }
  }

  return undefined;
}
