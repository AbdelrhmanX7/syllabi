import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Spacer } from './Spacer';


const meta = {
  title: 'da-v2/Spacer',
  component: Spacer,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage p-10'>
        <Story />
      </div>
    ),
  ],
  args: { x: 4, y: 4 },
} satisfies Meta<typeof Spacer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: (args) => (
    <div className='clay-well inline-flex items-center px-4 py-3'>
      <span className='text-ink font-bold'>Before</span>
      <Spacer {...args} />
      <span className='text-ink font-bold'>After</span>
    </div>
  ),
};
