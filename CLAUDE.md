# CLAUDE.md — Syllabi

Syllabi is an open-source (MIT), self-hostable study app: Canvas classes, handwritten notebooks (pen board),
AI tutor, question bank with spaced repetition, lectures, concept maps, code lab, phone inbox. Built for
Android tablets (Tauri 2) and the web. Domain: `syllabi.studio`.

## Layout
- `apps/study` (`@repo/study`) — Next.js 16 Pages Router, React 19, HeroUI, Tailwind 3, React Query 5,
  static export, wrapped by Tauri 2 into an Android APK. Dev port **3016** (`--webpack`, never turbo).
  `features/*` (aplan, bank, code, conceptmaps, guide, handwriting, inbox, lab, lecturenotes, lectures,
  library, tutor), `lib/*` (api, ink, notebooks, perf, platform, ruler, youtube), `pages/*`, `src-tauri/`.
- `packages/*` — `@repo/{auth,ui,utils,whiteboard-core,whiteboard-react}`. `@repo/ui` = scrapbook/clay design system.
- `tools/` — `ui-audit` (clip/overlap gate), `perf-trace`, `uitest` (lib).
- `.claude/skills/` — `ui-rules`, `scrapbook-design-system`. Load `ui-rules` before any UI work.

## Commands (pnpm only)
```bash
pnpm install
pnpm dev                    # :3016
pnpm build                  # next build --webpack, static export
cd apps/study && pnpm test  # node --import tsx --test … (use this, not bare node --test)
cd apps/study && ./node_modules/.bin/tsc --noEmit   # the real type gate (no root tsconfig)
cd apps/study && ./node_modules/.bin/eslint          # lint
```
Run tsc after code changes. Declare every imported package in the owning `package.json` (pnpm is strict).

## Backend
The app talks to a Syllabi server's `/study` API (`NEXT_PUBLIC_API` at build time, or Settings → API base
URL per device). With no server configured it runs in demo mode on the in-memory mock (`lib/api/mock`, seeded
from `seed.ts`; `fixtures/*.json` are local captures and gitignored). Routing is hybrid: `LIVE_ROUTES` in
`apps/study/lib/api/client.ts` sends listed prefixes to the server, everything else to the mock. Settings can
force all-mock / all-live (`localStorage.study_mock` = '1'/'0').

## Release
Android: `scripts/android-release.mjs` builds a signed APK (keystore from env); `STUDY_BUILD_API` (env or
`apps/study/.env.release.local`) bakes in a default server, empty = demo mode. `scripts/publish-android.mjs`
publishes to the update feed. Bundle id `studio.syllabi.app`.

## Target device
Tablets like the Samsung Galaxy Tab A7/A6 (800×1280 portrait, 1280×800 landscape; WebView/Chrome can be old).
Never ship a web API newer than Chrome 103 without a guard (e.g. `AbortSignal.timeout` needs 103).
Budget 3–4 GB RAM; animate transforms/opacity only, no heavy blur.

## Hard UI rules (also in the `ui-rules` skill)
- NOTHING clipped: no sliced card edges, lips, shadows, chips, icons, text at any width. Flat rows inside
  scroll/overflow/modal boxes; no elevated cards there. Clay-lipped stacked items use `gap-3`, never touching.
  Gate: `node tools/ui-audit/run.mjs <baseUrl> <routes…>` (exit 1 on findings) + a zoomed screenshot.
- No wasted vertical space (dense, inline one-line facts). No avatars/initial tiles. No solid black
  (#000) fills/text/borders. No gradient blobs. Designed components from `@repo/ui` only (no hand-rolled
  pills/tabs/stars). Every destructive action opens a confirm modal.

## Writing (replies, UI text, pages, emails, README)
- Plain everyday words, like talking to a student friend. No tech or stack names in anything users read (no
  framework/tool/protocol names, no "spaced repetition", "MCP", "self-hostable" etc.); say what it does for them.
- Replies to the owner: what changed and what they need to do, 1–3 short lines. No file paths, commit ids, tool
  names or env vars unless asked.
- Short sentences, no filler, no hype, no "AI-sounding" phrasing.

