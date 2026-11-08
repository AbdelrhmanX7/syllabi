import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Button } from '../Button';
import { Popover, PopoverContent, PopoverTrigger } from './Popover';

const meta = {
  title: 'da-v2/Popover',
  component: Popover,
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
    children: null,
  },
} satisfies Meta<typeof Popover>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: () => (
    <Popover placement='bottom' showArrow>
      <PopoverTrigger>
        <Button variant='bordered'>Open menu</Button>
      </PopoverTrigger>
      <PopoverContent>
        <div className='flex flex-col gap-2'>
          <p className='text-sm font-bold'>Popover content</p>
          <p className='text-ink/70 text-xs'>Any content can go here.</p>
        </div>
      </PopoverContent>
    </Popover>
  ),
};

export const Placements: Story = {
  render: () => (
    <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6'>
      {(['top', 'bottom', 'left', 'right'] as const).map((p) => (
        <Popover key={p} placement={p} showArrow>
          <PopoverTrigger>
            <Button variant='bordered'>{p}</Button>
          </PopoverTrigger>
          <PopoverContent>
            <p className='text-sm font-bold'>{p} placement</p>
          </PopoverContent>
        </Popover>
      ))}
    </div>
  ),
};

export const WithBackdrop: Story = {
  render: () => (
    <div className='flex flex-wrap gap-3'>
      <Popover backdrop='opaque' placement='bottom'>
        <PopoverTrigger>
          <Button variant='bordered'>opaque</Button>
        </PopoverTrigger>
        <PopoverContent>
          <p className='text-sm font-bold'>Blocked</p>
        </PopoverContent>
      </Popover>
      <Popover backdrop='blur' placement='bottom'>
        <PopoverTrigger>
          <Button variant='bordered'>blur</Button>
        </PopoverTrigger>
        <PopoverContent>
          <p className='text-sm font-bold'>Blurred</p>
        </PopoverContent>
      </Popover>
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className='flex flex-wrap gap-3'>
      {(['sm', 'md', 'lg'] as const).map((s) => (
        <Popover key={s} placement='bottom' showArrow size={s}>
          <PopoverTrigger>
            <Button variant='bordered'>{s}</Button>
          </PopoverTrigger>
          <PopoverContent>
            <p>Size {s} content</p>
          </PopoverContent>
        </Popover>
      ))}
    </div>
  ),
};
