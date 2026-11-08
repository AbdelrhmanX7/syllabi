import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Card, CardBody, CardFooter, CardHeader } from './Card';

const meta = {
  title: 'da-v2/Card',
  component: Card,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage w-[420px] max-w-full p-12'>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: () => (
    <Card className='w-full max-w-[320px]'>
      <CardHeader>
        <span className='text-[13px] font-bold uppercase tracking-wider text-[hsl(var(--heroui-primary))]'>
          Featured
        </span>
        <h3 className='text-[20px] font-black'>A raised surface</h3>
      </CardHeader>
      <CardBody>
        <p className='text-[14px] opacity-70'>
          A 3px edge in a mid-tone of the fill, and a solid lip straight down. No press: a card is not a key.
        </p>
      </CardBody>
      <CardFooter>
        <span className='text-[14px] opacity-70'>5 min read</span>
      </CardFooter>
    </Card>
  ),
};

/** The lip ladder. This is the only visual knob `shadow` has left. */
export const ShadowLadder: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className='flex flex-wrap gap-8'>
      {(['none', 'sm', 'md', 'lg'] as const).map((s) => (
        <Card className='w-[150px]' key={s} shadow={s}>
          <CardBody>
            <span className='font-bold'>shadow={s}</span>
          </CardBody>
        </Card>
      ))}
    </div>
  ),
};

/**
 * The three hover contracts side by side — the point of this story is what the
 * FIRST card does, which is nothing. Hover each in turn.
 */
export const HoverContracts: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className='flex flex-wrap gap-8'>
      <Card className='w-[170px]'>
        <CardBody>
          <span className='font-bold'>static</span>
          <span className='text-[13px] opacity-70'>no hover response — it cannot be pushed</span>
        </CardBody>
      </Card>
      <Card className='w-[170px]' isHoverable>
        <CardBody>
          <span className='font-bold'>isHoverable</span>
          <span className='text-[13px] opacity-70'>rises 2px, lip grows 2px</span>
        </CardBody>
      </Card>
      <Card className='w-[170px]' isPressable onPress={() => undefined}>
        <CardBody>
          <span className='font-bold'>isPressable</span>
          <span className='text-[13px] opacity-70'>a real key — depresses</span>
        </CardBody>
      </Card>
    </div>
  ),
};

/**
 * A card on a card. This is the ground `clayKindFor` cannot see: the rim is
 * mixed from the card's own FILL, but what it has to separate the card from is
 * whatever is BEHIND it, and that is a different colour here than on the page.
 */
export const Nested: Story = {
  render: () => (
    <Card className='w-full max-w-[340px]'>
      <CardHeader>
        <h3 className='text-[18px] font-black'>Outer card</h3>
      </CardHeader>
      <CardBody>
        <Card className='w-full' shadow='sm'>
          <CardBody>
            <span className='font-bold'>Inner card</span>
            <span className='text-[13px] opacity-70'>
              Steps to `--surface-2`, so it is not painting its parent&apos;s exact colour. Visible in dark; a no-op
              in light, where that rung is the same value.
            </span>
          </CardBody>
        </Card>
      </CardBody>
    </Card>
  ),
};

export const Pressable: Story = {
  render: () => (
    <Card className='w-full max-w-[280px]' isPressable onPress={() => alert('pressed')}>
      <CardBody>Press me</CardBody>
    </Card>
  ),
};

/*
 * The three stories below cover props that clay retired. They are kept as
 * stories on purpose: the props are still ACCEPTED (six apps pass them) and
 * something should show that they now do nothing, rather than the prop quietly
 * disappearing from the docs page and someone assuming it was removed.
 */

export const WithTape: Story = {
  render: () => (
    <Card className='w-full max-w-[300px]' withTape>
      <CardBody>
        <span className='font-bold'>withTape — accepted, no-op</span>
        <span className='text-[13px] opacity-70'>Washi tape was a scrapbook extra. `Tape` is still exported.</span>
      </CardBody>
    </Card>
  ),
};

export const WithPin: Story = {
  render: () => (
    <Card className='w-full max-w-[300px]' withPin>
      <CardBody>
        <span className='font-bold'>withPin — accepted, no-op</span>
        <span className='text-[13px] opacity-70'>Also `withHoles`, `withGrain`, `tilted`, `rotate`.</span>
      </CardBody>
    </Card>
  ),
};

export const ShadowColors: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className='flex flex-wrap gap-8'>
      {(['ink', 'primary', 'danger'] as const).map((c) => (
        <Card className='w-[170px]' key={c} shadowColor={c}>
          <CardBody>
            <span className='font-bold'>shadowColor={c}</span>
            <span className='text-[13px] opacity-70'>
              No-op — clay&apos;s lip is the card&apos;s own side wall, derived from its fill.
            </span>
          </CardBody>
        </Card>
      ))}
    </div>
  ),
};
