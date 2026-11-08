// Builds local mock fixtures from your own Canvas account (read-only).
//   node capture.mjs [rawDir]   rawDir caches raw Canvas JSON (default: os tmpdir); output goes to fixtures/local/ (gitignored); fetched via fetch-raw.mjs if absent.
// Token comes from ~/.study/canvas.env at runtime and is never written anywhere.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BANK } from './question-bank.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rawDir = process.argv[2] || join(tmpdir(), 'study-canvas-raw');
const rawFile = join(rawDir, 'raw.json');

if (!existsSync(rawFile)) execFileSync('node', [join(here, 'fetch-raw.mjs'), rawDir], { stdio: 'inherit' });
const raw = JSON.parse(readFileSync(rawFile, 'utf8'));
const NOW = new Date();
const DAY = 86400000;
const iso = (d) => new Date(d).toISOString();
const ago = (days) => iso(NOW.getTime() - days * DAY);
const firstName = raw.self.first_name;
// Subject per course id comes from CANVAS_COURSES (see fetch-raw.mjs), recorded in raw.json.
const SUBJECTS = raw.subjects ?? {};
const COLORS = { calc: '#4F6BED', geology: '#B7791F', lab: '#2F855A', cpp: '#C05621' };

// ---------- html sanitising ----------
const YT = /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^"'\s]*&)?v=|embed\/|v\/)|youtu\.be\/)([\w-]{11})/g;
const ytIds = (s) => [...new Set([...(s || '').matchAll(YT)].map((m) => m[1]))];

