/**
 * Claude AI for non-premium accounts: access tiers, the router's tier mapping, cost math, the
 * monthly cap, the daily limit, the Claude-first / DeepSeek-fallback flow and the gates.
 * Never reaches a network or a database: the Claude client, the router fetch, the month-spend
 * loader and the daily counter are all fakes.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { aiTierOf, aiTierOfAccount, claudeOpen, claudeUntil } from "../src/auth/ai-access";
import { buildRouterRequest, ROUTER_SNIPPET_CHARS, routeClaudeTier, tierFromAnswers } from "../src/services/ai/claude-router";
import { claudeCostUsd, claudeMaxTokens, ClaudeError, setClaudeClientForTests, type ClaudeClientLike } from "../src/services/ai/claude";
import {
  assertClaudeBudget,
  countClaudeRequest,
  monthlyBudgetUsd,
  noteClaudeSpend,
  setDailyCounterForTests,
  setMonthSpendLoaderForTests,
} from "../src/services/ai/claude-budget";
import { claudeForSpend } from "../src/services/study/ai-claude";
import { newSpend, spendTotal } from "../src/services/study/ai-models";
import { classifyAiError } from "../src/services/study/ai-errors";
import { requirePremiumAi, requireVerifiedEmail } from "../src/auth/verified";
import { publicAccount } from "../src/auth/accounts";
import { inkAnswersFromClaude, parseInkAnswers } from "../src/services/study/ink-classify";

const KEY = { ANTHROPIC_API_KEY: "sk-test" } as NodeJS.ProcessEnv;

describe("access tiers", () => {
  test("no key → Claude closed; premium unaffected", () => {
    assert.equal(claudeOpen(new Date(), {} as NodeJS.ProcessEnv), false);
    assert.equal(aiTierOf("user", false, {} as NodeJS.ProcessEnv), "none");
    assert.equal(aiTierOf("user", true, {} as NodeJS.ProcessEnv), "premium");
    assert.equal(aiTierOf("owner", false, {} as NodeJS.ProcessEnv), "premium");
  });

  test("key set → every non-premium account is on the Claude route", () => {
    assert.equal(aiTierOf("user", false, KEY), "claude");
    assert.equal(aiTierOf("user", true, KEY), "premium");
    assert.equal(aiTierOf("admin", undefined, KEY), "premium");
  });

  test("CLAUDE_AI_UNTIL: a date-only value lasts through the end of that UTC day", () => {
    const env = { ...KEY, CLAUDE_AI_UNTIL: "2026-11-30" };
    assert.equal(claudeUntil(env)?.toISOString(), "2026-11-30T23:59:59.999Z");
    assert.equal(claudeOpen(new Date("2026-11-30T22:00:00Z"), env), true);
    assert.equal(claudeOpen(new Date("2026-12-01T00:00:00Z"), env), false);
    // The route stays on past the date (text moves to DeepSeek, see claudeForSpend); only the key turns it off.
    assert.equal(aiTierOf("user", false, env), "claude");
    assert.equal(aiTierOf("user", true, env), "premium");
  });

  test("CLAUDE_AI_UNTIL: a full timestamp is exact; garbage means no end", () => {
    const env = { ...KEY, CLAUDE_AI_UNTIL: "2026-11-15T12:00:00Z" };
    assert.equal(claudeOpen(new Date("2026-11-15T11:59:59Z"), env), true);
    assert.equal(claudeOpen(new Date("2026-11-15T12:00:01Z"), env), false);
    assert.equal(claudeOpen(new Date("2030-01-01"), { ...KEY, CLAUDE_AI_UNTIL: "soon" }), true);
  });

  test("background paths: an unverified account gets no Claude AI", () => {
    assert.equal(aiTierOfAccount({ role: "user", premium: false, isVerified: false }, KEY), "none");
    assert.equal(aiTierOfAccount({ role: "user", premium: false, isVerified: true }, KEY), "claude");
    assert.equal(aiTierOfAccount({ role: "user", premium: true, isVerified: false }, KEY), "premium");
  });
});

describe("router", () => {
  const ans = (hard: [string, number], simple: [string, number], long: [string, number]) => ({
    hard: { choice: hard[0], confidence: hard[1] },
    simple: { choice: simple[0], confidence: simple[1] },
    long: { choice: long[0], confidence: long[1] },
  });

  test("tier mapping leans cheap: opus only when clearly hard", () => {
    assert.equal(tierFromAnswers(ans(["yes", 0.9], ["no", 0.9], ["yes", 0.8])), "opus");
    assert.equal(tierFromAnswers(ans(["yes", 0.5], ["no", 0.9], ["no", 0.8])), "sonnet");
    assert.equal(tierFromAnswers(ans(["no", 0.9], ["yes", 0.8], ["no", 0.9])), "haiku");
    assert.equal(tierFromAnswers(ans(["no", 0.9], ["yes", 0.8], ["yes", 0.7])), "sonnet");
    assert.equal(tierFromAnswers(ans(["no", 0.9], ["no", 0.9], ["no", 0.9])), "sonnet");
    assert.equal(tierFromAnswers(null), "sonnet");
    assert.equal(tierFromAnswers({ hard: { choice: "yes" } }), "sonnet");
  });

  test("request carries the feature and only a snippet of the turn", () => {
    const body: any = buildRouterRequest("grading", "x".repeat(ROUTER_SNIPPET_CHARS * 4));
    assert.equal(body.state.feature, "grading");
    assert.ok(body.state.request.length < ROUTER_SNIPPET_CHARS + 20);
    assert.deepEqual(Object.keys(body.questions).sort(), ["hard", "long", "simple"]);
    assert.equal(body.questions.hard.type, "choice");
  });

  test("answer → tier, cost and model; failure / timeout / no key → sonnet", async () => {
    const ok = (async () =>
      new Response(JSON.stringify({ model: "typesafe/jev-1.13", usage: { cost: 0.0001 }, answers: ans(["yes", 0.95], ["no", 1], ["no", 1]) }), { status: 200 })) as unknown as typeof fetch;
    assert.deepEqual(await routeClaudeTier("f", "prove it", { apiKey: "k", fetchImpl: ok }), { tier: "opus", costUsd: 0.0001, model: "typesafe/jev-1.13" });

    const bad = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    assert.equal((await routeClaudeTier("f", "q", { apiKey: "k", fetchImpl: bad })).tier, "sonnet");

    const slow = ((_u: string, init: RequestInit) =>
      new Promise((_r, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    const t0 = Date.now();
    const r = await routeClaudeTier("f", "q", { apiKey: "k", fetchImpl: slow, timeoutMs: 50 });
    assert.equal(r.tier, "sonnet");
    assert.ok(Date.now() - t0 < 1000);

    assert.equal((await routeClaudeTier("f", "q", { apiKey: "" })).tier, "sonnet");
  });
});

describe("cost math", () => {
  test("input + output at the model's rate", () => {
    assert.equal(claudeCostUsd("claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 0 }), 2);
    assert.equal(claudeCostUsd("claude-sonnet-5-5", { input_tokens: 0, output_tokens: 1_000_000 }), 10);
    assert.equal(claudeCostUsd("claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000 }), 24);
    assert.ok(Math.abs(claudeCostUsd("claude-haiku-5-5", { input_tokens: 10_000, output_tokens: 2_000 }) - (0.001 + 0.001)) < 1e-12);
  });

  test("cache reads at 10% of input, cache writes at 125%", () => {
    const c = claudeCostUsd("claude-opus-5-5", { input_tokens: 0, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, output_tokens: 0 });
    assert.ok(Math.abs(c - (0.4 + 5)) < 1e-9);
  });

  test("haiku past 100K prompt tokens uses the higher rate; unknown model priced as opus", () => {
    const c = claudeCostUsd("claude-haiku-5-5", { input_tokens: 150_000, output_tokens: 1_000 });
    assert.ok(Math.abs(c - (150_000 * 0.5 + 1_000 * 2.5) / 1e6) < 1e-12);
    assert.equal(claudeCostUsd("claude-new", { input_tokens: 1_000_000 }), 4);
    assert.equal(claudeCostUsd("claude-sonnet-5-5", null), 0);
  });

  test("max_tokens gets headroom for thinking", () => {
    assert.equal(claudeMaxTokens(800, "low"), 2048);
    assert.equal(claudeMaxTokens(8192, "medium"), 16384);
    assert.equal(claudeMaxTokens(100_000, "high"), 64_000);
  });
});

describe("monthly cap and daily limit", () => {
  afterEach(() => {
    setMonthSpendLoaderForTests(null);
    setDailyCounterForTests(null);
  });

  test("default cap 195, env override", () => {
    assert.equal(monthlyBudgetUsd({} as NodeJS.ProcessEnv), 195);
    assert.equal(monthlyBudgetUsd({ CLAUDE_MONTHLY_BUDGET_USD: "50" } as NodeJS.ProcessEnv), 50);
    assert.equal(monthlyBudgetUsd({ CLAUDE_MONTHLY_BUDGET_USD: "x" } as NodeJS.ProcessEnv), 195);
  });

  test("under the cap passes, at the cap throws AI_BUDGET with the plain message", async () => {
    setMonthSpendLoaderForTests(async () => 100);
    await assertClaudeBudget(new Date("2026-11-08T10:00:00Z"), {} as NodeJS.ProcessEnv);
    setMonthSpendLoaderForTests(async () => 195);
    await assert.rejects(assertClaudeBudget(new Date("2026-11-08T10:00:00Z"), {} as NodeJS.ProcessEnv), (e: any) => e.code === "AI_BUDGET" && e.message === "The AI is resting until next month.");
  });

  test("sum is cached 60 s, local spend counts at once, month start is UTC", async () => {
    let calls = 0;
    let since: Date | null = null;
    setMonthSpendLoaderForTests(async (s) => {
      calls++;
      since = s;
      return 190;
    });
    const t = new Date("2026-11-08T10:00:00Z");
    await assertClaudeBudget(t, {} as NodeJS.ProcessEnv);
    assert.equal(since!.toISOString(), "2026-11-01T00:00:00.000Z");
    noteClaudeSpend(6);
    await assert.rejects(assertClaudeBudget(new Date(t.getTime() + 30_000), {} as NodeJS.ProcessEnv), (e: any) => e.code === "AI_BUDGET");
    assert.equal(calls, 1);
    await assertClaudeBudget(new Date(t.getTime() + 61_000), {} as NodeJS.ProcessEnv); // re-read: 190 again, local reset
    assert.equal(calls, 2);
  });

  test("a failed sum read lets the call through", async () => {
    setMonthSpendLoaderForTests(async () => {
      throw new Error("db down");
    });
    await assertClaudeBudget(new Date(), {} as NodeJS.ProcessEnv);
  });

  test("daily limit: 150 by default, the 151st request is refused", async () => {
    let n = 149;
    setDailyCounterForTests(async () => ++n);
    const uid = "64b000000000000000000001";
    await countClaudeRequest(uid, Date.now(), {} as NodeJS.ProcessEnv); // 150
    await assert.rejects(countClaudeRequest(uid, Date.now(), {} as NodeJS.ProcessEnv), (e: any) => e.code === "AI_DAILY_LIMIT" && /try again tomorrow/.test(e.message));
    n = 0;
    await countClaudeRequest(uid, Date.now(), { CLAUDE_DAILY_REQUESTS: "0" } as NodeJS.ProcessEnv); // 0 = off
    assert.equal(n, 0);
  });
});

// ─── Claude-first flow with a fake client ───────────────────────────────────────────────

type Reply = { text?: string; stop?: string; model?: string; usage?: Record<string, number>; throws?: Error; deltas?: string[] };

function fakeClient(replies: Reply[], seen: any[]): ClaudeClientLike {
  return {
    messages: {
      stream(body: any) {
        seen.push(body);
        const r = replies.shift() ?? { text: "{}" };
        let onText: ((d: string) => void) | null = null;
        return {
          on(_e: "text", cb: (d: string) => void) {
            onText = cb;
            return this;
          },
          async finalMessage() {
            for (const d of r.deltas ?? []) onText?.(d);
            if (r.throws) throw r.throws;
            return {
              model: r.model ?? body.model,
              stop_reason: r.stop ?? "end_turn",
              content: [{ type: "thinking", thinking: "" }, { type: "text", text: r.text ?? "" }],
              usage: r.usage ?? { input_tokens: 1000, output_tokens: 100 },
            } as any;
          },
        };
      },
    },
  };
}

describe("claudeForSpend", () => {
  const uid = "64b000000000000000000002";
  let seen: any[];
  let envBefore: NodeJS.ProcessEnv;
  beforeEach(() => {
    seen = [];
    envBefore = { ...process.env };
    process.env.ANTHROPIC_API_KEY = "sk-test";
    delete process.env.CLAUDE_AI_UNTIL;
    delete process.env.OPENROUTER_API_KEY; // "auto" → router has no key → sonnet, no network
    setMonthSpendLoaderForTests(async () => 0);
    setDailyCounterForTests(async () => 1);
  });
  afterEach(() => {
    process.env = envBefore;
    setClaudeClientForTests(null);
    setMonthSpendLoaderForTests(null);
    setDailyCounterForTests(null);
  });

  test("records the model and cost; request follows the current API rules", async () => {
    setClaudeClientForTests(fakeClient([{ text: '{"ok":1}', usage: { input_tokens: 1_000_000, output_tokens: 0 } }], seen));
    const spend = newSpend("claude", uid);
    const img = Buffer.from("not-an-image-but-long-enough-for-the-test-123456789");
    const out = await claudeForSpend(spend, { kind: "vision", choice: "sonnet", system: "SYS", user: "read it", images: [{ data: img, mime: "image/png" }], maxTokens: 1000, json: true });
    assert.equal(out, '{"ok":1}');
    assert.deepEqual(spend.models, ["anthropic/claude-sonnet-5-5"]);
    assert.equal(spend.visionCostUsd, 2);
    assert.equal(spendTotal(spend), 2);
    const body = seen[0];
    assert.equal(body.model, "claude-sonnet-5-5");
    assert.equal(body.thinking, undefined);
    assert.equal(body.temperature, undefined);
    assert.deepEqual(body.output_config, { effort: "medium" });
    assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
    assert.match(body.system[0].text, /^SYS/);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].role, "user");
    assert.equal(body.messages[0].content[0].type, "image");
    assert.equal(body.messages[0].content.at(-1).type, "text");
  });

  test("images are shrunk to a 1568 px long side and sent as JPEG", async () => {
    const sharp = (await import("sharp")).default;
    const big = await sharp({ create: { width: 4000, height: 2000, channels: 3, background: "#88aacc" } }).png().toBuffer();
    setClaudeClientForTests(fakeClient([{ text: "ok" }], seen));
    await claudeForSpend(newSpend("claude", uid), { kind: "vision", choice: "haiku", system: "s", user: "u", images: [{ data: big, mime: "image/png" }], maxTokens: 10 });
    const block = seen[0].messages[0].content[0];
    assert.equal(block.source.media_type, "image/jpeg");
    const meta = await sharp(Buffer.from(block.source.data, "base64")).metadata();
    assert.equal(meta.width, 1568);
    assert.equal(meta.height, 784);
  });

  test("haiku runs at low effort; opus at high", async () => {
    setClaudeClientForTests(fakeClient([{ text: "a" }, { text: "b" }], seen));
    await claudeForSpend(newSpend("claude", uid), { kind: "text", choice: "haiku", system: "s", user: "u", maxTokens: 500 });
    await claudeForSpend(newSpend("claude", uid), { kind: "text", choice: "opus", system: "s", user: "u", maxTokens: 500 });
    assert.equal(seen[0].model, "claude-haiku-5-5");
    assert.deepEqual(seen[0].output_config, { effort: "low" });
    assert.equal(seen[1].model, "claude-opus-5-5");
    assert.deepEqual(seen[1].output_config, { effort: "high" });
  });

  test("premium or no-AI spends never reach Claude", async () => {
    setClaudeClientForTests(fakeClient([], seen));
    await assert.rejects(claudeForSpend(newSpend("none", uid), { kind: "text", choice: "haiku", system: "s", user: "u", maxTokens: 10 }), (e: any) => e.code === "AI_NOT_ENABLED");
    await assert.rejects(claudeForSpend(newSpend("premium", uid), { kind: "text", choice: "haiku", system: "s", user: "u", maxTokens: 10 }), (e: any) => e.code === "AI_NOT_ENABLED");
    assert.equal(seen.length, 0);
  });

  test("a refusal is a plain error, its cost still counted", async () => {
    setClaudeClientForTests(fakeClient([{ stop: "refusal", text: "" }], seen));
    const spend = newSpend("claude", uid);
    await assert.rejects(claudeForSpend(spend, { kind: "vision", choice: "haiku", system: "s", user: "u", maxTokens: 10 }), (e: any) => e.code === "AI_REFUSED");
    assert.ok(spend.visionCostUsd > 0);
  });

  test("text: over the cap → DeepSeek answers, Claude is not called", async () => {
    setMonthSpendLoaderForTests(async () => 500);
    setClaudeClientForTests(fakeClient([], seen));
    const spend = newSpend("claude", uid);
    const out = await claudeForSpend(spend, { kind: "text", choice: "auto", system: "s", user: "u", maxTokens: 10, deepseek: async () => "from-deepseek" });
    assert.equal(out, "from-deepseek");
    assert.equal(seen.length, 0);
  });

  test("past CLAUDE_AI_UNTIL: text runs on DeepSeek, picture reading rests", async () => {
    process.env.CLAUDE_AI_UNTIL = "2020-01-01";
    setClaudeClientForTests(fakeClient([], seen));
    assert.equal(await claudeForSpend(newSpend("claude", uid), { kind: "text", choice: "auto", system: "s", user: "u", maxTokens: 10, deepseek: async () => "ds" }), "ds");
    await assert.rejects(claudeForSpend(newSpend("claude", uid), { kind: "vision", choice: "haiku", system: "s", user: "u", maxTokens: 10 }), (e: any) => e.code === "AI_BUDGET");
    assert.equal(seen.length, 0);
  });

  test("a reply the caller can't use (bad JSON) falls back to DeepSeek, its cost still counted", async () => {
    setClaudeClientForTests(fakeClient([{ text: '{"cut": "half', stop: "max_tokens" }], seen));
    const spend = newSpend("claude", uid);
    const out = await claudeForSpend(spend, { kind: "text", choice: "sonnet", system: "s", user: "u", maxTokens: 10, json: true, accept: (t) => { try { JSON.parse(t); return true; } catch { return false; } }, deepseek: async () => '{"ok":true}' });
    assert.equal(out, '{"ok":true}');
    assert.ok(spend.textCostUsd > 0);
  });

  test("vision over the cap → AI_BUDGET (no fallback)", async () => {
    setMonthSpendLoaderForTests(async () => 500);
    setClaudeClientForTests(fakeClient([], seen));
    await assert.rejects(claudeForSpend(newSpend("claude", uid), { kind: "vision", choice: "sonnet", system: "s", user: "u", maxTokens: 10 }), (e: any) => e.code === "AI_BUDGET");
  });

  test("text: a failed Claude call falls back to DeepSeek; when both fail the Claude reason wins", async () => {
    setClaudeClientForTests(fakeClient([{ throws: new Error("overloaded") }, { throws: new ClaudeError("AI_BUDGET", "The AI is resting until next month.") }], seen));
    assert.equal(await claudeForSpend(newSpend("claude", uid), { kind: "text", choice: "sonnet", system: "s", user: "u", maxTokens: 10, deepseek: async () => "ds" }), "ds");
    await assert.rejects(
      claudeForSpend(newSpend("claude", uid), {
        kind: "text",
        choice: "sonnet",
        system: "s",
        user: "u",
        maxTokens: 10,
        deepseek: async () => {
          throw new Error("deepseek down");
        },
      }),
      (e: any) => e.code === "AI_BUDGET"
    );
  });

  test("streaming: once Claude text reached the student there is no fallback", async () => {
    setClaudeClientForTests(fakeClient([{ deltas: ["Hel"], throws: new Error("cut") }], seen));
    const got: string[] = [];
    let ds = 0;
    await assert.rejects(
      claudeForSpend(newSpend("claude", uid), { kind: "text", choice: "sonnet", system: "s", user: "u", maxTokens: 10, onDelta: (t) => got.push(t), deepseek: async () => (ds++, "x") }),
      /cut/
    );
    assert.deepEqual(got, ["Hel"]);
    assert.equal(ds, 0);
  });

  test("daily limit: counted once per spend; past it the request is refused before any model", async () => {
    let n = 0;
    setDailyCounterForTests(async () => ++n);
    setClaudeClientForTests(fakeClient([{ text: "a" }, { text: "b" }], seen));
    const spend = newSpend("claude", uid);
    await claudeForSpend(spend, { kind: "text", choice: "haiku", system: "s", user: "u", maxTokens: 10 });
    await claudeForSpend(spend, { kind: "text", choice: "haiku", system: "s", user: "u", maxTokens: 10 });
    assert.equal(n, 1);
    setDailyCounterForTests(async () => 151);
    await assert.rejects(claudeForSpend(newSpend("claude", uid), { kind: "text", choice: "haiku", system: "s", user: "u", maxTokens: 10, deepseek: async () => "x" }), (e: any) => e.code === "AI_DAILY_LIMIT");
  });

  test("errors reach the app with their code", () => {
    assert.deepEqual(classifyAiError(new ClaudeError("AI_BUDGET", "The AI is resting until next month.")), { code: "AI_BUDGET", message: "The AI is resting until next month." });
    assert.equal(classifyAiError(new ClaudeError("AI_DAILY_LIMIT", "m")).code, "AI_DAILY_LIMIT");
    assert.deepEqual(classifyAiError(new ClaudeError("AI_FAILED", "x"), { code: "AI_FAILED", message: "fallback" }), { code: "AI_FAILED", message: "fallback" });
  });
});

describe("gates and the account payload", () => {
  const res = () => {
    const r: any = { statusCode: 200, body: null };
    r.status = (c: number) => ((r.statusCode = c), r);
    r.json = (b: unknown) => ((r.body = b), r);
    return r;
  };
  const run = (mw: any, req: any) => {
    const r = res();
    let passed = false;
    mw(req, r, () => (passed = true));
    return { passed, status: r.statusCode, code: r.body?.code };
  };

  test("text/vision routes: Claude-route accounts pass once verified", () => {
    assert.equal(run(requireVerifiedEmail, { aiEnabled: true, aiRoute: "claude", emailVerified: true }).passed, true);
    assert.equal(run(requireVerifiedEmail, { aiEnabled: true, aiRoute: "claude", emailVerified: false }).code, "EMAIL_NOT_VERIFIED");
    assert.equal(run(requireVerifiedEmail, { aiEnabled: false, aiRoute: "premium", emailVerified: true }).code, "AI_NOT_ENABLED");
  });

  test("voice/image routes: premium only", () => {
    assert.equal(run(requirePremiumAi, { aiEnabled: true, aiRoute: "premium", emailVerified: true }).passed, true);
    const r = run(requirePremiumAi, { aiEnabled: true, aiRoute: "claude", emailVerified: true });
    assert.equal(r.passed, false);
    assert.equal(r.status, 403);
    assert.equal(r.code, "VOICE_NOT_ENABLED");
  });

  test("/auth/me reports AI on for everyone while Claude is open; voice stays premium", () => {
    const before = process.env.ANTHROPIC_API_KEY;
    try {
      delete process.env.ANTHROPIC_API_KEY;
      assert.equal(publicAccount({ _id: "a", role: "user", premium: false }).premium, false);
      process.env.ANTHROPIC_API_KEY = "sk-test";
      const u = publicAccount({ _id: "a", role: "user", premium: false });
      assert.equal(u.premium, true);
      assert.equal(u.voiceAi, false);
      assert.equal(publicAccount({ _id: "b", role: "user", premium: true }).voiceAi, true);
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
    }
  });

  test("ink classify: Claude's labels map onto the same results", () => {
    const answers = inkAnswersFromClaude({ results: [{ i: 0, cls: "heading", confidence: 0.9 }, { i: 2, cls: "keypoint", confidence: 0.7 }, { i: 1, cls: "nonsense" }] });
    const out = parseInkAnswers(answers, 3, [0, 1, 2]);
    assert.deepEqual(out, [
      { cls: "heading", confidence: 0.9 },
      { cls: "plain", confidence: 0 },
      { cls: "keypoint", confidence: 0.7 },
    ]);
  });
});
