import type { Response } from "express";
import { httpDrain, SERVER_RESTARTING, SERVER_RESTARTING_MESSAGE } from "@/services/http-drain";

/**
 * Study SSE framing (contract "Conventions"): `event: <name>\ndata: <json>\n\n`, a `: ping`
 * comment every 10 s, and every stream ends with exactly one `done` or `error {message}` frame.
 * Note this is NOT the ai-chat framing (`data: {type,data}`) — the study FE parses named events.
 */
export interface StudySse {
  send(event: string, data: unknown): void;
  done(data?: unknown): void;
  error(message: string, code?: string): void;
  isOpen(): boolean;
  /** Aborted when the client goes away — pass it to every model call. */
  signal: AbortSignal;
}

export const PING_MS = 10_000;

export function openStudySse(res: Response): StudySse {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (!res.destroyed) res.flushHeaders();
  const ac = new AbortController();
  let open = !res.destroyed;
  const ping = setInterval(() => {
    if (open && !res.destroyed) res.write(": ping\n\n");
  }, PING_MS);
  ping.unref?.();
  const close = () => {
    if (!open) return;
    open = false;
    clearInterval(ping);
  };
  // `close` fires on normal end too; only an early close (before our terminal frame) aborts.
  let finished = false;
  res.on("close", () => {
    close();
    if (!finished) ac.abort();
  });
  if (!open) {
    clearInterval(ping);
    ac.abort();
  }
  const write = (event: string, data: unknown) => {
    if (open && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
  };
  const end = (event: string, data: unknown) => {
    if (finished) return;
    finished = true;
    write(event, data);
    close();
    if (!res.destroyed) res.end();
  };
  // A deploy that outlasts the drain cap ends this stream with one more terminal frame the
  // client can retry on, instead of a cut connection ("network error").
  httpDrain.onDrainCap(res, () => end("error", { message: SERVER_RESTARTING_MESSAGE, code: SERVER_RESTARTING }));
  return {
    send: (event, data) => {
      if (!finished) write(event, data);
    },
    done: (data) => end("done", data ?? {}),
    error: (message, code) => end("error", code ? { message, code } : { message }),
    isOpen: () => open && !finished,
    signal: ac.signal,
  };
}
