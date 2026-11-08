import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Avatar } from './Avatar';

const meta = {
  title: 'da-v2/Avatar',
  component: Avatar,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage p-10'>
        <Story />
      </div>
    ),
  ],
  args: { name: 'Mohamed', size: 'md' },
} satisfies Meta<typeof Avatar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Sizes: Story = {
  render: () => (
    <div className='flex items-center gap-4'>
      <Avatar name='M' size='sm' />
      <Avatar name='O' size='md' />
      <Avatar name='A' size='lg' />
    </div>
  ),
};

export const Colors: Story = {
  render: () => (
    <div className='flex items-center gap-4'>
      {(['default', 'primary', 'secondary', 'success', 'warning', 'danger'] as const).map((c) => (
        <Avatar color={c} key={c} name={c[0]} />
      ))}
    </div>
  ),
};
