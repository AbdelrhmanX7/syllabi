import { Coffee } from 'lucide-react';

import { Progress } from '@repo/ui';

import { LinkButton, Surface } from '@/components/ui/primitives';

// Same numbers as the README bar: edit .github/ios-fund.json (and run scripts/ios-fund.mjs for the SVG).
import fund from '../../../.github/ios-fund.json';

export function IosFund() {
  const { goal, raised } = fund as { goal: number; raised: number };
  const pct = Math.max(0, Math.min(100, Math.round((raised / goal) * 100)));

  return (
    <Surface className='flex min-w-0 flex-col gap-3 p-4 md:p-5'>
      <div className='flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1'>
        <h3 className='font-display text-st-fg text-lg font-bold'>Help bring Syllabi to iPad</h3>
        <p className='text-st-muted text-sm font-semibold'>
          ${raised} of ${goal} raised · {pct}%
        </p>
      </div>
      <Progress aria-label='iOS fund progress' maxValue={goal} size='md' value={raised} />
      <p className='text-st-muted text-sm leading-6'>
        The App Store needs an Apple Developer membership ($99 a year). When the fund gets there, the iPad and iPhone
        build goes to TestFlight, then the App Store.
      </p>
      <div>
        <LinkButton href='https://buymeacoffee.com/AbdelrhmanX7' variant='accent'>
          <Coffee aria-hidden className='h-4 w-4' />
          Chip in
        </LinkButton>
      </div>
    </Surface>
  );
}
