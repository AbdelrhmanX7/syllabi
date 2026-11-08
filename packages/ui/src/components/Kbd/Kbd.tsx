import React from 'react';

import { cn } from '../../cn';
import { CLAY_RIM } from '../clay';

/**
 * da-v2 Kbd — drop-in for HeroUI Kbd. Renders one or more keyboard keys as
 * scrapbook "physical key" stickers, optionally followed by a literal text
 * label (children).
 *
 * Visual: each key is a small inline-flex with paper bg, 2px ink border,
 * 2px hard offset shadow, mono font, rounded-sk-sm. Multi-key forms use a
 * subtle "+" separator between.
 */

export type KbdKey =
  | 'command'
  | 'shift'
  | 'ctrl'
  | 'option'
  | 'enter'
  | 'delete'
  | 'escape'
  | 'tab'
  | 'capslock'
  | 'up'
  | 'right'
  | 'down'
  | 'left'
  | 'pageup'
  | 'pagedown'
  | 'home'
  | 'end'
  | 'help'
  | 'space'
  | 'fn'
  | 'win'
  | 'alt';

const KEY_SYMBOL: Record<KbdKey, string> = {
  command: '⌘',
  shift: '⇧',
  ctrl: '⌃',
  option: '⌥',
  enter: '⏎',
  delete: '⌫',
  escape: '⎋',
  tab: '⇥',
  capslock: '⇪',
  up: '↑',
  right: '→',
  down: '↓',
  left: '←',
  pageup: '⇞',
  pagedown: '⇟',
  home: '↖',
  end: '↘',
  help: '?',
  space: '␣',
  fn: 'fn',
  win: '⊞',
  alt: '⌥',
};

export interface KbdProps extends Omit<React.HTMLAttributes<HTMLElement>, 'children'> {
  keys?: KbdKey | KbdKey[];
  children?: React.ReactNode;
  classNames?: { base?: string; abbr?: string; content?: string };
}

const KEY_PILL =
  /*
   * A `<kbd>` DEPICTS a key, but it IS a label — so it gets clay's rim and no
   * lip. The old `shadow-sk-sm` hard offset is gone with the scrapbook and is
   * deliberately not replaced: a lip says "push me", and pushing a description
   * of a keystroke does nothing. Quality bar #3.
   */
  'inline-flex h-[1.4em] min-w-[1.4em] items-center justify-center bg-[var(--card-bg)] border-[2px] rounded-[6px] font-mono text-ink leading-none px-[0.4em]';

export const Kbd = React.forwardRef<HTMLElement, KbdProps>(function Kbd(
  { keys, children, className, classNames, style, ...rest },
  ref,
) {
  const keyList = React.useMemo<KbdKey[]>(() => {
    if (!keys) return [];

    return Array.isArray(keys) ? keys : [keys];
  }, [keys]);

  return (
    <kbd
      ref={ref}
      className={cn('inline-flex items-center gap-1 align-middle text-[12px]', className, classNames?.base)}
      style={style as React.CSSProperties}
      {...rest}
    >
      {keyList.map((k, i) => (
        <React.Fragment key={`${k}-${i}`}>
          <abbr
            aria-label={k}
            className={cn(KEY_PILL, classNames?.abbr)}
            style={{ textDecoration: 'none', borderColor: CLAY_RIM }}
            title={k}
          >
            {KEY_SYMBOL[k]}
          </abbr>
        </React.Fragment>
      ))}
      {children ? (
        <span className={cn(KEY_PILL, classNames?.content)} style={{ borderColor: CLAY_RIM }}>
          {children}
        </span>
      ) : null}
    </kbd>
  );
});

Kbd.displayName = 'Kbd';
