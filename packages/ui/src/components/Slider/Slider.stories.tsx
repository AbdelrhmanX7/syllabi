import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Slider } from './Slider';

const meta = {
  title: 'da-v2/Slider',
  component: Slider,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage w-[420px] max-w-full p-8'>
        <Story />
      </div>
    ),
  ],
  args: {
    label: 'Quantity',
    defaultValue: 50,
    minValue: 0,
    maxValue: 100,
    step: 1,
  },
} satisfies Meta<typeof Slider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const WithSteps: Story = {
  args: {
    showSteps: true,
    step: 10,
    maxValue: 100,
    defaultValue: 30,
  },
};

export const WithTooltip: Story = {
  args: {
    showTooltip: true,
  },
};

export const Range: Story = {
  args: {
    isRange: true,
    defaultValue: [20, 75],
    label: 'Price range',
  },
};

export const Colors: Story = {
  render: () => (
    <div className='space-y-4'>
      {(['default', 'primary', 'success', 'warning', 'danger'] as const).map((c) => (
        <Slider key={c} color={c} defaultValue={40} label={c} />
      ))}
    </div>
  ),
};
