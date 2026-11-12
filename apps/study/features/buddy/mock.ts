// Sample mode for the «Custom AI» page: the same shapes as the server, kept in memory for the session.
import type { BuddyExpert, BuddyNote, BuddyTurn, ExpertEdit } from './api';

const BUILTIN: BuddyExpert[] = [
  { id: 'check', name: 'Checker', when: 'You want your own work checked, or ask where you went wrong.', job: ['Solve it first, compare line by line, find the first place it goes wrong.', 'Always say whether the work is right.'], gives: null, weakTopics: false, enabled: true, origin: 'builtin' },
  { id: 'hint', name: 'Hint giver', when: 'You are stuck and want a nudge, not the answer.', job: ['Give one hint for the next step only.', 'Never state the final answer.'], gives: null, weakTopics: false, enabled: true, origin: 'builtin' },
  { id: 'explain', name: 'Explainer', when: 'You ask what something means or why it is true.', job: ['Explain the idea in simple words.', 'Point at the key parts of the page.'], gives: null, weakTopics: false, enabled: true, origin: 'builtin' },
  { id: 'solve', name: 'Solver', when: 'You ask for the question to be solved step by step.', job: ['Solve the question and write every step.', 'The last step states the final answer.'], gives: 'steps', weakTopics: false, enabled: true, origin: 'builtin' },
  { id: 'similar', name: 'Question maker', when: 'You want another question like this one to practise.', job: ['Write one new question of the same kind and difficulty.', 'Never include the answer.'], gives: 'similar', weakTopics: true, enabled: true, origin: 'builtin' },
  { id: 'quiz', name: 'Quick check', when: 'You want to be tested on the idea.', job: ['Write one multiple-choice question about the idea behind the page.', 'Exactly four choices, one right.'], gives: 'quiz', weakTopics: true, enabled: true, origin: 'builtin' },
];

let experts: BuddyExpert[] = BUILTIN.map((expert) => ({ ...expert }));
let notes: BuddyNote[] = [
  { text: 'Often drops a minus sign when moving terms across.', at: '2026-11-10T15:00:00.000Z', by: 'check', classId: null },
  { text: 'Quick check on Power rule: got it right.', at: '2026-11-11T09:30:00.000Z', by: 'quiz', classId: null },
];
const turns: BuddyTurn[] = [
  {
    id: 'sample-2',
    at: '2026-11-11T09:30:00.000Z',
    question: 'Solve it step by step',
    handwritten: false,
    skill: 'solve',
    expert: 'Solver',
    pickedBy: 'button',
    status: 'done',
    error: null,
    trace: [
      { kind: 'pick', name: 'Solver', models: [], ms: 0, costUsd: 0, detail: 'You tapped this one.' },
      { kind: 'memory', name: 'What I remember about you', models: [], ms: 4, costUsd: 0, detail: 'Often drops a minus sign when moving terms across.' },
      { kind: 'expert', name: 'Solver', models: ['sample/tutor'], ms: 2300, costUsd: 0.006, detail: '1 mark on the page, 4 steps.' },
    ],
    reply: { say: 'Here is question 1, worked step by step.', steps: ['Write down what is given: $2x + 3 = 11$', 'Subtract 3 from both sides: $2x = 8$', 'Divide both sides by 2: $x = 4$', 'Final answer: $x = 4$'], marks: 1 },
    quizAnswer: null,
    rating: 'up',
    models: ['sample/tutor'],
    costUsd: 0.006,
    latencyMs: 2300,
  },
  {
    id: 'sample-1',
    at: '2026-11-10T15:00:00.000Z',
    question: 'did i do this right?',
    handwritten: true,
    skill: 'check',
    expert: 'Checker',
    pickedBy: 'picker',
    status: 'done',
    error: null,
    trace: [
      { kind: 'pick', name: 'Checker', models: ['sample/picker'], ms: 600, costUsd: 0.0004, detail: 'Chosen for: “did i do this right?”' },
      { kind: 'memory', name: 'What I remember about you', models: [], ms: 3, costUsd: 0, detail: 'Nothing yet.' },
      { kind: 'expert', name: 'Checker', models: ['sample/tutor'], ms: 2900, costUsd: 0.007, detail: '2 marks on the page, verdict: partly.' },
      { kind: 'remember', name: 'Saved to memory', models: [], ms: 0, costUsd: 0, detail: 'Often drops a minus sign when moving terms across.' },
    ],
    reply: { say: 'Almost: line 2 drops the minus sign.', verdict: 'partly', marks: 2 },
    quizAnswer: null,
    rating: null,
    models: ['sample/picker', 'sample/tutor'],
    costUsd: 0.0074,
    latencyMs: 3500,
  },
];

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'expert';

/** `/ai/buddy/*` in sample mode; undefined = not a buddy path. */
export function buddyMock(method: string, segments: string[], query: URLSearchParams, body: unknown): unknown | undefined {
  if (segments[0] !== 'ai' || segments[1] !== 'buddy') return undefined;

  const [, , what, id, action] = segments;
  const data = (body ?? {}) as Record<string, unknown>;

  if (what === 'experts') {
    if (method === 'GET') return { experts };
    if (method === 'PUT' && id) {
      const edit = data as unknown as ExpertEdit;
      const builtin = BUILTIN.some((expert) => expert.id === id);
      const target = id === 'new' ? slug(edit.name) : id;
      const next: BuddyExpert = { ...edit, id: target, origin: builtin ? 'edited' : 'custom' };

      experts = experts.some((expert) => expert.id === target) ? experts.map((expert) => (expert.id === target ? next : expert)) : [...experts, next];

      return { id: target };
    }
    if (method === 'DELETE' && id) {
      const original = BUILTIN.find((expert) => expert.id === id);

      experts = original ? experts.map((expert) => (expert.id === id ? { ...original } : expert)) : experts.filter((expert) => expert.id !== id);

      return { ok: true };
    }
  }

  if (what === 'memory') {
    if (method === 'GET') return { notes };
    if (id === 'forget') {
      notes = notes.filter((note) => note.text !== data.text);

      return { ok: true };
    }
    notes = [{ text: String(data.text ?? ''), at: new Date().toISOString(), by: 'you', classId: null }, ...notes];

    return { ok: true };
  }

  if (what === 'turns') {
    if (method === 'GET' && !id) {
      const rating = query.get('rating');

      return { turns: turns.filter((turn) => !rating || turn.rating === rating) };
    }

    const turn = turns.find((entry) => entry.id === id);

    if (!turn) return { ok: true };
    if (method === 'GET') return { ...turn, imageUrl: null };
    if (action === 'rating') turn.rating = (data.rating as BuddyTurn['rating']) ?? null;

    return { ok: true };
  }

  return undefined;
}
