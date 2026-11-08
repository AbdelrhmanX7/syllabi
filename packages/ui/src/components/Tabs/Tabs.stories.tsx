import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import type { HeroUIColor } from '../tokens';
import { Tab, Tabs } from './Tabs';
import type { TabsVariant } from './Tabs';

/**
 * The framed decorator is a 480px card, which is right for a single tab strip and wrong
 * for a comparison grid. A story opts out with `parameters: { skFrame: false }` and gets
 * the raw canvas instead — rather than every wide story fighting a max-width it can't
 * remove (meta decorators always wrap story decorators).
 *
 * The frame is `.clay-stage` — the shared clay card. It used to be scrapbook paper with an
 * ink border and a hard diagonal shadow, which meant clay tabs were being reviewed lying on
 * the language they replace; DESIGN.md now calls that mix a rendering bug.
 */
const frame: Decorator = (Story, context) => {
  if (context.parameters.skFrame === false) return <Story />;

  return (
    <div className='clay-stage w-[480px] max-w-full p-10'>
      <Story />
    </div>
  );
};

const meta = {
  title: 'da-v2/Tabs',
  component: Tabs,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [frame],
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

const VARIANTS: TabsVariant[] = ['solid', 'bordered', 'light', 'underlined'];
const COLORS: HeroUIColor[] = ['default', 'primary', 'secondary', 'success', 'warning', 'danger'];

const Legend = ({ children }: { children: React.ReactNode }) => (
  <span className='text-ink-muted text-xs font-bold'>
    {children}
  </span>
);

const Note = ({ children }: { children: React.ReactNode }) => (
  <p className='text-ink-muted max-w-prose text-xs leading-relaxed'>
    {children}
  </p>
);

/** Two tabs is the smallest thing that still shows selected AGAINST unselected. */
const MiniStrip = ({ variant, color }: { variant: TabsVariant; color: HeroUIColor }) => (
  <Tabs aria-label={`${variant} / ${color}`} color={color} defaultSelectedKey='b' variant={variant}>
    <Tab key='a' title='Students' />
    <Tab key='b' title='Analytics' />
  </Tabs>
);

/**
 * The real strip from the teacher follow-up sheet, so an option is judged on the copy it
 * will actually carry rather than on lorem.
 */
const RealStrip = (props: React.ComponentProps<typeof Tabs>) => (
  <Tabs aria-label='Follow-up type' defaultSelectedKey='lectures' {...props}>
    <Tab key='exams' title='Exams' />
    <Tab key='lectures' title='Lectures' />
    <Tab key='homework' title='Homework' />
  </Tabs>
);

const Matrix = () => (
  <div className='overflow-x-auto'>
    <div className='grid min-w-max grid-cols-[auto_repeat(6,minmax(0,1fr))] items-center gap-x-8 gap-y-5'>
      <span />
      {COLORS.map((color) => (
        <Legend key={color}>{color}</Legend>
      ))}

      {VARIANTS.map((variant) => (
        <React.Fragment key={variant}>
          <Legend>{variant}</Legend>
          {COLORS.map((color) => (
            <MiniStrip key={color} color={color} variant={variant} />
          ))}
        </React.Fragment>
      ))}
    </div>
  </div>
);

/**
 * Pins its subtree to the dark tokens whatever the Theme toolbar says.
 *
 * `.dark` is a real selector in scrapbook.css, so setting it on a wrapper re-declares
 * every token for that subtree. There is no matching LIGHT scope — the light values live
 * on `:root` — so this only works in one direction: a dark island inside a light page,
 * never the reverse. `.clay-stage` paints `--surface-0` itself, which is what lets the
 * island sit on a light page and still be internally consistent — and re-declaring the
 * tokens is exactly how every clay colour inside it moves, since they are all `color-mix`
 * of two custom properties rather than anything resolved at the root.
 */
const DarkPanel = ({ children }: { children: React.ReactNode }) => (
  <div className='dark' data-theme='dark'>
    <div className='clay-stage p-6'>{children}</div>
  </div>
);

const Section = ({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) => (
  <section className='flex flex-col gap-3'>
    <Legend>{title}</Legend>
    {note ? <Note>{note}</Note> : null}
    {children}
  </section>
);

export const Default: Story = {
  render: () => (
    <Tabs aria-label='Sections'>
      <Tab key='students' title='Students'>
        <div className='text-ink py-4 font-bold'>Student list here</div>
      </Tab>
      <Tab key='analytics' title='Analytics'>
        <div className='text-ink py-4 font-bold'>Charts here</div>
      </Tab>
      <Tab key='whatsapp' title='WhatsApp'>
        <div className='text-ink py-4 font-bold'>Message log</div>
      </Tab>
    </Tabs>
  ),
};

export const Underlined: Story = {
  render: () => (
    <Tabs aria-label='Sections' color='primary' variant='underlined'>
      <Tab key='one' title='First'>
        <div className='py-4'>One</div>
      </Tab>
      <Tab key='two' title='Second'>
        <div className='py-4'>Two</div>
      </Tab>
    </Tabs>
  ),
};

/**
 * The proof surface for the clay port: every variant against every colour, in one screen.
 *
 * Read it down a column to see one colour across the four voices, or across a row to see
 * one voice across the six colours. The two things to check are that the selected tab is
 * visibly LOWER than its sibling in the top two rows, and that `bordered` is telling its
 * story in the rim and the lip rather than repeating `solid` more quietly.
 */
export const VariantColorMatrix: Story = {
  parameters: { layout: 'padded', skFrame: false },
  render: () => (
    <div className='flex flex-col gap-6'>
      <Note>
        Rows are `variant`, columns are `color`. The second tab is selected in every cell — in the `solid` and
        `bordered` rows that means latched DOWN, one lip-height below its raised sibling. Flip the Theme control in the
        toolbar to check dark — or open “Variant Color Matrix Dark”, which pins the dark tokens regardless.
      </Note>
      <Matrix />
    </div>
  ),
};

/**
 * Half the contrast risk lives in dark mode, and the Theme toolbar shows one theme at a
 * time. This story renders the matrix on the dark surface unconditionally, so it can be
 * opened next to the light one instead of toggled between.
 */
export const VariantColorMatrixDark: Story = {
  parameters: { layout: 'padded', skFrame: false },
  render: () => (
    <div className='flex flex-col gap-6'>
      <Note>
        Pinned to the dark tokens even when the Theme toolbar says light. Every clay colour here is a `color-mix` of two
        `--heroui-*` custom properties, so re-declaring those on a wrapper is enough to move the whole language — which
        is exactly what this island proves. Watch the two places dark is hardest: the `light` row (a well has no lip to
        fall back on) and the `underlined` row (the bar is the entire selected state).
      </Note>
      <DarkPanel>
        <Matrix />
      </DarkPanel>
    </div>
  ),
};

/**
 * The decision, in one screen: how loud should a selected tab be?
 *
 * All five are the same strip, the same copy, the same `color='primary'` — only the
 * treatment moves. Every one of them is reachable through the public props today; none is
 * a mock-up. Pick a row and the individual stories below hold the same thing on its own.
 */
export const SelectedStateOptions: Story = {
  parameters: { layout: 'padded', skFrame: false },
  render: () => (
    <div className='mx-auto flex max-w-2xl flex-col gap-8'>
      <Note>
        Loudest at the top, quietest at the bottom. In the two slab variants the selected tab is LATCHED DOWN — held at
        the pressed offset with its lip closed while its siblings stay raised — so read the vertical offset, not just
        the colour. The numbers are measured contrast of the selected label against whatever sits behind it, light /
        dark.
      </Note>

      <Section
        note='Latched down AND filled with the brand. Two signals, which is why this is the default. 7.15:1 / 7.15:1. — variant="solid"'
        title='A · Pressed key'
      >
        <RealStrip color='primary' variant='solid' />
      </Section>

      <Section
        note='The same latch with the colour in the RIM, the LIP and the glow instead of the face. 7.15:1 / 7.54:1. — variant="bordered"'
        title='B · Pressed key, coloured edge'
      >
        <RealStrip color='primary' variant='bordered' />
      </Section>

      <Section
        note='No slab. The selected tab is a shallow WELL holding an 18% wash of the colour — clay pointing the other way. 15.54:1 / 14.15:1. — variant="light"'
        title='C · Well'
      >
        <RealStrip color='primary' variant='light' />
      </Section>

      <Section
        note='No slab, no lip, and therefore no press: a 3px rounded bar under the label and the brand on the label, nothing else. 7.15:1 / 8.29:1, bar the same against the page. — variant="underlined"'
        title='D · Bar'
      >
        <RealStrip color='primary' variant='underlined' />
      </Section>

      <Section
        note='The same rule, plus a weight step on the unselected tabs. Worth seeing because active and inactive labels sit at nearly the same luminance in this variant (1.32:1 apart for primary, 1.01:1 for success) — weight separates them without spending more colour. Costs one classNames line at the call site.'
        title='E · Rule + weight step'
      >
        <RealStrip classNames={{ tab: 'aria-[selected=false]:font-bold' }} color='primary' variant='underlined' />
      </Section>
    </div>
  ),
};

export const OptionA_Sticker: Story = {
  name: 'Option A · Pressed key',
  parameters: { skFrame: false },
  render: () => <RealStrip color='primary' variant='solid' />,
};

export const OptionB_Outline: Story = {
  name: 'Option B · Pressed key, coloured edge',
  parameters: { skFrame: false },
  render: () => <RealStrip color='primary' variant='bordered' />,
};

export const OptionC_Wash: Story = {
  name: 'Option C · Well',
  parameters: { skFrame: false },
  render: () => <RealStrip color='primary' variant='light' />,
};

export const OptionD_Rule: Story = {
  name: 'Option D · Bar',
  parameters: { skFrame: false },
  render: () => <RealStrip color='primary' variant='underlined' />,
};

export const OptionE_RuleWithWeightStep: Story = {
  parameters: { skFrame: false },
  render: () => (
    <RealStrip classNames={{ tab: 'aria-[selected=false]:font-bold' }} color='primary' variant='underlined' />
  ),
};

/**
 * The hardest test of the latch, isolated: `color='default'` has no hue to spend, so in
 * `solid` and `bordered` the press is doing ALL the work of showing which tab is selected.
 *
 * It holds. The selected key's top edge sits a lip-height lower, its lip is shut, and its
 * label steps from the muted mix to full-strength foreground — you read "that one is
 * pushed in" without a single unit of colour. Citrine, the scrapbook's default accent,
 * does not survive the port: clay's `default` is the theme's own surface.
 */
export const DefaultColorAccent: Story = {
  parameters: { layout: 'padded', skFrame: false },
  render: () => (
    <div className='mx-auto flex max-w-2xl flex-col gap-8'>
      <Note>
        The `default` colour across the four variants — the case with no brand hue to lean on. In `solid` and `bordered`
        the only difference between the selected tab and its siblings is the latch plus the label stepping out of the
        muted mix; there is no fill change at all, because the surface IS the fill.
      </Note>

      <Section
        note='Latched down on the theme surface. 21:1 / 15.76:1 for the label; the state is the 5px.'
        title='solid'
      >
        <RealStrip color='default' variant='solid' />
      </Section>
      <Section
        note='Identical to solid — with no brand hue there is nothing to put in the rim, so it falls back rather than drawing a neutral rim on a neutral face (which is a raised slab with no selected state at all).'
        title='bordered'
      >
        <RealStrip color='default' variant='bordered' />
      </Section>
      <Section
        note='A well one rung down the surface ladder (--heroui-content2). Mixing the surface into itself would have been a no-op, so this is the one colour where the wash steps instead of tints. 19.11:1 / 14.17:1.'
        title='light'
      >
        <RealStrip color='default' variant='light' />
      </Section>
      <Section
        note='Foreground bar, foreground label, muted siblings. 21:1 / 17.33:1 for both label and bar.'
        title='underlined'
      >
        <RealStrip color='default' variant='underlined' />
      </Section>
    </div>
  ),
};

/**
 * The states that had no proof surface before the clay port and needed one, because clay
 * changed what all four of them look like: `isDisabled` / `disabledKeys`, the three sizes
 * (whose lip depth now tracks their height), `fullWidth`, and vertical placement.
 *
 * The size row is the one to look at closely. A lip is a fixed number of pixels, so a
 * depth that suits `lg` is a plinth under `sm` — `sm 4 / md 5 / lg 6` is the ladder, and
 * in each case the latched tab's bottom edge lands exactly where its raised siblings'
 * lips end.
 */
export const ClayStates: Story = {
  parameters: { layout: 'padded', skFrame: false },
  render: () => (
    <div className='mx-auto flex max-w-3xl flex-col gap-10'>
      <Section note='Lip depth tracks tab height: sm 4px, md 5px, lg 6px.' title='sizes — sm / md / lg'>
        <div className='flex flex-col gap-4'>
          {(['sm', 'md', 'lg'] as const).map((size) => (
            <RealStrip key={size} color='primary' size={size} />
          ))}
        </div>
      </Section>

      <Section
        note='A disabled tab FLATTENS: no lip, because a lip says "push me" and an inert control must not claim that. It keeps its 3px edge and, if selected, its latch offset — position carries the state, elevation carries the affordance, and only the second one is a lie here.'
        title='isDisabled (whole strip) / disabledKeys (one tab)'
      >
        <div className='flex flex-col gap-4'>
          <RealStrip color='primary' disabledKeys={['homework']} />
          <RealStrip isDisabled color='primary' />
        </div>
      </Section>

      <Section note='Keys stretch; the lip stretches with them.' title='fullWidth'>
        <RealStrip fullWidth color='secondary' />
      </Section>

      <Section
        note='The lip points DOWN in a vertical strip too — clay has one light source and it does not rotate with the layout.'
        title="placement='start' (vertical)"
      >
        <RealStrip color='success' placement='start' />
      </Section>

      <Section
        note='No slab, so there was never a lip to take away; the bar and the muted label carry the disabled tab alone.'
        title='underlined, with a disabled tab'
      >
        <RealStrip color='danger' disabledKeys={['exams']} variant='underlined' />
      </Section>
    </div>
  ),
};
