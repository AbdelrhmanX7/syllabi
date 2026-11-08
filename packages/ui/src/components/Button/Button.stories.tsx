import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Button, type ButtonProps } from './Button';

const meta = {
  title: 'da-v2/Button',
  component: Button,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage p-10'>
        <Story />
      </div>
    ),
  ],
  argTypes: {
    color: {
      control: 'select',
      options: ['default', 'primary', 'secondary', 'success', 'warning', 'danger'],
    },
    variant: {
      control: 'select',
      options: ['solid', 'flat', 'bordered', 'light', 'ghost', 'shadow'],
    },
    size: { control: 'inline-radio', options: ['sm', 'md', 'lg'] },
    radius: { control: 'select', options: ['none', 'sm', 'md', 'lg', 'full'] },
    isIconOnly: { control: 'boolean' },
    isLoading: { control: 'boolean' },
    isDisabled: { control: 'boolean' },
    fullWidth: { control: 'boolean' },
    children: { control: 'text' },
  },
  args: {
    children: 'Start now',
    color: 'primary',
    variant: 'solid',
    size: 'md',
    radius: 'md',
    isIconOnly: false,
    isLoading: false,
    isDisabled: false,
    fullWidth: false,
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

const ArrowIcon = () => (
  <svg
    fill='none'
    stroke='currentColor'
    strokeLinecap='round'
    strokeLinejoin='round'
    strokeWidth={2.4}
    viewBox='0 0 24 24'
  >
    <path d='M5 12h14M13 6l6 6-6 6' />
  </svg>
);

const HeartIcon = () => (
  <svg
    fill='none'
    stroke='currentColor'
    strokeLinecap='round'
    strokeLinejoin='round'
    strokeWidth={2.4}
    viewBox='0 0 24 24'
  >
    <path d='M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78Z' />
  </svg>
);

const PlusIcon = () => (
  <svg
    fill='none'
    stroke='currentColor'
    strokeLinecap='round'
    strokeLinejoin='round'
    strokeWidth={2.4}
    viewBox='0 0 24 24'
  >
    <path d='M12 5v14M5 12h14' />
  </svg>
);

export const Playground: Story = {};

const COLORS = ['default', 'primary', 'secondary', 'success', 'warning', 'danger'] as const;
const VARIANTS = ['solid', 'flat', 'bordered', 'light', 'ghost', 'shadow'] as const;

/** Every variant × every color rendered in scrapbook style — the core matrix. */
export const Matrix: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className='flex flex-col gap-8'>
      {VARIANTS.map((variant) => (
        <section key={variant} className='flex flex-col gap-3'>
          <header className='font-hand text-ink text-[20px] font-bold'>{variant}</header>
          <div className='flex flex-wrap items-center gap-4'>
            {COLORS.map((color) => (
              <Button color={color} key={color} variant={variant}>
                {color}
              </Button>
            ))}
          </div>
        </section>
      ))}
    </div>
  ),
};

/** sm / md / lg, with icon-only variants. */
export const Sizes: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className='flex flex-col gap-6'>
      <div className='flex items-center gap-4'>
        <Button size='sm'>Small</Button>
        <Button size='md'>Medium</Button>
        <Button size='lg'>Large</Button>
      </div>
      <div className='flex items-center gap-4'>
        <Button isIconOnly aria-label='Add' size='sm'>
          <PlusIcon />
        </Button>
        <Button isIconOnly aria-label='Add' size='md'>
          <PlusIcon />
        </Button>
        <Button isIconOnly aria-label='Add' size='lg'>
          <PlusIcon />
        </Button>
      </div>
    </div>
  ),
};

/** All five radius tokens. Scrapbook prefers small radii — `full` still works for chips/avatars. */
export const Radii: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className='flex flex-wrap items-center gap-4'>
      {(['none', 'sm', 'md', 'lg', 'full'] as const).map((radius) => (
        <Button key={radius} radius={radius}>
          radius={radius}
        </Button>
      ))}
    </div>
  ),
};

export const WithIcons: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className='flex flex-wrap items-center gap-4'>
      <Button startContent={<HeartIcon />}>Like</Button>
      <Button endContent={<ArrowIcon />} variant='flat'>
        Continue
      </Button>
      <Button color='danger' startContent={<PlusIcon />} variant='bordered'>
        Create
      </Button>
      <Button color='success' endContent={<ArrowIcon />} startContent={<HeartIcon />} variant='shadow'>
        Both
      </Button>
    </div>
  ),
};

export const IconOnly: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className='flex flex-col gap-4'>
      <div className='flex items-center gap-3'>
        {VARIANTS.map((variant) => (
          <Button aria-label={`${variant} icon`} isIconOnly key={variant} size='sm' variant={variant}>
            <HeartIcon />
          </Button>
        ))}
      </div>
      <div className='flex items-center gap-3'>
        {COLORS.map((color) => (
          <Button aria-label={`${color} icon`} color={color} isIconOnly key={color} size='md'>
            <PlusIcon />
          </Button>
        ))}
      </div>
    </div>
  ),
};

export const Loading: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className='flex flex-wrap items-center gap-4'>
      <Button isLoading>Saving…</Button>
      <Button isLoading variant='flat'>
        Saving
      </Button>
      <Button color='danger' isLoading variant='bordered'>
        Deleting
      </Button>
      <Button aria-label='loading' color='success' isIconOnly isLoading size='md' />
    </div>
  ),
};

export const Disabled: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className='flex flex-wrap items-center gap-4'>
      <Button isDisabled>Disabled solid</Button>
      <Button isDisabled variant='flat'>
        Disabled flat
      </Button>
      <Button isDisabled variant='bordered'>
        Disabled bordered
      </Button>
      <Button isDisabled variant='light'>
        Disabled light
      </Button>
    </div>
  ),
};

export const FullWidth: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className='w-full max-w-[420px] space-y-4'>
      <Button fullWidth>Continue</Button>
      <Button fullWidth variant='bordered'>
        Back
      </Button>
    </div>
  ),
};

export const AsLink: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className='flex flex-wrap items-center gap-4'>
      <Button as='a' href='#' startContent={<ArrowIcon />}>
        Internal link
      </Button>
      <Button as='a' href='https://example.com' rel='noreferrer' target='_blank' variant='bordered'>
        External
      </Button>
    </div>
  ),
};

export const InContext: Story = {
  parameters: { layout: 'padded' },
  render: (args: ButtonProps) => (
    <div className='flex flex-col gap-6'>
      <div className='clay-stage flex w-full max-w-[480px] items-center justify-end gap-3 p-4'>
        <Button variant='light' {...args} color='default'>
          Cancel
        </Button>
        <Button {...args} color='primary'>
          Save changes
        </Button>
      </div>

      {/* An icon-button toolbar sits IN something — a recessed well, not a
          raised tray: it holds the buttons rather than competing with them. */}
      <div className='clay-well flex items-center gap-2 p-2'>
        <Button isIconOnly aria-label='Like' size='sm' variant='light'>
          <HeartIcon />
        </Button>
        <Button isIconOnly aria-label='Add' size='sm' variant='light'>
          <PlusIcon />
        </Button>
        <Button isIconOnly aria-label='Forward' size='sm' variant='light'>
          <ArrowIcon />
        </Button>
      </div>
    </div>
  ),
};
