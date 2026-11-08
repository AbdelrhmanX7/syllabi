import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Button } from '../Button';
import { addToast, closeAll, Toast, ToastProvider } from './Toast';
import type { ToastVariant } from './Toast';
import type { HeroUIColor } from '../tokens';

const meta = {
  title: 'da-v2/Toast',
  component: Toast,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage p-10'>
        <ToastProvider />
        <Story />
      </div>
    ),
  ],
  args: { title: 'Saved', description: 'Data updated successfully' },
} satisfies Meta<typeof Toast>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: () => (
    <div className='flex flex-wrap gap-3'>
      <Button color='primary' onPress={() => addToast({ title: 'Hello', description: 'A regular message' })}>
        Default
      </Button>
      <Button
        color='success'
        onPress={() => addToast({ title: 'Done', color: 'success', shouldShowTimeoutProgress: true })}
      >
        Success
      </Button>
      <Button color='danger' onPress={() => addToast({ title: 'Something went wrong', color: 'danger', timeout: 0 })}>
        Danger sticky
      </Button>
      <Button color='warning' onPress={() => addToast({ title: 'Notice', color: 'warning', variant: 'bordered' })}>
        Warning bordered
      </Button>
      <Button onPress={() => closeAll()} variant='light'>
        Close all
      </Button>
    </div>
  ),
};

export const Promise: Story = {
  render: () => (
    <Button
      color='primary'
      onPress={() => {
        const p = new window.Promise((resolve) => setTimeout(resolve, 1500));
        addToast({ title: 'Saving…', promise: p });
      }}
    >
      Promise demo
    </Button>
  ),
};

const COLORS: HeroUIColor[] = ['default', 'primary', 'secondary', 'success', 'warning', 'danger'];
const VARIANTS: ToastVariant[] = ['flat', 'bordered', 'solid'];

const Legend = ({ children }: { children: React.ReactNode }) => (
  <span className='text-ink-muted text-xs font-bold'>
    {children}
  </span>
);

/**
 * The severity surface, which had no story at all before the clay port — and it is
 * exactly the thing worth proving, because severity is the ONLY job this component has.
 *
 * What to read here: the icon chip. It used to be `var(--citrine)` on every severity in
 * `Alert` and a clipped washi strip in `Toast`, so severity was carried by the 16px glyph
 * and the face wash and nothing else. The chip is now the severity fill at full strength,
 * which puts a saturated hue right beside the title in every variant — including `solid`,
 * where it inverts rather than disappearing into a face of its own colour.
 *
 * `<Toast>` is rendered statically here rather than through `addToast`, so the whole grid
 * sits still and can be compared. The live queue is in Playground.
 */
export const SeverityMatrix: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className='flex flex-col gap-8'>
      {VARIANTS.map((variant) => (
        <section className='flex flex-col gap-3' key={variant}>
          <Legend>variant=&quot;{variant}&quot;</Legend>
          <div className='flex flex-wrap items-start gap-4'>
            {COLORS.map((color) => (
              <Toast
                color={color}
                description='Short message description'
                hideCloseButton
                key={color}
                title={color}
                variant={variant}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  ),
};

/**
 * `severity` and `color` are separate props: `severity` picks the GLYPH, `color` picks the
 * palette. They were allowed to disagree — and still are, since that is the HeroUI contract
 * — but it is worth being able to see the disagreement rather than discovering it in an app.
 */
export const SeverityVersusColor: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className='flex flex-wrap items-start gap-4'>
      <Toast color='default' hideCloseButton severity='danger' title='severity=danger' description='color=default' />
      <Toast color='danger' hideCloseButton severity='success' title='severity=success' description='color=danger' />
      <Toast color='success' hideCloseButton title='matched' description='severity unset' />
    </div>
  ),
};
