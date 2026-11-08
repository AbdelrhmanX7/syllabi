# Accounts: sign up once, reach your data from any device

Goal: a student creates an account and their data follows them to the Android tablet, a phone browser, a
laptop or a Mac. One hosted server (run by the project at syllabi.studio) stores every account; self-hosters can
keep a private single-owner server or open it up too.

## Model

- One server, many accounts. Study data is already scoped by `userId` everywhere; the account row (the `Admin`
  model) gains a role: `owner` (runs the server; the old `admin` role maps to it) or `user`.
- `REGISTRATION=open|closed` (default `closed`). Closed keeps today's single-owner behaviour: first-run setup,
  env seed or CLI. Open lets anyone register. The hosted server runs open.
- Clients: the web app (`apps/study` static export) served at a public URL, so it works in any browser (phone,
  computer, Mac, iPad); the Android APK (Tauri); both point at the hosted server by default, and either can
  switch to another server in Settings.

## Sign-in methods

Email + password, magic link (email), Google. Every email link uses a single-use random token, stored hashed
with an expiry (verify: 48 h, magic link: 15 min, reset: 1 h).

## Server API (`/auth`, JSON; the session token is the same 30-day HS256 JWT the app already uses)

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/auth/config` | – | `{registration, google, magicLink, emailVerification}`: which options the server offers |
| POST | `/auth/register` | `{name?, email, password}` | `201 {token, user}`; sends a verification email |
| POST | `/auth/login` | `{email, password}` | `{token, user}`; `400 {message}` on bad credentials |
| POST | `/auth/verify-email` | `{token}` | `{token, user}` (marks verified) |
| POST | `/auth/resend-verification` | Bearer | `{message}` |
| POST | `/auth/magic-link` | `{email, redirect?}` | always `200 {message}` (no account enumeration) |
| POST | `/auth/magic-link/consume` | `{token}` | `{token, user}`; creates the account when registration is open |
| POST | `/auth/forgot-password` | `{email}` | always `200 {message}` |
| POST | `/auth/reset-password` | `{token, password}` | `{token, user}` |
| GET | `/auth/google/start?redirect=` | – | 302 to Google (server-side OAuth code flow) |
| GET | `/auth/google/callback` | – | 302 to `redirect#token=<jwt>`; `redirect` must be the app URL or the `studio.syllabi.app://` scheme |
| GET | `/auth/me` | Bearer | `{user}` |
| POST | `/auth/me/password` | Bearer `{currentPassword?, newPassword}` | `{message}` (current password optional for accounts with no password, e.g. Google-only) |
| DELETE | `/auth/me` | Bearer `{password?}` | deletes the account and all its data and files |

`user` = `{_id, name, email, role, isVerified, providers: ('password'|'google'|'magic')[], createdAt}`.
The existing `/admin/login`, `/admin/me`, `/admin/setup` stay for older app builds.

Rules: AI endpoints (anything under `/study/ai`, tutor, extraction) need a verified email
(`403 {code: 'EMAIL_NOT_VERIFIED'}`); everything else works right away. Rate limits per IP and per email on
register, login, magic link and forgot password. Email goes out through Resend (`RESEND_API_KEY`) or SMTP
(`SMTP_URL`); with neither set, links are written to the server log (development). Links point at `APP_URL`
(`/auth/verify/?token=`, `/auth/magic/?token=`, `/auth/reset/?token=`, `/auth/callback/#token=`).

## App

- `/login`: Sign in | Create account, email + password, "Continue with Google", "Email me a sign-in link",
  "Forgot password?". Options come from `/auth/config`; an old server without it falls back to `/admin/login`.
- `/auth/verify`, `/auth/magic`, `/auth/reset`, `/auth/callback` finish the email and Google flows.
- Settings → Account: email and verification status, change password, sign out, delete account (confirm modal).
- Demo mode shows "Create an account to keep your data".
- On the APK, Google sign-in opens the system browser and returns through the `studio.syllabi.app://auth`
  deep link (Google blocks OAuth inside embedded WebViews).
- Phone-width layout (bottom navigation instead of the side rail) so the web app is usable on phones.

## Sharing and collaboration

