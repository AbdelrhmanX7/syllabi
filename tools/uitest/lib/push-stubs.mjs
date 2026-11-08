/**
 * Browser stubs for the push pipeline — and a precise statement of what is faked.
 *
 * Three things in the notification flow cannot be driven from a real headless Chrome on demand:
 *
 *   1. `pushManager.subscribe()` needs a real push service (FCM). There is none here, and a
 *      subscription minted against one is not reproducible anyway.
 *   2. `Notification.permission === 'denied'` cannot be produced by Playwright at all —
 *      `grantPermissions` only grants, and `clearPermissions` only returns to `default`.
 *   3. A connected Socket.IO needs a backend. `NotificationStatusCard` renders `active` ONLY when
 *      the socket is connected, so without one every card is `partial` and the whole
 *      «active → partial on a mis-attribution» downgrade becomes unobservable: both states render
 *      the same string and two assertions pass on a screen that can only say one thing.
 *
 * Everything else is real: the service worker registers for real, `navigator.serviceWorker.ready`
 * resolves for real, the app's own `subscribeDeviceForPush` runs for real, the POST leaves the
 * browser for real and is read off the wire, and `socket.io-client` runs for real on top of the
 * faked transport.
 *
 * ⚠️ A STUB THAT READS LIKE A BROWSER ASSERTION IS WORSE THAN NO ASSERTION. Every scenario using
 * these has to say, per surface, which half it is leaning on.
 */

/**
 * Count every call to `Notification.requestPermission`, keeping the real one underneath.
 *
 * ⚠️ COUNTING, NOT BLOCKING. Playwright answers the permission prompt with no UI, so a prompt that
 * WAS raised is invisible in a screenshot and indistinguishable from one that was never raised.
 * The counter is the only witness — and «this load raised no prompt» is the assertion that guards
 * a STICKY denial.
 */
export const installPermissionCounter = (context) =>
  context.addInitScript(() => {
    window.__permissionAsks = 0;

    if (typeof window.Notification === 'undefined') return;

    const original = window.Notification.requestPermission.bind(window.Notification);

    window.Notification.requestPermission = (...args) => {
      window.__permissionAsks += 1;

      return original(...args);
    };
  });

/** Freeze `Notification.permission` at a value Playwright cannot produce (i.e. `denied`). */
export const freezePermission = (context, value) =>
  context.addInitScript((permission) => {
    if (typeof window.Notification === 'undefined') return;

    Object.defineProperty(window.Notification, 'permission', { get: () => permission, configurable: true });
  }, value);

/**
 * A `PushManager` that exists only in the page.
 *
 * @param {object} options
 * @param {string} options.endpoint        the endpoint an ALREADY-SUBSCRIBED device reports
 * @param {string} options.freshEndpoint   the endpoint a NEW `subscribe()` mints — deliberately
 *                                         different, so «the POST carried the new one» is provable
 * @param {number[]|null} options.keyBytes  `options.applicationServerKey` of the existing
 *                                         subscription. `null` models an engine that will not say,
 *                                         which `applicationServerKeyMatches` must read as «leave
 *                                         it alone» rather than «churn it».
 * @param {boolean} options.existing       false = a fresh device with nothing subscribed yet
 *
 * Records, per page load (the init script re-runs on every navigation):
 *   `__push.subscribeCalls` · `__push.unsubscribeCalls` · `__push.userVisibleOnly`
 *   `__push.subscribedKeys` — each `subscribe()`'s `applicationServerKey`, tagged `bytes` or
 *   `string`. The tag is load-bearing: iOS/Safari REJECT the string form outright, and a caller
 *   that passes the raw base64 works everywhere except the platform the conversion exists for.
 */
