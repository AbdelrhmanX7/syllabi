import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { ScrollShadow } from './ScrollShadow';

const longBody = Array.from({ length: 30 }).map((_, i) => (
  <p key={i} className='border-line/15 border-b py-2'>
    Item {i + 1} — a somewhat long description so there is enough content to scroll.
  </p>
));

const wideBody = (
  <div className='flex gap-4 px-2 py-3'>
    {Array.from({ length: 20 }).map((_, i) => (
      <div
        key={i}
        className='[border:2.5px_solid_var(--line)] bg-paper grid size-24 shrink-0 place-items-center rounded-md font-bold shadow-[3px_3px_0_var(--shadow-c)]'
      >
        {i + 1}
      </div>
    ))}
  </div>
);

const meta = {
  title: 'da-v2/ScrollShadow',
  component: ScrollShadow,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage p-6'>
        <Story />
      </div>
    ),
  ],
  args: {
    children: longBody,
    className: 'h-64 w-full max-w-[360px]',
  },
} satisfies Meta<typeof ScrollShadow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Vertical: Story = {};

export const Horizontal: Story = {
  args: {
    orientation: 'horizontal',
    className: 'w-full max-w-[360px]',
    children: wideBody,
  },
};

export const HiddenScrollBar: Story = {
  args: {
    hideScrollBar: true,
    className: 'h-64 w-full max-w-[360px]',
  },
};
