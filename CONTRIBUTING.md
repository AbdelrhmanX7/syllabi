# Contributing to Syllabi

Thanks for helping. This guide covers setup, the checks a pull request has to pass, and the UI rules every
screen follows.

## Ways to help

- **Report a bug**: use the bug template and include the device or browser, the screen, and steps to reproduce.
  A screenshot helps.
- **Suggest a feature**: use the feature template and say what you're trying to get done as a student, not just
  the solution.
- **Improve the docs**: fixes to the READMEs and guides are always welcome.
- **Write code**: issues labelled `good first issue` are small and self-contained, and `help wanted` issues are
  ones the maintainer would like a hand with. Comment on an issue before starting so two people don't build
  the same thing.
- **Test on a real tablet**: reports from Android tablets, especially older or low-RAM ones, are very useful.

Questions and half-formed ideas belong in [Discussions](https://github.com/AbdelrhmanX7/syllabi/discussions).

## Setup

You need Node 22+ and pnpm 10 (`corepack enable` installs the version pinned in `package.json`).

```bash
git clone https://github.com/<you>/syllabi && cd syllabi
pnpm install
pnpm dev                     # the app on http://localhost:3016, in demo mode
```

Demo mode runs on built-in sample data (`apps/study/lib/api/mock`), so you don't need a server for most UI
work. To work against a server, see [`apps/server/README.md`](apps/server/README.md).

The dev server uses webpack (`next dev --webpack`). Don't switch it to Turbopack.

## Checks before you open a pull request

Run these from `apps/study` (or the package you changed):

```bash
./node_modules/.bin/tsc --noEmit   # type check; this is the real gate
pnpm test                          # unit tests (node --test via tsx)
./node_modules/.bin/eslint         # lint
```

For UI changes, also:

```bash
node tools/ui-audit/run.mjs http://localhost:3016 /your-route/   # from the repo root; exits 1 if anything is clipped
```

Include before and after screenshots at tablet sizes (1280×800 landscape, 800×1280 portrait) in the pull request.

## Rules the code follows

- **pnpm only.** Declare every package you import in the `package.json` of the workspace that imports it.
- **Old tablets matter.** Don't use a web API newer than Chrome 103 without a guard (for example,
  `AbortSignal.timeout` needs 103). Animate only `transform` and `opacity`, and avoid heavy blur.
- **Demo data is fictional.** Never commit real names, courses, grades or account data, including in tests
  and fixtures.
- **Tests sit next to the code** as `*.test.ts`. Pure logic goes in `lib/` folders so it can be tested without a
  browser.

## UI rules

Every screen is built from the clay design system (`packages/ui` and `apps/study/components/ui/primitives.tsx`).

- **Designed components only.** Use the existing buttons, chips, tabs, badges and inputs. Don't hand-roll pills,
  tab bars or star ratings.
- **Nothing clipped.** No cut-off text, chips, icons, card edges or shadows at any width. Use flat rows inside
  scrolling or modal boxes, and keep a `gap-3` gap between stacked clay items so their lips never touch.
- **Dense.** Prefer one-line facts to tall tiles, and leave no wasted vertical space.
- **No avatars or initial-letter tiles, no solid black (`#000`), no gradient blobs.**
- **Every destructive action opens a confirm modal.**

## Pull requests

- Keep each pull request to one change, and link the issue it closes.
- Write the commit message as one line saying what changed and why, in plain words.
- Fill in the pull request template. A maintainer reviews within a few days.
- By contributing, you agree your work is released under the MIT license.

## Code of Conduct

Taking part means following the [Code of Conduct](CODE_OF_CONDUCT.md).
