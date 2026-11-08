import { spawn, type ChildProcessWithoutNullStreams } from "child_process";

/**
 * The ONLY place the code sandbox touches child_process, so tests mock this one file.
 * Both functions call the docker CLI with an argv array (never a shell string). The CLI
 * inherits our env (it needs HOME / DOCKER_HOST); nothing reaches the CONTAINER, since the
 * sandbox argv has no -e / --env-file.
 */
export const DOCKER_BIN = "docker";

/** A long-running `docker run -i …` — the caller pipes stdin and reads stdout/stderr. */
export function spawnDocker(args: string[]): ChildProcessWithoutNullStreams {
  return spawn(DOCKER_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
}

export interface DockerResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Spawn failure (ENOENT when the docker CLI is missing). */
  error?: NodeJS.ErrnoException;
}

/** A short docker CLI call (`kill`, `image inspect`, `pull`). Never throws. */
export function runDocker(args: string[], timeoutMs = 10_000): Promise<DockerResult> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let settled = false;
    const finish = (r: DockerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(DOCKER_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: "", error: e as NodeJS.ErrnoException });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stdout: out, stderr: err + "\n[timed out]" });
    }, timeoutMs);
    timer.unref?.();
    child.stdin.end();
    child.stdout.on("data", (c: Buffer) => {
      if (out.length < 64_000) out += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      if (err.length < 64_000) err += c.toString("utf8");
    });
    child.on("error", (e) => finish({ code: null, stdout: out, stderr: err, error: e }));
    child.on("close", (code) => finish({ code, stdout: out, stderr: err }));
  });
}
