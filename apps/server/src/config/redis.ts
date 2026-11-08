import Redis from "ioredis";

/** REDIS_URL (e.g. redis://redis:6379) wins; otherwise REDIS_HOST / REDIS_PORT (default 127.0.0.1:6379). */
export const REDIS_OPTIONS = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
};

/**
 * Create a new ioredis client. Each caller gets its own connection (required for pub/sub
 * separation). Used for rate limits and the inbox SSE fan-out; both fail open if Redis is down.
 */
export function createRedisClient(): Redis {
  const client = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : new Redis(REDIS_OPTIONS);
  client.on("error", () => undefined);
  return client;
}
