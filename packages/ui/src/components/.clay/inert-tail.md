
---

## Verdict per component

| component | verdict |
|---|---|
| **Spacer** | **nothing needed.** Its only scrapbook reference is a code comment explaining that it stays invisible by design. Renders in both themes; no geometry, no colour. |
| **Thinking** | **nothing needed.** Its one token is `text-[color:var(--ink)]` — the theme foreground, not scrapbook geometry. Its own header already documents that it uses `HEROUI_COLOR_TEXT` rather than a raw semantic scale. |
| **ScrollShadow** | **nothing changed — see the measurement below.** The mismatch is real and measures **1.01:1**. |
| Divider | ported — separator re-tokened |
| Skeleton | ported — dashed ink border → clay rim, clay radius |
| Kbd | ported — ink border + hard offset → clay rim, no lip |
| Code | ported — ink border + hard offset → clay rim, clay radius |
| Spinner | ported — hard diagonal drop-shadow removed |
| User | ported — Caveat dropped |
| Progress | ported + **two real defects fixed** |
| Badge | ported + **one real defect fixed** |

Every one of the 18 stories across these components renders in **both themes with zero page
errors** — verified, not assumed. That check is the reason this report exists in its current
form; see the section on `tsc` at the end.

### The rims, after (all `CLAY_RIM`, measured on the story ground)

| | light | dark |
|---|---|---|
| Divider (h and v) | 1px solid **3.90:1** | **5.24:1** |
| Kbd key | 2px **3.90:1** | **5.24:1** |
| Code | 2px **3.90:1** | **5.24:1** |
| Skeleton | 1px **3.90:1** | **5.24:1** |

All four previously drew on `--line`, which **flips**: an ink hairline at ~2.8:1 in light and
~1.3:1 in dark for Divider, and a hard `--line` border for Kbd/Code. They now clear 3:1 in both
themes and are the same relationship in each. Divider also went **dashed → solid** and 2px →
1px: a dashed ink hairline is scrapbook, and thin-and-visible beats thick-and-faint.

**Kbd deliberately has no lip.** A `<kbd>` *depicts* a key but *is* a label — pressing a
description of a keystroke does nothing, so it gets the rim and not the affordance. Quality
bar #3. Its `shadow-sk-sm` is gone and nothing replaces it.

### Progress — two defects, both real

1. **The linear bar was on the FILL map, and its own circular variant was not.**
   `fillColor` read `HEROUI_COLOR_SHADOW[color]`; the circular ring in the same file already
   read `HEROUI_COLOR_TEXT[color]`, with a comment explaining why. So one component disagreed
   with itself about what colour a mark is. Measured in dark, primary bar against its track:

   **2.49:1 → 6.78:1.**

   That 2.49 is the *same number* the brief cites for the Accordion open-indicator — same
   mechanism, same value, different component. Verified by resolution, not by eye: in dark the
   bar now paints `rgb(191,153,229)` (`--p-text`) where it used to paint `rgb(120,40,200)` (the
   raw brand). Of the improvement, the map is the larger half (7.54:1 on the old track).
2. **The bar grew from the wrong end in RTL** — i.e. on this whole platform. The indicator was
   `absolute inset-y-0 left-0 border-r-[2px]`, all physical. Measured: with `direction: rtl`
   the fill sat against the track's *left* edge. Now `start-0` / `border-e-[2px]`, and the fill
   measures anchored to the right — the start. `inert-tail-shots/progress-dark.png`.

   Also removed: a span whose own comment called it a "Hand-drawn dashed underline accent".
   The track reads as a groove because it is filled `--paper-2`, not because a dashed line is
   drawn along its bottom.

### Badge — the one genuine port, and it was not separating from its host in dark

Diagonals gone (`2px 2px 0` and `1.5px 1.5px 0`), `rounded-sk-sm` → clay radius. `variant='shadow'`
has no shadow to draw and a badge is inert, so it renders the separating ring instead — the
useful half of what it meant.

The ring itself was the defect. Measured on a dark host:

| | light | dark |
|---|---|---|
| ring vs host, before (`outline`, a constant near-black) | 18.65:1 | **1.03:1** |
| badge FILL vs host | 7.02:1 | 2.73:1 |
| ring vs host, after (`CLAY_RIM`) | 3.90:1 | **5.24:1** |

