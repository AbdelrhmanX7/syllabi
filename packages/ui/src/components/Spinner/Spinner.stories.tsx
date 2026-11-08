import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Spinner } from './Spinner';

const meta = {
  title: 'da-v2/Spinner',
  component: Spinner,
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
    color: {
      control: 'select',
      options: ['default', 'primary', 'secondary', 'success', 'warning', 'danger', 'current'],
    },
    size: { control: 'inline-radio', options: ['sm', 'md', 'lg'] },
  },
  args: { color: 'primary', size: 'md', label: 'Loading…' },
} satisfies Meta<typeof Spinner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Sizes: Story = {
  render: () => (
    <div className='flex items-center gap-6'>
      <Spinner size='sm' />
      <Spinner size='md' />
      <Spinner size='lg' />
    </div>
  ),
};

export const Colors: Story = {
  render: () => (
    <div className='flex flex-wrap items-center gap-6'>
      {(['default', 'primary', 'secondary', 'success', 'warning', 'danger'] as const).map((c) => (
        <Spinner color={c} key={c} label={c} />
      ))}
    </div>
  ),
};
