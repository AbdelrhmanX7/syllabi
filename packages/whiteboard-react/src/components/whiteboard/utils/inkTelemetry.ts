import { perfMark } from './perfSpan';

/**
 * Structured auto-colour feature event. Travels the existing perfMark seam (so the host's `span`
 * kind, which the backend already accepts) as label `ink-<op>` + a compact pipe detail:
 * `engine|lang|cls|conf|<ms>ms|src|c<chars>` (trailing empty fields trimmed; a correction's cls is `from>to`),
 * then the optional `extra` fields as `key=value` (all seven base fields kept when there are extras).
 * Free text in an extra (the recognised words) has `|` replaced by `¦`; the detail is capped at
 * {@link INK_DETAIL_MAX} chars.
 */
export const INK_DETAIL_MAX = 200;

export type InkTelemetryOp = 'recognize' | 'classify' | 'correction' | 'recolor';

export interface InkTelemetryEvent {
  op: InkTelemetryOp;
  engine?: string;
  ms?: number;
  cls?: string;
  from?: string;
  to?: string;
  lang?: string;
  chars?: number;
  conf?: number;
  src?: string;
  /** Extra `key=value` fields, in order (text is escaped and trimmed; empty values dropped). */
  extra?: Array<[string, string | number | undefined]>;
}

/** Recognised text for a detail field: one line, no `|`, at most `max` chars. */
export function inkDetailText(text: string, max = 40): string {
  return text.replace(/\|/g, '¦').replace(/\s+/g, ' ').trim().slice(0, max);
}

const clean = (value: string | undefined): string => (value ?? '').replace(/[|\s]+/g, '_').slice(0, 24);

/** Pure: label + detail for an event (exported for tests and for hosts that parse them). */
export function formatInkTelemetry(event: InkTelemetryEvent): { label: string; ms: number; detail: string } {
  const cls = event.from || event.to ? `${clean(event.from)}>${clean(event.to)}` : clean(event.cls);
  const ms = Number.isFinite(event.ms) ? Math.max(0, Math.round(event.ms as number)) : 0;
  const fields = [
    clean(event.engine),
    clean(event.lang),
    cls,
    typeof event.conf === 'number' && Number.isFinite(event.conf) ? event.conf.toFixed(2) : '',
    `${ms}ms`,
    clean(event.src),
    typeof event.chars === 'number' && Number.isFinite(event.chars) ? `c${Math.round(event.chars)}` : '',
  ];

  const extra = (event.extra ?? [])
    .map(([key, value]) => [key, typeof value === 'number' ? (Number.isFinite(value) ? String(Math.round(value)) : '') : inkDetailText(value ?? '', 60)])
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}=${value}`);

  if (extra.length === 0) {
    while (fields.length > 0 && fields[fields.length - 1] === '') fields.pop();
  }

  return { label: `ink-${event.op}`, ms, detail: [...fields, ...extra].join('|').slice(0, INK_DETAIL_MAX) };
}

/** Report one feature event. Never throws, never duration-filtered. */
export function inkTelemetry(event: InkTelemetryEvent): void {
  const { label, ms, detail } = formatInkTelemetry(event);

  perfMark(label, ms, detail);
}
