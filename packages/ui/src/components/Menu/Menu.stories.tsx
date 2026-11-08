import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Menu, MenuItem, MenuSection } from './Menu';

const meta = {
  title: 'da-v2/Menu',
  component: Menu,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage p-12'>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Menu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: () => (
    <Menu aria-label='actions' onAction={(k) => console.log('action', k)}>
      <MenuItem key='copy' shortcut='⌘C'>
        Copy
      </MenuItem>
      <MenuItem key='paste' shortcut='⌘V'>
        Paste
      </MenuItem>
      <MenuItem key='cut' shortcut='⌘X'>
        Cut
      </MenuItem>
      <MenuItem key='delete' color='danger' description='Delete permanently'>
        Delete
      </MenuItem>
    </Menu>
  ),
};

export const Sections: Story = {
  render: () => (
    <Menu aria-label='settings' onAction={(k) => console.log('action', k)}>
      <MenuSection showDivider title='Account'>
        <MenuItem key='profile'>Profile</MenuItem>
        <MenuItem key='settings'>Settings</MenuItem>
      </MenuSection>
      <MenuSection title='Danger zone'>
        <MenuItem key='logout' color='danger' shortcut='⌘Q'>
          Sign out
        </MenuItem>
      </MenuSection>
    </Menu>
  ),
};
