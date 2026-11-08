import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Input } from './Input';

const meta = {
  title: 'da-v2/Input',
  component: Input,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage w-[420px] max-w-full p-10'>
        <Story />
      </div>
    ),
  ],
  args: { label: 'Name', placeholder: 'Type your name here' },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Sizes: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className='flex w-full max-w-[360px] flex-col gap-4'>
      <Input label='Small' placeholder='small' size='sm' />
      <Input label='Medium' placeholder='medium' size='md' />
      <Input label='Large' placeholder='large' size='lg' />
    </div>
  ),
};

export const Invalid: Story = {
  render: () => <Input errorMessage='Invalid email' isInvalid label='Email' value='not-an-email' />,
};

export const Variants: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className='flex w-full max-w-[360px] flex-col gap-4'>
      <Input label='bordered' placeholder='bordered' variant='bordered' />
      <Input label='flat' placeholder='flat' variant='flat' />
      <Input label='underlined' placeholder='underlined' variant='underlined' />
      <Input label='faded' placeholder='faded' variant='faded' />
    </div>
  ),
};

/**
 * The `validate` prop, which for a long time was declared and never called — see
 * `useValidation`. This story exists as a regression test for exactly that: it is
 * the only place the behaviour can be exercised without a backend, and the bug was
 * invisible to `tsc`, to lint, and to every visual review.
 *
 * What to check: the rule RUNS from mount (so `checkValidity()` is false on an empty
 * field and a native submit is blocked) but only SHOWS after the field has been
 * blurred once. Both halves matter — running late lets a bad value submit, showing
 * early puts a red error under every field the moment a form opens.
 */
export const Validation: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <form className='flex w-full max-w-[360px] flex-col gap-4'>
      <Input
        data-testid='min-length'
        label='Password'
        placeholder='At least 8 characters'
        type='password'
        validate={(value) => {
          if (!value.length) return 'Password is required';

          if (value.length < 8) return 'Password must be at least 8 characters';

          return null;
        }}
      />
      <Input
        data-testid='digits-only'
        label='Phone number'
        placeholder='01xxxxxxxxx'
        type='tel'
        validate={(value) => (/^01\d{9}$/.test(value) ? null : 'Invalid number')}
      />
      {/* A prop-driven error still WINS over a passing rule — a parent that has
          already decided a field is bad (a server rejection, a cross-field rule)
          knows something the local rule cannot. */}
      <Input
        errorMessage='This number is already registered'
        isInvalid
        label='Already registered'
        validate={() => null}
        value='01100000001'
      />
    </form>
  ),
};
