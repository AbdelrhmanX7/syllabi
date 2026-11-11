import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Tag } from './Tag';

const meta = {
  title: 'da-v2/Tag',
  component: Tag,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  args: { children: 'Physics' },
} satisfies Meta<typeof Tag>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Row: Story = {
  render: () => (
    <div className='flex max-w-xs flex-wrap gap-2'>
      <Tag>Calculus</Tag>
      <Tag>Limits</Tag>
      <Tag onRemove={() => undefined}>Derivatives</Tag>
      <Tag>+2</Tag>
    </div>
  ),
};
