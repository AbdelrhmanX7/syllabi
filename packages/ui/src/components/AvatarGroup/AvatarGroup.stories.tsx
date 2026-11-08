import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Avatar } from '../Avatar/Avatar';
import { CLAY_FILL, CLAY_LABEL, clayKindFor, clayVars } from '../clay';
import { AvatarGroup } from './AvatarGroup';


const meta = {
  title: 'da-v2/AvatarGroup',
  component: AvatarGroup,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage p-10'>
        <Story />
      </div>
    ),
  ],
  args: { max: 3 },
} satisfies Meta<typeof AvatarGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: (args) => (
    <AvatarGroup {...args}>
      <Avatar name='M' />
      <Avatar name='O' />
      <Avatar name='A' />
      <Avatar name='K' />
      <Avatar name='R' />
      <Avatar name='N' />
    </AvatarGroup>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className='flex flex-col gap-4'>
      {(['sm', 'md', 'lg'] as const).map((s) => (
        <AvatarGroup key={s} max={3} size={s}>
          <Avatar name='M' />
          <Avatar name='O' />
          <Avatar name='A' />
          <Avatar name='K' />
          <Avatar name='R' />
        </AvatarGroup>
      ))}
    </div>
  ),
};

export const RenderCount: Story = {
  render: () => (
    <AvatarGroup
      max={2}
      renderCount={(n) => (
        // A custom count node, in clay rather than the scrapbook's citrine +
        // ink-border + diagonal shadow. Inert, so it is `.clay-surface` (raised,
        // no press ladder) — a lip that travels would promise a click there is
        // none of. Fill and label both come out of the maps; no literal colours.
        <span
          className='clay-surface inline-flex h-10 min-w-10 items-center justify-center rounded-full border-[3px] border-[color:var(--clay-edge)] px-3 text-[15px] font-bold'
          style={{
            background: CLAY_FILL.primary,
            color: CLAY_LABEL.primary,
            ...clayVars(CLAY_FILL.primary, { kind: clayKindFor('primary'), depth: 4 }),
          }}
        >
          +{n} others
        </span>
      )}
    >
      <Avatar name='M' />
      <Avatar name='O' />
      <Avatar name='A' />
      <Avatar name='K' />
      <Avatar name='R' />
    </AvatarGroup>
  ),
};
