import type { TodayAPlanEntry, TodayHighAnnouncement, TodayWarning } from '../types';
import type { StudyClass } from '@/lib/api/types';

import { useMemo } from 'react';
import { cn } from '@repo/ui';
import { AlertTriangle, ChevronRight, Megaphone, Target } from 'lucide-react';
import Link from 'next/link';

import { useGradePlan, useTodayAPlan } from '../api';
import { overallStatus } from '../lib/grade-math';
import { aPlanHeadline } from '../lib/headline';
import { isRequirementStatus, visibleTodayPlans } from '../lib/today';

import { REQUIREMENT_META, STATUS_META, StatusPill } from './shared';
import { DeadlineChanges } from './PlanSections';

import { classHref } from '@/components/classes/ClassCard';
import { itemHref } from '@/components/items/ItemRow';
import { Badge, SectionTitle, Surface } from '@/components/ui/primitives';
import { isSampleData } from '@/lib/api/sample';
import { formatDue, formatRelative } from '@/lib/format';

/** Where the class page's "Get an A" tab lives. The shell owns the tab param; `tab=aplan` is the ask. */
export const aPlanHref = (classId: string) => `${classHref({ id: classId })}&tab=aplan`;

/**
 * Goal chip for a class. `compact` fits inside a ClassCard (which is already a link, so no links here):
 * "A goal · At risk · Average 79.3% on …". Full size is a small card that links to the plan.
 */
export function GradeGoalCard({ classId, compact }: { classId: string; compact?: boolean }) {
  const { data: plan } = useGradePlan(classId);

  if (!plan) return null;
  const status = overallStatus(plan);
  const headline = aPlanHeadline(plan);
  // Mock answers carry `__sample`: on a class card (no page banner) the made-up status stays muted.
  const sample = isSampleData(plan);

  if (compact && sample) {
    return (
      <div className='flex min-w-0 items-center gap-2 text-xs'>
        <Target aria-hidden className='text-st-muted h-3.5 w-3.5 shrink-0' />
        <span className='text-st-muted shrink-0 font-semibold'>{plan.target.letter} goal</span>
        <Badge>Sample</Badge>
      </div>
    );
  }

  if (compact) {
    return (
      <div className='flex min-w-0 items-center gap-2 text-xs'>
        <Target aria-hidden className={cn('h-3.5 w-3.5 shrink-0', STATUS_META[status].text)} />
        <span className='text-st-fg shrink-0 font-semibold'>{plan.target.letter} goal</span>
        <span className='text-st-muted min-w-0 truncate' title={headline.text}>
          {STATUS_META[status].label}
        </span>
      </div>
    );
  }

  return (
    <Link className='block' href={aPlanHref(classId)}>
      <Surface className='hover:bg-st-raised/50 flex items-start gap-3 p-4 transition-colors'>
        <Target aria-hidden className='text-st-accent mt-0.5 h-5 w-5 shrink-0' />
        <div className='min-w-0 flex-1'>
          <div className='flex items-center gap-2'>
            <span className='text-st-fg text-sm font-semibold'>
              {plan.current.letter ?? '—'} → {plan.target.letter}
            </span>
            {sample ? <Badge>Sample</Badge> : <StatusPill status={status} />}
          </div>
          <p className='text-st-muted mt-1 text-sm leading-snug'>
            {sample ? 'Sample data — switch off mock mode in Settings to see your real plan.' : headline.text}
          </p>
        </div>
        <ChevronRight aria-hidden className='text-st-muted h-4 w-4 shrink-0 self-center' />
      </Surface>
    </Link>
  );
}

function ClassPlanRow({ entry, cls }: { entry: TodayAPlanEntry; cls: StudyClass | undefined }) {
  const status = isRequirementStatus(entry.status) ? REQUIREMENT_META[entry.status] : null;

  return (
    <li className='border-st-line border-b py-0.5 last:border-b-0'>
      <Link
        className='hover:bg-st-raised flex min-h-14 items-center gap-3 px-4 py-3 transition-colors'
        href={aPlanHref(entry.classId)}
      >
        <span
          aria-hidden
          className='h-8 w-1 shrink-0 rounded-full'
          style={{ backgroundColor: cls?.color ?? 'currentColor' }}
        />
        <div className='min-w-0 flex-1'>
          <div className='flex items-center gap-2'>
            <span className='text-st-fg text-sm font-semibold'>{cls?.code ?? 'Class'}</span>
            {status && <Badge tone={status.tone}>{status.label}</Badge>}
          </div>
          {(entry.alerts ?? []).map((alert) => (
            <p key={alert} className='text-st-warn mt-0.5 flex items-start gap-1.5 text-sm font-medium'>
              <AlertTriangle aria-hidden className='mt-0.5 h-3.5 w-3.5 shrink-0' />
              <span className='min-w-0'>{alert}</span>
            </p>
          ))}
          {entry.topAction && <p className='text-st-muted mt-0.5 text-sm [overflow-wrap:anywhere]'>{entry.topAction}</p>}
        </div>
        <ChevronRight aria-hidden className='text-st-muted h-4 w-4 shrink-0' />
      </Link>
    </li>
  );
}

