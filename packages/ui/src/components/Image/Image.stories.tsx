import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Image } from './Image';


const meta = {
  title: 'da-v2/Image',
  component: Image,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage p-10'>
        <Story />
      </div>
    ),
  ],
  args: {
    src: 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=400',
    alt: 'demo',
    width: 240,
    height: 160,
  },
} satisfies Meta<typeof Image>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Variants: Story = {
  render: () => (
    <div className='flex flex-wrap items-end gap-6'>
      <Image
        alt='zoom'
        height={160}
        isZoomed
        src='https://images.unsplash.com/photo-1518770660439-4636190af475?w=400'
        width={240}
      />
      <Image
        alt='blurred'
        height={160}
        isBlurred
        src='https://images.unsplash.com/photo-1518770660439-4636190af475?w=400'
        width={240}
      />
    </div>
  ),
};

export const Error: Story = {
  args: { src: 'https://invalid-url.example/missing.png' },
};
