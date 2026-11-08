// Class guide, exam schedule + countdown, and real exam results (BE P-CM).
import React from 'react';

import { BlueprintEditor } from './components/BlueprintEditor';
import { ExamCountdown } from './components/ExamCountdown';
import { ExamResults } from './components/ExamResults';
import { GuideEditor } from './components/GuideEditor';
import { ScheduleEditor } from './components/ScheduleEditor';
import { termStartFor } from './lib/schedule';

import { useClasses } from '@/lib/api/hooks';

export { BlueprintEditor, ExamCountdown, ExamResults, GuideEditor, ScheduleEditor };
export { guideKeys, useBlueprint, useGuide, useResults, useSchedule } from './api';
export type * from './types';

/** The class page «Guide & exams» tab: countdown, schedule, results, exam format, then the guide itself. */
export default function GuideTab({ classId }: { classId: string }) {
  const classes = useClasses();
  const cls = classes.data?.find((c) => c.id === classId);
  const termStart = cls ? termStartFor(cls as unknown as { term: string } & Record<string, unknown>) : null;

  return (
    <div className='flex flex-col gap-5'>
      <ExamCountdown classId={classId} />
      <div className='grid gap-5 xl:grid-cols-2'>
        <ScheduleEditor classId={classId} termStart={termStart} />
        <ExamResults classId={classId} />
      </div>
      <BlueprintEditor classId={classId} />
      <GuideEditor classId={classId} />
    </div>
  );
}
