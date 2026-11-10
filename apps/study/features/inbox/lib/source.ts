// Where an inbox item came from, as one of six tags. The backend's `source` is free text on purpose
// (an older or different server may send its own words, or nothing): anything unknown is «Other».
import type { InboxItem } from '../types';

export const INBOX_SOURCES = ['phone', 'claude', 'codex', 'shared', 'upload', 'other'] as const;
export type InboxSource = (typeof INBOX_SOURCES)[number];

export const SOURCE_LABEL: Record<InboxSource, string> = {
  phone: 'Phone',
  claude: 'Claude',
  codex: 'Codex',
  shared: 'Shared',
  upload: 'Upload',
  other: 'Other',
};

/** Chip colour per tag. No danger/warning: those mean «removed» / «needs attention» here. */
export const SOURCE_COLOR: Record<InboxSource, 'primary' | 'secondary' | 'default'> = {
  phone: 'primary',
  claude: 'secondary',
  codex: 'secondary',
  shared: 'default',
  upload: 'default',
  other: 'default',
};

export function inboxSource(item: Pick<InboxItem, 'source'>): InboxSource {
  const raw = typeof item.source === 'string' ? item.source.trim().toLowerCase() : '';

  if (!raw) return 'other';
  if ((INBOX_SOURCES as readonly string[]).includes(raw)) return raw as InboxSource;
  if (/claude|anthropic/.test(raw)) return 'claude';
  if (/codex|openai|chatgpt/.test(raw)) return 'codex';
  if (/phone|drop|shortcut|qr/.test(raw)) return 'phone';
  if (/share/.test(raw)) return 'shared';
  if (/upload|app|tablet|web/.test(raw)) return 'upload';

  return 'other';
}

/** The tags present, in the fixed order (for the filter row). */
export function sourcesPresent(items: Pick<InboxItem, 'source'>[]): InboxSource[] {
  const seen = new Set(items.map(inboxSource));

  return INBOX_SOURCES.filter((source) => seen.has(source));
}
