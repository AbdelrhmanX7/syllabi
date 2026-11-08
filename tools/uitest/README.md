# uitest — the pre-ship UI harness

Drives the real apps in a real browser against fixtures we control, and asserts
what a screenshot cannot: that a value reached the screen, survived local state,
and left again in the outgoing request body.

```bash
node tools/uitest/run.mjs                    # every scenario
node tools/uitest/run.mjs figures-web        # one or more by name
node tools/uitest/run.mjs --list             # what exists
```

| env | effect |
| --- | --- |
| `MOBILE=1` | phone viewport (390x844) instead of each scenario's desktop default |
| `GEOM=1` | dump every figure's measured geometry as it is asserted |
| `HEADFUL=1` | show the browser |
| `UITEST_OUT=<dir>` | where screenshots and logs go (default: a directory under the system tmpdir) |
| `UITEST_PORT_<APP>=<port>` | run that app's dev server somewhere else, e.g. `UITEST_PORT_WEB=3100`, when another tool holds its usual port |

**Ports.** admin `:3002`, teacher `:3003`, accounting `:3005`, minology `:3006`,
ahmed-yousef `:3009` — each app's own dev-script port, reused when already
serving. **apps/web is the exception: uitest runs it on `:3020`, not `:3000`.**
`:3000` is reserved on this machine for another local tool and must stay free, so
the harness passes `--port 3020` when it spawns web and never binds `:3000`.

Exit code is non-zero if any surface failed. **Artifacts never go inside the
repo** — no `.gitignore` entry is needed, and a run leaves the working tree
untouched.

Plain Node ESM, zero dependencies beyond the `playwright` already in the repo
root. Nothing to install.

---

## The three modes, and the bug class each one catches

**Mock mode** — every request the browser makes is answered by Playwright route
interception. The app boots for real, renders for real, and runs its own
normalisers and reducers for real; only the wire is fake.

> Catches: render bugs, state bugs, and **silent drops** — a field that arrives
> in the payload, renders fine, and then vanishes from the body the app posts
> back. `captureRequest` is the only way to see that class at all; a screenshot
> of a correct-looking screen is exactly what a silent drop produces.

**SSR-stub mode** — a `node:http` server bound to the app's `NEXT_PUBLIC_API`
origin. Route interception lives in the browser, so it cannot reach a
`getStaticProps` / `getServerSideProps` / RSC fetch: that request leaves the Next
dev server's own Node process. The only way to answer it without a real backend
is to *be* the backend.

> Catches: the same classes on server-rendered pages, which mock mode simply
> cannot reach. Requires the real backend to be down — the harness fails loudly
> if the port is taken rather than quietly testing against real data.

**Full-stack mode** — no interception at all, real backend, real database. Not
scripted here; see the `local-fullstack-browser-testing` memory for the throwaway
admin recipe.

> Catches: **contract drift**. Mock mode proves the app is self-consistent; it
> proves nothing about whether the backend still sends that shape. Fixtures are a
> snapshot of a contract, and a snapshot goes stale silently.

Use mock mode by default. Reach for full-stack when the change is about a
contract rather than a component.

---

## Footguns

Each of these produced a false pass or a mystery failure at least once.

**`playwright` is CommonJS.** `import { chromium } from 'playwright'` throws in
an `.mjs` file. Default-import the module object and destructure:
`import playwright from 'playwright'; const { chromium } = playwright;` The bare
specifier resolves because these files live inside the repo.

**There are no downloaded Playwright browsers here.** The system Chrome at
`/usr/bin/google-chrome` is the only one, so every launch must pass
`executablePath`. `lib/browser.mjs` does this; use it.

**There is no Playwright MCP in this session.** Driving a browser means writing a
script like these, not calling a tool.

**Text must be matched EXACTLY.** `getByText(x)` is substring matching.
These stems share long prefixes and an option's text is frequently a substring of
its stem, so substring matching resolves to several elements and then either
throws a strict-mode violation or silently matches the wrong one. Use
`{ exact: true }`, and normalise whitespace before comparing inside `evaluate`.

**`atob` rejects base64url.** `isTokenExpired` in `@repo/auth` decodes the JWT
payload with `atob()`, which is strict base64 and throws on `-` and `_`. A token
that happens to encode with either character makes the guard treat the session as
broken and bounce to `/login` — and it looks like "the page redirected", not "the
token was malformed". `makeJwt` in `lib/auth.mjs` nudges a nonce until the
encoding avoids both characters. Do not hand-roll a token.

**A lazy image never decodes off-screen.** `loading="lazy"` plus
`content-visibility` means `naturalWidth` stays 0 for a figure that is perfectly
fine — it is just below the fold. Scroll first, then wait for the decode. And
`complete` alone is a false pass: a 404'd image is also "complete". The real load
signal is `complete && naturalWidth > 0`.

