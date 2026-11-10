import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpSource, uploadSource } from "../src/services/study/inbox/source";

test("upload: a drop token is always phone, whatever the body claims", () => {
  assert.equal(uploadSource("64b000000000000000000001", undefined), "phone");
  assert.equal(uploadSource("64b000000000000000000001", "shared"), "phone");
});

test("upload: the signed-in app may say shared or upload, nothing else", () => {
  assert.equal(uploadSource(null, "shared"), "shared");
  assert.equal(uploadSource(null, " Upload "), "upload");
  assert.equal(uploadSource(null, "claude"), "upload");
  assert.equal(uploadSource(null, "phone"), "upload");
  assert.equal(uploadSource(null, undefined), "upload");
  assert.equal(uploadSource(null, 42), "upload");
});

test("mcp: name first, then user agent, then Claude's callback", () => {
  assert.equal(mcpSource({ name: "Claude" }), "claude");
  assert.equal(mcpSource({ name: "My Codex key" }), "codex");
  assert.equal(mcpSource({ name: "OpenAI ChatGPT" }), "codex");
  assert.equal(mcpSource({ name: "Codex", userAgent: "claude-code/2.0" }), "codex");
  assert.equal(mcpSource({ name: "laptop", userAgent: "codex_cli_rs/0.40" }), "codex");
  assert.equal(mcpSource({ name: "", redirectUris: ["https://claude.ai/api/mcp/auth_callback"] }), "claude");
  assert.equal(mcpSource({ name: "inspector", redirectUris: ["http://localhost:6274/oauth/callback"] }), "other");
  assert.equal(mcpSource({}), "other");
});
