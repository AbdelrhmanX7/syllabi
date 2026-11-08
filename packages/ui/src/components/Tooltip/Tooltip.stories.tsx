import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Button } from '../Button';
import { Tooltip } from './Tooltip';

const meta = {
  title: 'da-v2/Tooltip',
  component: Tooltip,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage p-16'>
        <Story />
      </div>
    ),
  ],
  args: {
    content: 'Tooltip',
    children: <Button variant='bordered'>Hover here</Button>,
  },
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Placements: Story = {
  render: () => (
    <div className='grid grid-cols-3 gap-6'>
      {(['top', 'bottom', 'left', 'right'] as const).map((p) => (
        <Tooltip content={p} key={p} placement={p} showArrow>
          <Button variant='bordered'>{p}</Button>
        </Tooltip>
      ))}
    </div>
  ),
};

export const Colors: Story = {
  render: () => (
    <div className='flex flex-wrap items-center gap-4'>
      {(['default', 'primary', 'secondary', 'success', 'warning', 'danger', 'inverse'] as const).map((c) => (
        <Tooltip color={c} content={c} key={c} showArrow>
          <Button variant='bordered'>{c}</Button>
        </Tooltip>
      ))}
    </div>
  ),
};
