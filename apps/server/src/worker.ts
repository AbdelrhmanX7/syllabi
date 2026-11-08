import "dotenv/config";
import mongoose from "mongoose";
import { logger } from "@/services/logger.service";
import { runWorkerInProcess, startStudyBackground } from "@/services/study/background";

/**
 * Separate background worker: `node dist/worker.js` (dev: `pnpm dev:worker`).
 *
 * Only needed when the API runs with RUN_WORKER_IN_PROCESS=false (default is in-process, one
 * container). It runs the Canvas sync cron and polls the study job tables (video transcripts,
 * lecture processing, uploaded-transcript summaries) every STUDY_JOBS_POLL_MS (default 15 s).
 * No HTTP listener. It needs the same env as the API (MONGODB_URI, JWT_SECRET for Canvas token
 * decryption, storage, AI keys) plus ffmpeg/ffprobe, yt-dlp and poppler on PATH.
 * Run ONE worker; extra replicas set NODE_APP_INSTANCE != "0" and stay idle.
 */

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/syllabi";

mongoose.set("strictQuery", true);

async function main() {
  if (!process.env.JWT_SECRET && !process.env.SECRET_KEY) {
    throw new Error("JWT_SECRET is not set. The worker needs it to decrypt stored Canvas tokens.");
  }

  await mongoose.connect(MONGODB_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
  });

  if (runWorkerInProcess()) {
    console.warn("[worker] RUN_WORKER_IN_PROCESS is not false: the API also runs study jobs. Set it to false for the API (claims keep jobs from running twice).");
  }
  const background = startStudyBackground("worker");
  console.log("[worker] Syllabi background worker started");

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[worker] ${signal}: stopping`);
    const safety = setTimeout(() => process.exit(1), 30_000);
    safety.unref();
    try {
      await background.stop();
      await mongoose.disconnect().catch(() => {});
      await logger.flush();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

process.on("unhandledRejection", (reason) => {
  console.error("[worker] unhandled rejection:", reason);
});

main().catch((error) => {
  console.error("[worker] failed to start:", error);
  process.exit(1);
});