function HighAnnouncementRow({
  announcement,
  cls,
}: {
  announcement: TodayHighAnnouncement;
  cls: StudyClass | undefined;
}) {
  const nextAction = announcement.actions.find((action) => action.dueAt) ?? announcement.actions[0];

  return (
    <li className='border-st-line border-b py-0.5 last:border-b-0'>
      <Link
        className='hover:bg-st-raised flex flex-col gap-1 px-4 py-3 transition-colors'
        href={itemHref({ id: announcement.itemId })}
      >
        <div className='flex items-center gap-2 text-xs'>
          <span className='font-semibold' style={{ color: cls?.color }}>
            {cls?.code}
          </span>
          {announcement.postedAt && (
            <span className='text-st-muted ml-auto'>{formatRelative(announcement.postedAt)}</span>
          )}
        </div>
        {announcement.title && <p className='text-st-fg text-sm font-semibold leading-snug'>{announcement.title}</p>}
        <p className='text-st-fg text-sm leading-snug'>{announcement.summary}</p>
        <DeadlineChanges changes={announcement.deadlineChanges ?? []} />
        {nextAction && (
          <p className='text-st-accent text-xs font-medium'>
            {nextAction.text}
            {nextAction.dueAt && <span className='text-st-muted font-normal'> · {formatDue(nextAction.dueAt)}</span>}
          </p>
        )}
      </Link>
    </li>
  );
}

/** Live `/today.warnings`: a policy item due within 48 h and not handed in. Real data — no Sample chip. */
function WarningRow({ warning, cls }: { warning: TodayWarning; cls: StudyClass | undefined }) {
  return (
    <li className='border-st-line border-b py-0.5 last:border-b-0'>
      <Link
        className='hover:bg-st-raised flex items-start gap-3 px-4 py-3 transition-colors'
        href={itemHref({ id: warning.itemId })}
      >
        <AlertTriangle aria-hidden className='text-st-warn mt-0.5 h-4 w-4 shrink-0' />
        <div className='min-w-0 flex-1'>
          <div className='flex items-center gap-2 text-xs'>
            <span className='font-semibold' style={{ color: cls?.color }}>
              {cls?.code}
            </span>
            {warning.dueAt && <span className='text-st-warn ml-auto font-medium'>{formatDue(warning.dueAt)}</span>}
          </div>
          <p className='text-st-fg text-sm font-medium'>{warning.title}</p>
          <p className='text-st-muted text-xs leading-snug'>{warning.reason}</p>
        </div>
      </Link>
    </li>
  );
}

/** Today: one row per class (status + the single most useful next step) and the important announcements. */
export function TodayAPlanStrip() {
  const { data } = useTodayAPlan();
  const classes = useMemo(() => new Map((data?.classes ?? []).map((cls) => [cls.id, cls])), [data?.classes]);
  const entries = useMemo(() => visibleTodayPlans(data?.aPlan), [data?.aPlan]);
  const needAttention = entries.filter(
    (entry) => entry.status === 'at_risk' || entry.status === 'missed' || (entry.alerts?.length ?? 0) > 0,
  ).length;
  const high = (data?.highAnnouncements ?? []).slice(0, 4);
  const warnings = data?.warnings ?? [];

  if (entries.length === 0 && high.length === 0 && warnings.length === 0) return null;

  return (
    <div className='mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2'>
      {warnings.length > 0 && (
        <section className='lg:col-span-2'>
          <SectionTitle count={warnings.length}>
            <AlertTriangle className='text-st-warn mr-1 inline h-4 w-4' /> Don&apos;t miss — one miss can cost the A
          </SectionTitle>
          <Surface className='overflow-hidden'>
            <ul>
              {warnings.map((warning) => (
                <WarningRow key={warning.itemId} cls={classes.get(warning.classId)} warning={warning} />
              ))}
            </ul>
          </Surface>
        </section>
      )}
      {entries.length > 0 && (
        <section>
          <SectionTitle
            action={
              needAttention > 0 ? (
                <Badge tone='warn'>{needAttention} need attention</Badge>
              ) : entries.every((entry) => entry.status === 'on_track' || entry.status === 'met') ? (
                <Badge tone='ok'>All on track</Badge>
              ) : undefined
            }
          >
            <Target className='text-st-muted mr-1 inline h-4 w-4' /> A plan
          </SectionTitle>
          <Surface className='overflow-hidden'>
            <ul>
              {entries.map((entry) => (
                <ClassPlanRow key={entry.classId} cls={classes.get(entry.classId)} entry={entry} />
              ))}
            </ul>
          </Surface>
        </section>
      )}
      {high.length > 0 && (
        <section>
          <SectionTitle count={high.length}>
            <Megaphone className='text-st-muted mr-1 inline h-4 w-4' /> Important announcements
          </SectionTitle>
          <Surface className='overflow-hidden'>
            <ul>
              {high.map((announcement) => (
                <HighAnnouncementRow
                  key={announcement.itemId}
                  announcement={announcement}
                  cls={classes.get(announcement.classId)}
                />
              ))}
            </ul>
          </Surface>
        </section>
      )}
    </div>
  );
}
