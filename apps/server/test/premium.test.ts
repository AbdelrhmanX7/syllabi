/**
 * AI features only for premium accounts (auth/verified.ts, auth/premium.ts, /admin/premium),
 * end to end against a throwaway MongoDB database on this machine (MONGODB_TEST_URI, default
 * mongodb://127.0.0.1:27017). Skipped when no MongoDB answers. No test ever reaches a model:
 * the AI calls used here fail validation (400) right after the gate.
 */
import { after, before, describe, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { isAiAccount } from "../src/auth/roles";

const storageDir = mkdtempSync(path.join(tmpdir(), "syllabi-premium-test-"));
process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR = storageDir;
process.env.JWT_SECRET = process.env.JWT_SECRET || "premium-test-secret-" + Math.random().toString(36).slice(2);

const dbName = `syllabi_test_premium_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const baseUri = (process.env.MONGODB_TEST_URI || "mongodb://127.0.0.1:27017").replace(/\/+$/, "");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mongoose: any = require("mongoose");
let mongoUp = false;

const test = (name: string, fn: () => Promise<void>) =>
  nodeTest(name, async (t) => {
    if (!mongoUp) return t.skip("MongoDB is not reachable");
    await fn();
  });

nodeTest("isAiAccount: the owner (incl. the legacy role) always, users only when premium", () => {
  assert.equal(isAiAccount("owner", false), true);
  assert.equal(isAiAccount("admin", undefined), true);
  assert.equal(isAiAccount(undefined, undefined), true);
  assert.equal(isAiAccount("user", true), true);
  assert.equal(isAiAccount("user", false), false);
  assert.equal(isAiAccount("user", undefined), false);
  assert.equal(isAiAccount("user", "true"), false);
});

describe("premium (AI on)", () => {
  let server: Server;
  let base = "";
  const users: Record<string, { id: string; token: string; email: string }> = {};

  async function call(who: string | null, method: string, url: string, body?: unknown) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { "Content-Type": "application/json", ...(who ? { Authorization: `Bearer ${users[who].token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  }

  before(async () => {
    mongoose.set("strictQuery", true);
    try {
      await mongoose.connect(`${baseUri}/${dbName}`, { serverSelectionTimeoutMS: 1500 });
      mongoUp = true;
    } catch {
      return;
    }
    const { createApp } = await import("../src/app");
    const { signSessionToken } = await import("../src/compat/auth");
    const { Admin } = await import("../src/models/admin");
    const rows = [
      // The owner on the legacy role value, with no premium flag stored.
      { key: "owner", role: "admin", premium: undefined, isVerified: true },
      { key: "plain", role: "user", premium: undefined, isVerified: true },
      { key: "vip", role: "user", premium: true, isVerified: true },
      { key: "unverified", role: "user", premium: true, isVerified: false },
    ];
    for (const r of rows) {
      const email = `${r.key}@example.test`;
      const admin = await Admin.create({ name: r.key, email, role: r.role, isVerified: r.isVerified, ...(r.premium === undefined ? {} : { premium: r.premium }) });
      if (r.premium === undefined) await Admin.collection.updateOne({ _id: admin._id }, { $unset: { premium: "" } });
      users[r.key] = { id: String(admin._id), token: signSessionToken(String(admin._id)), email };
    }
    server = createApp().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server?.closeAllConnections();
    server?.close();
    (await import("../src/middleware/rate-limit")).closeRateLimitRedis();
    if (mongoUp) {
      await mongoose.connection.dropDatabase().catch(() => {});
      await mongoose.disconnect();
    }
    rmSync(storageDir, { recursive: true, force: true });
  });

  test("a non-premium account gets 403 AI_NOT_ENABLED on AI routes", async () => {
    for (const [method, url] of [
      ["POST", "/study/questions/extract"],
      ["POST", "/study/ai/flashcards"],
      ["POST", "/study/ai/ask"],
      ["POST", "/study/exams"],
    ] as const) {
      const r = await call("plain", method, url, {});
      assert.equal(r.status, 403, `${method} ${url}`);
      assert.equal(r.body.code, "AI_NOT_ENABLED");
      assert.equal(r.body.message, "AI features are only on for some accounts right now.");
    }
    // Plain reads under /ai and non-AI routes still work.
    assert.equal((await call("plain", "GET", "/study/ai/conversations")).status, 200);
    assert.equal((await call("plain", "GET", "/study/questions")).status, 200);
  });

  test("premium and the owner pass the gate (the handler's own validation answers)", async () => {
    for (const who of ["vip", "owner"]) {
      const r = await call(who, "POST", "/study/questions/extract", {});
      assert.equal(r.status, 400, who);
      assert.equal(r.body.code, "VALIDATION_ERROR");
    }
  });

  test("premium still needs a verified email", async () => {
    const r = await call("unverified", "POST", "/study/questions/extract", {});
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "EMAIL_NOT_VERIFIED");
  });

  test("/auth/me and /admin/me report the effective premium", async () => {
    assert.equal((await call("plain", "GET", "/auth/me")).body.user.premium, false);
    assert.equal((await call("vip", "GET", "/auth/me")).body.user.premium, true);
    assert.equal((await call("owner", "GET", "/auth/me")).body.user.premium, true);
    assert.equal((await call("owner", "GET", "/admin/me")).body.user.premium, true);
  });

  test("only the owner can list, grant and remove", async () => {
    assert.equal((await call("plain", "GET", "/admin/premium")).status, 403);
    assert.equal((await call("vip", "POST", "/admin/premium", { email: "plain@example.test" })).status, 403);
    assert.equal((await call("plain", "DELETE", "/admin/premium/vip@example.test")).status, 403);
    assert.equal((await call(null, "GET", "/admin/premium")).status, 401);

    const list = await call("owner", "GET", "/admin/premium");
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.accounts.map((a: any) => a.email), ["owner@example.test", "unverified@example.test", "vip@example.test"]);
    assert.equal(list.body.accounts[0].owner, true);

    assert.equal((await call("owner", "POST", "/admin/premium", { email: "nobody@example.test" })).status, 404);
    assert.equal((await call("owner", "POST", "/admin/premium", { email: "nope" })).status, 400);
    assert.equal((await call("owner", "DELETE", "/admin/premium/owner@example.test")).status, 400);

    const granted = await call("owner", "POST", "/admin/premium", { email: " Plain@Example.test " });
    assert.equal(granted.status, 200);
    assert.equal(granted.body.account.email, "plain@example.test");
    assert.equal((await call("plain", "POST", "/study/questions/extract", {})).status, 400);

    assert.equal((await call("owner", "DELETE", "/admin/premium/plain@example.test")).status, 200);
    assert.equal((await call("plain", "POST", "/study/questions/extract", {})).body.code, "AI_NOT_ENABLED");
  });
});
