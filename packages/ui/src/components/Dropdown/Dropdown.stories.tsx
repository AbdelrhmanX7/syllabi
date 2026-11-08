import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Button } from '../Button';
import { Dropdown, DropdownItem, DropdownMenu, DropdownSection, DropdownTrigger } from './Dropdown';

const meta = {
  title: 'da-v2/Dropdown',
  component: Dropdown,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage p-16'>
        <Story />
      </div>
    ),
  ],
  args: {
    children: null,
  },
} satisfies Meta<typeof Dropdown>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: () => (
    <Dropdown>
      <DropdownTrigger>
        <Button variant='bordered'>Open menu</Button>
      </DropdownTrigger>
      <DropdownMenu aria-label='actions' onAction={(k) => console.log('action', k)}>
        <DropdownItem key='new'>New</DropdownItem>
        <DropdownItem key='copy'>Copy</DropdownItem>
        <DropdownItem key='edit'>Edit</DropdownItem>
        <DropdownItem key='delete' color='danger'>
          Delete
        </DropdownItem>
      </DropdownMenu>
    </Dropdown>
  ),
};

export const Sections: Story = {
  render: () => (
    <Dropdown>
      <DropdownTrigger>
        <Button variant='bordered'>Settings</Button>
      </DropdownTrigger>
      <DropdownMenu aria-label='settings'>
        <DropdownSection showDivider title='Account'>
          <DropdownItem key='profile'>Profile</DropdownItem>
          <DropdownItem key='settings'>Settings</DropdownItem>
        </DropdownSection>
        <DropdownSection title='Danger zone'>
          <DropdownItem key='logout' color='danger'>
            Sign out
          </DropdownItem>
        </DropdownSection>
      </DropdownMenu>
    </Dropdown>
  ),
};

export const SingleSelection: Story = {
  render: () => {
    const [keys, setKeys] = React.useState<Set<string>>(new Set(['list']));

    return (
      <Dropdown>
        <DropdownTrigger>
          <Button variant='bordered'>View</Button>
        </DropdownTrigger>
        <DropdownMenu
          aria-label='view mode'
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onSelectionChange={(k: any) => setKeys(new Set(Array.from(k as Iterable<string>)))}
          selectedKeys={keys}
          selectionMode='single'
        >
          <DropdownItem key='grid'>Grid</DropdownItem>
          <DropdownItem key='list'>List</DropdownItem>
          <DropdownItem key='cards'>Cards</DropdownItem>
        </DropdownMenu>
      </Dropdown>
    );
  },
};

export const WithShortcuts: Story = {
  render: () => (
    <Dropdown>
      <DropdownTrigger>
        <Button variant='bordered'>Edit</Button>
      </DropdownTrigger>
      <DropdownMenu aria-label='edit'>
        <DropdownItem key='copy' shortcut='⌘C'>
          Copy
        </DropdownItem>
        <DropdownItem key='paste' shortcut='⌘V'>
          Paste
        </DropdownItem>
        <DropdownItem key='cut' shortcut='⌘X'>
          Cut
        </DropdownItem>
      </DropdownMenu>
    </Dropdown>
  ),
};
