import type { Server, ServerResponse } from "http";
import type { NextFunction, Request, Response } from "express";

/**
 * Deploy-time HTTP drain.
 *
 * The incident (2026-10-05 17:05): a deploy rolled the 4 fork-mode `api` workers and two
 * in-flight Study SSE requests, 14–21 s into a model call, died at the exact second their
 * worker restarted — the client saw "network error". pm2 sends SIGINT, then SIGKILL after
 * `kill_timeout`, and `api` had none set, so pm2's 1.6 s default killed every in-flight
 * response long before the old 30 s shutdown timer mattered.
 *
 * On a stop signal the worker now:
 *   1. stops listening (`server.close()`) — nginx gets ECONNREFUSED on this port and retries
 *      the request on another upstream (default `proxy_next_upstream error timeout`; a refused
 *      connection was never sent, so POSTs fail over too);
 *   2. waits for every in-flight Express response to finish, up to DRAIN_CAP_MS;
 *   3. at the cap, ends each survivor gracefully — an SSE stream gets a final
 *      `error {code:"SERVER_RESTARTING"}` frame in its own framing so the client retries
 *      instead of seeing a cut connection — then force-destroys whatever is left after
 *      DRAIN_FLUSH_GRACE_MS.
 *
 * Every Express response is tracked, not only SSE: a short JSON request in flight at exit is
 * cut just the same. Socket.IO is deliberately NOT tracked — engine.io answers /socket.io/
 * before Express sees it, so polling and websocket sessions keep their existing behaviour
 * (they end when the process exits) and never hold the drain open.
 *
 * Tunables are hardcoded on purpose (no env flags). `ecosystem.config.js` `api.kill_timeout`
 * MUST exceed SHUTDOWN_SAFETY_MS, or pm2 SIGKILLs mid-drain — a test pins that ordering.
 */
export const DRAIN_CAP_MS = 120_000;
/** After the cap's final frames are written, how long they get to flush before a hard destroy. */
export const DRAIN_FLUSH_GRACE_MS = 1_500;
/** Hard stop for the whole shutdown (drain + cleanup), in case a cleanup step hangs. */
export const SHUTDOWN_SAFETY_MS = DRAIN_CAP_MS + DRAIN_FLUSH_GRACE_MS + 10_000;

export const SERVER_RESTARTING = "SERVER_RESTARTING";
export const SERVER_RESTARTING_MESSAGE = "The server is restarting. Please retry.";

/** Writes a stream's own final frame and ends it. Called once, only if the cap is hit. */
export type DrainTerminator = () => void;

export interface DrainResult {
  inFlightAtStart: number;
  /** Ended at the cap with a final frame / 503. */
  terminated: number;
  /** Still open after the flush grace and destroyed. */
  forced: number;
  elapsedMs: number;
}

export interface HttpDrain {
  /** Express middleware: tracks every response until it closes. Mount first. */
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  /** Track `res` (idempotent) and set how it is ended if the drain cap is hit. */
  onDrainCap(res: ServerResponse, terminator: DrainTerminator): void;
  inFlight(): number;
  isDraining(): boolean;
  /** `o` overrides the cap/grace for this call (tests); production uses the defaults. */
  drain(server?: Pick<Server, "close">, o?: { capMs?: number; graceMs?: number }): Promise<DrainResult>;
}

/** The fallback for a tracked response that registered no terminator of its own. */
function defaultTerminate(res: ServerResponse): void {
  const body = { code: SERVER_RESTARTING, message: SERVER_RESTARTING_MESSAGE };
  if (!res.headersSent) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Retry-After", "5");
    res.setHeader("Connection", "close");
    res.end(JSON.stringify(body));
    return;
  }
  const type = String(res.getHeader("Content-Type") ?? "");
  if (type.includes("text/event-stream")) {
    res.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
    res.end();
    return;
  }
  // A half-sent non-stream body cannot be completed truthfully; cut it.
  res.destroy();
}

