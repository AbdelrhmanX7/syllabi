import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { THINKING_VARIANTS } from './frames';
import { Thinking } from './Thinking';

const meta = {
  title: 'da-v2/Thinking',
  component: Thinking,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage p-10'>
        <Story />
      </div>
    ),
  ],
  argTypes: {
    variant: { control: 'select', options: THINKING_VARIANTS },
    color: { control: 'select', options: ['default', 'primary', 'secondary', 'success', 'warning', 'danger'] },
    speedMs: { control: { type: 'range', min: 30, max: 400, step: 10 } },
  },
  args: { variant: 'braille-spin', color: 'primary', speedMs: 90, label: 'Crunching the numbers…' },
} satisfies Meta<typeof Thinking>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

const COLORS = ['default', 'primary', 'secondary', 'success', 'warning', 'danger'] as const;

/** Every variant against every semantic colour — the grid to eyeball on a real
 *  handset, since a font without braille/block coverage renders tofu. */
export const Matrix: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className='flex flex-col gap-6'>
      {THINKING_VARIANTS.map((variant) => (
        <section key={variant} className='flex flex-col gap-3'>
          <header className='font-hand text-ink text-[18px]'>
            {variant}
          </header>
          <div className='flex flex-wrap items-center gap-6'>
            {COLORS.map((color) => (
              <Thinking color={color} key={color} label={color} variant={variant} />
            ))}
          </div>
        </section>
      ))}
    </div>
  ),
};

/** Slow enough to read a single cell; fast enough to look frantic. */
export const Speeds: Story = {
  render: () => (
    <div className='flex flex-col gap-4'>
      <Thinking label='40ms — fast' speedMs={40} variant='shade-ripple' />
      <Thinking label='90ms — default' speedMs={90} variant='shade-ripple' />
      <Thinking label='250ms — slow' speedMs={250} variant='shade-ripple' />
    </div>
  ),
};

/**
 * REDUCED MOTION
 *
 * There is no story control for this — it is an OS setting, so flip it for real
 * and reload:
 *   • GNOME:   `gsettings set org.gnome.desktop.interface enable-animations false`
 *   • macOS:   System Settings → Accessibility → Display → Reduce motion
 *   • Windows: Settings → Accessibility → Visual effects → Animation effects
 *   • Chrome DevTools: ⌘/Ctrl+Shift+P → "Emulate CSS prefers-reduced-motion"
 *
 * With it on, no requestAnimationFrame loop is ever started: each strip renders
 * one representative mid-cycle frame and holds it. The `role='status'` name
 * still announces, so a screen-reader user is told work is in progress either
 * way. Below is exactly what each variant freezes on.
 */
export const ReducedMotionFrames: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className='flex flex-col gap-4'>
      <p className='text-ink max-w-[46ch] text-[14px] font-bold'>
        This is the static frame shown when the user turns off motion in their device settings — no animation loop at all.
      </p>
      {THINKING_VARIANTS.map((variant) => (
        <div className='flex items-center gap-4' key={variant}>
          <Thinking color='default' variant={variant} />
          <span className='text-ink text-[13px] font-bold'>
            {variant}
          </span>
        </div>
      ))}
    </div>
  ),
};

/** No label — the accessible name falls back to "Thinking…". */
export const GlyphsOnly: Story = {
  render: () => (
    <div className='flex items-center gap-6'>
      {THINKING_VARIANTS.map((variant) => (
        <Thinking color='secondary' key={variant} variant={variant} />
      ))}
    </div>
  ),
};
