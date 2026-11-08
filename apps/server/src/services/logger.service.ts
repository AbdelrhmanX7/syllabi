import { Logtail } from '@logtail/node';
import { LogLevel } from '@logtail/types';
import { AsyncLocalStorage } from 'async_hooks';

/**
 * User context for logging
 */
export interface UserContext {
  userId?: string;
  userRole?: 'Student' | 'Teacher' | 'Admin' | 'AssistantTeacher' | 'StudioTeacher';
}

// AsyncLocalStorage for request-scoped user context
const userContextStorage = new AsyncLocalStorage<UserContext>();

/**
 * Query params whose VALUES must never leave the process in a log line.
 *
 * `logRequest` ships `req.url` — query string included — to BetterStack, an
 * off-platform store with its own retention. Today no route puts a secret in a
 * query string, so this is a latent shape, not a live leak; but the moment
 * someone adds `?token=` or a reset code, it would be silently persisted
 * third-party and nobody would notice, because the logger would be doing what
 * it always did. (The FE just shipped the mirror fix: credential forms that
 * could native-GET-submit `?phone=&password=` before hydration.)
 *
 * Matching is by param NAME, case-insensitive — a value-shape heuristic would
 * miss exactly the one that matters.
 */
const REDACTED_QUERY_PARAMS = new Set([
  'password',
  'newpassword',
  'confirmpassword',
  'oldpassword',
  'token',
  'secret',
  'secretkey',
  'code',
  'otp',
  'apikey',
  'authorization',
  // `/study/drop?t=sk_drop_…` and `POST /study/inbox?t=…` (Study phone inbox drop tokens).
  't',
]);

/**
 * Credentials that live in a PATH SEGMENT rather than in a query parameter.
 *
 * `/student/offline/dl/<token>/<storage key>` is the offline download proxy, and
 * that token is a bearer credential: it carries the student, the device and the
 * lecture, it is good for fifteen minutes, and it is the ONLY authentication on
 * that route (the mount sits above `studentVerification` because a `<video>`
 * element cannot attach an Authorization header to 1,500 segment requests).
 * Logging it hands anyone with read access to BetterStack — or shell on the box
 * — a whole lecture's content, from any machine, with no JWT and no registered
 * device.
 *
 * Only the token is replaced; the storage key stays visible so the route
 * remains observable. Matched from `/offline/dl/` rather than the full mount
 * path so a re-mount cannot silently un-redact it.
 */
const PATH_SECRET_SEGMENTS: ReadonlyArray<RegExp> = [
  /(\/offline\/dl\/)([^/?#]+)/g,
];

/**
 * Replace the value of every denylisted query param in a URL with [REDACTED],
 * and every credential-bearing PATH segment too (see PATH_SECRET_SEGMENTS).
 * Clean URLs pass through byte-identical. Never throws — a malformed URL is
 * returned as-is rather than crashing the logging path.
 */
export function redactUrlSecrets(url: unknown): string {
  let raw = typeof url === 'string' ? url : String(url ?? '');
  for (const pattern of PATH_SECRET_SEGMENTS) {
    raw = raw.replace(pattern, '$1[REDACTED]');
  }

  const qIndex = raw.indexOf('?');
  if (qIndex === -1) return raw;

  try {
    const path = raw.slice(0, qIndex);
    const query = raw.slice(qIndex + 1);
    const rewritten = query
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        if (eq === -1) return pair;
        const name = pair.slice(0, eq);
        let decoded = name;
        try {
          decoded = decodeURIComponent(name);
        } catch {
          /* undecodable name — match on the raw spelling */
        }
        return REDACTED_QUERY_PARAMS.has(decoded.toLowerCase())
          ? `${name}=[REDACTED]`
          : pair;
      })
      .join('&');
    return `${path}?${rewritten}`;
  } catch {
    return raw;
  }
}

/**
 * BetterStack Logger Service
 * Centralized logging service for the application
 */
class LoggerService {
  private logtail: Logtail | null = null;
  private isEnabled: boolean = false;

  constructor() {
    const sourceToken = process.env.BETTERSTACK_SOURCE_TOKEN;

    if (sourceToken) {
      // BETTERSTACK_ENDPOINT = your source's ingesting host (shown next to the token in BetterStack).
      const endpoint = process.env.BETTERSTACK_ENDPOINT;
      this.logtail = new Logtail(sourceToken, endpoint ? { endpoint } : undefined);
      this.isEnabled = true;
      console.log('✅ BetterStack logging initialized');
    } else {
      console.warn('⚠️  BetterStack logging disabled (BETTERSTACK_SOURCE_TOKEN not set)');
    }
  }

  /**
   * Run a function with user context attached to all logs within it
   * Use this in middleware to set user context for the entire request
   */
  runWithUserContext<T>(context: UserContext, fn: () => T): T {
    return userContextStorage.run(context, fn);
  }

  /**
   * Set user context for the current async context
   * Returns the current store or undefined if not in a context
   */
  setUserContext(context: UserContext): void {
    const store = userContextStorage.getStore();
    if (store) {
      Object.assign(store, context);
    }
  }

