import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Badge } from './Badge';

const Bell = () => (
  <svg
    aria-hidden
    fill='none'
    height='24'
    stroke='currentColor'
    strokeLinecap='round'
    strokeLinejoin='round'
    strokeWidth={2}
    viewBox='0 0 24 24'
    width='24'
  >
    <path d='M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9' />
    <path d='M10.3 21a1.94 1.94 0 0 0 3.4 0' />
  </svg>
);

const meta = {
  title: 'da-v2/Badge',
  component: Badge,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage p-12'>
        <Story />
      </div>
    ),
  ],
  args: {
    content: 5,
    color: 'primary',
    children: <Bell />,
  },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Numeric: Story = {
  render: () => (
    <div className='flex gap-8'>
      <Badge content={1} color='primary'>
        <Bell />
      </Badge>
      <Badge content={12} color='success'>
        <Bell />
      </Badge>
      <Badge content={'99+'} color='danger'>
        <Bell />
      </Badge>
    </div>
  ),
};

export const Dot: Story = {
  render: () => (
    <div className='flex gap-8'>
      <Badge isDot color='success'>
        <Bell />
      </Badge>
      <Badge isDot color='danger'>
        <Bell />
      </Badge>
      <Badge isDot color='warning'>
        <Bell />
      </Badge>
    </div>
  ),
};

export const Placements: Story = {
  render: () => (
    <div className='grid grid-cols-2 gap-8'>
      {(['top-right', 'top-left', 'bottom-right', 'bottom-left'] as const).map((p) => (
        <Badge key={p} placement={p} content={9} color='primary'>
          <div className='[border:2.5px_solid_var(--line)] bg-surface-1 size-12 rounded-md shadow-[3px_3px_0_var(--shadow-c)]' />
        </Badge>
      ))}
    </div>
  ),
};
