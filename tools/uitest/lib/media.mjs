/**
 * Video fixtures — a real, playable MP4 plus a range-aware loopback host.
 *
 * The sibling of `assets.mjs`, and for the same reason: watch-coverage is credited by DWELL,
 * so nothing short of media time genuinely flowing through a real decoder exercises it. A
 * `data:` URI, a stubbed `<video>` shim, or a fake `currentTime` all move the playhead without
 * ever entering the code path the feature is about — the accumulator explicitly refuses credit
 * for a jump it did not watch happen.
 *
 * ⚠️ THIS ONE IS NOT DEPENDENCY-FREE. `assets.mjs` can encode a PNG by hand; an H.264 MP4 is
 * another matter, so the clip is built with the system `ffmpeg` and CACHED OUTSIDE THE REPO
 * (see `MEDIA_CACHE`) — the encode costs ~150ms once and nothing on every run after. A machine
 * without ffmpeg gets a named error from `ensureCoverageVideo`, which the scenario turns into
 * one clear skip note rather than twenty timeouts.
 *
 * ⚠️ RANGE REQUESTS ARE LOAD-BEARING. Chrome seeks by asking for a byte range; a 200-only host
 * makes a seek either refetch the whole file or silently do nothing, and "the student seeked
 * forward" is half of what the gap scenario is testing.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/** Outside the repo, on purpose — a run must leave the working tree untouched. */
export const MEDIA_CACHE = path.join(os.tmpdir(), 'ka-uitest-media');

const MIME = {
  '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment',
  '.png': 'image/png',
  '.json': 'application/json',
};

const run = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${cmd} failed: ${String(stderr || error.message).split('\n').slice(-3).join(' ')}`));

        return;
      }
      resolve({ stdout, stderr });
    });
  });

/**
 * The two encodes, in preference order.
 *
 * The first burns a running second-count into the frame, which is what makes a screenshot of
 * the player worth looking at — you can see WHERE the playhead was when the bar was painted.
 * It needs a font through fontconfig, which not every box has, so a flat colour is kept behind
 * it: bigger loss for a human reading the artifacts, no loss at all for the assertions.
 */
const RECIPES = [
  {
    label: 'counter',
    filter:
      "color=c=0x14203c:s=320x180:r=10,drawtext=text='%{eif\\:t\\:d}s':fontcolor=0xffd166:fontsize=64:x=(w-tw)/2:y=(h-th)/2",
  },
  { label: 'flat', filter: 'color=c=0x14203c:s=320x180:r=10' },
];

/**
 * A silent H.264 clip of `seconds` seconds, generated once and cached.
 *
 * SILENT deliberately: an audio track buys nothing here and costs a headless browser an audio
 * device it may not have.
 *
 * @returns {Promise<{path:string, bytes:Buffer, seconds:number, recipe:string}>}
 */
export async function ensureCoverageVideo({ seconds = 120, ffmpeg = process.env.UITEST_FFMPEG || 'ffmpeg' } = {}) {
  fs.mkdirSync(MEDIA_CACHE, { recursive: true });

  const file = path.join(MEDIA_CACHE, `coverage-${seconds}s.mp4`);
  const stampFile = `${file}.recipe`;

  if (fs.existsSync(file) && fs.statSync(file).size > 1024) {
    return {
      path: file,
      bytes: fs.readFileSync(file),
      seconds,
      recipe: fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8') : 'cached',
    };
  }

  const failures = [];

  for (const recipe of RECIPES) {
    try {
      await run(ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        recipe.filter,
        '-t',
        String(seconds),
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-pix_fmt',
        'yuv420p',
        // A keyframe every 2s: seeking lands close to the requested time instead of rewinding
        // to a distant IDR, which would credit buckets the scenario never asked for.
        '-g',
        '20',
        '-an',
        '-movflags',
        '+faststart',
        file,
      ]);

      if (!fs.existsSync(file) || fs.statSync(file).size < 1024) throw new Error('produced no usable file');

      fs.writeFileSync(stampFile, recipe.label, 'utf8');

      return { path: file, bytes: fs.readFileSync(file), seconds, recipe: recipe.label };
    } catch (error) {
      failures.push(`${recipe.label}: ${String(error.message).slice(0, 160)}`);
    }
  }

  throw new Error(
    `could not build the ${seconds}s coverage clip — no usable ffmpeg. Install it, or point ` +
      `UITEST_FFMPEG at one. Tried: ${failures.join(' | ')}`,
  );
}

/**
 * Serve a `{ '/clip.mp4': Buffer }` table on loopback, honouring `Range`.
 *
 * Port 0: the OS picks a free one and the caller builds URLs from the returned origin, so two
 * runs never collide — and nothing here can drift onto :3000, which is reserved on this machine.
 */
export async function startMediaHost(files, { port = 0, host = '127.0.0.1' } = {}) {
  const hits = [];
  const ranges = [];

  const server = http.createServer((req, res) => {
    const key = (req.url || '').split('?')[0];
    const body = files[key];

    hits.push(`${req.method} ${key}`);

    if (!body) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('no such media');

      return;
    }

    const type = MIME[path.extname(key)] || 'application/octet-stream';
    // The app origin is not this origin, so a media request is cross-origin — without CORS the
    // element still plays but is "tainted", and a tainted element is a different code path.
    const common = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    };

    if (req.method === 'HEAD') {
      res.writeHead(200, { ...common, 'Content-Length': body.length }).end();

      return;
    }

    const match = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');

    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;

      if (!(start >= 0 && start <= end && end < body.length)) {
        res.writeHead(416, { ...common, 'Content-Range': `bytes */${body.length}` }).end();

        return;
      }

      ranges.push(`${start}-${end}`);
      res
        .writeHead(206, {
          ...common,
          'Content-Range': `bytes ${start}-${end}/${body.length}`,
          'Content-Length': end - start + 1,
        })
        .end(body.subarray(start, end + 1));

      return;
    }

    res.writeHead(200, { ...common, 'Content-Length': body.length }).end(body);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const origin = `http://${host}:${server.address().port}`;

  return {
    origin,
    hits,
    ranges,
    url: (p) => `${origin}${p}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * The lecture-video host every coverage scenario uses: one clip, offered as the two MP4
 * qualities the player's fallback chain looks for, so the quality picker has a real choice to
 * resolve rather than a single URL it cannot get wrong.
 */
export async function startLectureVideoHost({ seconds = 120, port = 0 } = {}) {
  const clip = await ensureCoverageVideo({ seconds });
  const files = { '/lecture-720.mp4': clip.bytes, '/lecture-360.mp4': clip.bytes };
  const host = await startMediaHost(files, { port });

  return {
    ...host,
    seconds: clip.seconds,
    recipe: clip.recipe,
    mp4Urls: [
      { quality: '720_enhanced', status: 'finished', url: host.url('/lecture-720.mp4') },
      { quality: '360', status: 'finished', url: host.url('/lecture-360.mp4') },
    ],
  };
}