With a near-black ring on a near-black host and a 2.73:1 fill, **nothing about the badge
separated it from what it sat on in dark**. `CLAY_RIM` is the shared answer for a component
framing content it does not control — Avatar's argument, and a badge lands on avatars. The
`outline` still colours the badge's own border, where the existing reasoning holds.

### ScrollShadow — real, invisible, and not mine to fix properly

Card, Modal and Drawer have all moved to `--card-bg`. ScrollShadow still fades to `--paper`.
Measured:

| | `--paper` | `--card-bg` | fade vs surface |
|---|---|---|---|
| light | `#fefdf8` | `#ffffff` | **1.01:1** |
| dark | `#14162c` | `#14162c` | identical — nothing to fix |

So the fade is exact in dark and off by a hundredth of a ratio in light. **I did not change it.**
Doing it properly means fading to `--card-bg`, and the component's transparent endpoint uses
`rgb(var(--paper-rgb) / 0)` specifically so the gradient does not interpolate through grey —
there is **no `--card-bg-rgb`** to do the same with. Adding one is a `scrapbook.css` change.

**Reported, not applied:** add `--card-bg-rgb` and point the fade at it. Today the visible
impact is nil; it becomes a real band the moment `--paper` is separated from `--surface-1`.

---

## The verification gate this whole migration is using does not work

This is the most important thing in this report and it is not about the inert tail.

I introduced a bug: removing Divider's `LINE, tint` import while a second usage survived in the
horizontal branch. **`npx tsc --noEmit` from `packages/ui` reported clean.** I only found it
because the story rendered blank in a browser.

So I tested the gate directly — appended `const __CANARY: number = "not a number"` and a
reference to an undefined identifier, and ran it:

```
$ npx tsc --noEmit
error TS2688: Cannot find type definition file for 'minimatch'.
$ echo $?
0
```

Nothing. **TS2688 is a fatal config-level error and tsc aborts before type-checking any
source.** Bypass the implicit type-library scan and the real errors appear at once:

```
$ npx tsc --noEmit --typeRoots /tmp/does-not-exist
src/components/Autocomplete/Autocomplete.tsx:75  TS2304: Cannot find name 'RED'.
src/components/Dropdown/Dropdown.tsx:843         TS17001: duplicate JSX attribute
src/components/Pagination/Pagination.tsx:417-418 TS7053: implicit any indexing CSSProperties
src/components/Tabs/Tabs.tsx:519                 TS2352: unsound cast to CSSProperties
```

Consequences:
- **`packages/ui`'s `lint` script IS `tsc --noEmit`.** The brief names it as the substitute for
  ESLint. It has been green on broken code for this entire migration, and every "tsc clean"
  any of us has reported — mine on Pagination, Card and Table included — was worth nothing for
  this class of error.
- **`Autocomplete.tsx:75 Cannot find name 'RED'` is a live crash**, the same shape as the bug I
  just made: that component will throw on render exactly as Divider did. Whoever owns
  Autocomplete should be told now.
- I fixed my own two (Pagination 417-418, `--clay-*` assigned through a type with no index
  signature). The other three are not mine.

**Root cause:** `@types/minimatch@6.0.0` is an empty deprecation stub shipping no `.d.ts`, and
it is picked up by the implicit `@types` scan. Removing the dependency, or adding `"types": []`
to `packages/ui/tsconfig.json`, restores checking. **Reported, not applied** — it is shared
infrastructure, and turning it on mid-flight surfaces other agents' errors in their files
without warning. That is the orchestrator's call, not mine.

**Until it is fixed, the only gate that actually works is rendering the story.** A blank
`#storybook-root` with a captured `pageerror` is what caught my Divider bug; it is the check I
used across all 18 stories here, and I would put it in the brief above `tsc`.

### Verification actually performed
- All 18 stories, both themes, asserted non-empty `#storybook-root` and zero page errors.
- Rims, Progress marks, Progress direction and Badge ring measured in-browser, both themes.
- `tsc` with the config error bypassed: the eight files I touched are type-clean.
- No shared file edited. No commit, no push, no `lint:fix`.
