import { cn, ScrollShadow } from '@repo/ui';

import { ActionButton } from '@/components/ui/primitives';

/** One tap target: what the button shows, and the math dropped on the page. */
export interface MathSymbol {
  label: string;
  /** Read aloud / tooltip, in plain words. */
  name: string;
  tex: string;
}

/**
 * Fraction, root, power and subscript come with stand-in letters (a, b, x, n): the placed math is a
 * picture, so to change the letters write over it or delete it and write your own.
 */
export const MATH_SYMBOLS: MathSymbol[] = [
  { label: 'a⁄b', name: 'Fraction', tex: '\\frac{a}{b}' },
  { label: '√x', name: 'Square root', tex: '\\sqrt{x}' },
  { label: 'x²', name: 'Power', tex: 'x^{2}' },
  { label: 'xₙ', name: 'Subscript', tex: 'x_{n}' },
  { label: '±', name: 'Plus or minus', tex: '\\pm' },
  { label: '×', name: 'Times', tex: '\\times' },
  { label: '÷', name: 'Divide', tex: '\\div' },
  { label: '≤', name: 'Less than or equal', tex: '\\leq' },
  { label: '≥', name: 'Greater than or equal', tex: '\\geq' },
  { label: '≠', name: 'Not equal', tex: '\\neq' },
  { label: '≈', name: 'About equal', tex: '\\approx' },
  { label: '∞', name: 'Infinity', tex: '\\infty' },
  { label: 'π', name: 'Pi', tex: '\\pi' },
  { label: 'θ', name: 'Theta', tex: '\\theta' },
  { label: 'α', name: 'Alpha', tex: '\\alpha' },
  { label: 'β', name: 'Beta', tex: '\\beta' },
  { label: 'Δ', name: 'Delta', tex: '\\Delta' },
  { label: 'Σ', name: 'Sum', tex: '\\Sigma' },
  { label: '∫', name: 'Integral', tex: '\\int' },
  { label: '→', name: 'Arrow', tex: '\\to' },
  { label: '°', name: 'Degrees', tex: '{}^{\\circ}' },
];

/**
 * The math symbol bar: one flat strip of tap targets above the page; each tap drops the typeset
 * symbol in the middle of the view. Flat keys (no lip) so the scrolling strip never cuts them.
 */
export function MathSymbolBar({ onInsert, className }: { onInsert: (symbol: MathSymbol) => void; className?: string }) {
  return (
    <div
      aria-label='Math symbols'
      className={cn('bg-st-surface border-st-clay-edge pointer-events-auto rounded-st border-2 px-1', className)}
      data-math-bar
      role='toolbar'
    >
      <ScrollShadow hideScrollBar className='flex items-center gap-1 py-1' orientation='horizontal'>
        {MATH_SYMBOLS.map((symbol) => (
          <ActionButton
            key={symbol.name}
            aria-label={symbol.name}
            className='min-h-9 h-9 min-w-10 shrink-0 px-2 text-base font-medium'
            title={symbol.name}
            variant='ghost'
            onClick={() => onInsert(symbol)}
          >
            {symbol.label}
          </ActionButton>
        ))}
      </ScrollShadow>
    </div>
  );
}
