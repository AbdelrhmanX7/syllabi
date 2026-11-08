import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Snippet } from './Snippet';

const meta = {
  title: 'da-v2/Snippet',
  component: Snippet,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage w-[640px] max-w-full p-10'>
        <Story />
      </div>
    ),
  ],
  args: { children: 'npm install @repo/ui' },
} satisfies Meta<typeof Snippet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const MultiLine: Story = {
  args: {
    children: ['git clone repo.git', 'cd repo', 'yarn install', 'yarn dev'],
  },
};

export const Variants: Story = {
  render: () => (
    <div className='flex flex-col gap-3'>
      {(['flat', 'solid', 'shadow', 'bordered'] as const).map((v) => (
        <Snippet key={v} variant={v}>
          variant: {v}
        </Snippet>
      ))}
    </div>
  ),
};

export const Colors: Story = {
  render: () => (
    <div className='flex flex-col gap-3'>
      {(['default', 'primary', 'secondary', 'success', 'warning', 'danger'] as const).map((c) => (
        <Snippet color={c} key={c}>
          color: {c}
        </Snippet>
      ))}
    </div>
  ),
};

export const HideSymbolNoCopy: Story = {
  render: () => (
    <div className='flex flex-col gap-3'>
      <Snippet hideSymbol>without leading $ symbol</Snippet>
      <Snippet hideCopyButton>without copy button</Snippet>
    </div>
  ),
};
