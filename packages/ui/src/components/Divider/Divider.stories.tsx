import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Divider } from './Divider';

const meta = {
  title: 'da-v2/Divider',
  component: Divider,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage w-[420px] max-w-full p-8'>
        <Story />
      </div>
    ),
  ],
  args: {},
} satisfies Meta<typeof Divider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Horizontal: Story = {
  render: () => (
    <div>
      <p className='font-bold'>Above the line</p>
      <Divider />
      <p className='font-bold'>Below the line</p>
    </div>
  ),
};

export const Vertical: Story = {
  render: () => (
    <div className='flex h-16 items-center gap-3'>
      <span className='font-bold'>Left</span>
      <Divider orientation='vertical' />
      <span className='font-bold'>Middle</span>
      <Divider orientation='vertical' />
      <span className='font-bold'>Right</span>
    </div>
  ),
};