function cleanHtml(html) {
  if (!html) return '';
  let h = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/<iframe[^>]*?src="([^"]*)"[^>]*>[\s\S]*?<\/iframe>/gi, (_, src) => {
      const id = ytIds(src)[0];

      return id ? `<p><a href="https://www.youtube.com/watch?v=${id}">YouTube video ${id}</a></p>` : '';
    })
    .replace(/verifier=[^&"'\s]+/g, 'verifier=redacted')
    .replace(/mailto:[^"'\s>]+/gi, '#')
    .replace(/[\w.+-]+\x40[\w-]+(\.[\w-]+)+/g, 'redacted-email')
    .replace(/\x40/g, '&#64;')
    .replace(new RegExp(raw.self.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), firstName);

  if (h.length > 20000) {
    h = h.slice(0, 20000);
    h = h.slice(0, h.lastIndexOf('>') + 1) + '<!-- truncated -->';
  }

  return h;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const fileUrl = (id, name) => `https://example.invalid/file/${id}/${slug(name)}`;

// ---------- transform ----------
const classes = [];
const modulesByClass = {};
const allItems = [];

for (const [cid, c] of Object.entries(raw.courses)) {
  const classId = `cls_${cid}`;
  const items = new Map(); // key -> Item
  const put = (key, item) => {
    if (!items.has(key)) items.set(key, item);

    return items.get(key);
  };
  const videosFrom = (html, parent, moduleId) => {
    const out = [];

    const ids = ytIds(html);

    ids.forEach((id, k) => {
      out.push(
        put(`yt_${id}`, {
          id: `itm_yt_${id}`,
          classId,
          moduleId,
          type: 'video',
          title: ids.length > 1 ? `${parent.title} (video ${k + 1})` : `${parent.title} (video)`,
          canvasUrl: parent.canvasUrl,
          updatedAt: parent.updatedAt,
          seenAt: parent.seenAt,
          video: { provider: 'youtube', videoId: id, durationSec: null, transcriptStatus: 'none' },
        }),
      );
    });

    return out;
  };
  const seen = (updatedAt) => (NOW - new Date(updatedAt) < 5 * DAY ? null : iso(+new Date(updatedAt) + 3600000));
  const submissionOf = (a) => {
    const s = a.submission;

    if (!s) return undefined;
    const due = a.due_at ? new Date(a.due_at) : null;
    let state = 'unsubmitted';

    if (s.workflow_state === 'graded' || (s.score != null && s.workflow_state !== 'unsubmitted')) state = 'graded';
    else if (s.workflow_state === 'submitted' || s.workflow_state === 'pending_review') state = s.late ? 'late' : 'submitted';
    else if (s.missing || (due && due < NOW && a.points_possible > 0)) state = 'missing';

    return { state, score: s.score ?? null };
  };
  const toolOf = (a) => {
    const u = a.external_tool_tag_attributes?.url || '';

    if (/derivita/i.test(u)) return { tool: 'Derivita' };
    if (/quiz-lti/i.test(u)) return { tool: 'New Quizzes' };
    if (a.submission_types?.includes('external_tool')) return { tool: 'External tool' };

    return null;
  };

  // assignment items (keyed by assignment id; quizzes keyed by quiz id)
  const asgByQuiz = new Map();
  const asgByTopic = new Map();
  const asgItem = new Map();

  for (const a of c.assignments.filter((x) => x.published)) {
    const external = toolOf(a);
    const isQuiz = !!a.quiz_id || external?.tool === 'New Quizzes';
    const html = cleanHtml(a.description);
    const item = {
      id: `itm_${a.quiz_id || a.id}`,
      classId,
      moduleId: null,
      type: isQuiz ? 'quiz' : 'assignment',
      title: a.name,
      canvasUrl: a.html_url,
      updatedAt: a.updated_at,
      seenAt: seen(a.updated_at),
      dueAt: a.due_at || null,
      points: a.points_possible ?? null,
      submission: submissionOf(a),
      external,
      ...(html ? { html } : {}),
    };

    if (!item.submission) delete item.submission;
    if (a.quiz_id) asgByQuiz.set(a.quiz_id, a.id);
    if (a.discussion_topic?.id) asgByTopic.set(a.discussion_topic.id, a.id);
    asgItem.set(a.id, item);
  }

  const pagesById = new Map();

  for (const p of [...Object.values(c.pageBodies), ...Object.values(c.itemPages)]) pagesById.set(p.url, p);

  // modules
  const mods = [];

  for (const m of [...c.modules].sort((a, b) => a.position - b.position)) {
    const node = { id: `mod_${m.id}`, name: m.name, position: m.position, items: [] };
    const add = (it) => it && !node.items.includes(it) && node.items.push(it);

    for (const mi of m.items || []) {
      if (mi.type === 'SubHeader') continue;
      if (mi.type === 'Assignment') {
        const it = asgItem.get(mi.content_id);

        if (it) {
          it.moduleId = node.id;
          add(put(`a_${mi.content_id}`, it));
        }
      } else if (mi.type === 'Quiz') {
        const aid = asgByQuiz.get(mi.content_id);
        const it = aid ? asgItem.get(aid) : null;

        if (it) {
          it.moduleId = node.id;
          add(put(`a_${aid}`, it));
        } else {
          const q = c.quizzes.find((x) => x.id === mi.content_id);

          add(put(`q_${mi.content_id}`, { id: `itm_${mi.content_id}`, classId, moduleId: node.id, type: 'quiz', title: mi.title, canvasUrl: q?.html_url || mi.html_url, updatedAt: q?.updated_at || ago(10), seenAt: null, dueAt: q?.due_at || null, points: q?.points_possible ?? null, external: null }));
        }
      } else if (mi.type === 'Discussion') {
        const aid = asgByTopic.get(mi.content_id);
        const it = aid ? asgItem.get(aid) : null;

        if (it) {
          it.moduleId = node.id;
          add(put(`a_${aid}`, it));
        } else {
          add(put(`d_${mi.content_id}`, { id: `itm_d${mi.content_id}`, classId, moduleId: node.id, type: 'link', title: mi.title, canvasUrl: mi.html_url, updatedAt: ago(20), seenAt: ago(19), external: null }));
        }
      } else if (mi.type === 'Page') {
        const p = pagesById.get(mi.page_url);
        const html = cleanHtml(p?.body);
        const upd = p?.updated_at || ago(30);
        const it = put(`p_${mi.page_url}`, { id: `itm_${p?.page_id || `p_${slug(mi.page_url)}`}`, classId, moduleId: node.id, type: 'page', title: mi.title, canvasUrl: p?.html_url || mi.html_url, updatedAt: upd, seenAt: seen(upd), ...(html ? { html } : {}) });

        add(it);
        for (const v of videosFrom(p?.body, it, node.id)) add(v);
      } else if (mi.type === 'File') {
        const f = c.itemFiles[mi.content_id];
        const upd = f?.updated_at || ago(30);

        add(put(`f_${mi.content_id}`, { id: `itm_${mi.content_id}`, classId, moduleId: node.id, type: 'file', title: f?.display_name || mi.title, canvasUrl: mi.html_url, updatedAt: upd, seenAt: seen(upd), file: { mime: f?.['content-type'] || 'application/octet-stream', size: f?.size || 0, version: 1, url: fileUrl(mi.content_id, f?.display_name || mi.title), expiresAt: iso(+NOW + 3600000) } }));
      } else if (mi.type === 'ExternalUrl' || mi.type === 'ExternalTool') {
        const id = ytIds(mi.external_url)[0];

        if (id) {
          add(put(`yt_${id}`, { id: `itm_yt_${id}`, classId, moduleId: node.id, type: 'video', title: mi.title, canvasUrl: mi.html_url, updatedAt: ago(30), seenAt: ago(29), video: { provider: 'youtube', videoId: id, durationSec: null, transcriptStatus: 'none' } }));
        } else {
          add(put(`l_${mi.id}`, { id: `itm_l${mi.id}`, classId, moduleId: node.id, type: 'link', title: mi.title, canvasUrl: mi.external_url || mi.html_url, updatedAt: ago(30), seenAt: ago(29), external: mi.type === 'ExternalTool' ? { tool: 'External tool' } : null }));
        }
      }
    }
    mods.push(node);
  }

  // items not in modules: assignments, pages, files, announcements
  for (const [aid, it] of asgItem) put(`a_${aid}`, it);
  for (const p of pagesById.values()) {
    const html = cleanHtml(p.body);
    const it = put(`p_${p.url}`, { id: `itm_${p.page_id}`, classId, moduleId: null, type: 'page', title: p.title, canvasUrl: p.html_url, updatedAt: p.updated_at, seenAt: seen(p.updated_at), ...(html ? { html } : {}) });

    videosFrom(p.body, it, it.moduleId);
  }
  for (const f of c.files) {
    put(`f_${f.id}`, { id: `itm_${f.id}`, classId, moduleId: null, type: 'file', title: f.display_name, canvasUrl: `${process.env.CANVAS_BASE_URL?.replace(/\/$/, "")}/courses/${cid}/files/${f.id}`, updatedAt: f.updated_at, seenAt: seen(f.updated_at), file: { mime: f['content-type'], size: f.size, version: 1, url: fileUrl(f.id, f.display_name), expiresAt: iso(+NOW + 3600000) } });
  }
  for (const a of c.announcements) {
    const html = cleanHtml(a.message);
    const it = put(`n_${a.id}`, { id: `itm_n${a.id}`, classId, moduleId: null, type: 'announcement', title: a.title, canvasUrl: a.html_url, updatedAt: a.posted_at || a.created_at, seenAt: NOW - new Date(a.posted_at) < 10 * DAY ? null : iso(+new Date(a.posted_at) + 3600000), ...(html ? { html } : {}) });

    videosFrom(a.message, it, null);
  }
  for (const [, it] of asgItem) if (it.html) videosFrom(c.assignments.find((x) => `itm_${x.quiz_id || x.id}` === it.id)?.description, it, it.moduleId);

  // keep video items inside module trees when their parent page is in a module (already added above)
  const flat = [...items.values()];
  const cls = c.course;
  const enr = c.enroll[0]?.grades || {};
  const graded = flat.filter((i) => i.submission?.state === 'graded' && i.points > 0).sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  const pct = (xs) => xs.reduce((s, i) => s + i.submission.score / i.points, 0) / (xs.length || 1);
  const trend = graded.length >= 5 ? Math.sign(Math.round((pct(graded.slice(-3)) - pct(graded)) * 20)) : 0;
  const open = (i) => i.dueAt && ['assignment', 'quiz'].includes(i.type) && i.points > 0 && ['unsubmitted', 'missing', 'late'].includes(i.submission?.state);

  classes.push({
    id: classId,
    canvasCourseId: +cid,
    name: cls.name.replace(/^\d+\s*-\s*/, ''),
    code: cls.course_code.replace(/^(\w+)-(\d+)-(\d+)$/, '$1 $2'),
    term: cls.term?.name || 'Fall 2026',
    color: COLORS[SUBJECTS[cid]] ?? '#4F6BED',
    grade: { score: enr.current_score ?? null, letter: enr.current_grade ?? null, trend },
    counts: {
      due: flat.filter((i) => open(i) && new Date(i.dueAt) >= NOW && new Date(i.dueAt) < NOW.getTime() + 7 * DAY).length,
      overdue: flat.filter((i) => open(i) && new Date(i.dueAt) < NOW && i.submission?.state !== 'submitted').length,
      unseen: flat.filter((i) => i.seenAt === null).length,
    },
  });
  modulesByClass[classId] = mods;
  allItems.push(...flat);
}

// ---------- questions ----------
let seed = 7;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;

  return seed / 4294967296;
};
const questions = [];

for (const [cid, subject] of Object.entries(SUBJECTS)) {
  const rows = BANK[subject] ?? [];
  const classId = `cls_${cid}`;

  rows.forEach(([topic, subtopic, difficulty, type, stem, choices, answer, solutionSteps, tags, kind, hint], n) => {
    const hit = hint ? allItems.find((i) => i.classId === classId && i.title.toLowerCase().includes(hint.toLowerCase())) : null;
    const attempts = Math.floor(rnd() * 7);
    const correct = Math.min(attempts, Math.round(attempts * (0.35 + rnd() * 0.6)));
    const mastery = attempts ? +Math.min(1, Math.max(0.05, correct / attempts - (difficulty - 3) * 0.04 + (rnd() - 0.5) * 0.1)).toFixed(2) : 0;
    const dueIn = Math.round((rnd() * 8 - 3) * DAY);

    questions.push({
      id: `q_${cid}_${String(n + 1).padStart(2, '0')}`,
      classId,
      topic,
      subtopic,
      difficulty,
      source: { kind, itemId: hit?.id ?? null, pageId: null, lectureId: null, ref: hint },
      type,
      stem,
      imageUrl: null,
      ...(choices ? { choices } : {}),
      answer,
      solutionSteps,
      tags,
      stats: { attempts, correct, lastResult: attempts ? (correct === attempts ? 'right' : correct === 0 ? 'wrong' : rnd() > 0.5 ? 'right' : 'partial') : null, mastery },
      srs: { dueAt: iso(+NOW + dueIn), stability: +(1 + rnd() * 9).toFixed(2), difficulty: +(3 + rnd() * 5).toFixed(2), reps: correct, lapses: attempts - correct },
      createdAt: ago(3 + Math.floor(rnd() * 25)),
    });
  });
}

// ---------- mastery ----------
const mastery = {};

for (const c of classes) {
  const byTopic = new Map();

  for (const q of questions.filter((x) => x.classId === c.id)) {
    const t = byTopic.get(q.topic) || { topic: q.topic, ms: [], attempts: 0, dueCount: 0 };

    t.attempts += q.stats.attempts;
    if (q.stats.attempts) t.ms.push(q.stats.mastery);
    if (new Date(q.srs.dueAt) <= NOW) t.dueCount++;
    byTopic.set(q.topic, t);
  }
  mastery[c.id] = { topics: [...byTopic.values()].map((t) => ({ topic: t.topic, mastery: t.ms.length ? +(t.ms.reduce((a, b) => a + b, 0) / t.ms.length).toFixed(2) : 0, attempts: t.attempts, dueCount: t.dueCount })) };
}

// ---------- today ----------
const byDue = (a, b) => new Date(a.dueAt) - new Date(b.dueAt);
const isOpen = (i) => i.dueAt && ['assignment', 'quiz'].includes(i.type) && i.points > 0 && ['unsubmitted', 'missing', 'late'].includes(i.submission?.state);
const today = {
  due: allItems.filter((i) => isOpen(i) && new Date(i.dueAt) >= NOW && new Date(i.dueAt) < NOW.getTime() + 7 * DAY).sort(byDue),
  overdue: allItems.filter((i) => isOpen(i) && new Date(i.dueAt) < NOW && i.submission?.state !== 'submitted').sort(byDue).reverse().slice(0, 10),
  unseen: allItems.filter((i) => i.seenAt === null && i.type !== 'announcement' && i.type !== 'video').sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 12),
  announcements: allItems.filter((i) => i.type === 'announcement' && i.seenAt === null).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)),
  review: { dueCount: questions.filter((q) => new Date(q.srs.dueAt) <= NOW).length, newCount: questions.filter((q) => q.stats.attempts === 0).length },
  weakTopics: Object.entries(mastery).flatMap(([classId, m]) => m.topics.filter((t) => t.attempts > 0).sort((a, b) => a.mastery - b.mastery).slice(0, 2).map((t) => ({ classId, topic: t.topic, mastery: t.mastery }))).sort((a, b) => a.mastery - b.mastery).slice(0, 5),
  classes,
};

