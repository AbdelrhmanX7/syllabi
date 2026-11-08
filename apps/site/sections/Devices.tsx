import type { LucideIcon } from 'lucide-react';

import { ArrowRight, Globe, Smartphone, Tablet } from 'lucide-react';

import { Badge, Surface } from '@/components/ui/primitives';

import { TONE, type Tone } from '~/sections/tone';

const DEVICES: { icon: LucideIcon; title: string; text: string; tone: Tone }[] = [
  {
    icon: Globe,
    title: 'Web',
    text: 'app.syllabi.studio in any browser, on a laptop or a phone. Sign in and it is all there.',
    tone: 'blue',
  },
  {
    icon: Tablet,
    title: 'Android tablet',
    text: 'Install the Android app built for the pen, or open the web app in the tablet’s browser.',
    tone: 'green',
  },
  {
    icon: Smartphone,
    title: 'iPhone or Android phone',
    text: 'Snap a worksheet or the whiteboard; it lands in the tablet’s Inbox. Nothing to install on the phone.',
    tone: 'citrine',
  },
];

/** Phone → tablet: a snapped page leaves the phone and lands in the tablet's Inbox. */
function PhoneToTablet() {
  return (
    <Surface className='flex min-w-0 flex-col gap-3 p-3 sm:p-4'>
      <div className='flex min-w-0 items-center gap-2 sm:gap-4' data-inbox-scene>
        <div aria-hidden className='border-st-clay-edge bg-st-raised flex w-[24%] max-w-[120px] shrink-0 flex-col gap-1.5 rounded-lg border-2 p-1.5'>
          <div className='bg-tone-citrine flex aspect-[3/4] flex-col justify-start gap-1.5 rounded-sm p-1.5'>
            <span className='bg-tone-citrine-fg/60 block h-1 w-3/4 rounded-full' />
            <span className='bg-tone-citrine-fg/40 block h-1 w-full rounded-full' />
            <span className='bg-tone-citrine-fg/40 block h-1 w-5/6 rounded-full' />
            <span className='bg-tone-citrine-fg/40 block h-1 w-2/3 rounded-full' />
          </div>
          <span className='border-st-control-edge bg-st-surface mx-auto block h-5 w-5 rounded-full border-2' />
        </div>

        <ArrowRight aria-hidden className='text-st-muted h-5 w-5 shrink-0' />

        <div className='border-st-clay-edge bg-st-raised relative min-w-0 flex-1 rounded-lg border-2 p-1.5'>
          <img
            alt='The tablet Inbox: pages snapped on a phone, each ready to add to notes, a concept map or the question bank'
            className='border-st-line block h-auto w-full rounded-md border'
            height={800}
            loading='lazy'
            src='/shots/inbox.png'
            width={1280}
          />
          <div
            className='border-st-clay-edge bg-st-surface text-st-fg shadow-clay absolute right-2 top-2 flex max-w-[70%] items-center gap-1.5 rounded-md border-2 px-2 py-1 text-[11px] font-semibold leading-4 sm:right-3 sm:top-3 sm:text-xs'
            data-inbox-toast
          >
            <Smartphone aria-hidden className='text-tone-citrine-fg h-3.5 w-3.5 shrink-0' />
            <span className='min-w-0'>
              New photo<span className='hidden sm:inline'> from iPhone</span>
            </span>
          </div>
        </div>
      </div>
      <p className='text-st-muted text-sm leading-snug'>
        <span className='text-st-fg font-semibold'>Phone inbox.</span> On an iPhone, add the “Send to Study” share
        shortcut once; from any phone, scan a QR code for a one-off send. Each photo opens as a notebook page,
        becomes questions, or starts a concept map.
      </p>
    </Surface>
  );
}

export function Devices() {
  return (
    <section
      aria-labelledby='devices-title'
      className='mx-auto max-w-6xl scroll-mt-4 px-4 py-8 md:py-10'
      data-reveal
      id='devices'
    >
      <div className='mb-6 max-w-3xl'>
        <Badge className={TONE.citrine.badge}>Phone, tablet and web</Badge>
        <h2 className='font-display text-st-fg mt-3 text-2xl font-bold leading-tight md:text-3xl' id='devices-title'>
          Your notes on every device.
        </h2>
        <p className='text-st-muted mt-2 text-base'>
          Sign in to the web app with one free account, on a laptop, a tablet or a phone, and your classes, notebooks and
          questions are there.
        </p>
      </div>

      <div className='grid items-start gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-10'>
        <div className='min-w-0' data-reveal-item>
          <PhoneToTablet />
        </div>

        <div className='flex min-w-0 flex-col gap-5'>
          <ul className='flex flex-col gap-3'>
            {DEVICES.map(({ icon: Icon, title, text, tone }) => (
              <li className='flex min-w-0 items-start gap-3' data-reveal-item key={title}>
                <span
                  aria-hidden
                  className={`${TONE[tone].tile} inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md`}
                >
                  <Icon className='h-5 w-5' />
                </span>
                <p className='min-w-0 text-sm leading-snug'>
                  <span className='text-st-fg block font-semibold'>{title}</span>
                  <span className='text-st-muted'>{text}</span>
                </p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
