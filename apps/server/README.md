# Syllabi server

The self-hostable backend for the Syllabi app. It serves the `/study` API the app calls
(classes, Canvas sync, notebooks, question bank, lectures, concept maps, code lab, phone inbox,
AI tutor) plus `/auth` for accounts (and `/admin`, the owner sign-in older app builds use).

Stack: Node 22, Express, MongoDB (Mongoose), Redis, any S3-compatible object store, an
OpenAI-compatible text model (DeepSeek by default) and, optionally, OpenRouter for vision and speech.

## Quick start with Docker Compose

The compose stack runs the API, MongoDB (single-node replica set), Redis and MinIO.

```bash
cd apps/server
cp .env.example .env
# edit .env and set at least:
#   JWT_SECRET=<openssl rand -hex 32>
#   MINIO_ROOT_PASSWORD=<openssl rand -hex 24>
#   ADMIN_EMAIL=you@example.com  ADMIN_PASSWORD=<8+ chars>   (creates the owner on first boot)
#   DEEPSEEK_API_KEY=...          OPENROUTER_API_KEY=...      (AI features)
docker compose up -d --build
curl http://127.0.0.1:5000/health     # {"status":"ok"}
```

What gets exposed:

- **API**: published on `127.0.0.1:5000` only, so it is reachable from this machine and nothing else.
- **MongoDB, Redis, MinIO**: no published ports. They are reachable only inside the compose network.
- **Files**: MinIO stays private. The API streams every upload and download itself
  (`STORAGE_PROXY=true`), so the bucket needs no public URL and no CORS setup.

To use the server from a tablet or phone, put a TLS reverse proxy (Caddy, nginx, Traefik, a
tunnel you control) in front of `127.0.0.1:5000`. Then set `PUBLIC_BASE_URL` to the origin the
device uses, e.g. `https://syllabi.example.com`. File URLs are built from that value, so it has
to be right.

The image is large (about 1.5 GB) because it bundles LibreOffice, Chromium, ffmpeg and poppler.

### Creating the owner account

Every server has an **owner**: the account that runs it. By default (`REGISTRATION=closed`)
the owner is the only account, and nobody else can sign up. The owner account is created once,
by the first of these to happen:

1. **Env at boot**: `ADMIN_EMAIL` plus `ADMIN_PASSWORD`. These values only create the account.
   A later restart never re-applies them. You sign in (in the app and on the MCP consent page)
   with that email and password.
2. **First-run screen in the app** (`POST /admin/setup`). Inside a container a request is never
   from loopback, so set `SETUP_TOKEN` in `.env` and enter it in the app.
3. **CLI**:
   ```bash
   docker compose exec server node dist/auth/cli.js create --email you@example.com
   docker compose exec server node dist/auth/cli.js reset-password
   ```
   Without Docker, run `pnpm owner create ...` from `apps/server`.

### Letting other people sign up

Set `REGISTRATION=open` to let anyone create an account on your server. Each account gets its
own classes, notebooks and question bank (all study data is stored per account), and can sign
in with email + password, an emailed sign-in link, or Google. New accounts can use everything
right away, except the AI features, which wait until the email address is confirmed.

| Variable | Purpose |
| --- | --- |
| `REGISTRATION` | `open` or `closed` (default `closed`) |
| `APP_URL` | public URL of the web app; email links and the Google return point at it |
| `RESEND_API_KEY` or `SMTP_URL` | sends the verify / sign-in / reset emails. With neither, links are printed to the server log (development) |
| `MAIL_FROM` | sender address |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | "Continue with Google"; the OAuth client's redirect URI is `<PUBLIC_BASE_URL>/auth/google/callback` |

Accounts can delete themselves (with all their data and files) from the app. The last owner
account cannot be deleted. The API is described in `docs/accounts.md` at the repo root.

### Pointing the app at the server

Enter the server URL in the app's Settings, or build the app with `NEXT_PUBLIC_API=<url>`
(see `apps/study/.env.example`). The app calls `<url>/study/...`, `<url>/auth/...` and `<url>/admin/...`.

## Running without Docker

You need Node 22, pnpm 10, MongoDB 7 and, optionally, Redis.

```bash
pnpm install                       # from the repo root
cd apps/server
cp .env.example .env               # set JWT_SECRET; STORAGE_DRIVER=local keeps files on disk
pnpm dev                           # http://127.0.0.1:5000
# production build
pnpm build && pnpm start
```

Smoke test a running server (signs in, creates and deletes a class and a page, and hits one GET
under every `/study` prefix; exits 1 on any 5xx or unexpected 404):

```bash
SMOKE_BASE_URL=http://127.0.0.1:5000 SMOKE_LOGIN=you@example.com SMOKE_PASSWORD=... pnpm smoke
```

