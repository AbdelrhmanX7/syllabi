/**
 * Mock mode — the whole network of a browser context, answered locally.
 *
 * Every request is classified into exactly one of four buckets:
 *
 *   allowed      the app origin and the asset host — `route.continue()`
 *   mocked       a `METHOD /path` the scenario declared — fulfilled from the table
 *   catch-all    any other call to the API origin — answered locally and LOGGED,
 *                so an endpoint the scenario forgot shows up as a named gap
 *                instead of a silent hang or a real backend hit
 *   blocked      anything else (fonts, geo lookups, analytics) — aborted
 *
 * `escapedOrigins()` is the nothing-escaped assertion: a run that touched a real
 * backend or a third party is not a reproducible run, even if it passed.
 */

const RESPONSE_TAG = Symbol.for('uitest.response');

/**
 * An explicit status + body, for when the body is itself an array and the
 * `[status, body]` shorthand would be ambiguous: `withStatus(500, { … })`.
 */
export const withStatus = (status, body) => ({ [RESPONSE_TAG]: true, status, body });

/** 200 with an empty JSON object — the shell keeps booting, the gap is logged. */
export const CATCH_ALL_EMPTY = 'empty';
/** 404 — for apps whose service layer must be seen handling a missing endpoint. */
export const CATCH_ALL_NOT_FOUND = 'notFound';

export function createMockApi({
  appOrigin,
  apiOrigin = 'http://localhost:5000',
  allowOrigins = [],
  routes = {},
  catchAll = CATCH_ALL_EMPTY,
  abortSocketIo = true,
  blockThirdParty = true,
  rewriteScripts = null,
}) {
  const allowed = new Set([appOrigin, ...allowOrigins].filter(Boolean));
  const calls = [];
  const unmatched = new Set();
  const blocked = [];
  const continuedOrigins = new Set();
  const captures = new Map();
  let patchedScripts = 0;

  const originOf = (url) => `${url.protocol}//${url.host}`;

  /**
   * A route entry is a body, a `[status, body]` pair, a `withStatus(...)` value,
   * or a function returning any of those. The function may be ASYNC — that is
   * how a scenario holds a response open to assert a loading state, or answers
   * 500 to assert a failure state.
   *
   * The pair form is recognised only when the first element is an HTTP status
   * number, because plenty of these endpoints return a BARE ARRAY as the body
   * (`GET /get-active-study-phases` and friends) and that must not be mistaken
   * for `[status, body]`. `withStatus` is the unambiguous escape hatch.
   */
  const respond = async (route, entry, request) => {
    const value = typeof entry === 'function' ? await entry(request) : entry;
    const isPair =
      Array.isArray(value) && value.length === 2 && typeof value[0] === 'number' && value[0] >= 100 && value[0] <= 599;
    let status = 200;
    let body = value;

    if (value && value[RESPONSE_TAG]) {
      status = value.status ?? 200;
      body = value.body;
    } else if (isPair) {
      [status, body] = value;
    }

    return route.fulfill({
      status,
      contentType: 'application/json; charset=utf-8',
      body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
    });
  };

  /**
   * Exact `METHOD /path` first; then a key ending in `*` as a prefix, for the
   * families of bare-array lookup endpoints (`GET /get-*`) that cascading
   * selects map directly — those throw on the `{}` catch-all rather than
   * degrading, so they need a shaped default.
   */
  const findRoute = (key) => {
    if (Object.prototype.hasOwnProperty.call(routes, key)) return routes[key];

    for (const candidate of Object.keys(routes)) {
      if (candidate.endsWith('*') && key.startsWith(candidate.slice(0, -1))) return routes[candidate];
    }

    return undefined;
  };

  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const origin = originOf(url);
    const key = `${request.method()} ${url.pathname}`;

    // Socket.IO cannot be usefully faked. Aborting fails it fast; letting it
    // through makes the page hang on a backend that is not there.
    if (abortSocketIo && url.pathname.startsWith('/socket.io')) {
      blocked.push({ reason: 'socket.io', url: request.url() });

      return route.abort();
    }

    if (allowed.has(origin)) {
      continuedOrigins.add(origin);

      // Dev-chunk rewrites: flip a build-time constant in the SERVED javascript
      // rather than editing app source (e.g. minology's `CONTENT_LIVE = false`
      // gate, which would otherwise render "coming soon" instead of the page).
      if (rewriteScripts && origin === appOrigin && /\.js(\?|$)/.test(request.url())) {
        const response = await route.fetch();
        const text = await response.text();
        let patched = text;

        for (const { find, replace } of rewriteScripts) patched = patched.replace(find, replace);

        if (patched !== text) patchedScripts += 1;

        return route.fulfill({ response, body: patched });
      }

      return route.continue();
    }

    if (origin === apiOrigin) {
      const capture = captures.get(key);

      if (capture) {
        capture.count += 1;
        let body = null;

        try {
          body = request.postDataJSON();
        } catch {
          body = request.postData();
        }
        capture.bodies.push(body);
        capture.last = body;
      }

      const entry = findRoute(key);

      if (entry !== undefined) {
        calls.push({ key, kind: 'mocked' });

        return respond(route, entry, request);
      }

      calls.push({ key, kind: 'catch-all' });
      unmatched.add(key);

      if (typeof catchAll === 'function') return respond(route, catchAll(request), request);
      if (catchAll === CATCH_ALL_NOT_FOUND) {
        return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'not found' }) });
      }

      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }

    if (!blockThirdParty) {
      continuedOrigins.add(origin);

      return route.continue();
    }

    blocked.push({ reason: 'third-party', method: request.method(), url: request.url() });

    return route.abort();
  };

  return {
    /** Register a route table entry after construction. */
    add(key, entry) {
      routes[key] = entry;

      return this;
    },
    /**
     * Watch an outgoing call and keep its parsed body — how a commit/submit POST
     * is asserted on. Register BEFORE the click that fires it.
     */
    captureRequest(key) {
      const capture = { key, count: 0, bodies: [], last: null };

      captures.set(key, capture);

      return capture;
    },
    async install(context) {
      await context.route('**/*', handler);

      return this;
    },
    get calls() {
      return calls;
    },
    get unmatched() {
      return [...unmatched].sort();
    },
    get blocked() {
      return blocked;
    },
    get patchedScripts() {
      return patchedScripts;
    },
    /** Origins that were let through but are neither the app nor a declared asset host. */
    escapedOrigins() {
      return [...continuedOrigins].filter((origin) => !allowed.has(origin));
    },
    summary() {
      return {
        mocked: calls.filter((c) => c.kind === 'mocked').length,
        catchAll: calls.filter((c) => c.kind === 'catch-all').length,
        unmatched: this.unmatched,
        blocked: blocked.length,
        patchedScripts,
        escaped: this.escapedOrigins(),
      };
    },
  };
}
