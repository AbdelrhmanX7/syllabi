// Runtime shape check of the fixtures against apps/study/lib/api/types.ts. Usage: node check.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(here, 'local', f), 'utf8'));
const errs = [];
const bad = (m) => errs.push(m);
const isStr = (v) => typeof v === 'string';
const isNum = (v) => typeof v === 'number';
const nullable = (f) => (v) => v === null || f(v);
const oneOf = (...xs) => (v) => xs.includes(v);
const iso = (v) => isStr(v) && !Number.isNaN(Date.parse(v));
const shape = (name, o, spec) => {
  for (const [k, f] of Object.entries(spec)) {
    if (k.endsWith('?')) {
      const kk = k.slice(0, -1);

      if (o[kk] !== undefined && !f(o[kk])) bad(`${name}.${kk} invalid: ${JSON.stringify(o[kk])?.slice(0, 80)}`);
    } else if (!f(o[k])) bad(`${name}.${k} invalid: ${JSON.stringify(o[k])?.slice(0, 80)}`);
  }
  for (const k of Object.keys(o)) if (!(k in spec) && !(`${k}?` in spec)) bad(`${name}.${k} unexpected key`);
};

const classes = load('classes.json');
const modules = load('modules.json');
const items = load('items.json');
const today = load('today.json');
const questions = load('questions.json');
const transcripts = load('transcripts.json');
const mastery = load('mastery.json');

const clsSpec = { id: isStr, canvasCourseId: isNum, name: isStr, code: isStr, term: isStr, color: isStr, 'hidden?': (v) => typeof v === 'boolean',
  grade: (g) => nullable(isNum)(g.score) && nullable(isStr)(g.letter) && [-1, 0, 1].includes(g.trend),
  counts: (c) => isNum(c.due) && isNum(c.overdue) && isNum(c.unseen) };
const itemSpec = { id: isStr, classId: isStr, moduleId: nullable(isStr), type: oneOf('file', 'page', 'assignment', 'quiz', 'video', 'link', 'announcement'), title: isStr, canvasUrl: isStr, updatedAt: iso, seenAt: nullable(iso),
  'dueAt?': nullable(iso), 'points?': nullable(isNum),
  'submission?': (s) => oneOf('unsubmitted', 'submitted', 'graded', 'missing', 'late')(s.state) && nullable(isNum)(s.score),
  'external?': nullable((e) => isStr(e.tool)),
  'file?': (f) => isStr(f.mime) && isNum(f.size) && isNum(f.version) && isStr(f.url) && iso(f.expiresAt),
  'video?': (v) => v.provider === 'youtube' && isStr(v.videoId) && nullable(isNum)(v.durationSec) && oneOf('none', 'pending', 'ready', 'failed')(v.transcriptStatus),
  'html?': isStr };
const qSpec = { id: isStr, classId: isStr, topic: isStr, subtopic: nullable(isStr), difficulty: oneOf(1, 2, 3, 4, 5),
  source: (s) => oneOf('canvas_quiz', 'derivita', 'pdf', 'slides', 'video', 'lecture', 'photo', 'manual', 'ai_similar', 'mock')(s.kind) && nullable(isStr)(s.itemId) && nullable(isStr)(s.pageId) && nullable(isStr)(s.lectureId) && nullable(isStr)(s.ref),
  type: oneOf('free', 'mcq', 'code_output', 'code_write', 'label_image'), stem: isStr, imageUrl: nullable(isStr), 'choices?': (a) => Array.isArray(a) && a.every(isStr), answer: isStr,
  solutionSteps: (a) => Array.isArray(a) && a.every(isStr), tags: (a) => Array.isArray(a) && a.every(isStr),
  stats: (s) => isNum(s.attempts) && isNum(s.correct) && nullable(oneOf('right', 'wrong', 'partial'))(s.lastResult) && isNum(s.mastery),
  srs: (s) => iso(s.dueAt) && isNum(s.stability) && isNum(s.difficulty) && isNum(s.reps) && isNum(s.lapses), createdAt: iso };

classes.forEach((c, i) => shape(`classes[${i}]`, c, clsSpec));
const ids = new Set();

items.forEach((it, i) => {
  shape(`items[${i}]`, it, itemSpec);
  if (ids.has(it.id)) bad(`duplicate item id ${it.id}`);
  ids.add(it.id);
});
for (const [cid, mods] of Object.entries(modules)) {
  mods.forEach((m) => {
    shape(`module ${m.id}`, m, { id: isStr, name: isStr, position: isNum, items: Array.isArray });
    m.items.forEach((it) => {
      shape(`${m.id}/${it.id}`, it, itemSpec);
      if (it.classId !== cid) bad(`${it.id} wrong class`);
    });
  });
}
questions.forEach((q, i) => {
  shape(`questions[${i}]`, q, qSpec);
  if (q.type === 'mcq' && !q.choices?.includes(q.answer.replace(/^`|`$/g, '')) && !q.choices?.includes(q.answer)) bad(`${q.id}: mcq answer not among choices`);
});
for (const [k, t] of Object.entries(transcripts)) {
  if (!ids.has(k)) bad(`transcript ${k} has no item`);
  shape(`transcript ${k}`, t, { segments: (a) => a.every((s) => isNum(s.start) && isNum(s.end) && isStr(s.text)), summary: nullable(isStr), keyPoints: Array.isArray });
}
shape('today', today, { due: Array.isArray, overdue: Array.isArray, unseen: Array.isArray, announcements: Array.isArray, review: (r) => isNum(r.dueCount) && isNum(r.newCount),
  weakTopics: (a) => a.every((w) => isStr(w.classId) && isStr(w.topic) && isNum(w.mastery)), classes: Array.isArray });
for (const [c, m] of Object.entries(mastery)) m.topics.forEach((t) => shape(`mastery ${c}`, t, { topic: isStr, mastery: isNum, attempts: isNum, dueCount: isNum }));

console.log(errs.length ? errs.slice(0, 30).join('\n') + `\n${errs.length} errors` : `OK: ${classes.length} classes, ${items.length} items, ${questions.length} questions`);
process.exit(errs.length ? 1 : 0);
