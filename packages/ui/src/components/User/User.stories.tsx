import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { User } from './User';


const meta = {
  title: 'da-v2/User',
  component: User,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage p-10'>
        <Story />
      </div>
    ),
  ],
  args: { name: 'Mohamed Abdullah', description: 'Math teacher' },
} satisfies Meta<typeof User>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const WithAvatarProps: Story = {
  render: () => (
    <div className='flex flex-col gap-3'>
      <User avatarProps={{ color: 'primary', name: 'M' }} description='Student · Middle school' name='Mohamed Ali' />
      <User avatarProps={{ color: 'success', name: 'O' }} description='admin@example.com' name='Omar K.' />
    </div>
  ),
};
