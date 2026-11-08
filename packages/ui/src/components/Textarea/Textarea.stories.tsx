import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Textarea } from './Textarea';

const meta = {
  title: 'da-v2/Textarea',
  component: Textarea,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage w-[460px] max-w-full p-6 sm:p-10'>
        <Story />
      </div>
    ),
  ],
  args: { label: 'Comment', placeholder: 'Write your thoughts here…' },
} satisfies Meta<typeof Textarea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Invalid: Story = {
  render: () => <Textarea errorMessage='Text is too short' isInvalid label='Comment' value='hi' />,
};
