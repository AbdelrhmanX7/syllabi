import { randomBytes, randomUUID } from "crypto";
import { runDocker, spawnDocker } from "./exec";

/**
 * C++ code-run sandbox (contract "Code (C++ class)"). Untrusted code runs on the prod API box,
 * so every run is a throwaway docker container with no network, a read-only root fs, a
 * non-root user, no capabilities, and hard memory / pid / cpu / file-size caps. Files go in as
 * a tar on stdin (never a bind mount); the container script is a fixed string and the only
 * argv it receives is the whitelisted `-std` value.
 *
 * Timeouts are enforced twice: `timeout -s KILL` inside the container, and a Node watchdog
 * that `docker kill`s the deterministic container name if a phase overruns.
 */

// ─── limits (hardcoded on purpose — no env knobs) ───────────────────────────────────────
export const SANDBOX_IMAGE = "gcc:14";
export const COMPILE_TIMEOUT_S = 15;
export const RUN_TIMEOUT_S = 5;
export const OUTPUT_CAP = 64 * 1024;
export const MAX_FILES = 20;
export const MAX_SOURCE_BYTES = 256 * 1024;
export const MAX_STDIN_BYTES = 64 * 1024;
export const ALLOWED_STDS = ["c++17", "c++20"] as const;
export type CppStd = (typeof ALLOWED_STDS)[number];
/** First char alphanumeric/underscore so a name can never read as a g++ flag (`-o.cpp`). */
export const FILE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
export const SOURCE_EXT_RE = /\.(cpp|h|hpp)$/;
/** Per process. The 4 prod API forks give at most 4 concurrent containers on the box. */
export const MAX_CONCURRENT = 1;
export const MAX_QUEUED = 5;
/** Container start + teardown headroom on top of the in-container timeouts. */
const STARTUP_SLACK_MS = 10_000;
const RUN_SLACK_MS = 3_000;
/** After `docker kill`, how long to wait for the CLI to exit before abandoning it. */
const KILL_GRACE_MS = 5_000;

export const TRUNCATION_MARKER = "\n…[output truncated at 64 KB]";

export interface CodeFile {
  name: string;
  content: string;
}
export interface RunRequest {
  std: CppStd;
  files: CodeFile[];
  stdin: string;
}
export interface RunResult {
  compile: { ok: boolean; output: string };
  run: { stdout: string; stderr: string; exitCode: number | null; timeMs: number; timedOut: boolean } | null;
}

export class SandboxError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

// ─── validation ─────────────────────────────────────────────────────────────────────────

const bad = (message: string) => new SandboxError(400, "VALIDATION_ERROR", message);

/** Shared by run, review and projects. `requireCpp`: at least one .cpp (run/review only). */
export function validateFiles(files: unknown, opts: { requireCpp: boolean; allowEmpty?: boolean }): CodeFile[] {
  if (!Array.isArray(files)) throw bad("files must be an array");
  if (!files.length && !opts.allowEmpty) throw bad("files must not be empty");
  if (files.length > MAX_FILES) throw bad(`At most ${MAX_FILES} files`);
  const seen = new Set<string>();
  let total = 0;
  const out: CodeFile[] = [];
  for (const f of files) {
    const name = (f as any)?.name;
    const content = (f as any)?.content;
    if (typeof name !== "string" || !FILE_NAME_RE.test(name) || name.includes("/") || name.includes("\\") || name.includes(".."))
      throw bad(`Invalid file name: ${String(name).slice(0, 80)}`);
    if (!SOURCE_EXT_RE.test(name)) throw bad(`File must end in .cpp, .h or .hpp: ${name}`);
    if (seen.has(name)) throw bad(`Duplicate file name: ${name}`);
    seen.add(name);
    if (typeof content !== "string") throw bad(`content must be a string: ${name}`);
    total += Buffer.byteLength(content, "utf8");
    if (total > MAX_SOURCE_BYTES) throw bad(`Source exceeds ${MAX_SOURCE_BYTES / 1024} KB in total`);
    out.push({ name, content });
  }
  if (opts.requireCpp && !out.some((f) => f.name.endsWith(".cpp"))) throw bad("At least one .cpp file is required");
  return out;
}

export function validateRunBody(body: any): RunRequest {
  if (body?.lang !== undefined && body.lang !== "cpp") throw bad("lang must be 'cpp'");
  const std = body?.std ?? "c++17";
  if (!(ALLOWED_STDS as readonly string[]).includes(std)) throw bad(`std must be one of ${ALLOWED_STDS.join(", ")}`);
  const files = validateFiles(body?.files, { requireCpp: true });
  const stdin = body?.stdin ?? "";
  if (typeof stdin !== "string") throw bad("stdin must be a string");
  if (Buffer.byteLength(stdin, "utf8") > MAX_STDIN_BYTES) throw bad(`stdin exceeds ${MAX_STDIN_BYTES / 1024} KB`);
  return { std, files, stdin };
}

