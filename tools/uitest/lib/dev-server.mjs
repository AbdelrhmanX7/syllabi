/**
 * Per-app dev server manager.
 *
 * A dev server that is already serving is REUSED — the common case, since the
 * apps are usually up while working. Only a cold port is spawned, and only what
 * this process spawned is stopped at the end.
 *
 * NEVER run a lint script from here. `npm run lint:fix` in this repo is
 * `eslint --fix && prettier --write .`, which rewrites the whole app tree.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Ports come from each app's `dev` script in its package.json, with one
 * deliberate exception.
 *
 * apps/web's own dev script takes :3000, but **:3000 is reserved on this machine
 * and must stay free** — another local tool owns it. So uitest runs web on 3020
 * instead, passing `--port` when it spawns. Nothing here ever binds :3000.
 * Override any of these with `UITEST_PORT_<APP>=<port>`.
 */
export const APPS = {
  web: { dir: 'apps/web', port: 3020 },
  admin: { dir: 'apps/admin', port: 3002 },
  teacher: { dir: 'apps/teacher', port: 3003 },
  assistant: { dir: 'apps/assistant', port: 3021 },
  accounting: { dir: 'apps/accounting', port: 3005 },
  minology: { dir: 'apps/minology', port: 3006 },
  'ahmed-yousef': { dir: 'apps/ahmed-yousef', port: 3009 },
};

const running = new Map();

/** Is anything accepting TCP on this port? */
export function portIsOpen(port, host = '127.0.0.1', timeout = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * Who is on this port?
 *
 * "Something answered HTTP" is NOT enough. A dev server can die and an unrelated
 * local tool can take the port; the probe then says "reusing" and every scenario
 * runs against the wrong app, failing with timeouts that look like app bugs.
 * A Next dev response always references `/_next/`, so that is the identity check.
 */
async function probePort(port, timeoutMs = 90_000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`http://localhost:${port}/`, { signal: controller.signal });
    const text = await response.text();

    clearTimeout(timer);

    return {
      alive: true,
      isNext: text.includes('/_next/'),
      title: (text.match(/<title[^>]*>([^<]*)</i) || [])[1]?.trim() || null,
    };
  } catch {
    return { alive: false, isNext: false, title: null };
  }
}

/** `UITEST_PORT_WEB=3100` moves an app off a port something else is holding. */
function portFor(name, app) {
  const override = process.env[`UITEST_PORT_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];

  return override ? Number(override) : app.port;
}

/** Best-effort PID of whatever holds the port, for the run report. */
async function pidOnPort(port) {
  return new Promise((resolve) => {
    const child = spawn('ss', ['-ltnp'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';

    child.stdout.on('data', (buf) => {
      out += buf;
    });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const line = out.split('\n').find((l) => new RegExp(`[:.]${port}\\s`).test(l));
      const match = line && line.match(/pid=(\d+)/);

      resolve(match ? Number(match[1]) : null);
    });
  });
}

/**
 * Ensure the app's dev server is up, and return where it lives.
 *
 * @returns {Promise<{name:string, origin:string, port:number, pid:number|null, reused:boolean}>}
 */
export async function ensureApp(name, { timeoutMs = 240_000, log = () => {} } = {}) {
  if (running.has(name)) return running.get(name);

  const app = APPS[name];

  if (!app) throw new Error(`unknown app '${name}' — add it to APPS in tools/uitest/lib/dev-server.mjs`);

  const port = portFor(name, app);
  const origin = `http://localhost:${port}`;
  const envVar = `UITEST_PORT_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const probe = await probePort(port, 20_000);

  if (probe.alive) {
    if (!probe.isNext) {
      throw new Error(
        `port ${port} (${name}) answers HTTP but is not a Next dev server` +
          `${probe.title ? ` — the page calls itself “${probe.title}”` : ''}. Something else took the port. ` +
          `Free it, or set ${envVar}=<port> to run ${name} somewhere else.`,
      );
    }

    const handle = { name, origin, port, pid: await pidOnPort(port), reused: true, child: null };

    running.set(name, handle);
    log(`dev server for ${name}: reusing ${origin} (pid ${handle.pid ?? '?'})`);

    return handle;
  }

  if (await portIsOpen(port)) {
    throw new Error(
      `port ${port} (${name}) is held by something that does not answer HTTP — free it, or set ${envVar}=<port>`,
    );
  }

  log(`dev server for ${name}: spawning \`npm run dev\` on :${port} in ${app.dir} …`);

  const child = spawn('npm', ['run', 'dev', '--', '--port', String(port)], {
    cwd: path.join(REPO_ROOT, app.dir),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    // Downloads ON regardless of the checkout's .env.local (which ships `read`): the offline
    // scenarios test the download player, and `read` silently renders every download as not saved.
    env: { NEXT_PUBLIC_OFFLINE_MODE: 'downloads', ...process.env, BROWSER: 'none' },
  });

  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  const startedAt = Date.now();
  let ready = false;

  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`\`npm run dev\` for ${name} exited with code ${child.exitCode}`);
    if ((await probePort(port, 30_000)).isNext) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!ready) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    throw new Error(`dev server for ${name} did not start within ${Math.round(timeoutMs / 1000)}s`);
  }

  const handle = { name, origin, port, pid: child.pid, reused: false, child };

  running.set(name, handle);
  log(`dev server for ${name}: started ${origin} (pid ${child.pid}) in ${Math.round((Date.now() - startedAt) / 1000)}s`);

  return handle;
}

/** Warm a route so the first assertion is not racing Turbopack's first compile. */
export async function warm(origin, routePath, { timeoutMs = 180_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    await fetch(`${origin}${routePath}`, { signal: controller.signal, redirect: 'manual' });
  } catch {
    /* the scenario's own navigation reports the real failure */
  } finally {
    clearTimeout(timer);
  }
}

/** Stop only the servers this process started; reused ones keep running. */
export async function stopSpawned(log = () => {}) {
  for (const handle of running.values()) {
    if (handle.reused || !handle.child) continue;
    try {
      process.kill(-handle.child.pid, 'SIGTERM');
      log(`stopped the dev server this run started for ${handle.name} (pid ${handle.child.pid})`);
    } catch {
      /* already gone */
    }
  }
  running.clear();
}
