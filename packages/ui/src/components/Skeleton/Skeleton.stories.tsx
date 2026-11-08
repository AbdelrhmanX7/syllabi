import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Skeleton } from './Skeleton';

const meta = {
  title: 'da-v2/Skeleton',
  component: Skeleton,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage w-[400px] max-w-full p-6 sm:p-10'>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Skeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: () => (
    <div className='flex w-full max-w-[320px] flex-col gap-3'>
      <Skeleton className='h-6 w-1/2' />
      <Skeleton className='h-4 w-full' />
      <Skeleton className='h-4 w-5/6' />
      <Skeleton className='h-32 w-full' />
    </div>
  ),
};
