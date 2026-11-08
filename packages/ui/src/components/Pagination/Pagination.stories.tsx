import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Pagination } from './Pagination';

const meta = {
  title: 'da-v2/Pagination',
  component: Pagination,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='bg-background w-full max-w-[520px] overflow-x-auto rounded-[20px] p-10'>
        <Story />
      </div>
    ),
  ],
  args: { total: 12, initialPage: 4 },
} satisfies Meta<typeof Pagination>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithControls: Story = { args: { showControls: true } };

export const Compact: Story = { args: { isCompact: true, showControls: true } };

export const Shadowed: Story = { args: { showShadow: true, showControls: true } };
