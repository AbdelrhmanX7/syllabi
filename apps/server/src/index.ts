import "dotenv/config";
import { createServer } from "http";
import mongoose from "mongoose";
import { createApp } from "@/app";
import { ensureOwnerFromEnv } from "@/auth/owner";
import { createShutdownHandler } from "@/services/http-drain";
import { logger } from "@/services/logger.service";
import { startStudyBackground } from "@/services/study/background";

const PORT = Number(process.env.PORT || 5000);
const HOST = process.env.HOST || "127.0.0.1";
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/syllabi";

mongoose.set("strictQuery", true);

async function main() {
  if (PORT === 3000) throw new Error("PORT 3000 is reserved; pick another (default 5000).");
  if (!process.env.JWT_SECRET && !process.env.SECRET_KEY) {
    throw new Error("JWT_SECRET is not set. It signs sessions and derives the at-rest encryption key.");
  }

  await mongoose.connect(MONGODB_URI, {
    maxPoolSize: 20,
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
  });

  // Create the owner from ADMIN_* env when there is no owner yet (registered users do not count).
  await ensureOwnerFromEnv();

  // Background work, started after the DB is up so the first tick can query. In-process by
  // default; RUN_WORKER_IN_PROCESS=false hands it to `node dist/worker.js` (services/study/background.ts).
  const background = startStudyBackground("api");

  const app = createApp();
  const server = createServer(app);

  const shutdown = createShutdownHandler({
    server,
    cleanup: async () => {
      await background.stop();
      await mongoose.disconnect().catch(() => {});
      await logger.flush();
    },
  });
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  server.listen(PORT, HOST, () => {
    console.log(`Syllabi server listening on http://${HOST}:${PORT}`);
  });
}

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

main().catch((error) => {
  console.error("[server] failed to start:", error);
  process.exit(1);
});
