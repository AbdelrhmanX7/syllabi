import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { NumberInput } from './NumberInput';

const meta = {
  title: 'da-v2/NumberInput',
  component: NumberInput,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage w-full max-w-[360px] p-10'>
        <Story />
      </div>
    ),
  ],
  args: { label: 'Count', placeholder: 'Enter a number', defaultValue: 0 },
} satisfies Meta<typeof NumberInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const WithMinMaxStep: Story = {
  args: { label: 'Percentage', minValue: 0, maxValue: 100, step: 5, defaultValue: 50 },
};

export const Currency: Story = {
  args: {
    label: 'Price',
    defaultValue: 1234.5,
    formatOptions: { style: 'currency', currency: 'EGP' },
  },
};

export const HideStepper: Story = {
  args: { label: 'No steppers', hideStepper: true, defaultValue: 7 },
};

export const Invalid: Story = {
  args: { label: 'Count', isInvalid: true, errorMessage: 'Invalid number', defaultValue: 0 },
};
