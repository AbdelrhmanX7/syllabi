import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from '../Button';
import { Navbar, NavbarBrand, NavbarContent, NavbarItem, NavbarMenu, NavbarMenuItem, NavbarMenuToggle } from './Navbar';

const meta = {
  title: 'da-v2/Navbar',
  component: Navbar,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Navbar>;

export default meta;
type Story = StoryObj<typeof meta>;

function BrandLogo() {
  return (
    <span className='inline-flex items-center gap-2'>
      <span className='bg-ink text-paper rounded-sk-sm inline-flex h-8 w-8 items-center justify-center font-extrabold'>
        dA
      </span>
      <span className='font-extrabold'>Syllabi</span>
    </span>
  );
}

export const Playground: Story = {
  render: () => (
    <div className='bg-surface-0 min-h-[400px]'>
      <Navbar isBordered>
        <NavbarBrand>
          <BrandLogo />
        </NavbarBrand>
        <NavbarContent justify='center'>
          <NavbarItem isActive>Home</NavbarItem>
          <NavbarItem>Subjects</NavbarItem>
          <NavbarItem>About</NavbarItem>
        </NavbarContent>
        <NavbarContent justify='end'>
          <NavbarItem className='hidden lg:inline-flex'>
            <Button size='sm'>Sign in</Button>
          </NavbarItem>
          <NavbarItem className='lg:hidden'>
            <NavbarMenuToggle />
          </NavbarItem>
        </NavbarContent>
        <NavbarMenu>
          <NavbarMenuItem isActive>Home</NavbarMenuItem>
          <NavbarMenuItem>Subjects</NavbarMenuItem>
          <NavbarMenuItem>About</NavbarMenuItem>
          <NavbarMenuItem>Sign in</NavbarMenuItem>
        </NavbarMenu>
      </Navbar>
      <div className='p-6'>
        <p className='text-ink/70 text-sm'>Page content here. Switch to a mobile viewport to try the mobile menu.</p>
      </div>
    </div>
  ),
};

export const Sticky: Story = {
  render: () => (
    <div className='bg-surface-0'>
      <Navbar isBordered position='sticky' shouldHideOnScroll>
        <NavbarBrand>
          <BrandLogo />
        </NavbarBrand>
        <NavbarContent justify='end'>
          <NavbarItem isActive>Home</NavbarItem>
          <NavbarItem>Subjects</NavbarItem>
        </NavbarContent>
      </Navbar>
      <div className='space-y-6 p-6'>
        {Array.from({ length: 30 }).map((_, i) => (
          <p key={i} className='text-ink/70 text-sm'>
            Paragraph #{i + 1} — scroll the page to try hide-on-scroll.
          </p>
        ))}
      </div>
    </div>
  ),
};
