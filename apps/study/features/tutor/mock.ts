// In-memory tutor for force-mock (the backend serves `/ai/ask` + `/ai/conversations` since #577). The
// shell's mock transport (`lib/api/mock`) calls `tutorMockRoutes.json` / `.sse` before its own switch,
// like the concept-map routes; `undefined` = not this feature's path. Class ids here are FIXTURE ids
// (`cls_<canvasCourseId>`) — the transport maps them. Conversations persist in localStorage.
//
// Every answer here is made up. The transport marks all of it `__sample`.
import type { ClassKind } from './lib/prompts';
import type {
  AskRequest,
  TutorConversation,
  TutorConversationDetail,
  TutorMessage,
  TutorMode,
  TutorQuizResult,
  TutorQuizTurn,
  TutorSource,
} from './types';
import type { SseFrame } from '@/lib/api/http';

import { appendMessages, conversationRow, conversationTitle, previewOf } from './lib/conversations';

import { StudyApiError } from '@/lib/api/errors';
import { delay } from '@/lib/api/mock/sse';

type Body = Record<string, unknown> | undefined;

const STATE_KEY = 'study_mock_tutor';
const nowIso = () => new Date().toISOString();
const uid = (prefix: string) =>
  `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`;

/* ------------------------------------------------------------------ fixtures */

/** Fixture class id → subject. Unknown ids read as `other`. */
const CLASS_KIND: Record<string, ClassKind> = {
  cls_demo_cs: 'cpp',
  cls_demo_earth: 'geology',
  cls_demo_lab: 'geology',
  cls_demo_math: 'calc',
};

/** Invented demo sources (some ids match seed / A-plan mock items; the rest open nothing). */
const SOURCES: Record<ClassKind, TutorSource[]> = {
  cpp: [
    {
      kind: 'transcript',
      id: 'itm_demo_video',
      title: 'Lecture recording — Inheritance',
      snippet: 'A class bundles data and the functions that operate on that data into one unit.',
      t: 6.5,
      week: 1,
    },
    {
      kind: 'item',
      id: 'itm_demo_hw',
      title: 'Lab 4: Bank account class',
      snippet: 'class Account { private: double balance; public: void deposit(double); … };',
      week: 2,
    },
  ],
  geology: [
    {
      kind: 'library',
      id: 'lib_geol_rock_cycle',
      title: 'Lecture 3 — The Rock Cycle (slides)',
      snippet: 'Weathering breaks any rock into sediment; heat and pressure make metamorphic rock.',
      week: 2,
    },
    {
      kind: 'item',
      id: 'itm_eas_quiz_3',
      title: 'Quiz 3 — Rocks and the Rock Cycle',
      snippet: 'Which process turns sediment into sedimentary rock?',
      week: 2,
    },
  ],
  calc: [
    {
      kind: 'transcript',
      id: 'itm_calc_lesson_1_video',
      title: 'Lesson 1 — Tangent lines and velocity (video)',
      snippet: 'the slope of the secant line approaches the slope of the tangent as h goes to zero',
      t: 95,
      week: 1,
    },
    {
      kind: 'item',
      id: 'itm_calc_mc_1',
      title: 'Mastery Check 1',
      snippet: 'Problems 3–5 are limits by factoring.',
      week: 2,
    },
  ],
  other: [],
};

interface QuizItem {
  stem: string;
  /** Any of these words in a typed answer counts as right. */
  keys: string[];
  model: string;
}

