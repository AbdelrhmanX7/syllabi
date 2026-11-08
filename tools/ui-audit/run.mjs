// UI audit gate: clipping, sliced card edges, overlapping items and tight gaps, measured in a real browser.
//
//   node tools/ui-audit/run.mjs <baseUrl> <route> [route...]
//   env: WIDTHS=360,390,768,1024,1440  LOGIN_PHONE / LOGIN_PASSWORD (admin-style /login form)  OUT=<dir>
//
// Every route is loaded at every width; the findings from clip-check.js are printed per page and a
// full-page screenshot is saved. Exit code 1 when anything is found. Run it before calling UI work done
// (root CLAUDE.md, «UI hard rule»). To audit an open modal/menu, import clip-check.js into your own
// script and page.evaluate() it after opening the thing.
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(path.resolve('package.json'));
const { chromium } = require('playwright');

const [base, ...routes] = process.argv.slice(2);
if (!base || !routes.length) {
  console.error('usage: node tools/ui-audit/run.mjs <baseUrl> <route> [route...]');
  process.exit(2);
}
const widths = (process.env.WIDTHS || '360,390,768,1024,1440').split(',').map(Number);
const out = process.env.OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'ui-audit-'));
const CHECK = fs.readFileSync(new URL('./clip-check.js', import.meta.url), 'utf8');

const browser = await chromium.launch();
// STORAGE_STATE=<playwright storageState.json> — pre-seeded session (e.g. from /dev/impersonate).
let storageState = process.env.STORAGE_STATE || undefined;
if (process.env.LOGIN_PHONE) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(base + '/login/', { waitUntil: 'domcontentloaded' });
  await p.locator('input').first().fill(process.env.LOGIN_PHONE);
  await p.locator('input[type=password]').fill(process.env.LOGIN_PASSWORD || '');
  await p.keyboard.press('Enter');
  await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60000 });
  storageState = await ctx.storageState();
  await ctx.close();
}

let total = 0;
for (const w of widths) {
  const ctx = await browser.newContext({ viewport: { width: w, height: w < 800 ? 844 : 900 }, storageState });
  const page = await ctx.newPage();
  for (const r of routes) {
    // networkidle never settles on socket apps; load, then give data a few seconds.
    await page.goto(base + r, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForTimeout(5000);
    const issues = await page.evaluate(CHECK);
    total += issues.length;
    const name = `${w}-${r.replace(/[/?=&]/g, '_').replace(/^_+|_+$/g, '') || 'root'}.png`;
    await page.screenshot({ path: path.join(out, name), fullPage: true });
    console.log(`${w} ${r}: ${issues.length ? issues.length + ' issue(s)' : 'clean'}`);
    for (const i of issues) console.log('   ' + i);
  }
  await ctx.close();
}
await browser.close();
console.log(`\n${total} issue(s). Screenshots: ${out}`);
process.exit(total ? 1 : 0);
