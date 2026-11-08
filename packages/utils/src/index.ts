export * from './format-date';
export * from './build-query-params';
export * from './animations';
/**
 * Also reachable as `@repo/utils/to-plain-text`, which is how every caller
 * imports it. The subpath keeps apps that only want to strip tags from pulling
 * `motion` (via `./animations`) and `date-fns` (via `./format-date`) with it.
 */
export * from './to-plain-text';
/**
 * Also reachable as `@repo/utils/graded-answer`, which is how the student apps import it —
 * it is dependency-free and runs on a results screen that should not pull `motion` and
 * `date-fns` in behind it.
 */
export * from './graded-answer';

/**
 * Also reachable as `@repo/utils/rubric-verdict` — dependency-free, and the student
 * results screens import it by subpath for the same reason as `./graded-answer`.
 */
export * from './rubric-verdict';
export * from './download-file';
