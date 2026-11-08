import type { Meta, StoryObj } from '@storybook/react-vite';
import React, { useState } from 'react';

import { ColorSwatch, SwatchPicker } from './ColorSwatch';

const meta = {
  title: 'da-v2/ColorSwatch',
  component: ColorSwatch,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  args: { color: '#2f5bea', label: 'Blue', isSelected: true },
} satisfies Meta<typeof ColorSwatch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Single: Story = {};

const INKS = ['#18204a', '#ffffff', '#1d4ed8', '#0f766e', '#15803d', '#7e22ce', '#be185d', '#c2410c', '#fde047'];

export const Picker: Story = {
  render: () => {
    const [value, setValue] = useState<string | null>('#1d4ed8');

    return (
      <div className='flex flex-col gap-4'>
        <SwatchPicker colors={[{ value: null, label: 'Keep the ink', content: 'Aa' }, ...INKS]} label='Ink' value={value} onChange={setValue} />
        <SwatchPicker colors={INKS} label='Ink (small)' size='sm' value={value} onChange={setValue} />
      </div>
    );
  },
};
