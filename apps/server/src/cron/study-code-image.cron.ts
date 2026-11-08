import { codeExecEnabled, ensureSandboxImage, SANDBOX_IMAGE } from "@/services/study/code/sandbox";
import { logger } from "@/services/logger.service";

/**
 * Study code sandbox: make sure the pinned compiler image exists, once, 30 s after boot, in the
 * background (never blocks boot, never on the request path). It inspects first and pulls only
 * when absent, so restarts cost no registry traffic. Runs in the API process (code runs execute
 * there, against its docker daemon). Manual equivalent: `docker pull gcc:14`.
 */
export function scheduleSandboxImageCheck(delayMs = 30_000): NodeJS.Timeout {
  const t = setTimeout(() => {
    ensureSandboxImage()
      .then((r) => {
        if (r === "failed") return logger.warn("study code sandbox image unavailable", { image: SANDBOX_IMAGE });
        if (r === "pulled") return logger.info("study code sandbox image pulled", { image: SANDBOX_IMAGE });
      })
      .catch((e) => logger.error("study code sandbox image check failed", e));
  }, delayMs);
  t.unref();
  return t;
}
