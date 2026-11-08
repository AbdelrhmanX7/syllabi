import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Select, SelectItem } from './Select';

const meta = {
  title: 'da-v2/Select',
  component: Select,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage w-[320px] max-w-full p-6 sm:p-10'>
        <Story />
      </div>
    ),
  ],
  args: { label: 'School level', placeholder: 'Select a level' },
} satisfies Meta<typeof Select>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Single: Story = {
  render: (args) => (
    <Select {...args}>
      <SelectItem key='primary'>Primary</SelectItem>
      <SelectItem key='middle'>Middle school</SelectItem>
      <SelectItem key='secondary'>High school</SelectItem>
    </Select>
  ),
};

export const Multiple: Story = {
  render: (args) => (
    <Select {...args} placeholder='Select tracks' selectionMode='multiple'>
      <SelectItem key='science'>Science</SelectItem>
      <SelectItem key='math'>Math</SelectItem>
      <SelectItem key='lit'>Humanities</SelectItem>
    </Select>
  ),
};

export const Invalid: Story = {
  render: (args) => (
    <Select {...args} errorMessage='Required field' isInvalid>
      <SelectItem key='primary'>Primary</SelectItem>
      <SelectItem key='middle'>Middle school</SelectItem>
    </Select>
  ),
};

/**
 * A destructive option must not highlight the same colour as a neutral one —
 * the single place a menu most needs to say something different. Each item's
 * wash and selected fill follow its OWN `color`.
 */
export const DestructiveOption: Story = {
  render: (args) => (
    <Select {...args} placeholder='Action'>
      <SelectItem key='rename'>Rename</SelectItem>
      <SelectItem key='duplicate'>Copy</SelectItem>
      <SelectItem key='archive' color='warning'>
        Archive
      </SelectItem>
      <SelectItem key='delete' color='danger'>
        Delete permanently
      </SelectItem>
    </Select>
  ),
};
