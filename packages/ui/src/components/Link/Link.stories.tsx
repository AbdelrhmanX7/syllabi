import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Link } from './Link';

const meta = {
  title: 'da-v2/Link',
  component: Link,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage p-10'>
        <Story />
      </div>
    ),
  ],
  args: { children: 'Read more', href: '#', color: 'primary', underline: 'hover' },
} satisfies Meta<typeof Link>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Colors: Story = {
  render: () => (
    <div className='flex flex-wrap items-center gap-4'>
      {(['foreground', 'primary', 'secondary', 'success', 'warning', 'danger'] as const).map((c) => (
        <Link color={c} href='#' key={c} underline='always'>
          {c}
        </Link>
      ))}
    </div>
  ),
};

export const Underlines: Story = {
  render: () => (
    <div className='flex flex-wrap items-center gap-6'>
      {(['none', 'hover', 'always', 'active', 'focus'] as const).map((u) => (
        <Link href='#' key={u} underline={u}>
          {u}
        </Link>
      ))}
    </div>
  ),
};

export const ExternalAndDisabled: Story = {
  render: () => (
    <div className='flex flex-col gap-3'>
      <Link href='https://example.com' isExternal>
        External link
      </Link>
      <Link href='#' isDisabled>
        Disabled link
      </Link>
    </div>
  ),
};