const QUIZ: Record<ClassKind, QuizItem[]> = {
  geology: [
    {
      stem: 'In **the lecture’s words**: what is the difference between *weathering* and *erosion*?',
      keys: ['place', 'in situ', 'transport', 'move'],
      model: 'Weathering breaks rock down **in place**; erosion **moves** the pieces away.',
    },
    {
      stem: 'Which rock family forms from cooled magma or lava?',
      keys: ['igneous'],
      model: '**Igneous** rock — intrusive when it cools underground, extrusive at the surface.',
    },
    {
      stem: 'What drives plate motion, according to lecture?',
      keys: ['convection', 'mantle'],
      model: '**Mantle convection** — hot material rises, cools, sinks, and drags the plates along.',
    },
  ],
  calc: [
    {
      stem: 'Evaluate $\\lim_{x \\to 2} \\dfrac{x^2 - 4}{x - 2}$.',
      keys: ['4', 'four'],
      model: 'Factor: $\\dfrac{(x-2)(x+2)}{x-2} = x + 2$, so the limit is $\\mathbf{4}$.',
    },
    {
      stem: 'What does $\\lim_{x \\to a} f(x) = L$ require of $f(a)$?',
      keys: ['nothing', 'need not', "doesn't", 'does not', 'undefined'],
      model: '**Nothing.** $f(a)$ may be undefined or different from $L$; only nearby values matter.',
    },
    {
      stem: 'True or false: if $\\lim_{x\\to a^-} f(x) = \\lim_{x\\to a^+} f(x)$, the two-sided limit exists.',
      keys: ['true'],
      model: '**True** — equal one-sided limits are exactly the two-sided limit.',
    },
  ],
  cpp: [
    {
      stem: 'What prints?\n\n```cpp\nint a = 3;\nint& r = a;\nr = 5;\nstd::cout << a;\n```',
      keys: ['5'],
      model: '`5` — `r` is a **reference**, another name for `a`.',
    },
    {
      stem: 'When does a destructor run for a local object?',
      keys: ['scope', 'end of', 'block', 'out of'],
      model: 'When the object **goes out of scope** — at the closing brace of its block.',
    },
    {
      stem: 'Which special member runs for `Account b = a;`?',
      keys: ['copy constructor', 'copy'],
      model: 'The **copy constructor** — it is initialization, not assignment.',
    },
  ],
  other: [
    {
      stem: 'In one sentence: what was the main idea of this week?',
      keys: [],
      model: 'Any one-sentence summary that names the central concept.',
    },
  ],
};

function explainAnswer(kind: ClassKind, request: AskRequest): string {
  const q = request.question.trim();
  const ctx = request.context ?? {};
  const about = ctx.videoAt
    ? ` about the moment at **${Math.floor(ctx.videoAt.t / 60)}:${String(Math.floor(ctx.videoAt.t % 60)).padStart(2, '0')}** in the video`
    : ctx.itemId
      ? ' about the item you opened'
      : ctx.pageId
        ? ' about your notebook page'
        : ctx.imagePngB64
          ? ' about what you circled'
          : '';
  const head = q ? `You asked${about}: _${q.length > 90 ? `${q.slice(0, 90)}…` : q}_\n\n` : '';

  switch (kind) {
    case 'calc':
      return `${head}**Idea.** A limit asks what $f(x)$ *approaches*, not what it equals at the point.\n\n$$\\lim_{x \\to 2} \\frac{x^2-4}{x-2} = \\lim_{x \\to 2} (x+2) = 4$$\n\n1. Try direct substitution — here it gives $\\tfrac{0}{0}$, so keep going.\n2. Factor and cancel the common factor.\n3. Substitute again.\n\nThe cancelled factor is why the graph has a **hole** at $x = 2$, not an asymptote.`;
    case 'cpp':
      return `${head}**Short answer.** A class is data plus the functions that are allowed to touch it.\n\n\`\`\`cpp\nclass Account {\n  double balance = 0;          // private by default\npublic:\n  void deposit(double amt) { balance += amt; }\n  double get() const { return balance; }\n};\n\`\`\`\n\n- \`private\` members are reachable only from member functions.\n- The constructor runs when the object is created; the destructor when it leaves scope.\n- Mark read-only accessors \`const\` so they work on const references.`;
    case 'geology':
      return `${head}**In the lecture’s words:** *weathering* happens **in place**; *erosion* is **transport**.\n\n- Mechanical weathering — frost wedging, roots, unloading.\n- Chemical weathering — dissolution, hydrolysis, oxidation.\n- Sediment is then **eroded**, **deposited**, **buried**, and **lithified** into sedimentary rock.\n\nShe draws the rock cycle as a loop and asks for the *process* on every arrow — label the arrows, not just the boxes.`;
    default:
      return `${head}**Short answer.** Start from the definition in the lecture, apply it to one concrete example, then check the edge case the assignment hints at.\n\n_(sample answer — the real tutor reads this class's items, transcripts and your notes.)_`;
  }
}

