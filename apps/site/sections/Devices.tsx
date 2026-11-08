import type { LucideIcon } from 'lucide-react';

import { ThemedShot } from '~/sections/ThemedShot';
import { Globe, Smartphone, Tablet } from 'lucide-react';

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
      <div className='relative flex min-w-0 items-center gap-1 sm:gap-2' data-inbox-scene>
        {/* The phone: camera open on a worksheet, shutter at the bottom. */}
        <div
          aria-hidden
          className='border-st-clay-edge bg-st-raised flex w-[26%] max-w-[128px] shrink-0 flex-col gap-1.5 rounded-lg border-2 p-1.5'
        >
          <span className='bg-st-line mx-auto block h-1 w-6 rounded-full' />
          <div className='relative aspect-[9/16] overflow-hidden rounded-md bg-[#1d2236]'>
            <div
              className='absolute inset-x-[14%] bottom-[24%] top-[14%] flex -rotate-3 flex-col gap-[7%] rounded-sm bg-[#fffdf5] px-[10%] pt-[12%]'
              data-inbox-paper
            >
              <span className='block h-[3px] w-3/4 rounded-full bg-[#2f5bea]/70' />
              <span className='block h-px w-full bg-[#9db4e8]' />
              <span className='block h-px w-full bg-[#9db4e8]' />
              <span className='block h-px w-full bg-[#9db4e8]' />
              <svg className='w-full' viewBox='0 0 40 12'>
                <path d='M1 8c4-6 6 4 10-1s5 3 9-2 6 4 10 0 5-2 9-3' fill='none' stroke='#2f5bea' strokeLinecap='round' strokeWidth='1.4' />
              </svg>
              <span className='block h-px w-full bg-[#9db4e8]' />
            </div>
            {(['left-[8%] top-[8%] border-l-2 border-t-2', 'right-[8%] top-[8%] border-r-2 border-t-2', 'bottom-[18%] left-[8%] border-b-2 border-l-2', 'bottom-[18%] right-[8%] border-b-2 border-r-2'] as const).map((pos) => (
              <span key={pos} className={`absolute h-[12%] w-[18%] border-[#f5c84c] ${pos}`} data-inbox-corner />
            ))}
            <span className='absolute bottom-[4%] left-1/2 flex h-[10%] -translate-x-1/2 items-center justify-center'>
              <span className='flex aspect-square h-full items-center justify-center rounded-full border-2 border-[#f3f4f8]' data-inbox-shutter>
                <span className='block h-[70%] w-[70%] rounded-full bg-[#f3f4f8]' />
              </span>
            </span>
            <span className='absolute inset-0 bg-[#ffffff] opacity-0' data-inbox-flash />
          </div>
        </div>

        {/* The trip: a dashed arc from the phone to the tablet. */}
        <svg aria-hidden className='text-st-muted h-10 w-8 shrink-0 sm:w-12' fill='none' viewBox='0 0 48 40'>
          <path d='M3 32C14 4 32 4 44 22' data-inbox-path stroke='currentColor' strokeDasharray='3 5' strokeLinecap='round' strokeWidth='2' />
          <path d='M38 21l6 1.5-1.5-6' stroke='currentColor' strokeLinecap='round' strokeLinejoin='round' strokeWidth='2' />
        </svg>

        {/* The photo in flight (animation only). */}
        <span
          aria-hidden
          className='pointer-events-none absolute left-0 top-0 z-10 flex h-9 w-7 flex-col gap-1 rounded-sm bg-[#fffdf5] p-1 opacity-0 shadow-md'
          data-inbox-flyer
        >
          <span className='block h-[2px] w-3/4 rounded-full bg-[#2f5bea]/70' />
          <span className='block h-px w-full bg-[#9db4e8]' />
          <span className='block h-px w-full bg-[#9db4e8]' />
          <span className='block h-px w-full bg-[#9db4e8]' />
        </span>

        <div className='border-st-clay-edge bg-st-raised relative min-w-0 flex-1 rounded-lg border-2 p-1.5'>
          <ThemedShot
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