  /**
   * Get current user context
   */
  getUserContext(): UserContext | undefined {
    return userContextStorage.getStore();
  }

  /**
   * Merge user context with provided context
   */
  private mergeWithUserContext(context?: Record<string, any>): Record<string, any> {
    const userContext = this.getUserContext();
    return {
      ...context,
      ...(userContext?.userId && { userId: userContext.userId }),
      ...(userContext?.userRole && { userRole: userContext.userRole }),
    };
  }

  /**
   * Log info level message
   */
  async info(message: string, context?: Record<string, any>) {
    const mergedContext = this.mergeWithUserContext(context);

    if (!this.isEnabled || !this.logtail) {
      console.log(`[INFO] ${message}`, mergedContext);
      return;
    }

    try {
      await this.logtail.info(message, mergedContext);
    } catch (error) {
      console.error('Failed to send log to BetterStack:', error);
    }
  }

  /**
   * Log warning level message
   */
  async warn(message: string, context?: Record<string, any>) {
    const mergedContext = this.mergeWithUserContext(context);

    if (!this.isEnabled || !this.logtail) {
      console.warn(`[WARN] ${message}`, mergedContext);
      return;
    }

    try {
      await this.logtail.warn(message, mergedContext);
    } catch (error) {
      console.error('Failed to send log to BetterStack:', error);
    }
  }

  /**
   * Log error level message
   */
  async error(message: string, error?: Error | any, context?: Record<string, any>) {
    const errorContext = this.mergeWithUserContext({
      ...context,
      error: error instanceof Error ? {
        message: error.message,
        stack: error.stack,
        name: error.name,
      } : error,
    });

    if (!this.isEnabled || !this.logtail) {
      console.error(`[ERROR] ${message}`, errorContext);
      return;
    }

    try {
      await this.logtail.error(message, errorContext);
    } catch (err) {
      console.error('Failed to send error to BetterStack:', err);
    }
  }

  /**
   * Log debug level message
   */
  async debug(message: string, context?: Record<string, any>) {
    const mergedContext = this.mergeWithUserContext(context);

    if (!this.isEnabled || !this.logtail) {
      if (process.env.NODE_ENV === 'development') {
        console.debug(`[DEBUG] ${message}`, mergedContext);
      }
      return;
    }

    try {
      await this.logtail.debug(message, mergedContext);
    } catch (error) {
      console.error('Failed to send log to BetterStack:', error);
    }
  }

  /**
   * Log HTTP request
   */
  async logRequest(req: any, res: any, duration: number) {
    const url = redactUrlSecrets(req.url);
    const context = {
      method: req.method,
      url,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      userAgent: req.get('user-agent'),
      ip: req.ip || req.connection?.remoteAddress,
      userId: req.user?.id || req.studentId || req.teacherId,
      userType: req.user?.type || req.userType,
    };

    const level = res.statusCode >= 500 ? 'error' :
      res.statusCode >= 400 ? 'warn' : 'info';

    const message = `${req.method} ${url} ${res.statusCode} - ${duration}ms`;

    if (level === 'error') {
      await this.error(message, undefined, context);
    } else if (level === 'warn') {
      await this.warn(message, context);
    } else {
      await this.info(message, context);
    }
  }

  /**
   * Log socket event
   */
  async logSocket(event: string, namespace: string, context?: Record<string, any>) {
    await this.info(`Socket event: ${event}`, {
      event,
      namespace,
      ...context,
    });
  }

  /**
   * Log job processing
   */
  async logJob(jobName: string, status: 'started' | 'completed' | 'failed', context?: Record<string, any>) {
    const message = `Job ${jobName} ${status}`;

    if (status === 'failed') {
      await this.error(message, undefined, context);
    } else {
      await this.info(message, {
        jobName,
        status,
        ...context,
      });
    }
  }

  /**
   * Log video processing
   */
  async logVideoProcessing(videoId: string, stage: string, context?: Record<string, any>) {
    await this.info(`Video processing: ${stage}`, {
      videoId,
      stage,
      ...context,
    });
  }

  /**
   * Log exam activity
   */
  async logExam(action: string, context?: Record<string, any>) {
    await this.info(`Exam: ${action}`, {
      action,
      ...context,
    });
  }

  /**
   * Log weekly question activity
   */
  async logWeeklyQuestion(action: string, context?: Record<string, any>) {
    await this.info(`Weekly Question: ${action}`, {
      action,
      ...context,
    });
  }

  /**
   * @deprecated Use logWeeklyQuestion instead
   */
  async logDailyQuestion(action: string, context?: Record<string, any>) {
    return this.logWeeklyQuestion(action, context);
  }

  /**
   * Flush logs (ensure all logs are sent before shutdown)
   */
  async flush() {
    if (this.logtail) {
      try {
        await this.logtail.flush();
        console.log('✅ BetterStack logs flushed');
      } catch (error) {
        console.error('Failed to flush BetterStack logs:', error);
      }
    }
  }
}

// Export singleton instance
export const logger = new LoggerService();
