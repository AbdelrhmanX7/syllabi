# syntax=docker/dockerfile:1.7
#
# Syllabi server image. Build from the REPO ROOT (the pnpm lockfile lives there):
#   docker build -f apps/server/Dockerfile -t syllabi-server .
# or just `docker compose up -d` from apps/server (see docker-compose.yml).
#
# Targets:
#   runtime (default)  the API with every tool it shells out to, except docker.
#   runtime-code       runtime + the docker CLI, for CODE_EXEC_ENABLED=true (see README: needs
#                      the host docker socket, which is root-equivalent on the host).

ARG NODE_VERSION=22

# ─── base: node + pnpm ───────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    PUPPETEER_SKIP_DOWNLOAD=true \
    CI=true
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /repo

# ─── deps: production node_modules only ──────────────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @syllabi/server...

# ─── build: compile TypeScript ───────────────────────────────────────────────────────────
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @syllabi/server...
COPY apps/server/ apps/server/
RUN pnpm --filter @syllabi/server build

# ─── runtime ─────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS app

# External programs the server runs (child_process / puppeteer):
#   poppler-utils         pdftoppm, pdftotext (PDF pages, text, syllabus parsing)
#   ffmpeg                ffmpeg, ffprobe (lectures, dictation, video)
#   libreoffice-*-nogui   soffice: office documents -> PDF
#   chromium              puppeteer: notebook page renders, lecture PDFs
#   python3 + libheif1    HEIC photo decoding (ctypes into libheif; bookworm's build links libde265)
#   yt-dlp                video transcripts (downloaded below; needs python3)
#   fonts-*               text in rendered PDFs/pages, incl. non-Latin fallbacks
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates tini \
      poppler-utils ffmpeg \
      libreoffice-writer-nogui libreoffice-impress-nogui libreoffice-calc-nogui \
      chromium \
      python3 libheif1 \
      fonts-dejavu-core fonts-liberation fonts-noto-core fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*

ADD --chmod=755 https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp /usr/local/bin/yt-dlp

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5000 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /repo/apps/server/dist ./apps/server/dist
COPY apps/server/package.json ./apps/server/package.json
COPY apps/server/assets ./apps/server/assets

# Assets resolve from the working directory, so run from apps/server.
WORKDIR /repo/apps/server
RUN mkdir -p public/files && chown -R node:node public
USER node

EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]

# ─── runtime-code: + docker CLI for the code runner ──────────────────────────────────────
FROM app AS runtime-code
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker

# ─── runtime (default target) ────────────────────────────────────────────────────────────
FROM app AS runtime