**`nextjs-portal` swallows clicks.** Next's dev-tools indicator is a fixed host
element that hit-tests over app UI in headless Chrome, most often over whatever
sits at the bottom of the viewport. It re-mounts itself, so hide it by stylesheet
(document styles beat the shadow `:host` rule) rather than removing it.
`newContext` in `lib/browser.mjs` does this on every page.

**Visible ≠ tappable.** A fixed overlay — the dev indicator, a push-permission
banner, a sticky footer — leaves a button fully visible while eating every tap on
it. `clickReachable` / `locatorReachable` ask `elementFromPoint` what a real tap
at the button's centre would actually hit. This is how the minology exam player's
covered navigation was found.

**`getBoundingClientRect` is the TRANSFORMED box.** These cards run an entry
animation, so a figure whose layout is a clean 322x202 measures 324.79x206.48
mid-scale, and a naive "not stretched" assertion fails on correct code. Assert on
the computed layout box (`figure.layout`); keep `rect` for overflow, which
compares two transformed boxes against each other and is consistent either way.

**An ancestor "precedes" its descendant.** `compareDocumentPosition` reports a
container that wraps both the stem and the figure as *preceding* the figure, so a
naive document-order check passes even when the figure renders in the wrong
place. Only a true sibling subtree counts — `betweenInDocumentOrder` excludes
ancestors.

**A stale `.next` build 404s dynamic dev routes.** If a route that exists in
source returns 404, the dev server is serving a stale production build. Restart
it rather than debugging the route.

**"Something answers HTTP on the port" is not "the app is up".** A dev server can
die and an unrelated local tool can take the port; a naive probe then reports
"reusing" and every assertion fails with a timeout that reads like an app bug.
This happened during the port of these scenarios: apps/web died and a tool called
another app took :3000, costing four 120-second timeouts before anyone looked at
the port. `lib/dev-server.mjs` now requires the response to reference `/_next/`
and names what it found instead — free the port, or move the app with
`UITEST_PORT_<APP>`.

**Absent is not null.** `hasOwnProperty` is the assertion for "this question
carries no `image` key". A payload with `image: null` and a payload with no
`image` key at all are different bugs, and `!q.image` cannot tell them apart.

**A fixture tests ABSENCE by DELETING the key, never by assigning `undefined`.**
`JSON.stringify` drops an undefined value, so `{ responseText: undefined }` and a
missing key go down the wire identically — the assertion passes and looks like it
proved something. It did not: the fixture object still answers `hasOwnProperty`
with `true`, so the test keeps passing on the day the app starts sending the
field, which is the one day it was supposed to fail. Build the row, then `delete
row.theKey`. `blank-essay-*` does this, and it is load-bearing there: a present
empty string («the student wrote nothing») and a missing field («this deployment
did not say») must render differently, and only deletion asks that question.

**Two positive assertions can both pass on a screen that renders one thing.**
"Payload A shows wrong" and "payload B shows pending" are both satisfied if the
badge text matches neither exact string — each check fails to find its own
opposite and reports nothing. When the point is that two payloads render
DIFFERENTLY, keep the first render and compare the two against each other; that
comparison is the assertion, and the per-payload checks are only its scaffolding.

**A bare-array body is not a `[status, body]` pair.** Several endpoints here
return a naked array on the wire (`GET /get-active-study-phases`, which
`StudyPhaseSelect` maps directly), so the mock table treats an array as a
status/body pair only when the first element is an HTTP status number. Use
`withStatus(500, { … })` when you want to be explicit. Note that these
bare-array endpoints throw inside the component rather than degrading when the
`{}` catch-all answers them — give them a shaped default, or a `GET /get-*`
prefix route.

**A modal fades in.** HeroUI's dialog animates over ~300ms, so a screenshot
taken immediately is translucent and an assertion on a mid-transition frame is a
coin flip. Settle before shooting.

**A rich-text editor mounts holding the PREVIOUS record's content.** The edit
modal stays mounted between openings and keeps its form state, so the Quill
instances mount filled with the question edited before this one and are re-filled
a render later. Two consequences: waiting for `.ql-editor` to exist is not
waiting for it to be *hydrated* — wait for its text — and a save fired too early
asserts against the wrong question. `openDraftEditor` in `extraction-echo-back`
does both. It is also a component footgun, not just a test one: anything the
editor decides "on mount" is deciding it about the wrong content.

**HeroUI hides the real `<input role="switch">` with `sr-only`.** Clicking the
switch by role fails: the input is covered by its own row. Click the wrapping
`<label>` and read `isChecked()` from the input.

**Never run a lint script from here.** `npm run lint:fix` in this repo is
`eslint --fix && prettier --write .` — it rewrites the whole app tree.
`lib/dev-server.mjs` only ever runs `npm run dev`.

