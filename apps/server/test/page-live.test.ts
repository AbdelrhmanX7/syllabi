/**
 * Live co-editing of a shared notebook page (sharing phase 2 part B): pushes, the stream, presence,
 * access. Same harness as share-edit.test.ts (throwaway MongoDB database, local storage driver; skipped
 * when no MongoDB answers).
 */
import { after, before, describe, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const storageDir = mkdtempSync(path.join(tmpdir(), "syllabi-page-live-test-"));
process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR = storageDir;
process.env.JWT_SECRET = process.env.JWT_SECRET || "page-live-test-secret-" + Math.random().toString(36).slice(2);
process.env.APP_URL = "https://app.test";

const dbName = `syllabi_test_page_live_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const baseUri = (process.env.MONGODB_TEST_URI || "mongodb://127.0.0.1:27017").replace(/\/+$/, "");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mongoose: any = require("mongoose");
let mongoUp = false;

const test = (name: string, fn: () => Promise<void>) =>
  nodeTest(name, async (t) => {
    if (!mongoUp) return t.skip("MongoDB is not reachable");
    await fn();
  });

type Frame = { event: string; data: any };

describe("live notebook pages", () => {
  let server: Server;
  let base = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m: Record<string, any> = {};
  const users: Record<string, { id: string; token: string; email: string }> = {};
  let shareId = "";
  const streams: AbortController[] = [];

  async function call(who: string | null, method: string, url: string, body?: unknown, raw?: string) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { "Content-Type": "application/json", ...(who ? { Authorization: `Bearer ${users[who].token}` } : {}) },
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
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

  /** Opens the stream as `who`; frames collect in `frames`, `ended` settles when the server closes it. */
  async function openStream(who: string, pageId: string, clientId: string) {
    const ac = new AbortController();
    streams.push(ac);
    const res = await fetch(`${base}/study/pages/${pageId}/live/stream?clientId=${clientId}`, {
      headers: { Accept: "text/event-stream", Authorization: `Bearer ${users[who].token}` },
      signal: ac.signal,
    });
    const frames: Frame[] = [];
    if (!res.ok || !res.body) return { status: res.status, frames, ended: Promise.resolve(), close: () => ac.abort() };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const ended = (async () => {
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let sep = buffer.indexOf("\n\n");
          while (sep !== -1) {
            const block = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            sep = buffer.indexOf("\n\n");
            const ev = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (ev) frames.push({ event: ev, data: data ? JSON.parse(data) : null });
          }
        }
      } catch {
        /* aborted */
      }
    })();
    return { status: res.status, frames, ended, close: () => ac.abort() };
  }

  const waitFor = async <T>(fn: () => T | undefined | null | false, ms = 3000): Promise<T> => {
    const until = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v as T;
      if (Date.now() > until) throw new Error("timed out waiting");
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  const oid = (id: string) => new mongoose.Types.ObjectId(id);
  const stroke = (id: string, x = 0) => ({ type: "path", oid: id, left: x, top: 0, path: [["M", x, 0]] });
  const board = (objects: unknown[]) =>
    JSON.stringify({ id: "b", title: "B", currentPageIndex: 0, pages: [{ id: "p1", backgroundType: "lined", canvasJSON: JSON.stringify({ version: "7.2.0", objects }), thumbnail: "" }] });

  /** The board the page's pointer names right now, straight from storage, and its item ids. */
  async function stored(pageId: string) {
    const row = await m.StudyPage.findById(pageId).lean();
    const doc = JSON.parse((await m.storage.getStudyObject(row.contentKey)).toString("utf8"));
    const items = JSON.parse(doc.pages[0].canvasJSON).objects as { oid: string }[];
    return { version: row.version as number, doc, ids: items.map((o) => o.oid) };
  }

  const push = (who: string, pageId: string, ops: unknown, clientId = `${who}-device`) =>
    call(who, "POST", `/study/pages/${pageId}/live`, { clientId, ops });

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
    m.Admin = (await import("../src/models/admin")).Admin;
    Object.assign(m, await import("../src/models/study"));
    m.storage = await import("../src/services/study/storage");
    for (const key of ["owner", "maya", "viewer", "stranger"]) {
      const email = `${key}@example.test`;
      const admin = await m.Admin.create({ name: key[0].toUpperCase() + key.slice(1), email, role: "user", isVerified: true });
      users[key] = { id: String(admin._id), token: signSessionToken(String(admin._id)), email };
    }
    server = createApp().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const owner = oid(users.owner.id);
    const id = new mongoose.Types.ObjectId();
    const key = m.storage.pageContentKey(users.owner.id, String(id), 1);
    // An old board: its first stroke has no id yet.
    await m.storage.putStudyObject(key, Buffer.from(board([{ type: "path", left: 1, top: 0, path: [["M", 1, 0]] }, stroke("a", 2)])), "application/json");
    m.page = await m.StudyPage.create({ _id: id, userId: owner, title: "Cells", kind: "note", version: 1, contentKey: key });
    m.solo = await m.StudyPage.create({ userId: owner, title: "Solo", kind: "note" });
  });

  after(async () => {
    for (const s of streams) s.abort();
    server?.closeAllConnections();
    server?.close();
    (await import("../src/middleware/rate-limit")).closeRateLimitRedis();
    (await import("../src/services/study/page-live")).closePageLive();
    if (!mongoUp) return rmSync(storageDir, { recursive: true, force: true });
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
    rmSync(storageDir, { recursive: true, force: true });
  });

  test("a page with an editor is live for the owner and the editor", async () => {
    const pageId = String(m.page._id);
    assert.equal((await call("owner", "GET", `/study/pages/${pageId}`)).body.live, false);
    const res = await call("owner", "POST", "/share", {
      resourceType: "notebook",
      resourceId: pageId,
      emails: [{ email: "maya@example.test", role: "editor" }, "viewer@example.test"],
    });
    assert.equal(res.status, 201);
    shareId = res.body.share.id;
    assert.equal((await call("owner", "GET", `/study/pages/${pageId}`)).body.live, true);
    const maya = await call("maya", "GET", `/study/pages/${pageId}`);
    assert.equal(maya.body.live, true);
    assert.equal(maya.body.shared.role, "editor");
  });

  test("two editors pushing at the same moment: every stroke survives, versions chain", async () => {
    const pageId = String(m.page._id);
    const before = await stored(pageId);
    const pushes = [];
    for (let i = 0; i < 4; i++) {
      pushes.push(push("owner", pageId, { items: [{ page: "p1", put: [stroke(`o${i}`, 10 + i)] }] }));
      pushes.push(push("maya", pageId, { items: [{ page: "p1", put: [stroke(`m${i}`, 20 + i)] }] }));
    }
    const results = await Promise.all(pushes);
    for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));
    const versions = results.map((r) => r.body.version).sort((a, b) => a - b);
    assert.deepEqual(versions, Array.from({ length: 8 }, (_, i) => before.version + 1 + i));
    for (const r of results) assert.equal(r.body.prevVersion, r.body.version - 1);
    const after = await stored(pageId);
    assert.equal(after.version, before.version + 8);
    for (let i = 0; i < 4; i++) {
      assert.ok(after.ids.includes(`o${i}`), `o${i} kept`);
      assert.ok(after.ids.includes(`m${i}`), `m${i} kept`);
    }
    // The old id-less stroke got its derived id and is still there, once.
    assert.equal(after.ids.filter((id) => id.startsWith("h")).length, 1);
    assert.ok(after.ids.includes("a"));
    // Maya's pushes are in the version log under her name.
    const log = (await m.StudyPage.findById(pageId).lean()).versionLog;
    assert.ok(log.some((e: any) => e.name === "Maya"));
  });

  test("an item deleted on one side stays deleted after the other side's push", async () => {
    const pageId = String(m.page._id);
    const [del, add] = await Promise.all([
      push("maya", pageId, { items: [{ page: "p1", del: ["a"] }] }),
      push("owner", pageId, { items: [{ page: "p1", put: [stroke("late", 99)] }] }),
    ]);
    assert.equal(del.status, 200);
    assert.equal(add.status, 200);
    const now = await stored(pageId);
    assert.ok(!now.ids.includes("a"));
    assert.ok(now.ids.includes("late"));
    // paper style rides along untouched
    assert.equal(now.doc.pages[0].backgroundType, "lined");
  });

  test("two whole-board saves on the same version: one wins, and its own bytes are stored", async () => {
    const pageId = String(m.page._id);
    const { version } = await stored(pageId);
    const one = board([stroke("one")]);
    const two = board([stroke("two")]);
    const [a, b] = await Promise.all([
      call("owner", "PUT", `/study/pages/${pageId}/content/blob?baseVersion=${version}`, undefined, one),
      call("maya", "PUT", `/study/pages/${pageId}/content/blob?baseVersion=${version}`, undefined, two),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const now = await stored(pageId);
    assert.equal(now.version, version + 1);
    assert.deepEqual(now.ids, a.status === 200 ? ["one"] : ["two"]);
  });

  test("viewers and strangers cannot push or listen", async () => {
    const pageId = String(m.page._id);
    const { version } = await stored(pageId);
    for (const who of ["viewer", "stranger"]) {
      assert.equal((await push(who, pageId, { items: [{ page: "p1", put: [stroke("x")] }] })).status, 404, who);
      const s = await openStream(who, pageId, `${who}-device`);
      assert.equal(s.status, 404, who);
    }
    assert.equal((await stored(pageId)).version, version);
    assert.equal((await call(null, "POST", `/study/pages/${pageId}/live`, { clientId: "anon-device", ops: {} })).status, 401);
    // bad input
    assert.equal((await push("owner", pageId, { items: [{ page: "p1", put: [{ type: "path" }] }] })).status, 400);
    assert.equal((await call("owner", "POST", `/study/pages/${pageId}/live`, { ops: {} })).status, 400);
  });

  test("the stream: hello, the other person's changes, who is here", async () => {
    const pageId = String(m.page._id);
    const mayaStream = await openStream("maya", pageId, "maya-tab");
    assert.equal(mayaStream.status, 200);
    const hello = await waitFor(() => mayaStream.frames.find((f) => f.event === "hello"));
    assert.equal(hello.data.version, (await stored(pageId)).version);
    assert.ok(hello.data.people.some((p: any) => p.name === "Maya"));

    const ownerStream = await openStream("owner", pageId, "owner-tab");
    const seen = await waitFor(() => mayaStream.frames.find((f) => f.event === "presence" && f.data.people.some((p: any) => p.name === "Owner")));
    assert.equal(seen.data.people.length, 2);

    const res = await push("owner", pageId, { items: [{ page: "p1", put: [stroke("live", 5)] }] }, "owner-tab");
    const ops = await waitFor(() => mayaStream.frames.find((f) => f.event === "ops" && f.data.version === res.body.version));
    assert.equal(ops.data.prevVersion, res.body.prevVersion);
    assert.equal(ops.data.by.name, "Owner");
    assert.deepEqual(ops.data.ops.items[0].put[0].oid, "live");
    // nobody hears their own push back
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!ownerStream.frames.some((f) => f.event === "ops" && f.data.version === res.body.version));

    // a whole-board save tells the others to re-read (no ops)
    const { version } = await stored(pageId);
    const saved = await call("owner", "PUT", `/study/pages/${pageId}/content/blob?baseVersion=${version}`, undefined, board([stroke("whole")]));
    assert.equal(saved.status, 200);
    const reread = await waitFor(() => mayaStream.frames.find((f) => f.event === "ops" && f.data.version === saved.body.version));
    assert.equal(reread.data.ops, null);

    // an earlier version can be read back (the base a device last had)
    const earlier = await call("maya", "GET", `/study/pages/${pageId}/content?version=${version}`);
    assert.equal(earlier.status, 200);
    assert.equal(earlier.body.version, version);

    ownerStream.close();
    await waitFor(() => mayaStream.frames.find((f) => f.event === "presence" && f.data.people.length === 1));
    mayaStream.close();
  });

  test("a sharing change re-checks access but keeps a remaining editor's stream open", async () => {
    // The re-check (on every sharing change and every 30 s) once looked the page up without its owner,
    // so it took every editor for a stranger and ended their stream.
    const pageId = String(m.page._id);
    const mayaStream = await openStream("maya", pageId, "maya-tab-recheck");
    await waitFor(() => mayaStream.frames.find((f) => f.event === "hello"));
    const ownerStream = await openStream("owner", pageId, "owner-tab-recheck");
    await waitFor(() => ownerStream.frames.find((f) => f.event === "hello"));

    const res = await call("owner", "PATCH", `/share/${shareId}`, { roles: [{ email: "viewer@example.test", role: "viewer" }] });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!mayaStream.frames.some((f) => f.event === "error"), "the editor's stream must stay open");
    assert.ok(!ownerStream.frames.some((f) => f.event === "error"), "the owner's stream must stay open");

    const pushed = await push("owner", pageId, { items: [{ page: "p1", put: [stroke("after-recheck", 9)] }] }, "owner-tab-recheck");
    assert.equal(pushed.status, 200);
    await waitFor(() => mayaStream.frames.find((f) => f.event === "ops" && f.data.version === pushed.body.version));
    mayaStream.close();
    ownerStream.close();
  });

  test("removing someone ends their stream and stops their pushes at once", async () => {
    const pageId = String(m.page._id);
    const mayaStream = await openStream("maya", pageId, "maya-tab-2");
    await waitFor(() => mayaStream.frames.find((f) => f.event === "hello"));
    assert.equal((await push("maya", pageId, { items: [{ page: "p1", put: [stroke("before-removal")] }] })).status, 200);

    const res = await call("owner", "PATCH", `/share/${shareId}`, { removeEmails: ["maya@example.test"] });
    assert.equal(res.status, 200);
    const revoked = await waitFor(() => mayaStream.frames.find((f) => f.event === "error"));
    assert.equal(revoked.data.code, "ACCESS_REVOKED");
    await mayaStream.ended;

    const { version } = await stored(pageId);
    assert.equal((await push("maya", pageId, { items: [{ page: "p1", put: [stroke("after-removal")] }] })).status, 404);
    assert.equal((await openStream("maya", pageId, "maya-tab-3")).status, 404);
    assert.equal((await stored(pageId)).version, version);
    assert.ok(!(await stored(pageId)).ids.includes("after-removal"));
    assert.equal((await call("owner", "GET", `/study/pages/${pageId}`)).body.live, false);
  });

  test("lowering someone to viewer stops their pushes too", async () => {
    const pageId = String(m.page._id);
    await call("owner", "PATCH", `/share/${shareId}`, { addEmails: [{ email: "maya@example.test", role: "editor" }] });
    assert.equal((await push("maya", pageId, { items: [{ page: "p1", put: [stroke("as-editor")] }] })).status, 200);
    await call("owner", "PATCH", `/share/${shareId}`, { roles: [{ email: "maya@example.test", role: "viewer" }] });
    assert.equal((await push("maya", pageId, { items: [{ page: "p1", put: [stroke("as-viewer")] }] })).status, 404);
  });

  test("the first push to a never-saved page creates its board", async () => {
    const pageId = String(m.solo._id);
    const res = await push("owner", pageId, {
      pages: [{ id: "n1", backgroundType: "grid" }],
      order: ["n1"],
      items: [{ page: "n1", put: [stroke("first")] }],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { prevVersion: 0, version: 1 });
    const now = await stored(pageId);
    assert.deepEqual(now.ids, ["first"]);
    assert.equal(now.doc.pages[0].backgroundType, "grid");
  });
  test("without the cross-fork lock a write gets its own key, and that version can still be read and restored", async () => {
    const pages = await import("../src/controllers/study-pages.controller");
    const owner = oid(users.owner.id);
    const id = new mongoose.Types.ObjectId();
    const row = { _id: id, userId: owner, version: 1 };
    const usual = m.storage.pageContentKey(users.owner.id, String(id), 2);
    assert.equal(pages.versionWriteKey(row, 2, true), usual);
    const own = pages.versionWriteKey(row, 2, false);
    assert.notEqual(own, usual);
    assert.match(own, /\/v2-[0-9a-f-]{36}\.json$/);
    assert.notEqual(pages.versionWriteKey(row, 2, false), own); // two racing forks never share a key

    // version 1 lives under its own key (logged); version 2 is current
    const k1 = pages.versionWriteKey(row, 1, false);
    await m.storage.putStudyObject(k1, Buffer.from(board([stroke("one")])), "application/json");
    const k2 = m.storage.pageContentKey(users.owner.id, String(id), 2);
    await m.storage.putStudyObject(k2, Buffer.from(board([stroke("two")])), "application/json");
    const at = new Date();
    await m.StudyPage.create({
      _id: id, userId: owner, title: "Logged", kind: "note", version: 2, contentKey: k2,
      versionLog: [
        { version: 1, userId: owner, name: "Owner", at, key: k1 },
        { version: 2, userId: owner, name: "Owner", at },
      ],
    });
    const earlier = await call("owner", "GET", `/study/pages/${id}/content?version=1`);
    assert.equal(earlier.status, 200);
    const restored = await call("owner", "POST", `/study/pages/${id}/versions/1/restore`, { baseVersion: 2 });
    assert.equal(restored.status, 200);
    assert.deepEqual((await stored(String(id))).ids, ["one"]);
  });
  test("a commit under a key of its own logs that key", async () => {
    const pages = await import("../src/controllers/study-pages.controller");
    const owner = oid(users.owner.id);
    const row = (await m.StudyPage.create({ userId: owner, title: "Own key", kind: "note", version: 0 })).toObject();
    const key = pages.versionWriteKey(row, 1, false);
    const done = await pages.casCommit(row, 1, key, { userId: owner, name: "Owner" } as never);
    assert.equal(done.contentKey, key);
    const log = (await m.StudyPage.findById(row._id).lean()).versionLog;
    assert.equal(log.at(-1).key, key);
    const usual = await pages.casCommit({ ...row, version: 1 }, 2, m.storage.pageContentKey(users.owner.id, String(row._id), 2), { userId: owner, name: "Owner" } as never);
    assert.ok(usual);
    assert.equal((await m.StudyPage.findById(row._id).lean()).versionLog.at(-1).key, null);
  });
});
