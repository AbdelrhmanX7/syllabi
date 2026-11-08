import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Accordion, AccordionItem } from './Accordion';

const meta = {
  title: 'da-v2/Accordion',
  component: Accordion,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage w-[460px] max-w-full p-8'>
        <Story />
      </div>
    ),
  ],
  args: { children: null },
} satisfies Meta<typeof Accordion>;

export default meta;
type Story = StoryObj<typeof meta>;

const items = [
  { key: 'one', title: 'First item', subtitle: 'Short description', content: 'First item content.' },
  { key: 'two', title: 'Second item', subtitle: 'Short description', content: 'Second item content.' },
  { key: 'three', title: 'Third item', subtitle: 'Short description', content: 'Third item content.' },
];

export const Light: Story = {
  render: () => (
    <Accordion variant='light'>
      {items.map((it) => (
        <AccordionItem key={it.key} subtitle={it.subtitle} title={it.title}>
          {it.content}
        </AccordionItem>
      ))}
    </Accordion>
  ),
};

export const Shadow: Story = {
  render: () => (
    <Accordion selectionMode='multiple' variant='shadow'>
      {items.map((it) => (
        <AccordionItem key={it.key} subtitle={it.subtitle} title={it.title}>
          {it.content}
        </AccordionItem>
      ))}
    </Accordion>
  ),
};

export const Bordered: Story = {
  render: () => (
    <Accordion variant='bordered'>
      {items.map((it) => (
        <AccordionItem key={it.key} subtitle={it.subtitle} title={it.title}>
          {it.content}
        </AccordionItem>
      ))}
    </Accordion>
  ),
};

export const Splitted: Story = {
  render: () => (
    <Accordion selectionMode='multiple' variant='splitted'>
      {items.map((it) => (
        <AccordionItem key={it.key} subtitle={it.subtitle} title={it.title}>
          {it.content}
        </AccordionItem>
      ))}
    </Accordion>
  ),
};
