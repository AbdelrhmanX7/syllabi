---
name: ui-rules
description: The project's standing UI/UX rules — density (no wasted vertical space), the one sizing ladder (CSS --size-* vars), inputs, scroll shadows instead of clipping, colour semantics, copy. Use BEFORE building or reviewing ANY UI in this monorepo (admin, teacher, web, any app using @repo/ui), and when the owner says a screen "looks bad", "too big", "hard to see", or asks for a UI/UX pass.
---

# UI rules (owner's standing rules)

Apply all of these; they override generic design skills. When a rule needs a value, the value
lives in ONE place (below) — change it there, never per component or per call site.

## 1. Mindset: dense, phone-first
- **No vertical waste.** Every row earns its height. No intro cards under a title, no headers
  that repeat what the page already says, no count chips nobody asked for.
- **No boxes around single things.** A lone field, a price, a summary row sits on the page —
  no border/card wrapper. Group with spacing and a hairline divider, not a box per item.
- Most users are on phones (teachers: iPhone PWA). Design at 375px first.
- One primary action per state. If an action is impossible, REPLACE its button with the
  valid one (e.g. upgrade replaces a disabled add) — never a disabled button under a banner.

## 2. Sizing — one ladder, CSS variables
Numbers: `packages/ui/src/styles/scrapbook.css` → `--size-*` block.
Classes: `packages/ui/src/components/sizing.ts` (`CONTROL_HEIGHT`, `CONTROL_WIDTH`,
`CONTROL_TEXT`, `FIELD_HEIGHT`, `FIELD_TEXT`, `INDICATOR`, `INDICATOR_LENGTH`, `FIELD_RADIUS`).

| token | sm | md | lg | used by |
|---|---|---|---|---|
| `--size-control-*` | 36 | 44 | 52 | Button, Input, Select, Autocomplete, NumberInput, Tabs, Pagination |
| `--size-indicator-*` | 18 | 20 | 24 | Checkbox, Radio, Slider thumb |
| `--size-text-*` | 13 | 14 | 15 | control labels / button text |
| `--size-field-text` | 16 | | | text typed in a field (under 16 → iOS zooms on focus) |

### Radius — one ladder (owner rule: nothing «very rounded» next to «square»)
Values: `packages/ui/src/styles/scrapbook.css` → `--radius-sm` 8 / `--radius-md` 12 / `--radius-lg` 16.
Classes: `rounded-sm` (chips, badges, tags, inline code, small tiles/checkboxes), `rounded-md` (buttons,
inputs, selects, list rows, segmented groups), `rounded-lg` (cards, panels, modals, sheets, popovers).
`rounded-st` = md, `rounded-st-lg` = lg; Tailwind's `rounded`/`xl`/`2xl`/`3xl`/`sk*` are aliases onto the
same three (apps/study/tailwind.config.ts; clay `sk*` in packages/ui/tailwind.preset.js). No arbitrary `rounded-[Npx]`. `rounded-full` ONLY on true circles (dots,
round icon buttons), switch tracks and thin bars — never on a chip, badge, pill button or tab group.

- A new @repo/ui component with a `size` prop MUST read `sizing.ts`, never hard-code `h-11`.
- Call sites pick `size`; they never pass height/padding/text classes to restyle a control.
- A status icon (bell etc.) is a flat icon (`variant='light'`), coloured by state: green on, red off.
- Not yet on the ladder (follow it by hand if touched): Switch (knob travel math), Chip, Avatar, Badge.

## 3. Overflow: scroll with a shadow, never clip

**#1 OWNER COMPLAINT, repeated 1000s of times: NOTHING may be visually cut. That includes a card's
top/bottom border, its clay lip and its shadow, a button's lip, a chip, an icon, or text.** The
classic case: Cards inside a `ModalBody`/Drawer/any `overflow-*` box get their top edge and bottom
lip sliced flat by the scroll box (the scroll box clips at its padding box, and a clay Card's
lip+glow needs ~16px above and ~36px below). Rules:
- **No elevated Card (clay lip/shadow) inside ANY scroll or overflow box** (ModalBody, DrawerBody,
  `overflow-y-auto`, `overflow-hidden`, ScrollShadow, Tabs panels that scroll). Inside those use
  FLAT rows: a hairline border or a tinted fill, no lip and no shadow. A card inside a modal is nested
  elevation anyway.
- If something elevated must live in a scroll box, the box needs inner padding ≥ the element's
  full shadow extent on every side (measure `box-shadow`), not a guess.
