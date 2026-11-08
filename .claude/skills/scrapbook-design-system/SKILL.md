---
name: Scrapbook Design System
description: Manage the scrapbook (Direction B) design system — create new components, review existing ones, list component inventory, and reference design tokens. Use when working on UI components in packages/ui, reviewing design system compliance, scaffolding new components, or asking about design tokens/visual rules.
---

# Scrapbook Design System Manager

You are managing the **Scrapbook (Direction B)** design system for Syllabi — a brutalist sticker-UI aesthetic with ink borders, hard offset shadows, slight rotations, citrine highlights, and Caveat handwriting accents.

## Actions

Determine which action the user wants based on their request:

- **"create component X"** / **"scaffold X"** / **"new component"** → [Create Component](#create-component)
- **"review X"** / **"audit X"** / **"check X"** / **"improve X"** → [Review Component](#review-component)
- **"list components"** / **"inventory"** / **"what's shipped"** → [Component Inventory](#component-inventory)
- **"tokens"** / **"colors"** / **"shadows"** / **"what tokens"** → [Token Reference](#token-reference)

---

## Create Component

### Pre-flight checks

1. Confirm the component doesn't already exist:
   ```bash
   ls packages/ui/src/components/ | grep -i "<Name>"
   ```
2. Check if HeroUI exports a component with the same name (we shadow it):
   ```bash
   grep -r "export.*<Name>" node_modules/@heroui/react/dist/index.d.ts 2>/dev/null | head -5
   ```

### Folder structure

Every component follows this exact pattern:

```
packages/ui/src/components/<Name>/
  <Name>.tsx           # Component implementation
  <Name>.stories.tsx   # Storybook stories
  index.ts             # Barrel export
```

### Implementation template

Follow the **Button** as the canonical reference (`packages/ui/src/components/Button/Button.tsx`). Every component MUST:

#### 1. Import from the shared token system

```tsx
import { cn } from '../../cn';
import type { HeroUIColor, HeroUISize, HeroUIVariant, HeroUIRadius } from '../tokens';
import { INK, pickRotation, HEROUI_COLOR_SHADOW, HEROUI_COLOR_FILL, HEROUI_COLOR_FOREGROUND, HEROUI_COLOR_SOFT_FILL } from '../tokens';
```

Only import the tokens you actually use.

#### 2. Mirror HeroUI's prop API

- Accept the same props HeroUI consumers already use: `color`, `variant`, `size`, `radius`, `isDisabled`, `classNames`, etc.
- Add a `rotate?: number` prop for per-instance rotation override.
- Use `React.forwardRef` so refs work.
- Type the props interface and export it.

#### 3. Apply the visual contract

These rules are **non-negotiable** on every component:

| Rule | Value |
|---|---|
| **Border** | `2.5px solid var(--line)` — never less than 2px, never more than 3px. **Never `var(--ink)`** — see role separation below |
| **Shadow** | `4px 4px 0 var(--shadow-c)` — flat, never blurred. **Never `var(--ink)`.** Per-color tinting via `HEROUI_COLOR_SHADOW` |
| **Shadow hover** | `5px 5px 0 <tint>` + `translate(-1px, -1px)` |
| **Shadow active** | `0 0 0 <tint>` + `translate(4px, 4px)` (pressed-key feel) |
| **Border radius** | 4–8px only. Use `rounded-sk-sm` (4px), `rounded-sk` (6px), `rounded-sk-lg` (8px) |
| **Rotation** | Use `pickRotation(seed)` for deterministic slight rotation. Override via `rotate` prop |
| **Focus ring** | `outline: 2px solid var(--citrine); outline-offset: 2px` |
| **Transition** | 80ms CSS-only. `cubic-bezier(0.3, 0.6, 0.2, 1.2)` for transform |
| **Disabled** | `opacity-50 cursor-not-allowed`, no rotation, no shadow |

#### 4. Use CSS custom properties for surface styling

Use the `surfaceFor()` pattern from Button — set `--sk-bd`, `--sk-bg`, `--sk-fg`, `--sk-sh`, `--sk-sh-h`, `--sk-rot` as inline style variables, then reference them in Tailwind classes:

```tsx
'[border:2.5px_solid_var(--sk-bd)] bg-[color:var(--sk-bg)] text-[color:var(--sk-fg)]'
'[box-shadow:var(--sk-sh)]'
'hover:[box-shadow:var(--sk-sh-h)]'
```

#### 5. Use named Tailwind tokens (not arbitrary values)

```tsx
// GOOD
'bg-paper text-ink shadow-sk border-sk rounded-sk'

// BAD — arbitrary values for tokens that exist, AND an ink-cast shadow
'bg-[var(--paper)] bg-[#fefdf8] shadow-[4px_4px_0_var(--ink)]'
```

#### 6. English / LTR only

The product is `dir="ltr"`, `lang="en"`, English only. Do not add `dir='rtl'` branches,
`rtl:` variants, Arabic copy or `ar` locale handling. Built-in labels (aria-labels, empty
states) are English; number/date formatting defaults to `en-US`.

#### 7. Support dark theme — role separation is the central rule

`--ink` used to do three jobs at once: text, border, and hard shadow. A theme flip that is
correct for text is wrong for the other two — a cream border reads as a neon wireframe, and a
cream shadow reads as a light leak (a shadow is the *absence* of light; it must stay dark in
both themes). The three roles are separate tokens now:

| Role | Token | Flips in dark? |
|---|---|---|
| Text / foreground | `--ink` | Yes → `#f5f1e6` chalk |
| Drawn outline | `--line`, `--line-strong`, `--line-soft` | Theme-aware |
| Hard offset shadow | `--shadow-c` | **No** — stays dark |
| Outline around a brand-CONSTANT fill (purple/citrine/red button) | `--line-on-brand` | **No** |
| Text/marks on a brand-CONSTANT fill | `--ink-const` | **No** |
| Muted / secondary text | `--ink-muted` | Theme-aware |

**Never draw a border with `--ink`. Never cast a hard shadow with `--ink`.** Use `--line` and
`--shadow-c`. Drawing a brand button's outline with the themed `--line` is what put a dim
lavender halo around the purple button in dark (1.09:1 against its own fill) — that case wants
`--line-on-brand`.

Also verify:

- Floating surfaces (Modal, Popover, Drawer, Toast) MUST have explicit `bg-paper` — never transparent
- Text must use `text-ink` — never hardcoded `#0d0e24`
- Elevation is luminance, not just shadow: `--surface-0` (page) → `--surface-1` (card) →
  `--surface-2` (popover/menu/tooltip) → `--surface-3` (hover/pressed). `--paper` is the paper
  SURFACE a Card paints with, one rung above the page — point it at the page rung and cards dissolve.
- On tinted/brand fills use the paired `*-text` tokens (`--amber-text`, `--red-text`,
  `--pink-text`); the raw brand hues fail contrast as text.
- Two families rotate in dark for the medium, not as new brand colors: amber → orange
  (`#fb923c`, a dark yellow is olive mud) and `--red-soft` → `#b01236`. The SOLID danger fill
  deliberately stays `#e11d48` — brightening it drops white below AA.

### Barrel export

After creating the component, add to `packages/ui/src/index.ts` **AFTER** the HeroUI star export:

```ts
// Phase N — <description>
export { <Name> } from './components/<Name>';
export type { <NameProps> } from './components/<Name>';
```

### index.ts template

```ts
export { <Name> } from './<Name>';
export type { <Name>Props } from './<Name>';
```

### Verification

```bash
cd apps/web && npx tsc --noEmit
cd apps/admin && npx tsc --noEmit
```

Do NOT use `npm run lint` — there's a known `@next/next/recommended` flat-config bug. `tsc --noEmit` is the type-check authority.

---

## Review Component

When asked to review/audit a component, check against this checklist:

### Visual contract compliance

- [ ] Border is `2.5px solid var(--line)` — **not `var(--ink)`** (not thinner, not thicker for main border)
- [ ] Border around a brand-CONSTANT fill uses `--line-on-brand`, not the themed `--line`
- [ ] Shadow is `4px 4px 0 var(--shadow-c)` — **not `var(--ink)`** — with correct per-color tinting from `HEROUI_COLOR_SHADOW`
- [ ] Text on a brand-CONSTANT fill uses `--ink-const`; muted text uses `--ink-muted`, not an opacity guess on `--ink`
- [ ] Hover lifts `translate(-1px, -1px)` and shadow grows to `5px 5px 0`
- [ ] Active presses `translate(4px, 4px)` and shadow vanishes (pressed-key feel)
- [ ] Border radius uses `rounded-sk-sm` (4px), `rounded-sk` (6px), or `rounded-sk-lg` (8px)
- [ ] Rotation uses `pickRotation(seed)` — not `Math.random()`
- [ ] Focus ring is citrine: `ring-[var(--citrine)]` or `outline: 2px solid var(--citrine)`
- [ ] Transitions are 80ms, CSS-only, no React state in animation loop
- [ ] Disabled state: `opacity-50`, no rotation, no shadow

### Token usage

- [ ] Uses named Tailwind tokens (`bg-paper`, `text-ink`, `shadow-sk`) not arbitrary values
- [ ] Colors reference `tokens.ts` constants, not hardcoded hex values
- [ ] No `bg-white` or `bg-[#fefdf8]` — use `bg-paper`

### Language

- [ ] Every built-in string (aria-label, empty state, placeholder) is English
- [ ] No RTL-only code paths (`dir='rtl'` checks, `rtl:` variants)

### HeroUI API parity

- [ ] Accepts same props as HeroUI equivalent (`color`, `variant`, `size`, `radius`, etc.)
- [ ] Uses `React.forwardRef`
- [ ] Props interface is exported
- [ ] `classNames` slot props accepted (even if subset honored)
- [ ] `isDisabled` / `disabled` both work

### Architecture

- [ ] Lives in `packages/ui/src/components/<Name>/<Name>.tsx`
- [ ] Has `index.ts` barrel export
- [ ] Has `.stories.tsx` file
- [ ] Exported from `packages/ui/src/index.ts` after HeroUI star export
- [ ] Imports from `../../cn` and `../tokens` — not from external paths

### Dark mode

- [ ] Floating surfaces have explicit `bg-paper`
- [ ] All colors use CSS variables that swap in dark theme
- [ ] No hardcoded light-only colors

Report findings as: **Pass**, **Fail** (with fix), or **Warning** (non-critical).

---

## Component Inventory

Read the current component list from the barrel export:

```bash
grep "export.*from.*'./components/" packages/ui/src/index.ts
```

Then cross-reference with the directory listing:

```bash
ls packages/ui/src/components/
```

### Currently shipped (shadowing HeroUI)

These components are in `packages/ui/src/components/` and exported from the barrel AFTER the HeroUI star export, so they shadow HeroUI's versions:

| Component | Exports | Phase |
|---|---|---|
| **Accordion** | `Accordion`, `AccordionItem` | P2R3 |
| **Alert** | `Alert` | P2R5 |
| **Avatar** | `Avatar` | P1 |
| **Badge** | `Badge` | P2R5 |
| **Button** | `Button` | P1 |
| **Card** | `Card`, `CardHeader`, `CardBody`, `CardFooter`, `Tape`, `Pin`, `HolePunch` | P1 |
| **Checkbox** | `Checkbox` | P1 |
| **Chip** | `Chip` | P1 |
| **Divider** | `Divider` | P2R5 |
| **Drawer** | `Drawer`, `DrawerContent`, `DrawerHeader`, `DrawerBody`, `DrawerFooter` | P2R3 |
| **Dropdown** | `Dropdown`, `DropdownTrigger`, `DropdownMenu`, `DropdownItem`, `DropdownSection` | P2R5 |
| **Icon** | `Icon`, `ICON_REGISTRY` | P2R5 |
| **Input** | `Input` | P1 |
| **Modal** | `Modal`, `ModalContent`, `ModalHeader`, `ModalBody`, `ModalFooter`, `useDisclosure` | P1 |
| **Pagination** | `Pagination` | P2R1 |
| **Popover** | `Popover`, `PopoverTrigger`, `PopoverContent` | P2R3 |
| **Progress** | `Progress`, `CircularProgress` | P2R1 |
| **RadioGroup** | `RadioGroup`, `Radio` | P2R1 |
| **ScrollShadow** | `ScrollShadow` | P2R5 |
| **Select** | `Select`, `SelectItem` | P2R1 |
| **Skeleton** | `Skeleton` | P1 |
| **Slider** | `Slider` | P2R5 |
| **Spinner** | `Spinner` | P1 |
| **Switch** | `Switch` | P1 |
| **Table** | `Table`, `TableHeader`, `TableColumn`, `TableBody`, `TableRow`, `TableCell` | P2R4 |
| **Tabs** | `Tabs`, `Tab` | P2R1 |
| **Textarea** | `Textarea` | P1 |
| **Toast** | `Toast`, `ToastProvider`, `addToast`, `closeToast`, `closeAll`, `Toaster` | P2R2 |
| **Tooltip** | `Tooltip` | P2R2 |

### NOT yet shadowed (falls through to HeroUI via star export)

These directories exist in `packages/ui/src/components/` but are NOT exported from the barrel (or are pass-through):

`Autocomplete`, `AvatarGroup`, `Breadcrumbs`, `CheckboxGroup`, `Code`, `Form`, `Image`, `Kbd`, `Link`, `Listbox`, `Menu`, `Navbar`, `NumberInput`, `Snippet`, `Spacer`, `User`

### Utilities (not components)

- `tokens.ts` — TypeScript color/shadow/rotation constants
- `cn()` — `clsx` + `tailwind-merge` utility (from `packages/ui/src/cn.ts`)

---

## Token Reference

### CSS Variables (source: `packages/ui/src/styles/scrapbook.css`)

| Token | Light | Dark |
|---|---|---|
| `--ink` | `#0d0e24` | `#f5f1e6` |
| `--paper` | `#fefdf8` | `#0d0e24` |
| `--paper-2` | `#f5f1e6` | `#17182f` |
| `--p` (primary) | `#7828c8` | same |
| `--p-light` | `#9353d3` | same |
| `--p-dark` | `#5b1a96` | same |
| `--citrine` | `#fde047` | same |
| `--pink` | `#ec4899` | same |
| `--b` (blue) | `#006fee` | same |
| `--g` (green) | `#10b981` | same |
| `--amber` | `#f59e0b` | `#fb923c` (rotates to orange) |
| `--red` | `#e11d48` | same (solid fill must NOT brighten — white drops below AA) |

**Role tokens — use these for borders and shadows, never `--ink`:**

| Token | Role | Light | Dark |
|---|---|---|---|
| `--line` / `--line-strong` | drawn outline | `#0d0e24` | theme-aware |
| `--line-soft` | hairline dividers | `rgba(13,14,36,.12)` | theme-aware |
| `--line-on-brand` | outline around a brand-CONSTANT fill | `#0d0e24` | **same** |
| `--shadow-c` | hard offset shadow | `#0d0e24` | **same** |
| `--ink-const` | text on a brand-CONSTANT fill | `#0d0e24` | **same** |
| `--ink-muted` | muted / secondary text | `rgba(13,14,36,.62)` | theme-aware |
| `--surface-0..3` | elevation ladder (page → card → popover → pressed) | `#fefdf8` / `#fff` / `#fff` / `#f5f1e6` | theme-aware |
| `--amber-text` / `--red-text` / `--pink-text` | brand hues as TEXT (contrast-fixed) | `#b45309` / `#e11d48` / `#be185d` | theme-aware |

Brand colors stay constant across themes. Only the ink/paper poles flip — plus amber and
`--red-soft`, which are tuned for the medium rather than being new brand colors.

### Tailwind Token Names (source: `packages/ui/tailwind.preset.js`)

**Colors:** `bg-ink`, `text-ink`, `bg-paper`, `bg-paper-2`, `text-citrine`, `bg-citrine`, `text-sk-primary`, `bg-sk-primary`, `text-sk-blue`, `text-sk-green`, `text-sk-pink`, `text-sk-amber`, `text-sk-red`, plus `*-soft` pastel washes (`bg-sk-pink-soft`, etc.)

**Shadows:** `shadow-sk-sm` (2×2), `shadow-sk` (4×4), `shadow-sk-lg` (5×5), `shadow-sk-xl` (6×6), `shadow-sk-primary`, `shadow-sk-blue`, `shadow-sk-green`, `shadow-sk-amber`, `shadow-sk-red`, `shadow-sk-pink`, `shadow-sk-pressed` (0×0)

**Borders:** `border-sk` (2.5px), `border-sk-thin` (2px), `border-sk-hair` (1.5px)

**Radii:** `rounded-sk-sm` (4px), `rounded-sk` (6px), `rounded-sk-lg` (8px)

**Fonts:** `font-sans` (IBM Plex Sans — the bundled "IBM Plex Sans Arabic" family, full Latin set → Cairo → system-ui), `font-hand` (Caveat → Kalam → IBM Plex Sans)

⚠ Caveat is not loaded by default; an app that wants handwritten accents loads it itself. The
`font-hand` stack ends in the brand face (not `cursive`) so a missing Caveat stays on-brand.

**Animations:** `animate-sk-pulse`, `animate-sk-pulse-soft`, `animate-sk-wiggle`

### TypeScript Constants (source: `packages/ui/src/components/tokens.ts`)

```ts
// Role tokens — CSS var refs, theme-aware. Prefer these.
INK = 'var(--ink)'            PAPER = 'var(--paper)'       PAPER_DARK = 'var(--paper-2)'
LINE = 'var(--line)'          LINE_STRONG / LINE_SOFT      LINE_ON_BRAND = 'var(--line-on-brand)'
SHADOW_C = 'var(--shadow-c)'  INK_ON_BRAND = 'var(--ink-const)'   INK_MUTED = 'var(--ink-muted)'
SURFACE_0..SURFACE_3

// Literal hexes — only for consumers that cannot take a CSS var
// (e.g. Recharts `<Bar fill={RED} />`, which writes an SVG presentation attribute).
PRIMARY = '#7828c8'  PRIMARY_LIGHT = '#9353d3'  PRIMARY_DARK = '#5b1a96'
CITRINE = '#fde047'  PINK = '#ec4899'  BLUE = '#006fee'
GREEN = '#10b981'    AMBER = '#f59e0b'  RED = '#e11d48'
```

`INK`/`PAPER`/`LINE`/`SHADOW_C` are **`var()` strings, not hexes**. String-concatenating an
alpha onto them (`` `${INK}55` ``) produces invalid CSS — use the Tailwind slash modifiers
(`text-ink/65`, `border-ink/20`), which compile via the `*-rgb` triplet tokens.

Maps: `HEROUI_COLOR_SHADOW`, `HEROUI_COLOR_FILL`, `HEROUI_COLOR_FOREGROUND`, `HEROUI_COLOR_SOFT_FILL`

Types: `HeroUIColor`, `HeroUIVariant`, `HeroUISize`, `HeroUIRadius`

Helper: `pickRotation(seed: number): number` — deterministic rotation from ladder `[-0.6, 0.4, -0.4, 0.8, -0.5, 0.6, -0.3, 0.5]`

### Key source files

| File | Purpose |
|---|---|
| `packages/ui/src/styles/scrapbook.css` | CSS variables, keyframes, legacy classes, dark theme |
| `packages/ui/tailwind.preset.js` | Tailwind token definitions |
| `packages/ui/src/components/tokens.ts` | TS constants + type definitions |
| `packages/ui/src/components/Button/Button.tsx` | Canonical component pattern |
| `packages/ui/src/index.ts` | Barrel export (shadowing order) |
| `packages/ui/src/cn.ts` | `cn()` utility |
| `docs/superpowers/plans/2026-05-07-scrapbook-design-system.md` | Full rollout plan + leaky abstractions |