/** The feedback, and the verdict for the score (null = ink the sample cannot read — not scored). */
function gradeAnswer(item: QuizItem, request: AskRequest): { text: string; result: TutorQuizResult | null } {
  const typed = request.question.trim();
  const ink = Boolean(request.context?.imagePngB64);

  if (ink && !typed) {
    return {
      text: `I see your handwritten answer. I can't read ink in sample mode — the real tutor will.\n\n**Model answer:** ${item.model}`,
      result: null,
    };
  }
  const right = item.keys.length === 0 || item.keys.some((key) => typed.toLowerCase().includes(key.toLowerCase()));

  return right
    ? { text: `**Correct.** ${item.model}`, result: 'right' }
    : {
        text: `**Not quite.** You wrote: _${typed.length > 80 ? `${typed.slice(0, 80)}…` : typed}_\n\n**Model answer:** ${item.model}`,
        result: 'wrong',
      };
}

/* ------------------------------------------------------------------ state */

interface PersistedState {
  conversations: TutorConversationDetail[];
}

let state: PersistedState | null = null;

function load(): PersistedState {
  if (state) return state;
  state = { conversations: [] };
  if (typeof window === 'undefined') return state;

  try {
    const raw = window.localStorage.getItem(STATE_KEY);

    if (raw) state = { conversations: [], ...(JSON.parse(raw) as Partial<PersistedState>) };
  } catch {
    // corrupt or blocked storage: start empty
  }

  return state;
}

function persist(): void {
  if (typeof window === 'undefined' || !state) return;

  try {
    window.localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // quota — this session still works from memory
  }
}

const summary = (detail: TutorConversationDetail): TutorConversation => conversationRow(detail);

function find(id: string): TutorConversationDetail {
  const found = load().conversations.find((conversation) => conversation.id === id);

  if (!found) throw new StudyApiError(404, 'Conversation not found', 'NOT_FOUND');

  return found;
}

/** Test/dev hook. */
export function resetTutorMockState(): void {
  state = { conversations: [] };
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(STATE_KEY);
    } catch {
      // ignore
    }
  }
}

/* ------------------------------------------------------------------ routes */

function parse(path: string): { segments: string[]; query: URLSearchParams } {
  const [pathname, search = ''] = path.split('?');

  return { segments: pathname.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(search) };
}

/* ------------------------------------------------------------------ board actions («Explain on my page») */

type BoardActionsBody = { question?: unknown; lang?: unknown; clusters?: unknown };

interface ClusterBox {
  id: string;
  box: { x: number; y: number; w: number; h: number };
}

const round4 = (value: number) => Math.round(value * 10000) / 10000;