export const installPushStub = (context, { endpoint, freshEndpoint, keyBytes = null, existing = true }) =>
  context.addInitScript(
    (config) => {
      window.__push = {
        subscribeCalls: 0,
        unsubscribeCalls: 0,
        subscribedKeys: [],
        userVisibleOnly: null,
        subscription: null,
      };

      if (typeof window.PushManager === 'undefined') return;

      const describeKey = (raw) => {
        if (raw == null) return { type: 'absent', value: null };
        if (typeof raw === 'string') return { type: 'string', value: raw };
        if (raw instanceof ArrayBuffer) return { type: 'bytes', value: Array.from(new Uint8Array(raw)) };
        if (ArrayBuffer.isView(raw)) {
          return { type: 'bytes', value: Array.from(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)) };
        }

        return { type: typeof raw, value: null };
      };

      const makeSubscription = (url, applicationServerKey) => ({
        endpoint: url,
        expirationTime: null,
        options: { userVisibleOnly: true, applicationServerKey },
        getKey: () => null,
        // The browser's own shape. `toSubscribeBody` LISTS these fields rather than spreading
        // them, so an extra key here must never reach the wire.
        toJSON: () => ({
          endpoint: url,
          expirationTime: null,
          keys: { p256dh: 'uitest-p256dh', auth: 'uitest-auth' },
          // A key no app asked for. If it shows up in the POST body, something spread `toJSON()`.
          browserAddedLater: 'do-not-forward',
        }),
        unsubscribe: async () => {
          window.__push.unsubscribeCalls += 1;
          window.__push.subscription = null;

          return true;
        },
      });

      if (config.existing) {
        window.__push.subscription = makeSubscription(
          config.endpoint,
          config.keyBytes ? new Uint8Array(config.keyBytes).buffer : undefined,
        );
      }

      window.PushManager.prototype.getSubscription = async function getSubscription() {
        return window.__push.subscription;
      };

      window.PushManager.prototype.subscribe = async function subscribe(options) {
        const raw = options ? options.applicationServerKey : null;

        window.__push.subscribeCalls += 1;
        window.__push.userVisibleOnly = !!(options && options.userVisibleOnly);
        window.__push.subscribedKeys.push(describeKey(raw));
        window.__push.subscription = makeSubscription(config.freshEndpoint, raw);

        return window.__push.subscription;
      };
    },
    { endpoint, freshEndpoint, keyBytes, existing },
  );

/** Everything the page recorded about push this load. */
export const readPushState = (page) =>
  page.evaluate(() => ({
    ...window.__push,
    permissionAsks: window.__permissionAsks ?? null,
    permission: typeof window.Notification === 'undefined' ? null : window.Notification.permission,
    subscription: window.__push?.subscription ? window.__push.subscription.endpoint : null,
  }));


/**
 * A Socket.IO server, answered by the mock table — so `useSocketContext().isConnected` can be TRUE.
 *
 * ⚠️ WHY THIS EXISTS AT ALL. `NotificationStatusCard` renders `active` only when the socket is
 * connected. Without one, EVERY card is `partial`, and «a mis-attributed device is downgraded
 * active → partial» becomes untestable: the match case and the mismatch case render the identical
 * string, both per-case assertions pass, and the surface proves nothing. See the README's
 * "two positive assertions can both pass on a screen that renders one thing".
 *
 * ⚠️ AND WHY IT IS HTTP, not a patched `window.WebSocket`. `createSocket` configures
 * `transports: ['polling', 'websocket']` — polling FIRST — and engine.io-client's
 * `tryAllTransports` defaults to false, so a polling transport that is ABORTED (which is what
 * `createMockApi` does by default) does not fall through to websocket: the socket simply never
 * connects. Answering the polling handshake keeps `engine.io-client`, `socket.io-client`, the
 * Manager and `SocketProvider` entirely real; only the server is local, exactly as every other
 * endpoint in mock mode.
 *
 * The Engine.IO v4 polling handshake, in full:
 *   GET  (no sid)  → `0{sid,upgrades:[],pingInterval,pingTimeout}`   engine OPEN
 *   POST `40`      → `ok`                                            socket.io CONNECT to `/`
 *   GET  (sid)     → `40{"sid":…}`                                   CONNECT ack — this is what
 *                                                                    fires `connect` on the client
 *   GET  (sid) …   → `2` after a pause                               server PING, keeps it alive
 *
 * `upgrades: []` on purpose: advertising websocket would send the client probing at a transport
 * nothing here answers.
 *
 * Spread into a `createMockApi` route table, and pass `abortSocketIo: false` alongside it.
 */
export const socketIoRoutes = ({ pollMs = 4000 } = {}) => {
  let acked = false;

  return {
    'GET /socket.io/': async (request) => {
      const sid = new URL(request.url()).searchParams.get('sid');

      if (!sid) {
        return [
          200,
          `0${JSON.stringify({
            sid: 'uitest-engine',
            upgrades: [],
            pingInterval: 25000,
            pingTimeout: 20000,
            maxPayload: 1000000,
          })}`,
        ];
      }

      if (!acked) {
        acked = true;

        return [200, `40${JSON.stringify({ sid: 'uitest-socket' })}`];
      }

      // Long-poll. A `2` returned immediately would hot-loop the client.
      await new Promise((resolve) => setTimeout(resolve, pollMs));

      return [200, '2'];
    },
    'POST /socket.io/': () => [200, 'ok'],
  };
};