**A dev server "Ready in 212ms" is serving a stale cache, and NESTED DYNAMIC
ROUTES ARE WHAT IT DROPS FIRST.** The stale-`.next` footgun above says restart
it; that is not always enough, because the restart reuses the same cache. In
apps/teacher, `/lecture/[id]/analytics/` AND `/lecture/[id]/` AND `/exam/[id]/`
all 404'd while `/lectures/` answered 200 — every route that is a file *and* a
directory at the same path was simply not registered. The tell is the startup
time: a genuine Turbopack cold start is seconds, not milliseconds. Move `.next`
aside and start again. Note this breaks `unshare-confirm` too, so a "pre-existing
scenario is broken" conclusion should rule this out first.

**A real feature needs a real decoder.** Watch coverage credits a bucket only for
media time that genuinely flowed through it — a scripted `currentTime`, a stubbed
`<video>` or a `data:` URI all move the playhead down the exact path the
accumulator refuses credit for, so they would pass while proving nothing.
`lib/media.mjs` builds an actual H.264 clip with ffmpeg and serves it with
`Range` support, because Chrome seeks by asking for a byte range. Playback runs in
real time: budget ~40s of wall clock per player scenario, and start it with a
real click (`play()` from `evaluate` is refused outright by the autoplay policy).

**`sendBeacon` IS interceptable, and its shape is the assertion.** A beacon fired
from a synthetic `pagehide` reaches `context.route` like anything else, and
`postDataJSON()` parses it. What separates it from an axios POST fired in the
same handler is `resourceType: 'ping'` and `content-type: text/plain` — and both
matter: an ordinary fetch is not guaranteed to survive a closing tab, and a
`Blob` with a type makes the browser announce `application/json`, which the
beacon route does not parse. Assert the transport, not only the body.

**The coverage bar only repaints while the video is PLAYING.** `coveredSegments`
is refreshed on the 15s snapshot tick, and that tick returns early when nothing
was accumulated since the last one. So a wait for "two stretches appeared" that
runs after `pause()` always times out, on correct code. Wait first, pause after.

**A TURBOPACK HOT UPDATE RE-EVALUATES MODULE SCOPE MID-RUN, AND MODULE SCOPE IS WHERE THE DEDUPES
LIVE.** A recompile while a scenario is running swaps the module instance under the page: any
`let` at module scope resets. That is not a corner case here — `createServiceWorker` collapses the
3–4 mounts of `useServiceWorker()` per page behind ONE shared promise held at module scope, and
`apps/ahmed-yousef`'s push hook keeps `lastResolvedAppId` the same way. A run that straddles a
recompile counts two requests where the product sent one, on correct code, and the next identical
run disagrees with it. The video-resume gate hit the same class and read `0.3` then `1` from two
identical runs with a «✓ Compiled in 247ms» between them. Close the dev socket for the whole
context:

```js
await context.routeWebSocket('**', (ws) => ws.close());   // no HMR, no re-evaluation
```

`push-identity-web` and `push-identity-ay` both do this. **And if two identical runs ever disagree,
read the dev-server log for a recompile before suspecting the app.**

**THE HARNESS CAN ONLY REUSE A DEV SERVER, NEVER SPAWN ONE** (`npm` is a dangling symlink here), so
a stale listener wins silently — and a Next server whose worktree has been DELETED keeps serving
the files it already loaded, answering 200 with `/_next/` in the body, which is exactly what
`lib/dev-server.mjs` probes for. Start your own servers in your own worktree, pass
`UITEST_PORT_<APP>`, and check what you are about to measure:

```bash
for p in $(pgrep -f next-server); do printf "%s %s\n" "$p" "$(readlink /proc/$p/cwd)"; done
```

A `(deleted)` suffix is a ghost. Port number is not identity.

**`context.cookies()` LIES AFTER AN ABORTED CROSS-ORIGIN NAVIGATION.** When a scenario lets the
app hard-navigate somewhere the mock blocks (`window.location.href = <other app>`), Chrome commits
an opaque-origin error document. In that tab `document.cookie` and `localStorage` both throw
`SecurityError` — so a `page.evaluate` reports "could not read" as "was cleared" — and
`context.cookies()` goes the other way: it keeps answering with the value from BEFORE the app's
last write. `push-identity-web` had a write-up of a real session-teardown defect on the strength of
that read; wrapping the `document.cookie` setter and reading back inside the write showed the
clear landing ~15ms before the error page committed. There was no defect. Do not assert storage
state through a navigation you aborted: assert it before, or do not assert it.

