import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Checkbox } from '../Checkbox';

import { CheckboxGroup } from './CheckboxGroup';

const meta = {
  title: 'da-v2/CheckboxGroup',
  component: CheckboxGroup,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage w-[360px] max-w-full p-10'>
        <Story />
      </div>
    ),
  ],
  args: { label: 'Interests' },
} satisfies Meta<typeof CheckboxGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Vertical: Story = {
  render: (args) => (
    <CheckboxGroup {...args} defaultValue={['a']}>
      <Checkbox value='a'>Math</Checkbox>
      <Checkbox value='b'>Physics</Checkbox>
      <Checkbox value='c'>Chemistry</Checkbox>
      <Checkbox isDisabled value='d'>
        Biology
      </Checkbox>
    </CheckboxGroup>
  ),
};

export const Horizontal: Story = {
  render: (args) => (
    <CheckboxGroup {...args} orientation='horizontal'>
      <Checkbox value='1'>Morning</Checkbox>
      <Checkbox value='2'>Afternoon</Checkbox>
      <Checkbox value='3'>Evening</Checkbox>
    </CheckboxGroup>
  ),
};

export const Invalid: Story = {
  render: (args) => (
    <CheckboxGroup {...args} errorMessage='Pick at least one option' isInvalid>
      <Checkbox value='a'>A</Checkbox>
      <Checkbox value='b'>B</Checkbox>
    </CheckboxGroup>
  ),
};
