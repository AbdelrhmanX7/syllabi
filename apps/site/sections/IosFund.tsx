import { useRef, useState } from 'react';

import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { Coffee } from 'lucide-react';

import { Progress } from '@repo/ui';

import { LinkButton, Surface } from '@/components/ui/primitives';

import { COFFEE } from '~/sections/links';

// Same numbers as the README bar: edit .github/ios-fund.json (and run scripts/ios-fund.mjs for the SVG).
import fund from '../../../.github/ios-fund.json';

gsap.registerPlugin(useGSAP, ScrollTrigger);

export function IosFund() {
  const { goal, raised } = fund as { goal: number; raised: number };
  const pct = Math.max(0, Math.min(100, Math.round((raised / goal) * 100)));
  const root = useRef<HTMLDivElement>(null);
  // The real value renders first (no JS, before hydration); with motion allowed the bar refills on view.
  const [shown, setShown] = useState(raised);

  useGSAP(
    () => {
      if (raised <= 0) return;
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        const state = { v: 0 };
        setShown(0);
        gsap.to(state, {
          v: raised,
          duration: 0.9,
          ease: 'power2.out',
          onUpdate: () => setShown(Math.round(state.v)),
          scrollTrigger: { trigger: root.current, start: 'top 85%', once: true },
        });
        return () => setShown(raised);
      });
    },
    { scope: root },
  );

  return (
    <div ref={root}>
      <Surface className='flex min-w-0 flex-col gap-3 p-4 md:p-5'>
        <div className='flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1'>
          <h3 className='font-display text-st-fg text-lg font-bold'>Help bring Syllabi to iPad</h3>
          <p className='text-st-muted text-sm font-semibold tabular-nums'>
            ${shown} of ${goal} raised · {pct}%
          </p>
        </div>
        <Progress aria-label='iOS fund progress' maxValue={goal} size='md' value={shown} />
        <p className='text-st-muted text-sm leading-6'>
          The App Store needs an Apple Developer membership ($99 a year). When the fund gets there, the iPad and iPhone
          build goes to TestFlight, then the App Store.
        </p>
        <div>
          <LinkButton href={COFFEE} variant='accent'>
            <Coffee aria-hidden className='h-4 w-4' />
            Chip in
          </LinkButton>
        </div>
      </Surface>
    </div>
  );
}
