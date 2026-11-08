import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Button } from '../Button';
import { Input } from '../Input';

import { Form } from './Form';

const meta = {
  title: 'da-v2/Form',
  component: Form,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage w-[420px] max-w-full p-10'>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Form>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: () => (
    <Form
      className='flex flex-col gap-4'
      validationBehavior='aria'
      onSubmit={(e) => {
        e.preventDefault();
        // eslint-disable-next-line no-alert
        alert('submitted');
      }}
    >
      <Input isRequired label='Name' name='name' placeholder='Enter your name' />
      <Input isRequired label='Email' name='email' placeholder='you@x.com' type='email' />
      <Button color='primary' type='submit'>
        Submit
      </Button>
    </Form>
  ),
};

export const WithValidationErrors: Story = {
  render: () => (
    <Form
      className='flex flex-col gap-3'
      validationBehavior='aria'
      validationErrors={{ email: 'Invalid email' }}
      onSubmit={(e) => e.preventDefault()}
    >
      <Input label='Email' name='email' />
      <Button color='primary' type='submit'>
        Submit
      </Button>
    </Form>
  ),
};