// ---------- transcript (fabricated) for the first video ----------
const firstVideo = allItems.find((i) => i.type === 'video');

if (firstVideo) firstVideo.video.transcriptStatus = 'ready';
allItems.filter((i) => i.type === 'video').slice(1, 3).forEach((v, k) => (v.video.transcriptStatus = k ? 'failed' : 'pending'));
const transcripts = firstVideo
  ? {
      [firstVideo.id]: {
        segments: [
          [0, 6.5, 'Welcome back. Today we are looking at what a class really gives you in C++.'],
          [6.5, 15, 'A class bundles data and the functions that operate on that data into one unit.'],
          [15, 24.2, 'We keep the data private and expose a small public interface, which is encapsulation.'],
          [24.2, 33, 'Constructors run when an object is created, and the destructor runs when it goes out of scope.'],
          [33, 42.8, 'Notice the order: members are constructed first, then the constructor body runs.'],
          [42.8, 52, 'When you derive from a base class, the base part is built before the derived part.'],
          [52, 61.5, 'Mark functions virtual if you want the call to dispatch on the real object type at runtime.'],
          [61.5, 70, 'That is polymorphism, and it is why a base class destructor should be virtual too.'],
        ].map(([start, end, text]) => ({ start, end, text })),
        summary: 'Overview of C++ classes: encapsulation, constructor and destructor order, inheritance construction order, and virtual dispatch.',
        keyPoints: ['Classes bundle data and behaviour; keep data private.', 'Constructors run base-first; destructors run in reverse.', 'Use virtual for runtime dispatch and for base destructors.'],
      },
    }
  : {};

const out = { 'classes.json': classes, 'modules.json': modulesByClass, 'items.json': allItems, 'today.json': today, 'questions.json': questions, 'transcripts.json': transcripts, 'mastery.json': mastery };

mkdirSync(join(here, 'local'), { recursive: true });
for (const [f, v] of Object.entries(out)) writeFileSync(join(here, 'local', f), JSON.stringify(v, null, 2) + '\n');

console.log(
  JSON.stringify({
    classes: classes.map((c) => ({ id: c.id, name: c.name, grade: c.grade, counts: c.counts, modules: modulesByClass[c.id].length, items: allItems.filter((i) => i.classId === c.id).length, byType: Object.fromEntries(Object.entries(Object.groupBy(allItems.filter((i) => i.classId === c.id), (i) => i.type)).map(([k, v]) => [k, v.length])), derivita: allItems.filter((i) => i.classId === c.id && i.external?.tool === 'Derivita').length, newQuizzes: allItems.filter((i) => i.classId === c.id && i.external?.tool === 'New Quizzes').length })),
    questions: questions.length,
    today: { due: today.due.length, overdue: today.overdue.length, unseen: today.unseen.length, announcements: today.announcements.length, weak: today.weakTopics.length },
  }, null, 1),
);
