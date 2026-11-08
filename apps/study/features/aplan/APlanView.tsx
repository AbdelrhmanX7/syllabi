import type { APlanState } from './api';

import { FileQuestion, Loader2 } from 'lucide-react';

import { useAPlan, useGradePlan } from './api';
import { CategoryBars } from './components/CategoryBars';
import { AnnouncementsDigest, ConflictsBanner, Risks, SyllabusEssentials, ThisWeek } from './components/PlanSections';
import { EngagementWarning, RecoveryPanel } from './components/RecoveryPanel';
import { StatusHeader } from './components/StatusHeader';
import { WhatIfCalculator } from './components/WhatIfCalculator';

import { ActionButton, EmptyState, ErrorNote, LoadingRows } from '@/components/ui/primitives';
import { describeError, isStudyApiError } from '@/lib/api/errors';

/** The first build (202) takes 20–60 s; after the poll cap the owner can start waiting again. */
function BuildingNote({ state }: { state: APlanState }) {
  const timedOut = state.phase === 'timed_out';

  return (
    <div className='rounded-st border-st-line bg-st-raised/50 flex items-start gap-3 border px-4 py-3' role='status'>
      {!timedOut && <Loader2 aria-hidden className='text-st-accent mt-0.5 h-5 w-5 shrink-0 animate-spin' />}
      <div className='min-w-0 flex-1 text-sm'>
        <p className='text-st-fg font-semibold'>
          {timedOut ? 'Your plan is taking longer than usual' : 'Building your plan…'}
        </p>
        <p className='text-st-muted mt-0.5'>
          {timedOut
            ? 'The grade numbers below are already live. Check again in a minute.'
            : 'Reading the syllabus and announcements — this takes under a minute.'}
        </p>
        {state.lastError && <p className='text-st-danger mt-1 text-xs'>Last attempt failed: {state.lastError}</p>}
      </div>
      {timedOut && (
        <ActionButton className='min-h-9 shrink-0 px-3 text-xs' variant='ghost' onClick={state.retry}>
          Check again
        </ActionButton>
      )}
    </div>
  );
}

/**
 * The class page's "Get an A" tab. Numbers come from the LIVE grade-plan; the a-plan (this week,
 * risks, announcements, syllabus essentials) is layered on once it is built.
 */
export default function APlanView({ classId }: { classId: string }) {
  const gradeQuery = useGradePlan(classId);
  const planState = useAPlan(classId);
  const aPlan = planState.plan;
  // The grade plan wins: it is Canvas-exact. The a-plan's embedded copy only fills in when it is missing.
  const grade = gradeQuery.data ?? aPlan?.gradePlan ?? null;
  // Syllabus names for exams not in Canvas yet ("Exam 2", "Final Exam") label the estimate.
  const futureExamTitles = aPlan?.policy?.exams.map((exam) => exam.name);
  const building = planState.phase === 'building' || planState.phase === 'timed_out';

  if (gradeQuery.isLoading || (planState.isLoading && !grade)) return <LoadingRows rows={6} />;
  if (!grade) {
    if (building) return <BuildingNote state={planState} />;
    if (isStudyApiError(gradeQuery.error, 404) || isStudyApiError(planState.error, 404))
      return (
        <EmptyState
          hint='Once the gradebook syncs from Canvas, this tab shows exactly what it takes to get an A.'
          icon={FileQuestion}
          title='No gradebook yet'
        />
      );

    return (
      <ErrorNote
        message={describeError(gradeQuery.error ?? planState.error, 'Could not load the plan')}
        onRetry={() => void gradeQuery.refetch()}
      />
    );
  }

  return (
    <div className='flex flex-col gap-6'>
      {building && <BuildingNote state={planState} />}
      {aPlan && <ConflictsBanner conflicts={aPlan.conflicts} />}
      {aPlan?.meetings && <EngagementWarning gradePlan={grade} meetings={aPlan.meetings} />}
      <StatusHeader
        aPlan={aPlan}
        classId={classId}
        futureExamTitles={futureExamTitles}
        grade={grade}
        planState={planState}
      />
      <div className='grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]'>
        <div className='flex min-w-0 flex-col gap-6'>
          {aPlan && <ThisWeek actions={aPlan.thisWeek} classId={classId} />}
          <CategoryBars futureExamTitles={futureExamTitles} plan={grade} />
          <WhatIfCalculator classId={classId} futureExamTitles={futureExamTitles} plan={grade} />
        </div>
        {aPlan && (
          <div className='flex min-w-0 flex-col gap-6'>
            <RecoveryPanel gradePlan={grade} plan={aPlan} />
            <Risks requirements={aPlan.requirements} risks={aPlan.risks} />
            <AnnouncementsDigest announcements={aPlan.announcements} />
            <SyllabusEssentials policy={aPlan.policy} policyStatus={aPlan.policyStatus} />
          </div>
        )}
      </div>
    </div>
  );
}
