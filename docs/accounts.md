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

## Sharing and collaboration (after accounts)

Share study material the way Google Docs shares a document. What can be shared: a notebook (pages and ink), a
flashcard deck, a question set, a concept map, a whole class's material.

1. **Share and fork.** Share with people by email or with a link, as *viewer*, *commenter* or *editor*. Anyone
   who can view can **fork** (make their own copy in their account, keeping a "forked from" link). A
   `Share` model holds `{resourceType, resourceId, ownerId, grants: [{userId|email, role}], link: {role|null,
   token}}`; every study read and write checks ownership or a grant. "Shared with me" lists what others shared.
2. **Edits and history.** Editors change the shared original; every change records who made it. Version
   history lets the owner see and restore earlier versions; comments on pages and cards.
3. **Live co-editing.** Several people on the same notebook page or deck at once, seeing each other's ink and
   cursors live (CRDT over WebSockets, e.g. Yjs), with offline edits merging when a device reconnects.

## Hosting (needs a decision)

The hosted server and the public web app need a home: a server for the API + MongoDB + Redis + object storage,
and static hosting for the web app (for example `app.syllabi.studio`). Never on the maintainer's personal PC.
