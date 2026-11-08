import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Switch } from './Switch';

const meta = {
  title: 'da-v2/Switch',
  component: Switch,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    // Clay sits on the plain themed page, not on a scrapbook sheet — the
    // channel's inset shadow has to be read against the real background it will
    // ship on, and a paper card with its own border hides that.
    (Story: () => React.ReactNode) => (
      <div className='bg-[color:hsl(var(--heroui-background))] p-10'>
        <Story />
      </div>
    ),
  ],
  args: { children: 'Enable notifications' },
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

const COLORS = ['default', 'primary', 'secondary', 'success', 'warning', 'danger'] as const;

export const Colors: Story = {
  render: () => (
    <div className='grid grid-cols-[auto_auto_auto] items-center gap-x-6 gap-y-3'>
      <span className='text-ink text-[12px] font-bold opacity-60'>colour</span>
      <span className='text-ink text-[12px] font-bold opacity-60'>off</span>
      <span className='text-ink text-[12px] font-bold opacity-60'>on</span>
      {COLORS.map((c) => (
        <React.Fragment key={c}>
          <span className='text-ink text-[14px] font-bold'>{c}</span>
          <Switch color={c} data-clay-off={c} />
          <Switch color={c} data-clay-on={c} defaultSelected />
        </React.Fragment>
      ))}
    </div>
  ),
};
