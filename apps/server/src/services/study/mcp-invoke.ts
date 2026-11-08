import { EventEmitter } from "events";
import type { NextFunction, Request, Response } from "express";

/**
 * Runs a study REST controller in-process for an MCP tool call, so a tool goes through the
 * EXACT code the REST route runs (validation, ownership checks, DTOs, usage rows) instead of
 * a second copy of it. The fake request carries only the owner id the auth layer resolved —
 * the same field (`req.adminId`) the `/study` mount sets after adminVerification.
 *
 * Handles plain JSON replies and the study SSE framing (`event: x\ndata: {...}\n\n`), whose
 * frames come back parsed in `events`.
 */

export interface Invoked {
  status: number;
  body: any;
  events: { event: string; data: any }[];
}

/** Upper bound for an SSE stream to send its terminal frame after the handler resolved. */
const SSE_SETTLE_MAX_MS = 10 * 60 * 1000;

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

export function parseSseFrames(raw: string) {
  const out: { event: string; data: any }[] = [];
  for (const block of raw.split("\n\n")) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data.push(line.slice(6));
    }
    if (!data.length) continue; // pings / empty
    let parsed: any = data.join("\n");
    try {
      parsed = JSON.parse(parsed);
    } catch {
      /* keep the raw text */
    }
    out.push({ event, data: parsed });
  }
  return out;
}

export function invokeController(
  handler: Handler,
  input: { userId: string; params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown; label?: string }
): Promise<Invoked> {
  return new Promise<Invoked>((resolve, reject) => {
    let settled = false;
    let sse = "";
    let body: any = undefined;
    const res = new EventEmitter() as any;
    res.statusCode = 200;
    res.headersSent = false;
    res.destroyed = false;
    res.writableEnded = false;
    const headers: Record<string, unknown> = {};
    const finish = () => {
      if (settled) return;
      settled = true;
      res.writableEnded = true;
      res.headersSent = true;
      const events = sse ? parseSseFrames(sse) : [];
      resolve({ status: res.statusCode, body, events });
      // Let openStudySse clear its ping timer (its `finished` flag means this is not an abort).
      setImmediate(() => res.emit("close"));
    };
    res.setHeader = (k: string, v: unknown) => {
      headers[k.toLowerCase()] = v;
      return res;
    };
    res.getHeader = (k: string) => headers[k.toLowerCase()];
    res.set = res.setHeader;
    res.flushHeaders = () => {
      res.headersSent = true;
    };
    res.status = (c: number) => {
      res.statusCode = c;
      return res;
    };
    res.json = (b: unknown) => {
      body = b;
      finish();
      return res;
    };
    res.send = (b: unknown) => {
      body = b;
      finish();
      return res;
    };
    res.write = (chunk: unknown) => {
      res.headersSent = true;
      sse += String(chunk);
      return true;
    };
    res.end = (chunk?: unknown) => {
      if (chunk !== undefined && chunk !== null) sse += String(chunk);
      finish();
      return res;
    };

    const req = {
      adminId: input.userId,
      userId: input.userId,
      isAdmin: true,
      adminRole: "admin",
      method: "POST",
      originalUrl: `mcp:${input.label ?? "tool"}`,
      url: `mcp:${input.label ?? "tool"}`,
      path: `mcp:${input.label ?? "tool"}`,
      headers: {},
      params: input.params ?? {},
      query: input.query ?? {},
      body: input.body ?? {},
      get: () => undefined,
    } as unknown as Request;

    const next: NextFunction = (err?: unknown) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve({ status: 404, body: { message: "not handled" }, events: [] });
    };

    Promise.resolve()
      .then(() => handler(req, res as Response, next))
      .then(
        () => {
          // A handler that returned without replying (should not happen) still settles. An SSE
          // stream may legitimately end AFTER the handler resolves (the study SSE helpers write
          // the terminal frame once the usage row is saved), so an open stream is waited for.
          if (settled) return;
          if (!res.headersSent) setImmediate(() => !settled && finish());
          else setTimeout(() => !settled && finish(), SSE_SETTLE_MAX_MS).unref?.();
        },
        (e) => next(e)
      );
  });
}
