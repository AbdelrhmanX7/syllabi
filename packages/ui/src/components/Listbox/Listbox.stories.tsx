import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Listbox, ListboxItem, ListboxSection } from './Listbox';

const meta = {
  title: 'da-v2/Listbox',
  component: Listbox,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage p-12'>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Listbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: () => (
    <Listbox aria-label='actions' onAction={(k) => console.log('action', k)}>
      <ListboxItem key='new'>New</ListboxItem>
      <ListboxItem key='copy'>Copy</ListboxItem>
      <ListboxItem key='edit'>Edit</ListboxItem>
      <ListboxItem key='delete' color='danger' description='Delete permanently'>
        Delete
      </ListboxItem>
    </Listbox>
  ),
};

export const Sections: Story = {
  render: () => (
    <Listbox aria-label='settings'>
      <ListboxSection showDivider title='Account'>
        <ListboxItem key='profile' description='View and edit your details'>
          Profile
        </ListboxItem>
        <ListboxItem key='settings'>Settings</ListboxItem>
      </ListboxSection>
      <ListboxSection title='Danger zone'>
        <ListboxItem key='logout' color='danger'>
          Sign out
        </ListboxItem>
      </ListboxSection>
    </Listbox>
  ),
};

export const SingleSelection: Story = {
  render: () => {
    const [keys, setKeys] = React.useState<Set<string>>(new Set(['list']));

    return (
      <Listbox
        aria-label='view mode'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onSelectionChange={(k: any) => setKeys(new Set(Array.from(k as Iterable<string>)))}
        selectedKeys={keys}
        selectionMode='single'
      >
        <ListboxItem key='grid'>Grid</ListboxItem>
        <ListboxItem key='list'>List</ListboxItem>
        <ListboxItem key='cards'>Cards</ListboxItem>
      </Listbox>
    );
  },
};

export const MultipleSelection: Story = {
  render: () => {
    const [keys, setKeys] = React.useState<Set<string>>(new Set(['read']));

    return (
      <Listbox
        aria-label='permissions'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onSelectionChange={(k: any) => setKeys(new Set(Array.from(k as Iterable<string>)))}
        selectedKeys={keys}
        selectionMode='multiple'
      >
        <ListboxItem key='read'>Read</ListboxItem>
        <ListboxItem key='write'>Write</ListboxItem>
        <ListboxItem key='admin' description='All permissions'>
          Admin
        </ListboxItem>
      </Listbox>
    );
  },
};
