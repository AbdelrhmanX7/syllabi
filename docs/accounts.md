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
`role` is `viewer | editor`; phase 1 hands out only `viewer`. The link token is 32 random bytes (base64url),
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

### Phase 2: editing together (next)

TODO, not built yet:
- **Editor and commenter roles.** The role field already allows `editor`; `canAccess(..., 'write')` is the one
  check every study write route adopts (today they check plain ownership). Editors change the original; every change
  records who made it. Comments on pages and cards.
- **Live co-editing.** Several people on the same notebook page or deck at once: Yjs CRDT documents over WebSockets
  (notebook ink as a Y.Array of strokes per board page, deck / question edits as Y.Maps), presence (who is here,
  cursors and the pen position) via the Yjs awareness protocol, and offline edits on a tablet merging when it
  reconnects (Yjs updates queued in IndexedDB). The server keeps the merged document and still writes the board
  JSON snapshot, so viewers, copies and the MCP keep working.
- **Version history.** The owner sees and restores earlier versions (page versions are already immutable objects).

## Hosting (needs a decision)

The hosted server and the public web app need a home: a server for the API + MongoDB + Redis + object storage,
and static hosting for the web app (for example `app.syllabi.studio`). Never on the maintainer's personal PC.
