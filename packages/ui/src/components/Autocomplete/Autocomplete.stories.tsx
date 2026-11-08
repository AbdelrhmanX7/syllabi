import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Autocomplete, AutocompleteItem } from './Autocomplete';

const meta = {
  title: 'da-v2/Autocomplete',
  component: Autocomplete,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage w-[420px] max-w-full p-10'>
        <Story />
      </div>
    ),
  ],
  args: { label: 'Subject', placeholder: 'Search for a subject' },
} satisfies Meta<typeof Autocomplete>;

export default meta;
type Story = StoryObj<typeof meta>;

const SUBJECTS = [
  { id: 'math', label: 'Math' },
  { id: 'physics', label: 'Physics' },
  { id: 'chem', label: 'Chemistry' },
  { id: 'bio', label: 'Biology' },
  { id: 'history', label: 'History' },
  { id: 'geo', label: 'Geography' },
];

export const Playground: Story = {
  render: (args) => (
    <Autocomplete {...args}>
      {SUBJECTS.map((s) => (
        <AutocompleteItem key={s.id}>{s.label}</AutocompleteItem>
      ))}
    </Autocomplete>
  ),
};

export const ItemsRenderProp: Story = {
  render: (args) => (
    <Autocomplete {...args} items={SUBJECTS}>
      {(item) => <AutocompleteItem key={item.id}>{item.label}</AutocompleteItem>}
    </Autocomplete>
  ),
};

export const AllowsCustomValue: Story = {
  render: (args) => (
    <Autocomplete {...args} allowsCustomValue description='You can type a custom value' label='Subject (Custom value)'>
      {SUBJECTS.map((s) => (
        <AutocompleteItem key={s.id}>{s.label}</AutocompleteItem>
      ))}
    </Autocomplete>
  ),
};

export const Invalid: Story = {
  render: (args) => (
    <Autocomplete {...args} errorMessage='Pick a subject' isInvalid>
      {SUBJECTS.map((s) => (
        <AutocompleteItem key={s.id}>{s.label}</AutocompleteItem>
      ))}
    </Autocomplete>
  ),
};
