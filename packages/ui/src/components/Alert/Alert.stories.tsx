import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Alert } from './Alert';

const meta = {
  title: 'da-v2/Alert',
  component: Alert,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage w-[480px] max-w-full p-8'>
        <Story />
      </div>
    ),
  ],
  args: {
    title: 'Saved successfully',
    description: 'The data was saved to the log.',
    color: 'success',
  },
} satisfies Meta<typeof Alert>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Colors: Story = {
  render: () => (
    <div className='flex flex-col gap-3'>
      <Alert color='default' title='Default alert' description='A standard message.' />
      <Alert color='primary' title='Info' description='A new update is available.' />
      <Alert color='success' title='Success' description='Data saved.' />
      <Alert color='warning' title='Warning' description='Please check the data.' />
      <Alert color='danger' title='Error' description='The operation failed.' />
    </div>
  ),
};

export const Closable: Story = {
  args: {
    color: 'warning',
    title: 'You can close this alert',
    description: 'Press the close button on the right.',
    isClosable: true,
  },
};
