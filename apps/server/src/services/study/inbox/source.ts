import type { Types } from "mongoose";

/**
 * Where an inbox item came from — the `source` the app shows as a small tag. Pure (no DB) so the
 * rules are unit-tested; the callers look up the facts (drop token, MCP client name).
 *
 *   phone   a drop token: the iOS Shortcut, the QR upload page, a one-shot link from get_inbox_upload_link
 *   claude  an MCP tool call from Claude (OAuth client / key name says so, or Claude's OAuth callback)
 *   codex   an MCP tool call from Codex / OpenAI
 *   shared  the Android app's share target («Add to Inbox» from another app)
 *   upload  the app itself, signed in (anything else on the admin upload path)
 *   other   an MCP client we cannot name
 */
export const INBOX_SOURCES = ["phone", "claude", "codex", "shared", "upload", "other"] as const;
export type InboxSource = (typeof INBOX_SOURCES)[number];

/** Sources the signed-in app may claim on `POST /study/inbox`; anything else there is `upload`. */
const APP_SOURCES: readonly InboxSource[] = ["shared", "upload"];

/** `POST /study/inbox`: a drop token is always `phone` (the body can't override it). */
export function uploadSource(tokenId: Types.ObjectId | string | null | undefined, claimed: unknown): InboxSource {
  if (tokenId) return "phone";
  const c = typeof claimed === "string" ? claimed.trim().toLowerCase() : "";
  return (APP_SOURCES as readonly string[]).includes(c) ? (c as InboxSource) : "upload";
}

const CLAUDE_CALLBACK = /^https:\/\/claude\.(ai|com)\//i;

/**
 * An MCP caller: its key / OAuth client name first, then the request's user agent; an OAuth client
 * whose callback is Claude's is Claude even with a blank name (registration only allows Claude's
 * callbacks or localhost).
 */
export function mcpSource(identity: { name?: string | null; redirectUris?: string[]; userAgent?: string | null }): InboxSource {
  for (const hay of [identity.name, identity.userAgent]) {
    const h = (hay ?? "").toLowerCase();
    if (/claude|anthropic/.test(h)) return "claude";
    if (/codex|openai|chatgpt/.test(h)) return "codex";
  }
  if ((identity.redirectUris ?? []).some((u) => CLAUDE_CALLBACK.test(u))) return "claude";
  return "other";
}
