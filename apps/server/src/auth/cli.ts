/**
 * Owner account CLI. Run from apps/server:
 *
 *   pnpm owner create --email me@example.com [--name "Me"] [--password …]
 *   pnpm owner reset-password [--email …] [--password …]
 *   pnpm owner show
 *
 * When --password is omitted it is read from OWNER_PASSWORD or prompted for (hidden).
 * Built output: `node dist/auth/cli.js <command> …`.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { createInterface } from "readline";
import { Admin } from "@/models/admin";
import { createFirstOwner, hashPassword, MIN_PASSWORD_LENGTH, OwnerInputError } from "@/auth/owner";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput?: (s: string) => void };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    out._writeToOutput = () => {};
  });
}

async function readPassword(args: string[]): Promise<string> {
  const given = flag(args, "password") ?? process.env.OWNER_PASSWORD;
  if (given) return given;
  const first = await promptHidden("Password: ");
  const again = await promptHidden("Repeat password: ");
  if (first !== again) throw new OwnerInputError("The passwords do not match.");
  return first;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || !["create", "reset-password", "show"].includes(command)) {
    console.log("Usage: owner <create|reset-password|show> [--email …] [--name …] [--password …]");
    process.exit(command ? 1 : 0);
  }

  await mongoose.connect(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/syllabi", {
    serverSelectionTimeoutMS: 10_000,
  });

  try {
    if (command === "show") {
      const rows = await Admin.find({}).select("name email phoneNumber role isDisabled createdAt").lean();
      if (!rows.length) console.log("No owner account yet.");
      for (const row of rows) {
        console.log(`${row._id}  ${row.name ?? ""}  email=${row.email ?? "-"}${row.phoneNumber ? `  phone=${row.phoneNumber}` : ""}  role=${row.role}${row.isDisabled ? "  (disabled)" : ""}`);
      }
      return;
    }

    if (command === "create") {
      const admin = await createFirstOwner({
        name: flag(args, "name"),
        email: flag(args, "email"),
        password: await readPassword(args),
      });
      if (!admin) throw new OwnerInputError("An owner account already exists. Use `reset-password` instead.");
      console.log(`Created the owner account ${admin._id} (${admin.email}).`);
      return;
    }

    // reset-password: the single owner (or the account named by --email when there are several).
    const email = flag(args, "email")?.toLowerCase();
    const filter = email ? { email } : {};
    const matches = await Admin.find(filter).select("_id").limit(2).lean();
    if (matches.length === 0) throw new OwnerInputError("No matching account. Run `create` first.");
    if (matches.length > 1) throw new OwnerInputError("Several accounts exist; pick one with --email.");
    const password = await readPassword(args);
    if (password.length < MIN_PASSWORD_LENGTH || password.length > 72) {
      throw new OwnerInputError(`The password must be ${MIN_PASSWORD_LENGTH}-72 characters.`);
    }
    await Admin.updateOne({ _id: matches[0]._id }, { $set: { password: await hashPassword(password), isDisabled: false } });
    console.log(`Password reset for ${matches[0]._id}.`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof OwnerInputError ? error.message : error);
  process.exit(1);
});
