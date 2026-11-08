import type { QuizScoreView } from '../lib/stream';
import type { TutorQuizResult } from '../types';

import { Target } from 'lucide-react';

import { Badge } from '@/components/ui/primitives';

const VERDICT: Record<TutorQuizResult, { label: string; tone: 'ok' | 'warn' | 'danger' }> = {
  right: { label: 'Correct', tone: 'ok' },
  partial: { label: 'Partly right', tone: 'warn' },
  wrong: { label: 'Not quite', tone: 'danger' },
};

/** The running quiz score above the composer: points / graded replies, the split, the last verdict. */
export function QuizScore({
  score,
  lastVerdict,
  compact = false,
}: {
  score: QuizScoreView;
  lastVerdict?: TutorQuizResult | null;
  compact?: boolean;
}) {
  const verdict = lastVerdict ? VERDICT[lastVerdict] : null;

  return (
    <div
      aria-live='polite'
      className={`text-st-muted flex flex-wrap items-center gap-2 text-xs ${compact ? 'px-1 pb-2' : 'pb-2'}`}
    >
      <Target className='text-st-fg h-4 w-4' strokeWidth={1.75} />
      <span className='text-st-fg font-semibold tabular-nums'>Score {score.label}</span>
      {score.percent !== null && <span className='tabular-nums'>{score.percent}%</span>}
      {score.answered > 0 && (
        <span className='tabular-nums'>
          {score.right} right · {score.partial} partly · {score.wrong} wrong
        </span>
      )}
      {score.answered === 0 && <span>Answer the question to start scoring.</span>}
      {verdict && <Badge tone={verdict.tone}>Last: {verdict.label}</Badge>}
    </div>
  );
}
