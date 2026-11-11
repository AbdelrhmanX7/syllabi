import type { Page } from '@/lib/api/types';
import type { LucideIcon } from 'lucide-react';

import { useState } from 'react';
import { cn } from '@repo/ui';
import {
  Atom,
  BookOpen,
  Brain,
  Briefcase,
  Building2,
  Calculator,
  ChartLine,
  Code,
  Coins,
  Cpu,
  Dna,
  FileText,
  FlaskConical,
  Gavel,
  Globe,
  HeartPulse,
  Landmark,
  Languages,
  Leaf,
  Lightbulb,
  Map as MapIcon,
  Microscope,
  Music,
  NotebookPen,
  Palette,
  PenTool,
  Rocket,
  Scale,
  Sigma,
  Sprout,
} from 'lucide-react';

import { coverColorOf } from '@/lib/notebooks/page-meta';

/** The server's fixed icon list (apps/server/src/services/study/page-meta.ts COVER_ICONS). */
const ICONS: Record<string, LucideIcon> = {
  'book-open': BookOpen,
  calculator: Calculator,
  sigma: Sigma,
  atom: Atom,
  'flask-conical': FlaskConical,
  dna: Dna,
  microscope: Microscope,
  leaf: Leaf,
  sprout: Sprout,
  globe: Globe,
  map: MapIcon,
  landmark: Landmark,
  scale: Scale,
  gavel: Gavel,
  brain: Brain,
  'heart-pulse': HeartPulse,
  code: Code,
  cpu: Cpu,
  'chart-line': ChartLine,
  coins: Coins,
  briefcase: Briefcase,
  'building-2': Building2,
  music: Music,
  palette: Palette,
  'pen-tool': PenTool,
  languages: Languages,
  rocket: Rocket,
  lightbulb: Lightbulb,
  'file-text': FileText,
  'notebook-pen': NotebookPen,
};

// Signed picture links change on every list load; keep the first one per cover until it nears expiry,
// so the same picture is not downloaded again on each visit.
const URL_TTL_MS = 50 * 60 * 1000;
const stableUrls = new Map<string, { url: string; at: number }>();

function stableCoverUrl(page: Pick<Page, 'id' | 'cover' | 'coverUrl'>): string | null {
  if (page.cover?.kind !== 'image' || !page.coverUrl) return null;
  const key = `${page.id}:${page.cover.updatedAt ?? ''}`;
  const known = stableUrls.get(key);

  if (known && Date.now() - known.at < URL_TTL_MS) return known.url;
  stableUrls.set(key, { url: page.coverUrl, at: Date.now() });

  return page.coverUrl;
}

function forgetCoverUrl(url: string): void {
  for (const [key, entry] of stableUrls) if (entry.url === url) stableUrls.delete(key);
}

// `card`: full width at one fixed shape, so a grid of covers lines up whatever the picture's size.
const SIZE = { xs: 'h-6 w-6 rounded-sm', sm: 'h-9 w-9 rounded-sm', lg: 'h-20 w-20 rounded-sm', card: 'aspect-[3/2] w-full rounded-md' } as const;
const ICON_SIZE = { xs: 'h-3.5 w-3.5', sm: 'h-4 w-4', lg: 'h-8 w-8', card: 'h-10 w-10' } as const;

/**
 * A notebook's cover: the AI picture, or a brand-colour tile with its icon. No cover yet → the plain
 * notebook tile. A picture that fails to load (expired link, offline) falls back to the colour tile.
 */
export function NoteCover({ page, size = 'sm' }: { page: Pick<Page, 'id' | 'cover' | 'coverUrl'>; size?: keyof typeof SIZE }) {
  const url = stableCoverUrl(page);
  const [broken, setBroken] = useState<string | null>(null);
  const cover = page.cover ?? null;

  if (url && broken !== url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- static export: a signed link, no image optimizer
      <img
        alt=''
        className={cn('border-st-line block shrink-0 border object-cover', SIZE[size])}
        decoding='async'
        loading='lazy'
        src={url}
        onError={() => {
          // Expired or unreachable: forget it, so the next fresh link from a list load is used.
          forgetCoverUrl(url);
          setBroken(url);
        }}
      />
    );
  }

  if (!cover) {
    return (
      <span className={cn('border-st-line bg-st-raised text-st-muted flex shrink-0 items-center justify-center border', SIZE[size])}>
        <NotebookPen className={ICON_SIZE[size]} />
      </span>
    );
  }

  const Icon = ICONS[cover.icon ?? ''] ?? NotebookPen;
  const tone = coverColorOf(cover.color);

  return (
    <span
      aria-hidden
      className={cn('flex shrink-0 items-center justify-center', SIZE[size])}
      style={{ backgroundColor: tone.fill, color: tone.ink }}
    >
      <Icon className={ICON_SIZE[size]} />
    </span>
  );
}
