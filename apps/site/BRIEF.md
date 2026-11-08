# syllabi.studio landing page — shared brief (every section agent reads this)

## What the site is
`apps/site` — a Next 16 (Pages Router, `--webpack`, static export) one-page site for **Syllabi**, the
open-source study app. `pages/index.tsx` renders, in order: `Nav`, `Hero`, `Notebooks`, `Study`,
`Organize`, `SelfHost`, `Footer` — one file each in `sections/`. Each agent owns exactly ONE section
file (plus optional private helpers named `sections/<Section>.*.tsx`). Never edit another section,
`pages/*`, configs, `BRIEF.md` or `apps/study/*`.

## Product facts (only claim these)
- Syllabi: open-source (MIT) study app for students on **Android tablets** (Tauri 2 APK) and the **web**.
  Built for real student tablets like the Samsung Galaxy Tab A7 (800×1280) — fast on 3–4 GB RAM, works on
  older Android WebViews.
- **Classes from Canvas**: grades, assignments, quizzes, files, pages, announcements in one place; manual
  (non-Canvas) classes too. Today screen = what's due and what to review.
- **Handwritten notebooks**: a pen board (S Pen / stylus pressure, palm rejection), pages per class or
  lecture, rulers & shapes; the AI can read your handwriting, explain a step and draw on the page.
- **AI tutor**: chat about any item, lecture or page; explains mistakes.
- **Question bank with spaced repetition**: questions made from your material, review queue, mock exams,
  weak-topic tracking.
- **Lectures**: recordings/YouTube → transcripts + lecture notes.
- **Concept maps**: for any class or topic — draw one on the pen board or from a photo; the AI builds a
  reference map or checks yours. (Generic: NOT geology-specific.)
- **Calendar** (new): week and month views of everything dated — due dates, exams, class times and reviews
  due, in each class's colour.
- **Phone inbox**: snap a page/whiteboard on your phone, it lands on the tablet.
- **Library**: every file and reading in one searchable place.
- **Self-hostable**: your own server (`apps/server`: Docker Compose — API, MongoDB, Redis, MinIO; any
  OpenAI-compatible model). With no server the app runs in **demo mode** on built-in sample data.
  `pnpm install && pnpm dev` → http://localhost:3016.
- Repo: https://github.com/AbdelrhmanX7/syllabi · License: MIT · Domain: syllabi.studio
- Downloads: link the APK to https://github.com/AbdelrhmanX7/syllabi/releases (don't invent version
  numbers, store badges, prices, user counts, testimonials or press quotes).
- NEVER mention: any private backend or other product, a Rock/Mineral lab, a Code lab, any specific university,
  professor or real student.

## Screenshots (made by the screenshot agent, from the real app in demo mode, 1280×800 unless noted)
`/shots/today.png`, `/shots/calendar.png`, `/shots/bank.png`, `/shots/concept-maps.png`,
`/shots/notebook.png`, `/shots/tutor.png`, `/shots/classes.png`, `/shots/lectures.png`,
`/shots/inbox.png`, `/shots/tablet-portrait.png` (800×1280). Use plain `<img>` with width/height attrs
(1280×800 → `width={1280} height={800}`), `className='h-auto w-full'`, `loading='lazy'` (except the hero),
meaningful `alt`. Frame a shot inside a `Surface` (rounded clay card) — the image must sit INSIDE the card's
padding so no card edge, lip or corner is clipped (`overflow-hidden` + matching inner radius is fine).

## Design system — the hard rules (owner is strict; violations get the work thrown out)
- Use the app's designed components, imported across the app boundary with the `@/` alias:
  `import { Surface, Badge, LinkButton, ActionButton, SectionTitle, FilterChip, Dot } from '@/components/ui/primitives';`
  (LinkButton props: `href`, `variant?: 'primary'|'secondary'|'soft'|'accent'(yellow star)|'ghost'`, `className`; Badge `tone?:
  'neutral'|'accent'|'ok'|'warn'|'danger'`.) `cn` from `@repo/ui`. Icons: `lucide-react`.
  NO hand-rolled pills, tabs, chips, stars or buttons — if you need a button/link-button/chip, use the above.
- Tokens only (Tailwind): `bg-st-bg`, `bg-st-surface`, `bg-st-raised`, `text-st-fg`, `text-st-muted`,
  `border-st-line`, `bg-st-accent` / `text-st-accent` (Notebook Blue #2F5BEA), `bg-st-accent-soft`,
  `bg-st-star` (yellow), `border-st-clay-edge`, `shadow-clay`, `shadow-clay-accent`, `rounded-st`,
  `rounded-st-lg`. Headings `font-display` (Bricolage Grotesque); body is Inter.
- CLAY look: 2px same-hue edge + a STRAIGHT-DOWN solid lip (`shadow-clay`), never diagonal offsets, never
  soft drop shadows. Clay items stacked/adjacent need `gap-3`+ so lips never touch the next item.
- NO solid black (#000) anywhere. NO gradient blobs / radial glows / orbs / hero halos — flat solid fills.
  No avatars, initial-letter tiles or faces. No emoji.
- DENSE: the owner hates vertical waste. Section padding ≈ `py-10 md:py-14` max; hero must show the
  headline, sub, CTAs AND the start of the product shot within the first 800px viewport at 1280 wide.
  Compact one-line facts over tall stat tiles. Copy is short and plain (no hype words like "revolutionary",
  "supercharge", "unleash", "seamless"). Max content width `max-w-6xl`, side gutter `px-4`.
- NOTHING CLIPPED at any width 360–1440: no cut text, chips, icons, card edges or lips; no horizontal page
  scroll. Grids collapse to one column on phones.
- Motion: optional, transform/opacity only, ≤200ms, respect `prefers-reduced-motion`. No scroll-jacking,
  no animation libraries.
- Accessibility: real headings (one `h1`, in Hero; sections use `h2`), `id` on each section for nav anchors:
  `#notebooks`, `#study`, `#organize`, `#self-host`. Contrast ≥ 4.5:1.
- Light theme is the default; tokens also switch under `.dark`, so never hardcode colours.

## Checks before you finish
`cd apps/site && ./node_modules/.bin/tsc --noEmit` must pass for YOUR file (ignore errors in other agents'
in-progress files; don't run `next build` or a dev server — the integrator does that).