Always start the server from `apps/server`, because fonts and the render bundle are resolved
from the working directory.

Features that call external programs need those programs on `PATH`. The Docker image installs
all of them:

| Program | Package (Debian/Ubuntu) | Used for |
| --- | --- | --- |
| `pdftoppm`, `pdftotext` | `poppler-utils` | PDF pages and text, syllabus parsing |
| `ffmpeg`, `ffprobe` | `ffmpeg` | lectures, dictation, video |
| `soffice` | `libreoffice-{writer,impress,calc}-nogui` | Office documents to PDF |
| Chromium | `chromium` (set `PUPPETEER_EXECUTABLE_PATH`) | notebook page renders, lecture PDFs |
| `python3` + libheif | `python3 libheif1` | HEIC photos from phones |
| `yt-dlp` | upstream release | video transcripts |
| `docker` | Docker CLI | code runner only, off by default |

MongoDB has to be a replica set (one node is enough) for library import and index maintenance,
because those use transactions: `mongod --replSet rs0`, then `rs.initiate()` once.

## Storage

There are three modes. All of them are configured in `.env`; see `.env.example` for every variable.

| Mode | Settings | Reads/uploads go to |
| --- | --- | --- |
| local | `STORAGE_DRIVER=local` (default outside production) | disk under `LOCAL_STORAGE_DIR`, served at `/files` |
| proxy | `STORAGE_DRIVER=s3`, `STORAGE_PROXY=true` | this server: signed `/objects/<key>` GETs (with HTTP Range) and `PUT /study/dev-upload/<key>` |
| direct | `STORAGE_DRIVER=s3`, `STORAGE_PROXY=false` | the bucket, through presigned URLs |

- **Which S3 stores work**: any S3-compatible one (MinIO, AWS S3, Cloudflare R2, Garage, and others).
  Set `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and
  `S3_FORCE_PATH_STYLE`. Path-style defaults to `true`, which MinIO needs.
- **Direct mode**: the device has to reach the bucket, and the bucket must allow CORS `GET` and
  `PUT` from the app. If the server reaches the store at an internal address (for example
  `http://minio:9000`), set `S3_PRESIGN_ENDPOINT` to the public address. URLs have to be signed
  for the host the device actually uses.
- **Proxy mode is the default** whenever `S3_ENDPOINT` is set and `S3_PRESIGN_ENDPOINT` is not.
- **Signed URLs** last one hour and are bound to a single key. They are HMAC-signed with
  `JWT_SECRET` in local/proxy mode and SigV4-signed in direct mode.
- **Question images** must never expire, so they get a plain URL with a random uuid in the name.
  It comes from `S3_PUBLIC_URL` if set (a public bucket or CDN), and from this server otherwise.

## Code runner (off by default)

The code lab can compile and run C++ (`POST /study/code/run`). Each run happens in a
throwaway `gcc:14` container with no network, a read-only filesystem and memory/pid limits.
This is **disabled unless `CODE_EXEC_ENABLED=true`**. While it is off, the endpoint returns
`503 CODE_EXEC_DISABLED` and the server never pulls the image.

Enabling it means the server must control a Docker daemon. In Docker Compose:

```bash
DOCKER_GID=$(stat -c %g /var/run/docker.sock) \
  docker compose -f docker-compose.yml -f docker-compose.code-exec.yml up -d --build
```

**Risk:** that override mounts `/var/run/docker.sock` into the API container. Anything that can
use the Docker socket can start privileged containers and mount the host filesystem, which makes
it **root-equivalent on the host**. Code is submitted by whoever is signed in, which on a server
with `REGISTRATION=open` means anyone who registers: never combine the two. The sandbox flags
limit what the submitted program itself can do. They do not protect the host from a compromised
API process. Only enable this on a machine you would trust with that level of access, and use a
strong owner password. A rootless Docker daemon or a dedicated VM lowers the impact.

## Background work

By default the API process also runs everything in the background:

- Canvas sync every 30 minutes (`STUDY_CANVAS_SYNC_CRON`)
- lecture and video transcript jobs
- summaries

To move that work out of the API, set `RUN_WORKER_IN_PROCESS=false` and run one
`node dist/worker.js` (`pnpm worker`) with the same env.

## Security notes

- **Binding**: the server binds `127.0.0.1` unless `HOST` says otherwise. Compose binds `0.0.0.0`
  inside the container but publishes only on `127.0.0.1`.
- **Internal services**: MongoDB and Redis run without auth inside the compose network. Do not
  publish their ports.
- **`JWT_SECRET`** signs sessions and file URLs, and is the key for the stored Canvas token.
  Rotating it signs everyone out and makes the stored Canvas token unreadable, so you have to
  reconnect Canvas.
- **CORS** is open (the app runs in a WebView at varying origins). Requests authenticate with a
  Bearer token, not cookies.
