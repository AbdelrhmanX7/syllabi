import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { CLAY_FILL, clayVars } from '../clay';
import type { HeroUIColor } from '../tokens';
import { Checkbox } from './Checkbox';

// A clay card, not the scrapbook's tilted paper — the control has to be judged
// on the surface it will actually sit on.
const ClayCard = ({ children }: { children: React.ReactNode }) => (
  <div
    className='clay-surface rounded-[20px] border-[3px] border-[color:var(--clay-edge)] p-8'
    style={{ background: CLAY_FILL.default, ...clayVars(CLAY_FILL.default, { kind: 'surface', depth: 8 }) }}
  >
    {children}
  </div>
);

const meta = {
  title: 'da-v2/Checkbox',
  component: Checkbox,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <ClayCard>
        <Story />
      </ClayCard>
    ),
  ],
  args: { children: 'I agree to the terms' },
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const States: Story = {
  render: () => (
    <div className='flex flex-col gap-3'>
      <Checkbox>Unchecked</Checkbox>
      <Checkbox defaultSelected>Checked</Checkbox>
      <Checkbox isIndeterminate>Indeterminate</Checkbox>
      <Checkbox isDisabled>Disabled</Checkbox>
      <Checkbox isInvalid>Invalid</Checkbox>
      <Checkbox lineThrough defaultSelected>
        Line-through when checked
      </Checkbox>
    </div>
  ),
};

const COLORS: HeroUIColor[] = ['default', 'primary', 'secondary', 'success', 'warning', 'danger'];

/** Every fill × every state — the surface the tick contrast is measured on. */
export const ColorMatrix: Story = {
  render: () => (
    <div className='flex flex-col gap-3'>
      {COLORS.map((c) => (
        <div key={c} className='flex items-center gap-5'>
          <span className='text-ink w-24 text-[13px] font-bold'>{c}</span>
          <Checkbox color={c} data-cb={`${c}-off`} />
          <Checkbox defaultSelected color={c} data-cb={`${c}-on`} />
          <Checkbox isIndeterminate color={c} data-cb={`${c}-ind`} />
          <Checkbox defaultSelected color={c} size='sm' />
          <Checkbox defaultSelected color={c} size='lg' />
        </div>
      ))}
    </div>
  ),
};