**A REACT `StrictMode` APP COUNTS EVERYTHING TWICE.** `apps/ahmed-yousef` sets
`reactStrictMode: true` and `apps/web` sets `false`, so the same "one POST per load" assertion is 1
on one app and 2 on the other, in dev only. Measure the per-load figure and assert the RATIO across
two loads rather than hard-coding either number — a scenario that pins "1" is wrong on half the
repo, and one that pins "2" silently stops catching a duplicate-mount bug the day production
behaviour changes. `push-identity-ay` does the former and says so in a `note`.

**A PUSH SUBSCRIPTION HAS TO BE STUBBED, AND THE SOCKET USUALLY DOES TOO.** `lib/push-stubs.mjs`
patches `PushManager.prototype` (a real subscription needs a real push service) and can freeze
`Notification.permission` at `denied` (Playwright grants and clears; it cannot deny). It also
exports `socketIoRoutes()`, which answers the Engine.IO **polling** handshake from the mock table —
polling, because `createSocket` configures `transports: ['polling', 'websocket']` with polling
first and engine.io-client's `tryAllTransports` defaults to false, so an ABORTED polling transport
never falls through to websocket and the socket simply never connects. That matters beyond the
socket: `NotificationStatusCard` only renders `active` when the socket is up, so without it the
match case and the mismatch case both render the same "notifications need updating" line and the whole
attribution-downgrade surface passes while proving nothing.

**A node test cannot see an `Illegal invocation`.** `setInterval` in a browser is
a `Window` method; stored on an instance field and called as `this.fn(...)` its
receiver is wrong and Chrome throws, while node's timers do not check theirs. The
whole coverage package's unit tests were green against a scheduler that could not
start a single timer in the app — and the throw, from inside an effect, unmounted
the React root and left /lecture/[id] blank. Anything torn off `window` needs a
browser to be tested at all; that is the gap this harness exists to close.

---

## Layout

```
run.mjs                 CLI: discovers scenarios, manages dev servers and the browser,
                        prints the PASS/FAIL table, exits non-zero on any failure
lib/browser.mjs         chromium launch (system Chrome), context defaults, dev-portal hiding
lib/dev-server.mjs      per-app dev servers: reuse if the port already serves, else spawn
lib/mock-api.mjs        route-interception layer: mock table, logged catch-all, third-party
                        blocking, dev-chunk rewriting, captureRequest, nothing-escaped check
lib/stub-api.mjs        the SSR-mode stub bound to the app's NEXT_PUBLIC_API origin
lib/assets.mjs          dependency-free PNG encoder + a loopback static host
lib/media.mjs           ffmpeg-built MP4 fixture (cached outside the repo) + a RANGE-aware host
lib/auth.mjs            per-app session seeding (cookie + localStorage) and the JWT generator
lib/asserts.mjs         Check, figure decode/geometry, document-order, click reachability
scenarios/*.mjs         one file per scenario — fixtures and assertions together
```

No scenarios are checked in yet (the monorepo's were not carried over); `scenarios/` is created
when the first one lands.

`node tools/uitest/run.mjs --list` is the authoritative list.

---

## Writing a new scenario

Drop a file in `scenarios/`. It is discovered automatically.

```js
export const name = 'my-scenario';          // defaults to the filename
export const title = 'what it proves';
export const app = 'web';                   // key in APPS in lib/dev-server.mjs
export const warmup = [['web', '/student']]; // optional: compile a route first

export async function run(ctx) {
  const check = ctx.surface('the thing under test');
  const context = await newContext(ctx.browser);

  await seedAuth(context, 'study');
  const mock = createMockApi({ appOrigin: ctx.app.origin, routes: { 'GET /student/x': payload } });
  const save = mock.captureRequest('POST /student/x');

  await mock.install(context);
  const page = await context.newPage();

  await page.goto(`${ctx.app.origin}/student/x`);
  check.eq('what the server was told', save.last?.field, 'expected');
  await ctx.shot(page, '01-after-save');
  await context.close();
}
```

`ctx` gives you `browser`, `app` / `apps`, `surface(label)`, `shot(page, name)`,
`write(name, data)`, `out`, `log`, and `env`. Every `ctx.surface()` is one row in
the report; a surface with no failures passes.

Two rules worth keeping:

- **Assert the absence case too.** Every scenario here carries a question with no
  `image` key, because "the figure renders" and "a figure renders on the question
  that has none" are different assertions and only the second catches a leak.
- **Assert what leaves the browser**, not only what arrives. `captureRequest` is
  the cheapest coverage in this harness.

---

## The gate

Before shipping a change, run the scenarios that cover the surfaces you touched,
and get them green — alongside `npx tsc --noEmit`. `tsc` proves the types line
up; uitest proves the pixels and the payloads do. Neither substitutes for the
other, and lint is not a substitute for either (see the footgun above).

If a scenario disagrees with code you just fixed, the code is right — update the
scenario's expectation and say so in the commit.
