// English, Pacific-time formatting for Canvas dates (TIME_ZONE below; change it for your school).
const TIME_ZONE = 'America/Los_Angeles';
const DAY = 86_400_000;

const dateFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: TIME_ZONE });
const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: TIME_ZONE,
});
const timeFormatter = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TIME_ZONE });

export function formatDate(value: string | number | Date | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? '' : dateFormatter.format(date);
}

export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? '' : dateTimeFormatter.format(date);
}

/** "in 3 days", "tomorrow 11:59 PM", "2 days ago", "today 3:00 PM". */
export function formatDue(value: string | null | undefined, now = Date.now()): string {
  if (!value) return '';
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return '';
  const diff = date.getTime() - now;
  const days = Math.round(diff / DAY);
  const startOfToday = new Date(now);

  startOfToday.setHours(0, 0, 0, 0);
  const dayIndex = Math.floor((date.getTime() - startOfToday.getTime()) / DAY);

  if (dayIndex === 0) return `today ${timeFormatter.format(date)}`;
  if (dayIndex === 1) return `tomorrow ${timeFormatter.format(date)}`;
  if (dayIndex === -1) return `yesterday ${timeFormatter.format(date)}`;
  if (diff < 0) return `${Math.abs(days)} days ago`;
  if (days < 7) return `in ${days} days`;

  return dateFormatter.format(date);
}

export function formatRelative(value: string | number | null | undefined, now = Date.now()): string {
  if (!value) return '';
  const time = new Date(value).getTime();

  if (Number.isNaN(time)) return '';
  const diff = now - time;
  const minutes = Math.round(diff / 60_000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);

  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);

  if (days < 7) return `${days} d ago`;

  return dateFormatter.format(new Date(time));
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';

  return `${value.toFixed(digits)}%`;
}

/** Days until an ISO date (negative = past). */
export function daysUntil(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();

  return Number.isNaN(time) ? null : Math.floor((time - now) / DAY);
}
