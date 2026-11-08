import type { Socket } from 'socket.io-client';

import type { AuthConfig, SocketUtils, SocketStatus } from './types';

const socketLogger = {
  log: (message: string, ...args: any[]) => {
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log(message, ...args);
    }
  },
  error: (message: string, ...args: any[]) => {
    // eslint-disable-next-line no-console
    console.log(message, ...args);
  },
  warn: (message: string, ...args: any[]) => {
    // eslint-disable-next-line no-console
    console.log(message, ...args);
  },
};

const noopSocketUtils: SocketUtils = {
  initSocket: async () => {},
  getSocket: () => null,
  onSocketInitialized: () => {},
  onSocketReconnect: () => () => {},
  isSocketConnected: () => false,
  getSocketStatus: () => 'not_initialized' as SocketStatus,
  disconnectSocket: () => {},
  removeUnloadListeners: () => {},
};

export function createSocket(config: AuthConfig): SocketUtils {
  if (!config.socket) {
    return noopSocketUtils;
  }

  const socketConfig = config.socket;

  // All singleton state lives inside the closure
  let socket: Socket | null = null;
  let initializationCallbacks: (() => void)[] = [];
  let reconnectionCallbacks: Set<() => void> = new Set();
  let isInitializing = false;
  let lastAuthToken: string | null = null;
  let cleanupFn: (() => void) | null = null;

  /*
   * Manager-level handlers are tracked so they can be detached again. `socket.io` is the
   * Manager, and it is CACHED and reused across `io()` calls for the same URL while
   * `forceNew` is false — `socket.removeAllListeners()` only clears socket-level
   * listeners, so without this these would stack up one set per re-init and fire every
   * reconnection callback N times.
   */
  let managerReconnectHandler: ((attempt: number) => void) | null = null;
  let managerReconnectErrorHandler: ((error: Error) => void) | null = null;

  const detachManagerListeners = (target: Socket | null) => {
    if (target) {
      if (managerReconnectHandler) target.io.off('reconnect', managerReconnectHandler);
      if (managerReconnectErrorHandler) target.io.off('reconnect_error', managerReconnectErrorHandler);
    }
    managerReconnectHandler = null;
    managerReconnectErrorHandler = null;
  };

  const resolveServerUrl = (): string => {
    const raw = typeof socketConfig.serverUrl === 'function' ? socketConfig.serverUrl() : socketConfig.serverUrl;

    // Extract just the origin (protocol + host + port) to avoid path issues
    try {
      return new URL(raw).origin;
    } catch {
      return raw;
    }
  };

  const initSocket = async (authToken?: string) => {
    if (isInitializing) {
      socketLogger.log('🔄 Socket initialization already in progress...');

      return;
    }

    if (socket && socket.connected && lastAuthToken === authToken) {
      socketLogger.log('🔌 Socket already connected with same token, skipping initialization');

      return;
    }

    if (!socket || socket.disconnected) {
      isInitializing = true;
      const serverUrl = resolveServerUrl();
      socketLogger.log('🔌 Initializing socket with URL:', serverUrl);
      socketLogger.log('🔑 Auth token:', authToken ? 'Present' : 'Missing');

      /*
       * Clean up an existing socket before replacing it.
       *
       * `disconnected` is simply `!connected`, so it is also true while a socket is
       * still connecting and throughout the reconnect backoff. `removeAllListeners()`
       * alone does NOT stop the Manager underneath — it only unhooks us from it — so
       * replacing the instance in that window used to leave an orphan quietly retrying
       * in the background. With unlimited reconnection attempts that orphan would retry
       * forever and, on success, hold a second authenticated session for the same
       * student that nothing is listening to. `disconnect()` stops the Manager too.
       */
      if (socket && socket.disconnected) {
        detachManagerListeners(socket);
        socket.removeAllListeners();
        socket.disconnect();
        socket = null;
      }

      // Lazy-load socket.io-client so it doesn't ship in every route's
      // first-load JS — it's only pulled in the first time a socket connects.
      let io: typeof import('socket.io-client').io;

      try {
        ({ io } = await import('socket.io-client'));
      } catch (error) {
        /*
         * A failed chunk fetch — flaky radio, or a stale chunk hash after a deploy,
         * both routine on phones — used to leave `isInitializing` stuck true forever,
         * because it is set above but only ever cleared in the socket's own event
         * handlers, which now never get attached. Every later initSocket() then
         * returned early at the guard, so the app ran socket-less (no video tracking,
         * no notifications) until a full reload. The caller cannot see this either:
         * initSocket is not awaited, so it surfaces only as an unhandledrejection.
         */
        isInitializing = false;
        socketLogger.error('🔥 Failed to load socket.io-client:', error);

        return;
      }

      socket = io(serverUrl, {
        auth: { token: authToken || '' },
        /*
         * Websocket FIRST but not websocket ONLY.
         *
         * This used to be `['websocket']`, which silently kills every socket feature on
         * any network that blocks or proxies websockets — a captive-portal wifi, a
         * corporate proxy, some mobile carriers. Nothing degrades visibly:
         * the rest of the app is REST/axios and keeps working, so a student watches a
         * whole lecture while `update-video-progress` never leaves the device and the
         * lecture reads back as never opened.
         *
         * Connect on POLLING and upgrade to websocket — engine.io's own default order,
         * and the only arrangement with no way to end up unconnected.
         *
         * `['websocket', 'polling']` does NOT fix this, which is worth stating because
         * it looks like it should: in engine.io-client 6.6 the next-transport fallback
         * lives in `_onError` alone and is gated on `tryAllTransports`, which is never
         * defaulted on — so with websocket first the client simply never attempts
         * polling. And even with the flag set, a proxy that accepts the upgrade and
         * then drops it surfaces as a CLOSE, and `_onClose` has no fallback branch.
         *
         * Same reasoning as apps/web/hooks/useExamSocket.ts, which hit this first.
         */
        transports: ['polling', 'websocket'],
        // Covers the mirror-image case: polling blocked, websocket allowed.
        tryAllTransports: true,
        reconnection: true,
        /*
         * Never stop trying. `reconnectionAttempts: 10` at a 2s delay meant the client
         * gave up permanently after ~20 seconds — a tunnel, a lift, or a WiFi→4G
         * handover was enough to end tracking for the rest of the session with no way
         * back except a full refresh. The backoff cap keeps an outage from turning into
         * a request flood: socket.io grows the delay exponentially and clamps it here.
         */
        reconnectionAttempts: Infinity,
        reconnectionDelay: 2000,
        reconnectionDelayMax: 10000,
        timeout: 20000,
        forceNew: false,
      });

      lastAuthToken = authToken || null;

      socket.on('connect', () => {
        socketLogger.log('✅ Socket connected successfully!', socket?.id);
        socketLogger.log('🔗 Socket auth:', socket?.auth);
        isInitializing = false;

        initializationCallbacks.forEach((callback) => callback());
        initializationCallbacks = [];
      });

      socket.on('disconnect', (reason) => {
        socketLogger.log('❌ Socket disconnected:', reason);
        if (reason === 'io server disconnect' || reason === 'io client disconnect') {
          isInitializing = false;
        }
      });

      socket.on('connect_error', (error) => {
        socketLogger.warn('🔥 Socket connection error:', error);
        isInitializing = false;
      });

      /*
       * Reconnect events live on the MANAGER (`socket.io`), not on the socket.
       *
       * This was `socket.on('reconnect', ...)`, which has been dead code since
       * socket.io-client v3 (installed: 4.8.3) — `reconnect` is not among the socket's
       * reserved events, so the handler never ran. Every `onSocketReconnect` consumer
       * (the upload manager, among others) was therefore silently never notified that
       * the connection had come back.
       */
      detachManagerListeners(socket);

      managerReconnectHandler = (attemptNumber: number) => {
        socketLogger.log('🔄 Socket reconnected after', attemptNumber, 'attempts');
        isInitializing = false;

        reconnectionCallbacks.forEach((callback) => {
          try {
            callback();
          } catch (error) {
            socketLogger.error('Error in reconnection callback:', error);
          }
        });
      };

      managerReconnectErrorHandler = (error: Error) => {
        socketLogger.warn('🔥 Socket reconnection error:', error);
      };

      socket.io.on('reconnect', managerReconnectHandler);
      socket.io.on('reconnect_error', managerReconnectErrorHandler);

      // Set up browser unload cleanup
      if (typeof window !== 'undefined' && !cleanupFn) {
        cleanupFn = () => {
          if (socket && socket.connected) {
            socket.disconnect();
          }
        };

        /*
         * `beforeunload` only — the `unload` listener that used to sit alongside it
         * made every page carrying a socket ineligible for the back/forward cache, so
         * a back-navigation on mobile tore down and re-executed the whole module graph
         * instead of restoring the page. The disconnect is best-effort housekeeping
         * anyway: the server sees the transport close on its own.
         */
        window.addEventListener('beforeunload', cleanupFn);
      }
    } else if (socket && socket.connected) {
      socketLogger.log('🔌 Socket already connected, checking auth token...');
      if (authToken && lastAuthToken !== authToken) {
        socketLogger.log('🔑 Updating auth token...');
        socket.auth = { token: authToken };
        lastAuthToken = authToken;
        socket.emit('authenticate', { token: authToken });
      }
    }
  };

  const getSocket = (): Socket | null => socket;

  const onSocketInitialized = (callback: () => void) => {
    if (socket && socket.connected) {
      callback();
    } else {
      initializationCallbacks.push(callback);
    }
  };

  const onSocketReconnect = (callback: () => void): (() => void) => {
    reconnectionCallbacks.add(callback);

    return () => {
      reconnectionCallbacks.delete(callback);
    };
  };

  const isSocketConnected = (): boolean => {
    return socket?.connected || false;
  };

  const getSocketStatus = (): SocketStatus => {
    if (!socket) return 'not_initialized';
    if (socket.connected) return 'connected';
    if (socket.disconnected) return 'disconnected';

    return 'connecting';
  };

  const disconnectSocket = () => {
    if (socket) {
      socketLogger.log('🔌 Disconnecting socket');
      detachManagerListeners(socket);
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
      lastAuthToken = null;
      isInitializing = false;
      initializationCallbacks = [];
      reconnectionCallbacks.clear();
    }
  };

  const removeUnloadListeners = () => {
    if (typeof window !== 'undefined' && cleanupFn) {
      window.removeEventListener('beforeunload', cleanupFn);
      cleanupFn = null;
    }
  };

  return {
    initSocket,
    getSocket,
    onSocketInitialized,
    onSocketReconnect,
    isSocketConnected,
    getSocketStatus,
    disconnectSocket,
    removeUnloadListeners,
  };
}
