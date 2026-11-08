// Read-only Canvas fetch -> raw JSON cache (outside the repo). Usage: node fetch-raw.mjs <outDir>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

const env = Object.fromEntries(
  readFileSync(`${homedir()}/.study/canvas.env`, 'utf8')
    .split('\n')
    .map((l) => l.trim().replace(/^export\s+/, ''))
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');

      return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, '')];
    }),
);
const BASE = env.CANVAS_BASE_URL.replace(/\/$/, '');
const TOKEN = env.CANVAS_TOKEN;
const out = process.argv[2];

mkdirSync(out, { recursive: true });

async function get(path) {
  const rows = [];
  let url = path.startsWith('http') ? path : `${BASE}/api/v1${path}`;
  let single = null;

  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });

    if (!res.ok) return { error: res.status, rows: [] };
    const j = await res.json();

    if (!Array.isArray(j)) {
      single = j;
      break;
    }
    rows.push(...j);
    const m = (res.headers.get('link') || '').match(/<([^>]+)>;\s*rel="next"/);

    url = m ? m[1] : null;
  }

  return single ? { single } : { rows };
}

// CANVAS_COURSES=<courseId>:<calc|cpp|geology|lab>,… in ~/.study/canvas.env (kept out of the repo).
const COURSES = (env.CANVAS_COURSES || '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [id, subject] = entry.split(':');

    return { id: Number(id), subject: subject || null };
  });

if (!COURSES.length) throw new Error('Set CANVAS_COURSES=<courseId>:<calc|cpp|geology|lab>,… in ~/.study/canvas.env');
const raw = { courses: {}, subjects: Object.fromEntries(COURSES.map((c) => [c.id, c.subject])) };

raw.self = (await get('/users/self')).single;
for (const { id } of COURSES) {
  const c = {};
  const q = (p) => get(`/courses/${id}${p}`);

  c.course = (await q('?include[]=total_scores&include[]=term&include[]=syllabus_body')).single;
  c.enroll = (await get(`/courses/${id}/enrollments?user_id=self&per_page=100`)).rows;
  c.modules = (await q('/modules?include[]=items&include[]=content_details&per_page=100')).rows;
  c.assignments = (await q('/assignments?include[]=submission&per_page=100')).rows;
  c.quizzes = (await q('/quizzes?per_page=100')).rows;
  c.announcements = (await get(`/announcements?context_codes[]=course_${id}&per_page=100`)).rows;
  c.pages = (await q('/pages?per_page=100')).rows;
  c.pageBodies = {};
  for (const p of c.pages) {
    const r = await q(`/pages/${p.url}`);

    if (r.single) c.pageBodies[p.url] = r.single;
  }
  c.files = (await q('/files?per_page=100')).rows;
  // module Page / File items not exposed by the list endpoints
  c.itemPages = {};
  c.itemFiles = {};
  let n = 0;

  for (const it of c.modules.flatMap((m) => m.items || [])) {
    if (it.type === 'Page' && it.url && !c.pageBodies[it.page_url] && n++ < 40) {
      const r = await get(it.url);

      if (r.single) c.itemPages[it.page_url] = r.single;
    }
    if (it.type === 'File' && it.url) {
      const r = await get(it.url);

      if (r.single) c.itemFiles[it.content_id] = r.single;
    }
  }
  raw.courses[id] = c;
  console.error(id, Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Array.isArray(v) ? v.length : typeof v])));
}
writeFileSync(`${out}/raw.json`, JSON.stringify(raw));
