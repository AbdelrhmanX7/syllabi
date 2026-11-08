import type { Meta, StoryObj } from '@storybook/react-vite';
import React, { useState } from 'react';
import { Search, Bell, Trash2, Settings } from 'lucide-react';

import { Icon } from './Icon';
import { Button } from '../Button';
import { CLAY_FILL, clayKindFor, clayVars } from '../clay';

/**
 * The demo tiles below are `<button>`s, so they get a real clay press — the same
 * ladder as `ClayButton`, straight DOWN, lip closing by exactly the distance the
 * tile travels (6 -> 4 -> 1 against 0 -> 2 -> 5). They used to hand-roll the
 * scrapbook's DIAGONAL ladder (`4px 4px 0` moving up-left on hover, down-right on
 * press), which is the language being deleted.
 *
 * `clayVars` supplies every colour; nothing here mixes its own.
 */
const tileStyle = {
  background: CLAY_FILL.default,
  ...clayVars(CLAY_FILL.default, { kind: clayKindFor('default'), depth: 6 }),
};

const TILE =
  'clay-btn flex items-center justify-center border-[3px] border-[color:var(--clay-edge)] ' +
  'transition-[transform,box-shadow] duration-200 ' +
  'hover:translate-y-[2px] active:translate-y-[5px] active:scale-[0.99] ' +
  'focus-visible:outline-none ' +
  'motion-reduce:transition-none motion-reduce:hover:translate-y-0';

const meta = {
  title: 'da-v2/Icon',
  component: Icon,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage p-12'>
        <Story />
      </div>
    ),
  ],
  argTypes: {
    name: { control: 'select', options: ['lock', 'heart', 'check'] },
    hover: { control: 'inline-radio', options: ['none', 'wiggle', 'pop', 'bounce', 'shake', 'spin'] },
    trigger: { control: 'inline-radio', options: ['self', 'group-hover', 'group-focus', 'always'] },
    active: { control: 'boolean' },
    size: { control: { type: 'range', min: 16, max: 80, step: 4 } },
    strokeWidth: { control: { type: 'range', min: 1, max: 3, step: 0.1 } },
  },
  args: {
    name: 'lock',
    hover: 'wiggle',
    trigger: 'self',
    active: true,
    size: 32,
    strokeWidth: 1.8,
    className: 'text-ink',
  },
} satisfies Meta<typeof Icon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/* ─── Stateful: lock toggles open/closed on click ───────────────────────── */
export const StatefulLock: Story = {
  render: () => {
    const [locked, setLocked] = useState(true);
    return (
      <div className='flex flex-col items-center gap-4'>
        <p className='font-hand text-ink/70 text-lg'>Press the lock</p>
        <button
          aria-label={locked ? 'Unlock' : 'Lock'}
          className={`${TILE} group h-20 w-20 rounded-[20px]`}
          style={tileStyle}
          onClick={() => setLocked((v) => !v)}
          type='button'
        >
          <Icon active={locked} className={locked ? 'text-ink' : 'text-sk-green'} name='lock' size={48} />
        </button>
        <p className='text-ink/70 text-xs'>{locked ? 'Locked' : 'Ready'}</p>
      </div>
    );
  },
};

/* ─── Stateful: heart pops on toggle ────────────────────────────────────── */
export const StatefulHeart: Story = {
  render: () => {
    const [fav, setFav] = useState(false);
    return (
      <div className='flex flex-col items-center gap-4'>
        <p className='font-hand text-ink/70 text-lg'>Press the heart</p>
        <button
          aria-label={fav ? 'Remove from favorites' : 'Add to favorites'}
          className='flex h-16 w-16 items-center justify-center rounded-full transition-transform hover:scale-110'
          onClick={() => setFav((v) => !v)}
          type='button'
        >
          <Icon active={fav} className='text-sk-red' name='heart' size={48} />
        </button>
        <p className='text-ink/70 text-xs'>{fav ? 'In favorites' : 'Not saved'}</p>
      </div>
    );
  },
};

