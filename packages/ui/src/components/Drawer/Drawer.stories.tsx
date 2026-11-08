import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Button } from '../Button';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter, DrawerHeader } from './Drawer';

const meta = {
  title: 'da-v2/Drawer',
  component: Drawer,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  args: {
    isOpen: false,
    children: null,
  },
} satisfies Meta<typeof Drawer>;

export default meta;
type Story = StoryObj<typeof meta>;

const DrawerDemo: React.FC<{ placement?: 'top' | 'right' | 'bottom' | 'left'; size?: 'sm' | 'md' | 'lg' }> = ({
  placement = 'right',
  size = 'md',
}) => {
  const [open, setOpen] = React.useState(false);

  return (
    <div className='clay-stage p-12'>
      <Button onPress={() => setOpen(true)}>Open ({placement})</Button>
      <Drawer isOpen={open} placement={placement} size={size} onOpenChange={setOpen}>
        <DrawerContent>
          <DrawerHeader>Drawer title</DrawerHeader>
          <DrawerBody>
            <p>Drawer content — it can be anything.</p>
          </DrawerBody>
          <DrawerFooter>
            <Button variant='bordered' onPress={() => setOpen(false)}>
              Cancel
            </Button>
            <Button color='primary' onPress={() => setOpen(false)}>
              Save
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </div>
  );
};

export const Right: Story = {
  render: () => <DrawerDemo placement='right' />,
};

export const Left: Story = {
  render: () => <DrawerDemo placement='left' />,
};

export const Bottom: Story = {
  render: () => <DrawerDemo placement='bottom' />,
};

export const Top: Story = {
  render: () => <DrawerDemo placement='top' />,
};
