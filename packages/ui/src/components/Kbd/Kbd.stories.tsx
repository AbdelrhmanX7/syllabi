import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Kbd } from './Kbd';

const meta = {
  title: 'da-v2/Kbd',
  component: Kbd,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage p-10'>
        <Story />
      </div>
    ),
  ],
  args: { keys: ['command'], children: 'K' },
} satisfies Meta<typeof Kbd>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Combinations: Story = {
  render: () => (
    <div className='flex flex-col items-start gap-3'>
      <Kbd keys={['command']}>K</Kbd>
      <Kbd keys={['command', 'shift']}>P</Kbd>
      <Kbd keys={['ctrl', 'option', 'delete']} />
      <Kbd keys={['enter']} />
      <Kbd keys={['up', 'down', 'left', 'right']} />
    </div>
  ),
};
