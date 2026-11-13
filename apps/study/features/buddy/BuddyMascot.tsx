// The study buddy's face: a 32-px pixel creature that shows what the buddy is doing (listening,
// reading, thinking, searching, writing) and how the work went (happy / almost). One small picture
// strip per theme, shown one frame at a time; pixels stay sharp because it is only ever drawn at whole
// multiples of 32. Decorative: the status line beside it says the same thing in words.
import { cn } from '@repo/ui';

import { BUDDY_MOODS, type BuddyMood } from './status';

const FRAME = 32;

function Strip({ className, frame, scale, src }: { className?: string; frame: number; scale: number; src: string }) {
  const size = FRAME * scale;

  return (
    <span
      className={cn('buddy-mascot-strip absolute inset-0', className)}
      style={{
        backgroundImage: `url(${src})`,
        backgroundPosition: `${-frame * size}px 0`,
        backgroundSize: `${BUDDY_MOODS.length * size}px ${size}px`,
      }}
    />
  );
}

export function BuddyMascot({ className, mood, scale = 1 }: { className?: string; mood: BuddyMood; scale?: 1 | 2 | 3 }) {
  const size = FRAME * scale;
  const frame = BUDDY_MOODS.indexOf(mood);
  const blink = BUDDY_MOODS.indexOf('blink');

  return (
    <span
      aria-hidden
      // A new face arrives with a small hop (the key restarts it); happy keeps hopping a few times.
      key={mood}
      className={cn('buddy-mascot relative block shrink-0', mood === 'happy' ? 'buddy-mascot-cheer' : 'buddy-mascot-in', className)}
      data-buddy-mood={mood}
      style={{ height: size, width: size }}
    >
      <Strip className='dark:hidden' frame={frame} scale={scale} src='/mascot/buddy.png' />
      <Strip className='hidden dark:block' frame={frame} scale={scale} src='/mascot/buddy-dark.png' />
      {/* Resting, it blinks now and then: the shut-eyes frame laid over the open one for a moment. */}
      {mood === 'idle' && (
        <>
          <Strip className='buddy-mascot-blink dark:hidden' frame={blink} scale={scale} src='/mascot/buddy.png' />
          <Strip className='buddy-mascot-blink hidden dark:block' frame={blink} scale={scale} src='/mascot/buddy-dark.png' />
        </>
      )}
    </span>
  );
}
