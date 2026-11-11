import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { TagInput } from './TagInput';

const meta = {
  title: 'da-v2/TagInput',
  component: TagInput,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  args: { value: [], onChange: () => undefined },
} satisfies Meta<typeof TagInput>;

export default meta;
type Story = StoryObj<typeof meta>;

function Controlled({ initial, maxTags }: { initial: string[]; maxTags?: number }) {
  const [tags, setTags] = React.useState(initial);

  return (
    <div className='w-80'>
      <TagInput aria-label='Tags' maxTags={maxTags} value={tags} onChange={setTags} />
    </div>
  );
}

export const Empty: Story = { render: () => <Controlled initial={[]} /> };
export const WithTags: Story = { render: () => <Controlled initial={['Calculus', 'Limits', 'Derivatives', 'Exam 2']} /> };
export const Full: Story = { render: () => <Controlled initial={['One', 'Two', 'Three']} maxTags={3} /> };
