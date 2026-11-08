/**
 * Premium (AI on) CLI. Run from apps/server:
 *
 *   pnpm premium list
 *   pnpm premium grant <email>
 *   pnpm premium remove <email>
 *
 * Built output: `node dist/auth/premium-cli.js <command> …`. Same rules as /admin/premium.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { listPremium, PremiumError, setPremium } from "@/auth/premium";

async function main() {
  const [command, email] = process.argv.slice(2);
  if (!command || !["list", "grant", "remove"].includes(command) || (command !== "list" && !email)) {
    console.log("Usage: premium <list|grant <email>|remove <email>>");
    process.exit(command ? 1 : 0);
  }

  await mongoose.connect(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/syllabi", { serverSelectionTimeoutMS: 10_000 });
  try {
    if (command === "list") {
      const rows = await listPremium();
      if (!rows.length) console.log("No accounts have AI yet.");
      for (const r of rows) console.log(`${r.email ?? "-"}  ${r.name ?? ""}${r.owner ? "  (owner, always)" : ""}`);
      return;
    }
    const account = await setPremium(email, command === "grant");
    console.log(`${command === "grant" ? "AI is on for" : "AI is off for"} ${account.email}.`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof PremiumError ? error.message : error);
  process.exit(1);
});