// ─── docker argv + payload ──────────────────────────────────────────────────────────────

/**
 * The fixed in-container script. `$1` = the whitelisted std. Reserved payload files
 * `__stdin` / `__nonce` can never collide with a user file (those must end in .cpp/.h/.hpp).
 * stderr carries framing: compile output, then `\n<nonce>:COMPILED:<rc>\n`, then the
 * program's stderr, then `\n<nonce>:EXIT:<rc>:<ms>\n`. stdout is the program's stdout only.
 * The nonce is deleted before user code runs, so the program cannot forge a frame.
 */
export const CONTAINER_SCRIPT = [
  "umask 077",
  "cd /work || exit 96",
  "tar -xf - --no-same-owner --no-same-permissions >/dev/null 2>&1 || exit 97",
  "N=$(cat __nonce); rm -f __nonce",
  `timeout -s KILL ${COMPILE_TIMEOUT_S} g++ -std="$1" -O2 -pipe -o /work/a.out ./*.cpp >/work/__cc 2>&1; C=$?`,
  `head -c ${OUTPUT_CAP + 1} /work/__cc >&2; rm -f /work/__cc`,
  `printf '\\n%s:COMPILED:%d\\n' "$N" "$C" >&2`,
  '[ "$C" -eq 0 ] || exit 0',
  "S=$(date +%s%N)",
  `( ulimit -t ${RUN_TIMEOUT_S + 1}; exec timeout -s KILL ${RUN_TIMEOUT_S} ./a.out <__stdin ); R=$?`,
  "E=$(date +%s%N)",
  `printf '\\n%s:EXIT:%d:%d\\n' "$N" "$R" $(( (E - S) / 1000000 )) >&2`,
].join("\n");

export function dockerRunArgs(name: string, std: CppStd): string[] {
  return [
    "run",
    "-i",
    "--rm",
    "--name",
    name,
    "--pull",
    "never",
    "--log-driver",
    "none",
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/work:rw,exec,nosuid,size=64m,uid=65534,gid=65534,mode=0700",
    "--tmpfs",
    "/tmp:rw,nosuid,size=16m",
    "--memory",
    "256m",
    "--memory-swap",
    "256m",
    "--pids-limit",
    "64",
    "--cpus",
    "1",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "65534:65534",
    "--ulimit",
    "fsize=33554432",
    "--ulimit",
    "nofile=256:256",
    "--ulimit",
    "core=0",
    "--hostname",
    "sandbox",
    "--workdir",
    "/work",
    SANDBOX_IMAGE,
    "sh",
    "-c",
    CONTAINER_SCRIPT,
    "sh",
    std,
  ];
}

