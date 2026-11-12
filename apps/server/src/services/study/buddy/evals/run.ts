/* eslint-disable no-console */
import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose, { Types } from "mongoose";
import sharp from "sharp";
import { newSpend, spendTotal } from "../../ai-models";
import { runBuddyTurn } from "../turn";
import { BUDDY_EVAL_CASES, renderAsk, renderCase, type EvalReply } from "./cases";

/**
 * Runs the buddy's cases against the real models and writes a report (JSON + readable text).
 *   node dist/services/study/buddy/evals/run.js [--routes claude,premium] [--only id,id] [--out dir]
 * Nothing is saved to the account: turns run dry (no turn log, no memory, no page image).
 * Exit code 1 when a check failed.
 */
const arg = (name: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
};

async function main() {
  const routes = (arg("routes") ?? "claude,premium").split(",") as Array<"claude" | "premium">;
  const only = arg("only")?.split(",");
  const outDir = arg("out") ?? path.join(process.cwd(), "evals-out");
  const uri = process.env.MONGODB_URL || process.env.MONGODB_URI || process.env.MONGO_URL || process.env.MONGO_URI;
  if (uri) await mongoose.connect(uri);
  const userId = new Types.ObjectId("000000000000000000000001");
  const cases = BUDDY_EVAL_CASES.filter((c) => !only || only.includes(c.id));
  const rows: any[] = [];
  for (const route of routes) {
    // Three at a time: quick enough, and gentle on the providers.
    for (let i = 0; i < cases.length; i += 3) {
      await Promise.all(
        cases.slice(i, i + 3).map(async (c) => {
          const { svg, clusters } = renderCase(c.lines);
          const image = await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
          const ask = c.askByHand ? await sharp(Buffer.from(renderAsk(c.askByHand))).jpeg({ quality: 88 }).toBuffer() : null;
          const spend = newSpend(route, String(userId));
          const t0 = Date.now();
          let reply: EvalReply | null = null;
          let error: string | null = null;
          try {
            const turn = await runBuddyTurn({ userId, image, mime: "image/jpeg", input: { question: c.question, clusters, v: 3, ...(c.skill ? { skill: c.skill } : {}) }, ask, spend, dryRun: true, ...(c.memory ? { memory: c.memory } : {}) });
            reply = turn ? (turn.reply as EvalReply) : null;
            if (!turn) error = "no usable answer";
          } catch (e) {
            error = String((e as Error)?.message ?? e).slice(0, 300);
          }
          const checks = c.checks.map((check) => {
            let ok = false;
            try {
              ok = !!reply && check.pass(reply);
            } catch {
              ok = false;
            }
            return { name: check.name, ok };
          });
          rows.push({ id: c.id, route, ms: Date.now() - t0, costUsd: Number(spendTotal(spend).toFixed(5)), models: [...new Set(spend.models)], ok: checks.every((x) => x.ok), checks, error, reply });
        })
      );
    }
  }
  rows.sort((a, b) => a.route.localeCompare(b.route) || cases.findIndex((c) => c.id === a.id) - cases.findIndex((c) => c.id === b.id));
  const lines: string[] = [];
  for (const route of routes) {
    const mine = rows.filter((r) => r.route === route);
    const passed = mine.filter((r) => r.ok).length;
    lines.push(`== ${route}: ${passed}/${mine.length} cases pass · ${(mine.reduce((s, r) => s + r.ms, 0) / mine.length / 1000).toFixed(1)}s average · $${mine.reduce((s, r) => s + r.costUsd, 0).toFixed(3)} total`);
    for (const r of mine) {
      lines.push(`${r.ok ? "PASS" : "FAIL"}  ${r.id.padEnd(20)} ${String(r.ms).padStart(6)}ms  ${r.models.join(",")}`);
      for (const check of r.checks) if (!check.ok) lines.push(`        ✗ ${check.name}`);
      if (r.error) lines.push(`        error: ${r.error}`);
      if (!r.ok && r.reply) lines.push(`        got: ${JSON.stringify({ ...r.reply, trace: undefined }).slice(0, 700)}`);
    }
  }
  const text = lines.join("\n");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(outDir, `buddy-${stamp}.json`), JSON.stringify(rows, null, 1));
  fs.writeFileSync(path.join(outDir, `buddy-${stamp}.txt`), text);
  console.log(text);
  console.log(`\nreport: ${path.join(outDir, `buddy-${stamp}.json`)}`);
  process.exit(rows.every((r) => r.ok) ? 0 : 1);
}

void main();
