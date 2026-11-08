import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { CLAY_FILL, clayVars } from '../clay';
import type { HeroUIColor } from '../tokens';
import { Radio, RadioGroup } from './RadioGroup';

// A clay card, not the scrapbook's tilted paper.
const ClayCard = ({ children }: { children: React.ReactNode }) => (
  <div
    className='clay-surface w-full max-w-[340px] rounded-[20px] border-[3px] border-[color:var(--clay-edge)] p-6 sm:p-8'
    style={{ background: CLAY_FILL.default, ...clayVars(CLAY_FILL.default, { kind: 'surface', depth: 8 }) }}
  >
    {children}
  </div>
);

const meta = {
  title: 'da-v2/RadioGroup',
  component: RadioGroup,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <ClayCard>
        <Story />
      </ClayCard>
    ),
  ],
  args: { label: 'Correct answer' },
} satisfies Meta<typeof RadioGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Vertical: Story = {
  render: (args) => (
    <RadioGroup {...args} defaultValue='a'>
      <Radio description='The first option' value='a'>
        Option A
      </Radio>
      <Radio description='The second option' value='b'>
        Option B
      </Radio>
      <Radio value='c'>Option C</Radio>
      <Radio isDisabled value='d'>
        Off
      </Radio>
    </RadioGroup>
  ),
};

export const Horizontal: Story = {
  render: (args) => (
    <RadioGroup {...args} defaultValue='true' orientation='horizontal'>
      <Radio value='true'>Correct</Radio>
      <Radio value='false'>Wrong</Radio>
    </RadioGroup>
  ),
};

export const Invalid: Story = {
  render: (args) => (
    <RadioGroup {...args} errorMessage='Required field' isInvalid>
      <Radio value='a'>A</Radio>
      <Radio value='b'>B</Radio>
    </RadioGroup>
  ),
};

const COLORS: HeroUIColor[] = ['default', 'primary', 'secondary', 'success', 'warning', 'danger'];

/** Every fill × both states — the surface the dot contrast is measured on. */
export const ColorMatrix: Story = {
  render: () => (
    <div className='flex flex-col gap-3'>
      {COLORS.map((c) => (
        <RadioGroup key={c} color={c} defaultValue='on' orientation='horizontal'>
          <Radio value='on'>{c}</Radio>
          <Radio value='off'>off</Radio>
        </RadioGroup>
      ))}
    </div>
  ),
};
