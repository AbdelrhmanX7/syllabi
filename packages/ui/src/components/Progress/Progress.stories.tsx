import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { CircularProgress, Progress } from './Progress';

const meta = {
  title: 'da-v2/Progress',
  component: Progress,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage w-[320px] max-w-full p-6 sm:p-10'>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Progress>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LinearStates: Story = {
  render: () => (
    <div className='flex flex-col gap-5'>
      <Progress aria-label='loading' label='Upload progress' showValueLabel value={42} />
      <Progress aria-label='loading' color='success' isStriped value={66} />
      <Progress aria-label='loading' color='warning' isIndeterminate />
    </div>
  ),
};

export const Circular: Story = {
  render: () => (
    <div className='flex flex-wrap items-center gap-3 sm:gap-6'>
      <CircularProgress aria-label='loading' showValueLabel value={42} />
      <CircularProgress aria-label='loading' color='success' showValueLabel value={88} />
      <CircularProgress aria-label='loading' color='warning' isIndeterminate size='lg' />
    </div>
  ),
};
