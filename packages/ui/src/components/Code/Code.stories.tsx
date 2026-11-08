import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Code } from './Code';

const meta = {
  title: 'da-v2/Code',
  component: Code,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage p-10'>
        <Story />
      </div>
    ),
  ],
  args: { children: 'npm install' },
} satisfies Meta<typeof Code>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Colors: Story = {
  render: () => (
    <div className='flex flex-wrap items-center gap-3'>
      {(['default', 'primary', 'secondary', 'success', 'warning', 'danger'] as const).map((c) => (
        <Code color={c} key={c}>
          {c}
        </Code>
      ))}
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className='flex flex-wrap items-center gap-3'>
      <Code size='sm'>size sm</Code>
      <Code size='md'>size md</Code>
      <Code size='lg'>size lg</Code>
    </div>
  ),
};
