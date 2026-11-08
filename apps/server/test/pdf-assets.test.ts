/**
 * Notebook PDF backgrounds on the server: stored per account by asset id, written once, read by the
 * owner / editors / viewers / link holders, written by the owner and editors, copied with a share
 * copy, removed with the account. Same harness as share.test.ts (throwaway MongoDB database, local
 * storage driver; skipped when no MongoDB answers).
 */
import { after, before, describe, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const storageDir = mkdtempSync(path.join(tmpdir(), "syllabi-pdf-assets-test-"));
process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR = storageDir;
process.env.JWT_SECRET = process.env.JWT_SECRET || "pdf-assets-test-secret-" + Math.random().toString(36).slice(2);
process.env.APP_URL = "https://app.test";

const dbName = `syllabi_test_pdf_assets_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const baseUri = (process.env.MONGODB_TEST_URI || "mongodb://127.0.0.1:27017").replace(/\/+$/, "");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mongoose: any = require("mongoose");
let mongoUp = false;

const test = (name: string, fn: () => Promise<void>) =>
  nodeTest(name, async (t) => {
    if (!mongoUp) return t.skip("MongoDB is not reachable");
    await fn();
  });

const pdf = (marker: string) => Buffer.from(`%PDF-1.4\n% ${marker}\n1 0 obj << >> endobj\n%%EOF\n`);
const A1 = "3b241101-e2bb-4255-8caf-4136c566a962";
const A2 = "7d444840-9dc0-11d1-b245-5ffdce74fad2";

describe("notebook PDF assets", () => {
  let server: Server;
  let base = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m: Record<string, any> = {};
  const users: Record<string, { id: string; token: string; email: string }> = {};
  let shareId = "";
  let linkToken = "";

  async function call(who: string | null, method: string, url: string, body?: Buffer | object, contentType = "application/pdf") {
    const raw = Buffer.isBuffer(body);
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": raw ? contentType : "application/json" } : {}),
        ...(who ? { Authorization: `Bearer ${users[who].token}` } : {}),
      },
      body: body === undefined ? undefined : raw ? new Uint8Array(body as Buffer) : JSON.stringify(body),
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
  // The local driver's signed url points at the configured public base; serve it from this test server.
  const fetchUrl = async (url: string) => {
    const u = new URL(url, base);
    const res = await fetch(`${base}${u.pathname}${u.search}`);
    assert.equal(res.status, 200);
    return Buffer.from(await res.arrayBuffer());
  };
  const stored = async (userId: string, assetId: string) => m.storage.studyObjectExists(m.storage.pdfAssetKey(userId, assetId));

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
    m.accounts = await import("../src/auth/accounts");
    for (const key of ["owner", "maya", "viewer", "stranger", "copier"]) {
      const email = `${key}@example.test`;
      const admin = await m.Admin.create({ name: key[0].toUpperCase() + key.slice(1), email, role: "user", isVerified: true });
      users[key] = { id: String(admin._id), token: signSessionToken(String(admin._id)), email };
    }
    server = createApp().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const owner = new mongoose.Types.ObjectId(users.owner.id);
    const id = new mongoose.Types.ObjectId();
    const key = m.storage.pageContentKey(users.owner.id, String(id), 1);
    const board = { id: "b", pages: [{ canvasJSON: "", pdfAssetId: A1 }, { canvasJSON: "", pdfAssetId: A1 }, { canvasJSON: "", pdfAssetId: A2 }] };
    await m.storage.putStudyObject(key, Buffer.from(JSON.stringify(board)), "application/json");
    m.page = await m.StudyPage.create({ _id: id, userId: owner, title: "Lab handout", kind: "note", version: 1, contentKey: key });
  });

  after(async () => {
    server?.closeAllConnections();
    server?.close();
    (await import("../src/middleware/rate-limit")).closeRateLimitRedis();
    (await import("../src/services/study/page-live")).closePageLive();
    if (!mongoUp) return rmSync(storageDir, { recursive: true, force: true });
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
    rmSync(storageDir, { recursive: true, force: true });
  });

  test("owner: upload is checked, written once, listed, and read back through a signed url", async () => {
    const url = `/study/pages/${m.page._id}/pdf-assets/${A1}`;
    assert.equal((await call("owner", "PUT", url, Buffer.from("not a pdf at all"))).status, 415);
    assert.equal((await call("owner", "PUT", url, Buffer.alloc(0))).status, 400);
    assert.equal((await call("owner", "PUT", `/study/pages/${m.page._id}/pdf-assets/..%2Fx`, pdf("x"))).status, 400);
    assert.equal((await call("owner", "HEAD", url)).status, 404);
    assert.equal((await call("owner", "GET", url)).status, 404);

    const first = await call("owner", "PUT", url, pdf("one"));
    assert.equal(first.status, 201);
    assert.equal(first.body.created, true);
    // Idempotent: a second PUT (even different bytes) is 200 and rewrites nothing.
    const again = await call("owner", "PUT", url, pdf("two"));
    assert.equal(again.status, 200);
    assert.equal(again.body.created, false);
    assert.equal((await call("owner", "HEAD", url)).status, 200);

    const got = await call("owner", "GET", url);
    assert.equal(got.status, 200);
    assert.ok((await fetchUrl(got.body.url)).equals(pdf("one")));
    // Stored under the owner's account, by asset id.
    assert.ok(await stored(users.owner.id, A1));

    const list = await call("owner", "GET", `/study/pages/${m.page._id}/pdf-assets?ids=${A1},${A2}`);
    assert.deepEqual(list.body.present, [A1]);
    assert.equal((await call("owner", "GET", `/study/pages/${m.page._id}/pdf-assets`)).status, 400);
  });

  test("account-scoped: an old install uploads without a page, and the page route finds it", async () => {
    assert.equal((await call("owner", "PUT", `/study/pdf-assets/${A2}`, pdf("two"))).status, 201);
    assert.equal((await call("owner", "HEAD", `/study/pdf-assets/${A2}`)).status, 200);
    assert.deepEqual((await call("owner", "GET", `/study/pdf-assets?ids=${A1},${A2},nope`)).body.present, [A1, A2]);
    const got = await call("owner", "GET", `/study/pages/${m.page._id}/pdf-assets/${A2}`);
    assert.ok((await fetchUrl(got.body.url)).equals(pdf("two")));
    // Someone else's account store is their own: the same id is not there.
    assert.equal((await call("stranger", "HEAD", `/study/pdf-assets/${A2}`)).status, 404);
  });

  test("sharing: editors read and write the owner's store, viewers and link holders read, strangers get 404", async () => {
    const res = await call("owner", "POST", "/share", {
      resourceType: "notebook",
      resourceId: String(m.page._id),
      emails: [{ email: "maya@example.test", role: "editor" }, "viewer@example.test"],
      link: true,
    });
    assert.equal(res.status, 201);
    shareId = res.body.share.id;
    linkToken = res.body.share.link.token;

    const NEW = "b1e4c1a0-0000-4000-8000-00000000abcd";
    const url = `/study/pages/${m.page._id}/pdf-assets`;
    // Editor writes, into the OWNER's store.
    assert.equal((await call("maya", "PUT", `${url}/${NEW}`, pdf("maya"))).status, 201);
    assert.ok(await stored(users.owner.id, NEW));
    assert.equal(await stored(users.maya.id, NEW), false);
    assert.equal((await call("maya", "GET", `${url}/${A1}`)).status, 200);
    // Named viewer reads, never writes.
    assert.equal((await call("viewer", "GET", `${url}/${A1}`)).status, 200);
    assert.deepEqual((await call("viewer", "GET", `${url}?ids=${A1}`)).body.present, [A1]);
    assert.equal((await call("viewer", "PUT", `${url}/viewer-asset`, pdf("v"))).status, 404);
    // Stranger: nothing, not even existence.
    assert.equal((await call("stranger", "GET", `${url}/${A1}`)).status, 404);
    assert.equal((await call("stranger", "HEAD", `${url}/${A1}`)).status, 404);
    assert.equal((await call("stranger", "PUT", `${url}/${A1}`, pdf("s"))).status, 404);
    assert.equal((await call(null, "GET", `${url}/${A1}`)).status, 401);

    // Through the share: the view's id for named people, the link token for anyone signed in.
    const viaShare = await call("viewer", "GET", `/share/view/${shareId}/pdf-assets/${A1}`);
    assert.equal(viaShare.status, 200);
    assert.ok((await fetchUrl(viaShare.body.url)).equals(pdf("one")));
    assert.equal((await call("stranger", "GET", `/study/share/view/${linkToken}/pdf-assets/${A2}`)).status, 200);
    assert.equal((await call("stranger", "GET", `/share/view/${shareId}/pdf-assets/${A1}`)).status, 404);
    assert.equal((await call("viewer", "GET", `/share/view/${shareId}/pdf-assets/missing-one`)).status, 404);
  });

  test("a copy from a share takes the PDFs along; deleting the account removes them", async () => {
    const fork = await call("copier", "POST", `/share/fork/${linkToken}`);
    assert.equal(fork.status, 201);
    assert.ok(await stored(users.copier.id, A1));
    assert.ok(await stored(users.copier.id, A2));
    const got = await call("copier", "GET", `/study/pages/${fork.body.resourceId}/pdf-assets/${A1}`);
    assert.equal(got.status, 200);
    assert.ok((await fetchUrl(got.body.url)).equals(pdf("one")));

    await m.accounts.deleteAccount(users.owner.id);
    assert.equal(await stored(users.owner.id, A1), false);
    assert.equal(await stored(users.owner.id, A2), false);
    // The copy keeps its own.
    assert.ok(await stored(users.copier.id, A1));
  });
});