Share study material the way Google Docs shares a document. What can be shared: a notebook (pages and ink), a
flashcard deck, a question set, a concept map. (A whole class's material: later.)

### Phase 1: share read-only + make a copy (shipped)

Code: `apps/server/src/routes/share.ts` (routes), `src/services/share/access.ts` (who may read/write, one helper:
`canAccess(caller, resource, 'read' | 'write')`), `src/services/share/resources.ts` (per type: ownership, title,
snapshot, deep copy), `src/models/share.ts`. App: `apps/study/features/share` (sheet, `/shared` page, demo mock).

**What a resource is.** Two of the four have no model of their own, so they are scoped queries:

| Type | Stored as | `resourceId` |
| --- | --- | --- |
| `notebook` | one `StudyPage` row; board JSON in object storage | page id |
| `deck` | the class's `StudyQuestion` rows tagged `flashcard` (+ `topic`) | class id (+ `topic`) |
| `questions` | the class's other `StudyQuestion` rows (+ `topic`; none = whole class) | class id (+ `topic`) |
| `conceptMap` | one `StudyConceptMap` row: its terms, lecture and week | map id |

**Model.** `Share {resourceType, resourceId, topic, ownerId, title, grants: [{userId|null, email, role, addedAt}],
link: {token, role} | null}`, collection `shares`, one row per resource (unique on owner + type + id + topic).
`role` is `viewer | editor` (editor: phase 2 part A below); the link is always `viewer`. The link token is 32 random bytes (base64url),
stored as is so the owner can copy the link again; turning the link off and on makes a new one. Copies record
where they came from in `study_share_forks {userId, resourceType, resourceId, topic, forkedFrom: {shareId,
ownerName, title, resourceType, resourceId}}` (the app shows "Copied from Maya's Membranes").

**API** (Bearer; mounted at `/share` and `/study/share`, since the app's transport puts live routes under `/study`):

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| POST | `/share` | `{resourceType, resourceId, topic?, emails?, link?}` | `201 {share}`; owner only; a second POST adds to the same share |
| GET | `/share/mine?resourceType&resourceId&topic?` | – | `{share \| null}` (people + link) |
| PATCH | `/share/:id` | `{addEmails?, removeEmails?, link?: boolean}` | `{share}`; owner only |
| DELETE | `/share/:id` | – | `204`; stop sharing (owner only) |
| GET | `/share/with-me` | – | `{items: [{id, resourceType, title, ownerName, role, sharedAt, updatedAt}]}` |
| GET | `/share/forks` | – | `{items}`: where my copies came from |
| GET | `/share/view/:idOrToken` | – | `{share, content}`: read-only snapshot |
| POST | `/share/fork/:idOrToken` | – | `201 {resourceType, resourceId, topic, classId}`: deep copy into my account |

**Rules.**
- Every call needs a signed-in account, a link included (the app shows a sign-in prompt and comes back to
  `/shared/?id=…` after signing in). `:idOrToken` is a 24-hex share id (owner or grant) or a 43-char link token.
- A grant by email matches only a **verified** address (anyone can register an unverified account with any
  address); on the first verified match the grant is pinned to that account. Strangers get `404`, never "exists
  but not yours". A deleted resource disappears from "Shared with me" and its links stop working.
- Adding people sends "X shared a notebook with you" (branded template, an Open button to `APP_URL/shared/?id=`),
  needs a verified email, and is limited (20 addresses per call, 50 people per share, 100 invites a day per
  account). Writes, views and copies have per-account rate limits too.
- The snapshot never carries progress, grades or Canvas data: questions come with fresh stats and schedule and no
  links into the owner's material; a concept map shares its terms, lecture and week only (no score, submission or
  instructor notes).
- A copy is independent of the original: new ids, the notebook's board JSON copied under the caller's own storage
  prefix (so deleting the owner's account never breaks it), questions with fresh progress. Questions and concept
  maps land in the caller's class with the same name, or a new manual class with that name. A copied concept map is
  a practice map. Question images stay references to their public URL.
- Known gaps: PDF backgrounds of a notebook live on the owner's device and do not travel with a share (ink and
  paper do). Deleting an account removes the shares it owns and every grant naming it.

### Phase 2, part A: "Can edit" (shipped)

Invited people can be **editors** who change the original. Code: `src/services/share/edit.ts` (the per-type
lookups + the rules), the study controllers it plugs into, `features/share` in the app.

**Roles.** `POST /share` and `PATCH /share/:id` take `emails` / `addEmails` entries as an address (gets the body's
`role`, default `viewer`) or `{email, role}`; `PATCH {roles: [{email, role}]}` changes someone's access. Only named
people with a verified email can edit; the link stays view-only. An editor's invite says "X invited you to edit a
notebook". `with-me` and `view` return the caller's real `role`; `view` adds `resourceId` / `topic` for editors
(the ids the study routes take) and `editedBy`.

**How writes work.** The study write routes look the row up by id alone. The owner takes the old path unchanged;
anyone else needs `canAccess(caller, resource, 'write')` on that one resource (deck / question rows: a share of
the row's class with its topic or the whole class, of the right kind: cards vs other questions). The write then
runs with the owner's id, limited to that row. Strangers, viewers and link holders get the same `404` as a missing
row; removing someone or lowering them to viewer stops their writes on the next request.

| Type | An editor may | Never |
| --- | --- | --- |
| notebook | `GET /pages/:id` (+ `shared: {role, ownerName}`, no class links), `GET/PUT content`, `PUT content/blob`, `POST content/commit`, `PUT ocr`; versions land under the owner's storage prefix | rename / file (`PATCH`), delete, renders, rulers, annotations, earlier versions |
| deck, questions | `PATCH /questions/:id` (stem, answer, choices, pairs, steps, subtopic, difficulty, type), `DELETE`, `POST /questions` into the shared class (a plain insert, fresh progress, no source links) | stats, schedule (attempt / similar stay owner-only), class, topic, image, the flashcard tag (`403`) |
| conceptMap | `PATCH /concept-maps/:id {promptTerms}` | score, notes pages (`403`), submission, grade fields |

Editors get the shared shapes back (questions without progress, a map without score).

**Who changed what.** `editedBy {userId, name, at}` on pages, questions and concept maps (an owner write clears it
on questions and maps; a page keeps the last committer and shows "Edited by" only when that is not the owner).
Page versions are immutable objects, so each commit also appends `{version, userId, name, at, restoredFrom}` to the
page's `versionLog` (last 100). The owner's **Earlier versions** (history button on the board):
`GET /pages/:id/versions?before=` lists 30 at a time with authors (null for versions before the log or written
by the AI drawing tools); `POST /pages/:id/versions/:v/restore {baseVersion}` copies that version into a new one
(nothing is overwritten; `409` when stale, `404` when that version is no longer stored). The app confirms first.

**App.** Share sheet: a Can view / Can edit picker for new people and per person; lowering or removing confirms.
"Shared with me" shows Can edit / Can view and "edited by". Editors edit cards and questions (edit, add, delete
with a confirm) and concept-map terms right on the shared page, and open a notebook on the board ("Open to
edit"), which saves to the original; editing at the same time is part B below. Viewers keep
the read-only view. The demo mock shares its deck and concept map as editable.

### Phase 2, part B: editing at the same time (shipped for notebook pages)

When the owner and the people with "Can edit" have the same notebook page open, each person's ink shows up
for the others within a second or two, changes merge quietly (no "keep mine / keep theirs" on a shared page),
and a small "Maya is here too" chip on the board says who else is there (a first name in text, no picture).
Code: server `src/services/share/live-merge.ts` (the merge), `src/services/study/page-live.ts` (lock, channel,
presence), `src/controllers/study-page-live.controller.ts` (routes); app `lib/notebooks/live-merge.ts` (same
merge, kept in step, same tests), `lib/notebooks/live.ts` (the session), `lib/notebooks/live-api.ts`,
`components/notebook/NotebookBoard.tsx`; editor `utils/itemIds.ts` and `WhiteboardEditor`'s `liveBoardRef`.

**Item ids.** Every board object (stroke, text box, image, shape) carries a stable `oid` in the page JSON. The
editor gives a new object a random id when it is added; a copy (paste, duplicate, a split eraser piece) gets a
fresh one while its source is still on the board; undo puts an object back with the id it had. The object eraser
removes by id; lasso move changes the object in place (same id). Objects saved before ids existed get an id
derived from their own JSON (a hash of page id + object JSON, `.n` for the n-th identical twin), computed the
same way by the app and the server, so old pages need no migration and two devices never name an old stroke
differently. Pages within a board are `pages[]` with their own ids; paper style (`backgroundType`,
`paperSpacingMm`) and the PDF fields are page fields.

**Merge.** Per item, no new library. A change is a set of ops, found by comparing the board on screen with the
version the device last had: page records added or changed, page ids removed, the page order, and per page
`put` (whole objects) / `del` (ids). Per-device fields (scroll, zoom, preview) never travel. The server applies
ops to its CURRENT version, so arrival order decides: the last change to an item wins; a deleted item stays
deleted unless someone puts it back later (an undo). A device never lets someone else's change overwrite an item
it changed and has not sent yet: that item goes out next and, arriving later, wins. Page add / remove / reorder
merge the same way (a page someone else added stays after the page it followed).

**Transport.** No WebSockets. The existing study SSE framing over a plain GET (signed in with the normal
`Authorization` header, which `fetch` streams can send), plus normal POSTs:

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| POST | `/study/pages/:id/live` | `{clientId, ops}` | `{prevVersion, version}`; ops sent to everyone else |
| GET | `/study/pages/:id/live/stream?clientId=` | – | SSE: `hello {version, people}`, `ops {prevVersion, version, ops, by}`, `presence {people}`; ends with `error {code: ACCESS_REVOKED}` |
| GET | `/study/pages/:id/content?version=N` | – | `{url, version}`: an earlier stored version |

`GET /pages/:id` adds `live: true` when someone besides the owner may edit the page; the app then uses the live
path for it. A batch goes out ~300 ms after a stroke ends (strokes finished meanwhile ride along), never pen
point by pen point; no live pen preview. Each push becomes a normal stored version (so restore and the version
log keep working) and is published on Redis channel `study:page:<pageId>`, which every API fork
pattern-subscribes (the inbox bus pattern), so the shared web server needs no change. A whole-board save, a
restore and the AI drawing tools publish `ops: null` ("re-read the page"); so do pushes over 256 KB (a photo).
Each device keeps a base version: an event whose `prevVersion` is its base moves the base along and goes on
screen item by item (no reload, the page's undo history restarts there); a gap re-reads the board once. A page
added, removed or moved by someone else reloads the editor on the merged board.

**Saves at the same moment.** Every write of page content (live pushes, whole-board saves, restore) runs under a
per-page lock: in-process chain + Redis `SET NX PX` (30 s) across forks, then the version compare-and-set (up to
3 retries for pushes). Holding the lock, a writer stores the usual `v<n+1>.json`. When it could not get the lock
(Redis down, or busy past 4 s) it writes a key of its own (`v<n+1>-<uuid>.json`, recorded in the version log), so
a racing fork can never overwrite the bytes the winning commit points at. This also fixes an older race where two
whole-board saves on the same version both wrote the `v<n+1>` object and the winner could point at the loser's
bytes. The older two-step save (signed upload, then commit) still writes `v<n+1>.json` directly and is not
covered; the app tries the one-step save first.

**Opening a page with edits made offline.** The device merges three-way: its edits since the version it last
had (read back with `content?version=`) onto the current version. A page that becomes shared while open
switches to the live path on its first conflicting save instead of showing the conflict prompt.

**Presence.** A Redis hash per page (one entry per open stream, refreshed on the 10 s ping, stale after 35 s),
with a per-fork local copy when Redis is down; joins and leaves are published. "Is here too" leaves out the
viewer's own devices.

**Access.** Only the owner and named editors can push or open the stream; viewers keep the read-only share view
(no live updates for them), strangers and link holders get `404`. Every push re-checks access. Changing or
removing people on a notebook share, stopping the share or deleting the page publishes a revoke: each open
stream re-checks at once and ends with `ACCESS_REVOKED` (and every 30 s as a backstop); the app stops sending
and keeps the person's unsent changes on their tablet.

**Gaps.**
- Every push is a stored version and a log entry: an hour of live writing can mean many versions (storage
  grows; the 100-entry author log covers minutes). The live path is used only on pages with editors.
- Someone else's change restarts undo for that page (undoing past it would delete their ink).
- A page add / remove / reorder by someone else reloads the editor (your view goes back to where the page opens).
- Item z-order changes (bring to front) do not travel; new items go on top.
- A device that changes the same item at the same moment as another may see a brief jump before the later
  write wins. PDF backgrounds still live on the importing device (ink and paper travel).
- Old app versions keep the whole-board save path; on a page someone edits live they still get the conflict
  prompt.
- Still TODO: comments on pages and cards; live co-editing of decks and question sets (they save per card).

## Hosting (needs a decision)

The hosted server and the public web app need a home: a server for the API + MongoDB + Redis + object storage,
and static hosting for the web app (for example `app.syllabi.studio`). Never on the maintainer's personal PC.
