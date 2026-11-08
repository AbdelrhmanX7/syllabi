#!/usr/bin/env node
/**
 * Smoke test for a running Syllabi server.
 *
 *   SMOKE_BASE_URL=http://127.0.0.1:5000 SMOKE_LOGIN=owner@example.com SMOKE_PASSWORD=... node scripts/smoke.mjs
 *
 * Signs in with the owner account (POST /admin/login), creates a manual class and a page, then
 * hits a representative GET under every /study prefix the app routes to this server. Any 5xx or
 * 404 (or a network error) fails the run with exit code 1. Needs Node 18+ (global fetch).
 * The class and page it creates are deleted again at the end.
 */

const BASE = (process.env.SMOKE_BASE_URL || "http://127.0.0.1:5000").replace(/\/+$/, "");
const LOGIN = process.env.SMOKE_LOGIN || process.env.ADMIN_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD || process.env.ADMIN_PASSWORD;

if (!LOGIN || !PASSWORD) {
  console.error("Set SMOKE_LOGIN (the owner email) and SMOKE_PASSWORD (or ADMIN_EMAIL + ADMIN_PASSWORD).");
  process.exit(2);
}

const results = [];
let token = "";

async function call(method, path, { body, expect, auth = true, accept, emptyIs404 = false, contentType } = {}) {
  const headers = {};
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = contentType || "application/json";
  if (accept) headers.Accept = accept;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  let status = 0;
  let data = null;
  let error = "";
  try {
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      signal: ctrl.signal,
      redirect: "manual",
    });
    status = res.status;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("text/event-stream")) {
      await res.body?.cancel().catch(() => {});
    } else {
      const text = await res.text();
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text.slice(0, 200);
      }
    }
  } catch (e) {
    error = e?.name === "AbortError" ? "timeout" : String(e?.message || e);
  } finally {
    clearTimeout(timer);
  }
  // emptyIs404: the route answers its own 404 {code:"NOT_FOUND"} for "nothing stored yet" (the app
  // reads that as empty); an unmatched route (Express "Cannot GET") still fails.
  const routeOwn404 = emptyIs404 && status === 404 && data && typeof data === "object" && data.code === "NOT_FOUND";
  const allowed = expect ? expect.includes(status) : (status > 0 && status < 500 && status !== 404) || routeOwn404;
  const ok = !error && allowed;
  const msg = error || (ok ? "" : typeof data === "object" && data ? JSON.stringify(data).slice(0, 200) : String(data ?? ""));
  results.push({ method, path, status, ok, msg });
  console.log(`${ok ? "ok  " : "FAIL"} ${String(status || "---").padEnd(3)} ${method.padEnd(6)} ${path}${msg && !ok ? `  ${msg}` : ""}`);
  return { status, data, ok };
}

const idOf = (d) => d?.id ?? d?._id ?? d?.class?.id ?? d?.class?._id ?? d?.page?.id ?? d?.page?._id ?? null;

async function main() {
  await call("GET", "/health", { auth: false, expect: [200] });
  await call("GET", "/admin/setup", { auth: false, expect: [200] });
  await call("POST", "/admin/login", { auth: false, body: { email: "nobody@example.invalid", password: "wrong-password" }, expect: [400, 401] });
  // The app's login request still names the field `phoneNumber` (it carries the email).
  const login = await call("POST", "/admin/login", { auth: false, body: { phoneNumber: LOGIN, password: PASSWORD }, expect: [200] });
  token = login.data?.token || "";
  if (!token) {
    console.error("Login failed; cannot continue.");
    process.exit(1);
  }
  await call("GET", "/admin/me", { expect: [200] });
  await call("GET", "/study/classes", { auth: false, expect: [401, 403] });

  // Writes: a manual class and a note page inside it.
  const cls = await call("POST", "/study/classes", { body: { name: "Smoke Test 101", code: "SMK 101" }, expect: [200, 201] });
  const classId = idOf(cls.data);
  const page = await call("POST", "/study/pages", { body: { title: "Smoke page", kind: "note", ...(classId ? { classId } : {}) }, expect: [200, 201] });
  const pageId = idOf(page.data);

  // One representative GET per LIVE_ROUTES prefix.
  await call("GET", "/study/canvas/connection");
  await call("GET", "/study/classes");
  if (classId) {
    await call("GET", `/study/classes/${classId}/items`);
    await call("GET", `/study/classes/${classId}/modules`);
    await call("GET", `/study/classes/${classId}/grade-plan`);
    await call("GET", `/study/classes/${classId}/a-plan`);
    await call("GET", `/study/classes/${classId}/library`);
    await call("GET", `/study/classes/${classId}/library/search?q=cell`);
    await call("GET", `/study/classes/${classId}/guide`);
    await call("GET", `/study/classes/${classId}/exams-schedule`);
    await call("GET", `/study/classes/${classId}/exam-blueprint`);
    await call("GET", `/study/classes/${classId}/exam-results`);
    await call("GET", `/study/classes/${classId}/lab-specimens`);
  }
  // Ids that don't exist: the route's own 404 {code:"NOT_FOUND"} proves it is mounted.
  const ghost = "0123456789abcdef01234567";
  await call("GET", `/study/items/${ghost}`, { emptyIs404: true });
  await call("GET", `/study/videos/${ghost}/transcript`, { emptyIs404: true });
  await call("GET", `/study/library/${ghost}`, { emptyIs404: true });
  // 503 = LibreOffice not installed on this host (the Docker image has it).
  await call("POST", "/study/convert/pdf", { body: "smoke test", contentType: "text/plain", expect: [200, 503] });
  await call("GET", "/study/today");
  await call("GET", "/study/pages");
  if (pageId) {
    await call("GET", `/study/pages/${pageId}`);
    await call("GET", `/study/pages/${pageId}/content`);
    await call("GET", `/study/pages/${pageId}/renders`);
    await call("GET", `/study/pages/${pageId}/annotations`);
    await call("GET", `/study/pages/${pageId}/ruler`);
    await call("PATCH", `/study/pages/${pageId}`, { body: { title: "Smoke page (renamed)" }, expect: [200] });
  }
  await call("GET", "/study/search?q=smoke");
  await call("GET", "/study/questions");
  await call("GET", "/study/review/next");
  await call("GET", "/study/mastery");
  await call("GET", "/study/lectures");
  await call("GET", "/study/exams");
  await call("GET", "/study/code/projects");
  await call("GET", "/study/mcp/keys");
  await call("GET", "/study/mcp/connections");
  await call("GET", "/study/.well-known/oauth-protected-resource", { auth: false, expect: [200] });
  await call("GET", "/study/.well-known/oauth-authorization-server", { auth: false, expect: [200] });
  await call("GET", "/study/mcp", { auth: false, expect: [401, 405] });
  await call("GET", "/study/inbox");
  await call("GET", "/study/inbox/tokens");
  if (classId) await call("GET", `/study/concept-maps?classId=${classId}`);
  await call("GET", "/study/handwriting/bank", { emptyIs404: true });
  await call("GET", "/study/drawing-profile");
  await call("GET", "/study/telemetry/perf");
  await call("GET", "/study/ai/conversations");

  // Clean up what this run created.
  if (pageId) await call("DELETE", `/study/pages/${pageId}`, { expect: [200, 204] });
  if (classId) await call("DELETE", `/study/classes/${classId}`, { expect: [200, 204] });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log("Failures:");
    for (const f of failed) console.log(`  ${f.status || "---"} ${f.method} ${f.path}  ${f.msg}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