/** The clusters the board sent, `{id, box}` (the contract) or `{id, bbox}` (the editor's shape). */
function clustersOf(body: BoardActionsBody): ClusterBox[] {
  return (Array.isArray(body.clusters) ? body.clusters : [])
    .map((raw) => {
      if (!raw || typeof raw !== 'object') return null;

      const record = raw as { id?: unknown; box?: unknown; bbox?: unknown };
      const box = (record.box ?? record.bbox) as { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | undefined;
      const id = typeof record.id === 'string' ? record.id : '';
      const nums = box ? [box.x, box.y, box.w, box.h].map(Number) : [];

      if (!id || nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) return null;

      return { id, box: { x: nums[0]!, y: nums[1]!, w: nums[2]!, h: nums[3]! } };
    })
    .filter((cluster): cluster is ClusterBox => cluster !== null);
}

/**
 * The canned pen plan: deterministic for the clusters sent, and it exercises EVERY action type the
 * contract has (point_at, circle, underline, arrow, write, pen_stroke) so the board's execution can be
 * checked end to end. Sample mode cannot read ink: the note echoes the question, nothing more.
 */
export function cannedBoardActions(body: BoardActionsBody): { actions: unknown[]; say: string; verdict?: string } {
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  const clusters = clustersOf(body);
  const first = clusters[0] ?? { id: '', box: { x: 0.2, y: 0.2, w: 0.3, h: 0.06 } };
  const second = clusters[1] ?? null;
  const last = clusters[clusters.length - 1] ?? first;
  const ref = (cluster: ClusterBox) => (cluster.id ? { clusterId: cluster.id } : { box: cluster.box });
  const centre = (cluster: ClusterBox) => ({ x: round4(cluster.box.x + cluster.box.w / 2), y: round4(cluster.box.y + cluster.box.h / 2) });
  // «Check this page» (step checker, stepCheck.ts): one verdict per line in the format it asks for.
  if (question.startsWith('TASK: grade my handwritten solution')) {
    const verdicts = ['OK: setup is right', 'WRONG: sample mistake on this step', 'WARN: sample — carries the error forward'];

    return {
      actions: clusters.slice(0, 12).map((cluster, index) => ({
        type: 'point_at',
        at: { x: round4(Math.min(1, cluster.box.x + cluster.box.w)), y: centre(cluster).y },
        note: `[${index + 1}] ${verdicts[Math.min(index, verdicts.length - 1)]}`,
      })),
      say: clusters.length
        ? 'CORRECT: sample — the first step. MISTAKES: sample — line 2. MISSING: sample — the final answer. NOTE: sample mode; the real tutor checks every step.'
        : 'MISSING: no handwritten working on this page.',
    };
  }

  const noteText = question ? `Sample note on: ${question}` : 'Sample note — the real tutor writes what matters here.';

  return {
    actions: [
      { type: 'point_at', at: centre(first), note: question ? 'Start here' : 'Look here first' },
      { type: 'circle', target: ref(first) },
      { type: 'underline', target: ref(second ?? first) },
      // First → last: across lines when there are several, so the arrow has room to be seen.
      second
        ? { type: 'arrow', from: ref(first), to: ref(last.id === first.id ? second : last), label: 'leads to' }
        : { type: 'arrow', from: { x: round4(first.box.x + first.box.w + 0.08), y: centre(first).y }, to: centre(first), label: 'here' },
      {
        type: 'write',
        text: Array.from(noteText).slice(0, 120).join(''),
        // The app finds the empty space next to this region.
        near: ref(last),
        size: 0.022,
      },
      { type: 'mark', target: ref(first), verdict: 'correct', label: 'sample tick' },
    ],
    verdict: 'correct',
    say: question
      ? `Sample answer to “${question.length > 80 ? `${question.slice(0, 80)}…` : question}” — the real tutor reads your page and marks what matters.`
      : 'Sample explanation — the real tutor reads your page, points at what matters and writes a short note in your hand.',
  };
}

async function json(method: string, path: string, body?: Body): Promise<unknown> {
  await delay(60 + Math.random() * 90);
  const { segments, query } = parse(path);
  const [head, a, id] = segments;

  if (head === 'board-ai' && a === 'board-actions') {
    if (method !== 'POST') throw new StudyApiError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED');

    return cannedBoardActions((body ?? {}) as BoardActionsBody);
  }

  if (a !== 'conversations') throw new StudyApiError(404, `Mock has no route for ${method} ${path}`, 'MOCK_NO_ROUTE');
  if (method !== 'GET') throw new StudyApiError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED');
  if (id) return find(id);
  const classId = query.get('classId');

  return load()
    .conversations.filter((conversation) => !classId || conversation.classId === classId)
    .map(summary)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The next quiz question for a thread: counts the assistant turns already asked. */
function nextQuizIndex(messages: TutorMessage[], total: number): number {
  const asked = messages.filter((message) => message.role === 'assistant').length;

  return total ? asked % total : 0;
}

/** Streams one `/ai/ask`; returns nothing — frames carry the answer. */
async function ask(body: Body, onFrame: (frame: SseFrame) => void, signal?: AbortSignal): Promise<void> {
  const request = (body ?? {}) as Partial<AskRequest>;
  const question = String(request.question ?? '').trim();
  const mode: TutorMode = request.mode === 'quiz' ? 'quiz' : 'explain';
  const classId = typeof request.classId === 'string' && request.classId ? request.classId : null;
  const kind = classId ? (CLASS_KIND[classId] ?? 'other') : 'other';

  if (!question && !request.context?.imagePngB64) throw new StudyApiError(400, 'question is required', 'BAD_REQUEST');

  const store = load();
  let conversation = request.conversationId
    ? store.conversations.find((candidate) => candidate.id === request.conversationId)
    : undefined;

  if (request.conversationId && !conversation) throw new StudyApiError(404, 'Conversation not found', 'NOT_FOUND');

  if (!conversation) {
    const at = nowIso();

    conversation = {
      id: uid('cv'),
      classId,
      title: conversationTitle(question || 'Handwritten question'),
      mode,
      createdAt: at,
      updatedAt: at,
      messageCount: 0,
      messages: [],
    };
    store.conversations.unshift(conversation);
  }

  const userTurn: TutorMessage = {
    role: 'user',
    text: question,
    createdAt: nowIso(),
    mode,
    ...(request.context ? { context: { ...request.context, imagePngB64: undefined } } : {}),
  };

  // What the assistant says: quiz = grade the pending question (if any) and ask the next; explain = answer.
  let text: string;
  const quiz = QUIZ[kind];
  let quizTurn: TutorQuizTurn | null = null;

  if (mode === 'quiz') {
    const score = { asked: 0, right: 0, partial: 0, wrong: 0, ...conversation.quiz };
    let graded: TutorQuizTurn['graded'];

    const pending = [...conversation.messages].reverse().find((message) => message.role === 'assistant');
    const index = nextQuizIndex(conversation.messages, quiz.length);
    const next = quiz[index] ?? QUIZ.other[0];
    const asksForNext = /\b(next|another|skip|quiz me|start)\b/i.test(question) && !/\d|=/.test(question);

    if (pending && pending.mode === 'quiz' && !asksForNext) {
      const previous = quiz[(index - 1 + quiz.length) % quiz.length] ?? QUIZ.other[0];

      const verdict = gradeAnswer(previous, request as AskRequest);

      if (verdict.result) {
        score[verdict.result] += 1;
        graded = { result: verdict.result, correctAnswer: previous.model };
      }
      text = `${verdict.text}\n\n---\n\n**Next question.** ${next.stem}`;
    } else {
      text = `${pending ? '' : `Let's go — one at a time. Type your answer or use the pen.\n\n`}**Question ${index + 1}.** ${next.stem}`;
    }
    score.asked += 1;
    quizTurn = { ...score, questionId: null, questionKind: 'free', ...(graded ? { graded } : {}) };
  } else {
    text = explainAnswer(kind, { ...(request as AskRequest), question });
  }

  const sources: TutorSource[] = [
    ...SOURCES[kind],
    ...(request.context?.pageId
      ? [
          {
            kind: 'page' as const,
            id: request.context.pageId,
            title: 'Your notebook page',
            snippet: 'Read from your ink.',
          },
        ]
      : []),
  ];

  onFrame({ event: 'meta', data: { conversationId: conversation.id } });

  const words = text.split(/(\s+)/);
  let chunk = '';
  let count = 0;

  for (const word of words) {
    chunk += word;
    if (/\S/.test(word)) count += 1;
    if (count >= 3) {
      await delay(38, signal);
      onFrame({ event: 'delta', data: { text: chunk } });
      chunk = '';
      count = 0;
    }
  }
  if (chunk) {
    await delay(38, signal);
    onFrame({ event: 'delta', data: { text: chunk } });
  }

  if (mode === 'explain' && sources.length) {
    await delay(120, signal);
    onFrame({ event: 'sources', data: { sources } });
  }

  const assistantTurn: TutorMessage = {
    role: 'assistant',
    text,
    createdAt: nowIso(),
    mode,
    ...(mode === 'explain' && sources.length ? { sources } : {}),
  };
  const updated = appendMessages(conversation, userTurn, assistantTurn);

  Object.assign(conversation, updated, {
    preview: previewOf(text),
    ...(quizTurn
      ? { quiz: { asked: quizTurn.asked, right: quizTurn.right, partial: quizTurn.partial, wrong: quizTurn.wrong } }
      : {}),
  });
  persist();

  onFrame({ event: 'done', data: { conversationId: conversation.id, ...(quizTurn ? { quiz: quizTurn } : {}) } });
}

/** `/board-ai/*` — the whiteboard teacher pipeline's frames, from canned content. */
async function boardAi(
  segments: string[],
  body: Body,
  onFrame: (frame: SseFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const route = segments.slice(1).join('/');
  const request = (body ?? {}) as Record<string, unknown>;

  await delay(250, signal);

  switch (route) {
    case 'generate': {
      const prompt = String(request.prompt ?? 'this topic');
      const kindOf = String(request.kind ?? 'free');

      onFrame({ event: 'status', data: 'Drafting…' });
      await delay(300, signal);
      if (kindOf === 'questions') {
        onFrame({ event: 'text', data: `Three questions on ${prompt}.` });
        onFrame({
          event: 'result',
          data: {
            blocks: [
              { type: 'heading', text: `Practice: ${prompt}` },
              {
                type: 'question',
                stem: `Define the key term in "${prompt}" in one sentence.`,
                answer: 'A concise definition in your own words.',
              },
              {
                type: 'question',
                stem: `Which statement about ${prompt} is correct?`,
                choices: [
                  'It only applies in theory.',
                  'It follows from the definition.',
                  'It contradicts the lecture.',
                ],
                answerIndex: 1,
              },
              {
                type: 'question',
                stem: `Work one short example that uses ${prompt}.`,
                answer: 'Any correct worked example.',
              },
            ],
          },
        });
      } else {
        const text = `**${prompt}** — the short version:\n\n- The definition, in the lecture's wording.\n- One worked example.\n- The common mistake.`;

        onFrame({ event: 'text', data: text });
        onFrame({
          event: 'result',
          data: {
            blocks: [
              { type: 'heading', text: prompt },
              {
                type: 'list',
                ordered: false,
                items: ['The definition, in the lecture’s wording.', 'One worked example.', 'The common mistake.'],
              },
            ],
          },
        });
      }
      break;
    }
    case 'analyze-page':
      onFrame({ event: 'status', data: 'Reading the page…' });
      await delay(400, signal);
      onFrame({
        event: 'result',
        data: {
          pageType: 'solution',
          questions: [
            {
              n: '1',
              text: 'Sample reading of your first problem.',
              verdict: 'correct',
              confidence: 0.6,
              reason: 'Sample mode cannot read ink; the real tutor checks each line.',
            },
          ],
        },
      });
      break;
    case 'concept-map/analyze':
      onFrame({ event: 'status', data: 'Reading the map…' });
      await delay(400, signal);
      onFrame({
        event: 'result',
        data: {
          graph: {
            nodes: [
              { id: 'a', text: 'Weathering' },
              { id: 'b', text: 'Sediment' },
              { id: 'c', text: 'Sedimentary rock' },
            ],
            edges: [
              { from: 'a', to: 'b', label: 'produces' },
              { from: 'b', to: 'c', label: '' },
            ],
          },
          fixes: [{ op: 'relabel_edge', from: 'b', to: 'c', label: 'is lithified into' }],
          checked: false,
        },
      });
      break;
    case 'concept-map/generate': {
      const topic = String(request.topic ?? 'Topic');

      onFrame({ event: 'status', data: 'Laying out…' });
      await delay(400, signal);
      onFrame({
        event: 'result',
        data: {
          graph: {
            title: topic,
            nodes: [
              { id: 'root', text: topic, bbox: { x: 0.4, y: 0.05, w: 0.2, h: 0.1 } },
              { id: 'n1', text: 'Definition', bbox: { x: 0.1, y: 0.4, w: 0.2, h: 0.1 } },
              { id: 'n2', text: 'Example', bbox: { x: 0.4, y: 0.4, w: 0.2, h: 0.1 } },
              { id: 'n3', text: 'Common mistake', bbox: { x: 0.7, y: 0.4, w: 0.2, h: 0.1 } },
            ],
            edges: [
              { from: 'root', to: 'n1', label: 'is' },
              { from: 'root', to: 'n2', label: 'shown by' },
              { from: 'root', to: 'n3', label: 'confused with' },
            ],
          },
        },
      });
      break;
    }
    case 'concept-map/from-terms': {
      // Sample mode cannot read ink: one node per cluster in the order sent, the first is the root,
      // every other hangs off it with «includes». Deterministic, so the drawing can be checked.
      const clusters = (Array.isArray(request.clusters) ? request.clusters : [])
        .map((cluster) => (cluster && typeof cluster === 'object' ? String((cluster as { id?: unknown }).id ?? '') : ''))
        .filter(Boolean);

      if (clusters.length === 0) {
        onFrame({ event: 'error', data: { message: 'Select the terms you wrote first.', code: 'NO_TERMS' } });

        return;
      }

      onFrame({ event: 'status', data: 'Reading your terms…' });
      await delay(400, signal);
      onFrame({
        event: 'result',
        data: {
          title: 'Your terms',
          direction: 'TB',
          nodes: clusters.map((id, index) => ({
            id: `n${index + 1}`,
            text: `Term ${index + 1}`,
            clusterIds: [id],
            level: index === 0 ? 0 : 1,
            ...(index === 0 ? { focus: true } : {}),
          })),
          edges: clusters.slice(1).map((_, index) => ({ from: 'n1', to: `n${index + 2}`, label: 'includes' })),
          extra: [],
        },
      });
      break;
    }
    case 'remake-page':
      onFrame({
        event: 'error',
        data: { message: 'Page remake is not available in Study yet.', code: 'NOT_AVAILABLE' },
      });

      return;
    default:
      throw new StudyApiError(404, `Mock has no SSE route for POST /${segments.join('/')}`, 'MOCK_NO_ROUTE');
  }

  onFrame({ event: 'done', data: null });
}

export const tutorMockRoutes = {
  json(method: string, path: string, body?: Body): Promise<unknown> | undefined {
    const { segments } = parse(path);

    if (segments[0] === 'board-ai' && segments[1] === 'board-actions') return json(method, path, body);

    return segments[0] === 'ai' && segments[1] === 'conversations' ? json(method, path) : undefined;
  },
  sse(path: string, body: Body, onFrame: (frame: SseFrame) => void, signal?: AbortSignal): Promise<void> | undefined {
    const { segments } = parse(path);

    if (segments[0] === 'ai' && segments[1] === 'ask') return ask(body, onFrame, signal);
    // The live Study route's path, answered by the same sample when the app runs on the mock.
    if (segments[0] === 'ai' && segments[1] === 'concept-map' && segments[2] === 'from-terms') {
      return boardAi(['board-ai', ...segments.slice(1)], body, onFrame, signal);
    }
    if (segments[0] === 'board-ai') return boardAi(segments, body, onFrame, signal);

    return undefined;
  },
};
