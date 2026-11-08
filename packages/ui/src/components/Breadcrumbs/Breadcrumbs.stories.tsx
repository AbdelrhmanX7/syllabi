import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { BreadcrumbItem, Breadcrumbs } from './Breadcrumbs';

const meta = {
  title: 'da-v2/Breadcrumbs',
  component: Breadcrumbs,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage w-[480px] max-w-full p-10'>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Breadcrumbs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: () => (
    <Breadcrumbs>
      <BreadcrumbItem href='/'>Home</BreadcrumbItem>
      <BreadcrumbItem href='/admin'>Dashboard</BreadcrumbItem>
      <BreadcrumbItem href='/admin/lectures'>Manage lectures</BreadcrumbItem>
      <BreadcrumbItem>Analytics</BreadcrumbItem>
    </Breadcrumbs>
  ),
};

export const StringSeparator: Story = {
  render: () => (
    <Breadcrumbs separator='/'>
      <BreadcrumbItem href='/'>Home</BreadcrumbItem>
      <BreadcrumbItem href='/admin'>Dashboard</BreadcrumbItem>
      <BreadcrumbItem>Details</BreadcrumbItem>
    </Breadcrumbs>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className='space-y-3'>
      <Breadcrumbs size='sm'>
        <BreadcrumbItem href='/'>Home</BreadcrumbItem>
        <BreadcrumbItem href='/products'>Products</BreadcrumbItem>
        <BreadcrumbItem>Detail</BreadcrumbItem>
      </Breadcrumbs>
      <Breadcrumbs size='md'>
        <BreadcrumbItem href='/'>Home</BreadcrumbItem>
        <BreadcrumbItem href='/products'>Products</BreadcrumbItem>
        <BreadcrumbItem>Detail</BreadcrumbItem>
      </Breadcrumbs>
      <Breadcrumbs size='lg'>
        <BreadcrumbItem href='/'>Home</BreadcrumbItem>
        <BreadcrumbItem href='/products'>Products</BreadcrumbItem>
        <BreadcrumbItem>Detail</BreadcrumbItem>
      </Breadcrumbs>
    </div>
  ),
};

export const Collapsed: Story = {
  render: () => (
    <Breadcrumbs maxItems={3}>
      <BreadcrumbItem href='/'>Home</BreadcrumbItem>
      <BreadcrumbItem href='/admin'>Dashboard</BreadcrumbItem>
      <BreadcrumbItem href='/admin/courses'>Courses</BreadcrumbItem>
      <BreadcrumbItem href='/admin/courses/1'>Chemistry</BreadcrumbItem>
      <BreadcrumbItem>Chapter 1</BreadcrumbItem>
    </Breadcrumbs>
  ),
};

export const Variants: Story = {
  render: () => (
    <div className='space-y-3'>
      <Breadcrumbs variant='light'>
        <BreadcrumbItem href='/'>Home</BreadcrumbItem>
        <BreadcrumbItem href='/admin'>Dashboard</BreadcrumbItem>
        <BreadcrumbItem>Details</BreadcrumbItem>
      </Breadcrumbs>
      <Breadcrumbs variant='solid'>
        <BreadcrumbItem href='/'>Home</BreadcrumbItem>
        <BreadcrumbItem href='/admin'>Dashboard</BreadcrumbItem>
        <BreadcrumbItem>Details</BreadcrumbItem>
      </Breadcrumbs>
      <Breadcrumbs variant='bordered'>
        <BreadcrumbItem href='/'>Home</BreadcrumbItem>
        <BreadcrumbItem href='/admin'>Dashboard</BreadcrumbItem>
        <BreadcrumbItem>Details</BreadcrumbItem>
      </Breadcrumbs>
    </div>
  ),
};
