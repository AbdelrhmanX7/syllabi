import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Chip } from './Chip';

const meta = {
  title: 'da-v2/Chip',
  component: Chip,
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
    color: { control: 'select', options: ['default', 'primary', 'secondary', 'success', 'warning', 'danger'] },
    variant: { control: 'select', options: ['solid', 'flat', 'bordered', 'dot', 'shadow', 'light'] },
    size: { control: 'inline-radio', options: ['sm', 'md', 'lg'] },
  },
  args: { color: 'primary', variant: 'flat', size: 'md', children: 'Physics' },
} satisfies Meta<typeof Chip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

const COLORS = ['default', 'primary', 'secondary', 'success', 'warning', 'danger'] as const;
const VARIANTS = ['solid', 'flat', 'bordered', 'dot', 'shadow', 'light'] as const;

export const Matrix: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className='flex flex-col gap-6'>
      {VARIANTS.map((variant) => (
        <section key={variant} className='flex flex-col gap-3'>
          <header className='font-hand text-ink text-[18px]'>{variant}</header>
          <div className='flex flex-wrap items-center gap-3'>
            {COLORS.map((color) => (
              <Chip color={color} key={color} variant={variant}>
                {color}
              </Chip>
            ))}
          </div>
        </section>
      ))}
    </div>
  ),
};

export const Closable: Story = {
  render: () => (
    <div className='flex flex-wrap items-center gap-3'>
      <Chip isClosable>Removable</Chip>
      <Chip color='success' isClosable variant='flat'>
        Done
      </Chip>
      <Chip color='danger' isClosable variant='bordered'>
        Rejected
      </Chip>
    </div>
  ),
};

export const Selected: Story = {
  render: () => (
    <div className='flex flex-wrap items-center gap-3'>
      <Chip>Idle</Chip>
      <Chip selected>Selected</Chip>
    </div>
  ),
};
