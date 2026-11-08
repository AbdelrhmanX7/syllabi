import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from '../Button';
import { ClayButton } from './ClayButton';

const meta = {
  title: 'da-v2/ClayButton',
  component: ClayButton,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof ClayButton>;

export default meta;
type Story = StoryObj<typeof meta>;

const COLORS = ['primary', 'secondary', 'success', 'danger', 'default'] as const;

export const Playground: Story = {
  args: { children: 'Start for free', color: 'primary', size: 'lg' },
};

/** Every colour, so the derived edge + lip can be checked against each fill. */
export const Colors: Story = {
  args: { children: '' },
  render: () => (
    <div className='flex flex-wrap items-center gap-4'>
      {COLORS.map((c) => (
        <ClayButton key={c} color={c} size='md'>
          {c}
        </ClayButton>
      ))}
    </div>
  ),
};

export const Sizes: Story = {
  args: { children: '' },
  render: () => (
    <div className='flex flex-wrap items-center gap-4'>
      {(['sm', 'md', 'lg'] as const).map((s) => (
        <ClayButton key={s} size={s}>
          {s}
        </ClayButton>
      ))}
    </div>
  ),
};

/**
 * The whole point of the migration: clay and scrapbook side by side, same
 * colour, same size. Switch the toolbar theme to confirm both follow it.
 */
export const VersusScrapbook: Story = {
  args: { children: '' },
  render: () => (
    <div className='flex flex-col gap-6'>
      {COLORS.map((c) => (
        <div key={c} className='flex items-center gap-4'>
          <span className='text-ink/70 w-20 text-xs font-bold'>{c}</span>
          <ClayButton color={c} size='md'>
            clay
          </ClayButton>
          <Button color={c} size='md'>
            scrapbook
          </Button>
        </div>
      ))}
    </div>
  ),
};

export const Disabled: Story = {
  args: { children: 'Disabled', isDisabled: true },
};