/* ─── Stateful: check draws in on activate ──────────────────────────────── */
export const DrawInCheck: Story = {
  render: () => {
    const [checked, setChecked] = useState(false);
    return (
      <div className='flex flex-col items-center gap-4'>
        <p className='font-hand text-ink/70 text-lg'>Complete the task</p>
        <button
          aria-label={checked ? 'Done' : 'Not done'}
          className={`${TILE} h-16 w-16 rounded-[18px]`}
          style={tileStyle}
          onClick={() => setChecked((v) => !v)}
          type='button'
        >
          <Icon active={checked} className='text-sk-green' name='check' size={36} strokeWidth={2.4} />
        </button>
        <p className='text-ink/70 text-xs'>{checked ? 'Done ✓' : 'Click to select'}</p>
      </div>
    );
  },
};

/* ─── Hover animation gallery — wrapped lucide icons ────────────────────── */
export const HoverAnimations: Story = {
  render: () => {
    const cells: { label: string; icon: typeof Search; anim: 'wiggle' | 'pop' | 'bounce' | 'shake' | 'spin' }[] = [
      { label: 'wiggle', icon: Bell, anim: 'wiggle' },
      { label: 'pop', icon: Search, anim: 'pop' },
      { label: 'bounce', icon: Settings, anim: 'bounce' },
      { label: 'shake', icon: Trash2, anim: 'shake' },
      { label: 'spin', icon: Settings, anim: 'spin' },
    ];
    return (
      <div className='flex flex-col items-center gap-3'>
        <p className='font-hand text-ink/70 text-lg'>Hover each icon</p>
        <div className='flex flex-wrap gap-3'>
          {cells.map(({ label, icon: I, anim }) => (
            <div key={label} className='flex flex-col items-center gap-2'>
              <button
                className={`${TILE} text-ink h-16 w-16 rounded-[18px]`}
                style={tileStyle}
                type='button'
              >
                <Icon as={I} hover={anim} size={28} />
              </button>
              <span className='font-hand text-ink/70 text-sm'>{label}</span>
            </div>
          ))}
        </div>
      </div>
    );
  },
};

/* ─── group-hover: icon reacts to button's hover, not its own ───────────── */
export const GroupHover: Story = {
  render: () => (
    <div className='flex flex-col items-center gap-3'>
      <p className='font-hand text-ink/70 text-lg'>The icon reacts to hovering the button</p>
      <Button color='primary' className='group'>
        <Icon as={Bell} hover='wiggle' trigger='group-hover' size={20} />
        New alert
      </Button>
      <p className='text-ink/70 text-xs'>(Hover anywhere on the button — the icon moves)</p>
    </div>
  ),
};

/* ─── Sizing scale ─────────────────────────────────────────────────────── */
export const Sizing: Story = {
  render: () => (
    <div className='flex flex-wrap items-end justify-center gap-3 sm:gap-6'>
      {[16, 20, 24, 32, 48, 64].map((s) => (
        <div key={s} className='flex flex-col items-center gap-2'>
          <Icon className='text-sk-primary' name='heart' size={s} active />
          <span className='font-hand text-ink/70 text-sm'>{s}px</span>
        </div>
      ))}
    </div>
  ),
};

/* ─── Color tokens — same icon, different text colors ───────────────────── */
export const ColorTokens: Story = {
  render: () => (
    <div className='flex flex-wrap items-center justify-center gap-3 sm:gap-6'>
      {(['text-ink', 'text-sk-primary', 'text-sk-blue', 'text-sk-green', 'text-sk-amber', 'text-sk-red'] as const).map(
        (cls) => (
          <div key={cls} className='flex flex-col items-center gap-2'>
            <Icon active className={cls} name='check' size={36} strokeWidth={2.4} />
            <span className='font-hand text-ink/70 text-xs'>{cls.replace('text-', '')}</span>
          </div>
        ),
      )}
    </div>
  ),
};