/** Minimal ustar archive (regular files only, flat names ≤ 100 bytes). */
export function makeTar(entries: { name: string; data: Buffer }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const h = Buffer.alloc(512);
    const put = (s: string, off: number, len: number) => h.write(s, off, len, "utf8");
    const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
    put(e.name, 0, 100);
    put(oct(0o644, 8), 100, 8);
    put(oct(65534, 8), 108, 8);
    put(oct(65534, 8), 116, 8);
    put(oct(e.data.length, 12), 124, 12);
    put(oct(Math.floor(Date.now() / 1000), 12), 136, 12);
    put("        ", 148, 8);
    put("0", 156, 1);
    put("ustar\0", 257, 6);
    put("00", 263, 2);
    let sum = 0;
    for (const b of h) sum += b;
    put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    blocks.push(h, e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

// ─── output handling ────────────────────────────────────────────────────────────────────

/** Keeps the first `cap` bytes and counts the rest. */
class CappedBuffer {
  private parts: Buffer[] = [];
  private kept = 0;
  total = 0;
  constructor(private cap: number) {}
  push(c: Buffer) {
    this.total += c.length;
    if (this.kept >= this.cap) return;
    const take = c.subarray(0, this.cap - this.kept);
    this.parts.push(take);
    this.kept += take.length;
  }
  get buf() {
    return Buffer.concat(this.parts);
  }
}

export function capText(buf: Buffer, total: number, cap = OUTPUT_CAP): string {
  if (total <= cap) return buf.toString("utf8");
  return buf.subarray(0, cap).toString("utf8") + TRUNCATION_MARKER;
}

/**
 * Splits the framed stderr. The compile frame is the FIRST marker (written before user code
 * runs); the exit frame is searched in the tail only, after the program has exited.
 */
class StderrParser {
  compileOut: Buffer | null = null;
  compileRc: number | null = null;
  private pre = Buffer.alloc(0);
  private run = new CappedBuffer(OUTPUT_CAP + 4096);
  private tail = Buffer.alloc(0);
  constructor(
    private nonce: string,
    private onCompiled: () => void
  ) {}
  push(c: Buffer) {
    if (this.compileRc === null) {
      this.pre = Buffer.concat([this.pre, c]);
      const re = new RegExp(`\\n${this.nonce}:COMPILED:(\\d+)\\n`);
      const m = re.exec(this.pre.toString("latin1"));
      if (m) {
        this.compileOut = this.pre.subarray(0, m.index);
        this.compileRc = Number(m[1]);
        const rest = this.pre.subarray(m.index + m[0].length);
        this.pre = Buffer.alloc(0);
        this.onCompiled();
        if (rest.length) this.pushRun(rest);
      } else if (this.pre.length > OUTPUT_CAP * 2 + 4096) {
        // head -c bounds the compile output; anything bigger is not our framing.
        this.pre = this.pre.subarray(0, OUTPUT_CAP * 2);
      }
      return;
    }
    this.pushRun(c);
  }
  private pushRun(c: Buffer) {
    this.run.push(c);
    this.tail = Buffer.concat([this.tail, c]);
    if (this.tail.length > 1024) this.tail = this.tail.subarray(this.tail.length - 1024);
  }
  /** Unframed leftovers when the compile marker never arrived (docker's own error text). */
  get raw() {
    return this.pre.toString("utf8");
  }
  exit(): { rc: number; ms: number; stderr: string } | null {
    const re = new RegExp(`\\n${this.nonce}:EXIT:(\\d+):(\\d+)\\n$`);
    const m = re.exec(this.tail.toString("latin1"));
    const markerLen = m ? m[0].length : 0;
    const userBytes = this.run.total - markerLen;
    const kept = this.run.buf;
    const stderr = userBytes <= OUTPUT_CAP ? kept.subarray(0, Math.max(0, userBytes)).toString("utf8") : kept.subarray(0, OUTPUT_CAP).toString("utf8") + TRUNCATION_MARKER;
    if (!m) return null;
    return { rc: Number(m[1]), ms: Number(m[2]), stderr };
  }
  /** Program stderr when there is no exit frame (container killed mid-run). */
  partialStderr(): string {
    return capText(this.run.buf, this.run.total);
  }
}

const DAEMON_ERR_RE = /Cannot connect to the Docker daemon|permission denied while trying to connect|No such image|Unable to find image|docker: Error response from daemon/i;

// ─── capacity ───────────────────────────────────────────────────────────────────────────

let active = 0;
const waiters: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  if (waiters.length >= MAX_QUEUED) throw new SandboxError(429, "BUSY", "The code runner is busy — try again in a few seconds");
  await new Promise<void>((resolve) => waiters.push(resolve));
  // `release` handed its slot straight to us, so `active` is already counted.
}

function release() {
  const next = waiters.shift();
  if (next) next();
  else active--;
}

/** Test hook. */
export const sandboxLoad = () => ({ active, queued: waiters.length });

// ─── run ────────────────────────────────────────────────────────────────────────────────

/**
 * Code runs are OFF unless CODE_EXEC_ENABLED=true. A run compiles and executes user-supplied C++
 * in a docker container (no network, read-only fs, memory/pid caps), which means this server needs
 * the docker CLI and access to a docker daemon. Giving a container the host's docker socket is
 * equivalent to root on the host, so only enable it on a machine you are willing to trust to that.
 */
export const codeExecEnabled = (): boolean => /^(1|true|yes|on)$/i.test((process.env.CODE_EXEC_ENABLED || "").trim());

export async function runCode(req: RunRequest): Promise<RunResult> {
  if (!codeExecEnabled()) throw new SandboxError(503, "CODE_EXEC_DISABLED", "Running code is disabled on this server (set CODE_EXEC_ENABLED=true)");
  await acquire();
  try {
    return await runOnce(req);
  } finally {
    release();
  }
}

function runOnce(req: RunRequest): Promise<RunResult> {
  const name = `study-run-${randomUUID()}`;
  const nonce = randomBytes(16).toString("hex");
  const tar = makeTar([
    ...req.files.map((f) => ({ name: f.name, data: Buffer.from(f.content, "utf8") })),
    { name: "__stdin", data: Buffer.from(req.stdin, "utf8") },
    { name: "__nonce", data: Buffer.from(nonce, "utf8") },
  ]);

  return new Promise<RunResult>((resolve, reject) => {
    let runStartedAt = 0;
    let settled = false;
    let killedBy: "compile" | "run" | null = null;
    let watchdog: NodeJS.Timeout | null = null;
    let grace: NodeJS.Timeout | null = null;
    const stdout = new CappedBuffer(OUTPUT_CAP);

    const arm = (ms: number, phase: "compile" | "run") => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        killedBy = phase;
        void runDocker(["kill", name]);
        // If the CLI still hasn't exited, stop waiting for it; the container is gone or going.
        grace = setTimeout(() => {
          child.kill("SIGKILL");
          finish(null);
        }, KILL_GRACE_MS);
      }, ms);
    };

    const parser = new StderrParser(nonce, () => {
      runStartedAt = Date.now();
      arm(RUN_TIMEOUT_S * 1000 + RUN_SLACK_MS, "run");
    });

    const child = spawnDocker(dockerRunArgs(name, req.std));

    const finish = (exitCode: number | null, spawnErr?: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      if (grace) clearTimeout(grace);
      if (spawnErr) {
        return reject(
          spawnErr.code === "ENOENT" ? new SandboxError(503, "SANDBOX_UNAVAILABLE", "The code runner is not available on this server") : spawnErr
        );
      }
      // Compile phase never reported → either the watchdog fired during compile, or docker
      // itself failed (daemon down, image missing) before our script ran.
      if (parser.compileRc === null) {
        if (killedBy === "compile")
          return resolve({ compile: { ok: false, output: `Compilation timed out (${COMPILE_TIMEOUT_S} s)` }, run: null });
        const raw = parser.raw;
        if (exitCode === 125 || exitCode === 126 || exitCode === 127 || DAEMON_ERR_RE.test(raw))
          return reject(new SandboxError(503, "SANDBOX_UNAVAILABLE", "The code runner is not available on this server"));
        return reject(new Error(`sandbox exited ${exitCode} without a compile frame: ${raw.slice(0, 300)}`));
      }
      const compileOutput = capText(parser.compileOut!, parser.compileOut!.length);
      if (parser.compileRc !== 0) {
        const output = parser.compileRc === 137 ? `${compileOutput}\nCompilation timed out or ran out of memory`.trim() : compileOutput;
        return resolve({ compile: { ok: false, output }, run: null });
      }
      const ex = parser.exit();
      const out = capText(stdout.buf, stdout.total);
      if (!ex) {
        // Killed mid-run (watchdog, or the container died) — no exit frame.
        return resolve({
          compile: { ok: true, output: compileOutput },
          run: {
            stdout: out,
            stderr: parser.partialStderr(),
            exitCode: null,
            timeMs: runStartedAt ? Date.now() - runStartedAt : 0,
            timedOut: killedBy === "run",
          },
        });
      }
      // `timeout -s KILL` → 137 at the deadline; `ulimit -t` → SIGXCPU (152).
      const timedOut = (ex.rc === 137 && ex.ms >= RUN_TIMEOUT_S * 1000 - 100) || ex.rc === 152;
      let stderr = ex.stderr;
      if (ex.rc === 137 && !timedOut) stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}[killed — memory limit (256 MB) exceeded?]`;
      resolve({
        compile: { ok: true, output: compileOutput },
        run: { stdout: out, stderr, exitCode: timedOut ? null : ex.rc, timeMs: ex.ms, timedOut },
      });
    };

    child.on("error", (e: NodeJS.ErrnoException) => finish(null, e));
    child.on("close", (code) => finish(code));
    child.stdout.on("data", (c: Buffer) => stdout.push(c));
    child.stderr.on("data", (c: Buffer) => parser.push(c));
    child.stdin.on("error", () => {}); // EPIPE when docker dies early; `close` reports it.
    arm(STARTUP_SLACK_MS + COMPILE_TIMEOUT_S * 1000, "compile");
    child.stdin.end(tar);
  });
}

// ─── image ──────────────────────────────────────────────────────────────────────────────

/**
 * Idempotent: inspect first, pull only when the image is absent. Called once at boot by the
 * leader API process, in the background — never on the request path (runs use `--pull never`
 * and a missing image is a 503).
 */
export async function ensureSandboxImage(): Promise<"present" | "pulled" | "failed"> {
  const inspect = await runDocker(["image", "inspect", "--format", "{{.Id}}", SANDBOX_IMAGE]);
  if (inspect.code === 0) return "present";
  if (inspect.error) return "failed";
  const pull = await runDocker(["pull", SANDBOX_IMAGE], 15 * 60_000);
  return pull.code === 0 ? "pulled" : "failed";
}