export function createHttpDrain(opts: { capMs?: number; graceMs?: number } = {}): HttpDrain {
  const capMs = opts.capMs ?? DRAIN_CAP_MS;
  const graceMs = opts.graceMs ?? DRAIN_FLUSH_GRACE_MS;
  const inflight = new Set<ServerResponse>();
  const terminators = new WeakMap<ServerResponse, DrainTerminator>();
  let emptyWaiters: Array<() => void> = [];
  let draining = false;

  const track = (res: ServerResponse) => {
    if (inflight.has(res)) return;
    inflight.add(res);
    // `close` fires on normal end AND on a client abort, so a response can never leak here.
    res.once("close", () => {
      inflight.delete(res);
      if (inflight.size === 0) {
        const waiters = emptyWaiters;
        emptyWaiters = [];
        waiters.forEach((w) => w());
      }
    });
  };

  /** Resolves true when nothing is in flight, false if `ms` elapsed first. */
  const waitEmpty = (ms: number) =>
    new Promise<boolean>((resolve) => {
      if (inflight.size === 0) return resolve(true);
      const timer = setTimeout(() => {
        emptyWaiters = emptyWaiters.filter((w) => w !== onEmpty);
        resolve(false);
      }, ms);
      const onEmpty = () => {
        clearTimeout(timer);
        resolve(true);
      };
      emptyWaiters.push(onEmpty);
    });

  return {
    middleware: (_req, res, next) => {
      track(res);
      next();
    },
    onDrainCap: (res, terminator) => {
      track(res);
      terminators.set(res, terminator);
    },
    inFlight: () => inflight.size,
    isDraining: () => draining,
    async drain(server, o = {}) {
      const startedAt = Date.now();
      draining = true;
      // Stop accepting first. The callback is ignored on purpose: it waits for EVERY
      // connection, including Socket.IO websockets that never end on their own.
      try {
        server?.close();
      } catch {
        /* not listening — nothing to stop */
      }
      const inFlightAtStart = inflight.size;
      let terminated = 0;
      let forced = 0;

      if (!(await waitEmpty(o.capMs ?? capMs))) {
        for (const res of [...inflight]) {
          terminated++;
          try {
            (terminators.get(res) ?? (() => defaultTerminate(res)))();
          } catch {
            res.destroy();
          }
        }
        if (!(await waitEmpty(o.graceMs ?? graceMs))) {
          for (const res of [...inflight]) {
            forced++;
            res.destroy();
          }
        }
      }
      return { inFlightAtStart, terminated, forced, elapsedMs: Date.now() - startedAt };
    },
  };
}

/** The process-wide drain used by index.ts and the SSE helpers. */
export const httpDrain = createHttpDrain();

/**
 * Build the SIGINT/SIGTERM handler: drain, then cleanup, then exit(0). A second signal is
 * ignored (pm2 may resend), and a safety timer exits(1) if anything hangs past
 * SHUTDOWN_SAFETY_MS — still inside pm2's kill_timeout, so the exit is ours, not a SIGKILL.
 */
export function createShutdownHandler(deps: {
  server: Pick<Server, "close">;
  drain?: HttpDrain;
  cleanup: () => Promise<void>;
  exit?: (code: number) => void;
  log?: (msg: string) => void;
  safetyMs?: number;
}): (signal: string) => Promise<void> {
  const drain = deps.drain ?? httpDrain;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? ((msg: string) => {
    try {
      console.log(msg);
    } catch {
      /* EPIPE on a dead pm2 IPC pipe */
    }
  });
  let started = false;
  return async (signal: string) => {
    if (started) return;
    started = true;
    log(`${signal} received. Draining ${drain.inFlight()} in-flight HTTP response(s)...`);
    const safety = setTimeout(() => exit(1), deps.safetyMs ?? SHUTDOWN_SAFETY_MS);
    safety.unref?.();
    try {
      const r = await drain.drain(deps.server);
      log(
        `Drain finished in ${r.elapsedMs}ms: ${r.inFlightAtStart} in flight, ` +
          `${r.terminated} ended at the cap, ${r.forced} force-closed.`
      );
      await deps.cleanup();
      clearTimeout(safety);
      exit(0);
    } catch {
      clearTimeout(safety);
      exit(1);
    }
  };
}
