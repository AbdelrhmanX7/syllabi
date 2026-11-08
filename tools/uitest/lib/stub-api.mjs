/**
 * SSR-stub mode — for pages whose data is fetched on the SERVER.
 *
 * Playwright route interception lives in the browser, so it cannot reach a
 * `getStaticProps` / `getServerSideProps` / RSC fetch: that request leaves the
 * Next dev server's own Node process. The only way to answer it without a real
 * backend is to BE the backend — bind a stub HTTP server to the exact origin the
 * app was built against (`NEXT_PUBLIC_API`, `http://localhost:5000` here).
 *
 * This is only usable when the real backend is down. If the port is taken, the
 * run fails loudly rather than silently testing against real data.
 */
import http from 'node:http';
import net from 'node:net';

async function portInUse(port, host) {
  return new Promise((resolve) => {
    const probe = net.connect({ port, host });

    probe.setTimeout(800);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('timeout', () => {
      probe.destroy();
      resolve(false);
    });
    probe.once('error', () => {
      probe.destroy();
      resolve(false);
    });
  });
}

/**
 * @param {object} options
 * @param {Array<{method?:string, path:string|RegExp, body:any, status?:number}>} options.routes
 *   `path` matches by prefix when it is a string.
 */
export async function startStubApi({ routes = [], port = 5000, host = '127.0.0.1' } = {}) {
  if (await portInUse(port, host)) {
    throw new Error(
      `SSR-stub mode needs ${host}:${port} — the app's NEXT_PUBLIC_API origin — but something is already ` +
        `listening there. That is either the real backend or another uitest run. Stop it and re-run; do NOT ` +
        `point the stub elsewhere, because the app's API origin is baked in at build time.`,
    );
  }

  const hits = [];
  const server = http.createServer((req, res) => {
    const pathname = (req.url || '').split('?')[0];

    hits.push(`${req.method} ${pathname}`);

    const match = routes.find(
      (route) =>
        (!route.method || route.method.toUpperCase() === req.method) &&
        (route.path instanceof RegExp ? route.path.test(pathname) : pathname.startsWith(route.path)),
    );

    if (!match) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'not found' }));

      return;
    }

    const body = typeof match.body === 'function' ? match.body(req) : match.body;

    res.writeHead(match.status ?? 200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  return {
    origin: `http://${host}:${port}`,
    hits,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
