// Per-section / per-feature accent hues. Blue is the primary (buttons, links); the rest give each
// part of the page its own colour. Every pair is a flat soft wash + a strong ink (AA in both themes).
export type Tone = 'blue' | 'citrine' | 'green' | 'coral' | 'purple';

export const TONE: Record<Tone, { tile: string; text: string; badge: string; bar: string }> = {
  blue: {
    tile: 'bg-st-accent-soft text-st-accent',
    text: 'text-st-accent',
    badge: 'bg-st-accent-soft text-st-accent border-st-accent/30',
    bar: 'bg-st-accent',
  },
  citrine: {
    tile: 'bg-tone-citrine text-tone-citrine-fg',
    text: 'text-tone-citrine-fg',
    badge: 'bg-tone-citrine text-tone-citrine-fg border-tone-citrine-fg/30',
    bar: 'bg-st-star',
  },
  green: {
    tile: 'bg-tone-green text-tone-green-fg',
    text: 'text-tone-green-fg',
    badge: 'bg-tone-green text-tone-green-fg border-tone-green-fg/30',
    bar: 'bg-tone-green-fg',
  },
  coral: {
    tile: 'bg-tone-coral text-tone-coral-fg',
    text: 'text-tone-coral-fg',
    badge: 'bg-tone-coral text-tone-coral-fg border-tone-coral-fg/30',
    bar: 'bg-tone-coral-fg',
  },
  purple: {
    tile: 'bg-tone-purple text-tone-purple-fg',
    text: 'text-tone-purple-fg',
    badge: 'bg-tone-purple text-tone-purple-fg border-tone-purple-fg/30',
    bar: 'bg-tone-purple-fg',
  },
};