- **Nothing overlaps or touches.** A clay lip is a solid 5–6px edge below the box (the soft glow
  beyond it may overlap a neighbour; the solid lip may not). The next item starts ≥ 4px below the
  lip: stacked clay controls, fields and cards use `gap-3` (12px), never `gap-2`/`pb-2`.
  List rows (sidebar, nav, menus) are FLAT (`!shadow-none`), with at least `gap-1` between them.
  The repeat offender: a clay primary button sitting right above a list, its lip running into the
  first row.
- After ANY UI change, PROVE it: `node tools/ui-audit/run.mjs <baseUrl> <routes…>` checks
  CUT/EDGE-CUT/OFFSCREEN/OVERLAP/TIGHT-GAP/COVERED at 360/390/768/1024/1440. Also evaluate
  `tools/ui-audit/clip-check.js` with every modal/drawer/menu/Select open, AND look at a zoomed
  screenshot of every place where two items meet. "Looks fine" without measuring is not done.

- Any `overflow-y-auto` box gets the `.scroll-shadow-y` class (pure CSS, `styles/scrapbook.css`;
  set `--scroll-shadow-bg` if its background isn't the card colour). ModalBody has it built in.
  `ScrollShadow` from `@repo/ui` for horizontal strips. Never `overflow-hidden` on content that can
  grow; never a bare scrollbar region.
- Truncate only text whose full value is shown elsewhere (tooltip / detail). Names, package
  titles, money: wrap, don't truncate.
- **List/nav rows are ONE line** (sidebar, conversation list, menus): truncate the title, with the
  full text in the opened view + `title` attr. Never let a list row wrap to 2–3 lines (owner, 2026-10-23).

## 4. Colour
- Flat solid fills only. No gradients, no blobs.
- Semantics: red = removed/ending/danger, green = added/new/success, warning = needs attention,
  primary = the action. A before→after (upgrade, swap) = current in red with line-through,
  new in green, stacked top→bottom with a down arrow.
- Tinted bands use numbered shades (`bg-danger-50 border-danger-200 text-danger-700`), not
  `/opacity` text on tints — the owner reads low contrast as broken.
- Content inside a selectable row (Select option, list item) inherits the row colour
  (`opacity-75` for secondary text), never a fixed ink — the selected row is filled.

- **One separator colour.** Every hairline (layout borders, `<Divider>`, table/list dividers) is
  `default-200`. Never mix a rim-coloured line next to a default-200 border.

## 5. Components
- `@repo/ui` only — no raw `<button>`, no HeroUI imports in apps. Icons only from `@repo/icons`.
- Every modal has a visible X close in the header (the clay Modal has none built in —
  `Button isIconOnly variant='light'` + `XIcon`, `aria-label='Close'`).
  ONE way to close: the X. No "Close" footer button duplicating it.
- A group of clay buttons never sits in an `overflow-hidden`/`truncate` box — it cuts the
  buttons' bottom lip. Truncate the TEXT inside a button, not the row.
- No `variant='shadow'` glow. Text is real characters, never `\uXXXX` escapes (JSX
  attributes don't decode them).
- Foreign keys are pickers (Select/Autocomplete), never raw ID inputs.
- **Every destructive action confirms in a modal** (delete, remove, clear, purge, revoke, cancel,
  reset). One click never destroys anything; a "click again within 3s" or inline "Are you sure?" row
  doesn't count. Admin: `components/shared/ConfirmDeleteModal.tsx`: names the item and says what's
  lost and whether /trash can restore it. The danger button is the only footer action; Enter
  doesn't confirm.

## 6. Copy (English only)
- The product is English only: no Arabic strings, no RTL (`dir='rtl'`) code paths, no `ar`
  locale branches. Dates/numbers format as `en-US`.
- Short, plain, friendly. Title says the situation + the fix in one line; no paragraph explaining the server.
- Missing value = "Not set", muted, never blank.
- Never shame a score or guilt-trip about a streak (a broken streak "starts fresh", it isn't "lost");
  never phrase a gap as an accusation ("You haven't studied" → "Nothing here yet"). Mascot voice
  is encouraging ("Almost!"), never "Wrong". No flirty or suggestive emoji/wording toward a student.
- Near money: no lone student count or per-student price.

## Review checklist (run before saying a UI change is done)
1. Any box wrapping a single item? Remove it.
2. Any hard-coded control height/text size in @repo/ui? Use `sizing.ts`.
3. Any overflow that clips or scrolls without a shadow? Use `ScrollShadow`.
4. Any secondary text with a fixed ink inside a selectable row? Inherit.
5. Any disabled primary button next to the real action? Replace it.
6. Modal has an X? Copy one line? No banned word?
7. `tsc --noEmit` in the app; look at it at 375px.
