import type { MasteryTopic, StudyClass } from '@/lib/api/types';

import React, { useMemo } from 'react';
import { Target } from 'lucide-react';

import { getMastery } from '../api';
import { useLoad } from '../hooks/useLoad';
import { pct } from '../lib/verdict';

import { Chip } from './BankBrowser';

/**
 * Per-class topic bars from `/mastery`, the weak ones called out, «Drill» starts a topic session.
 */

export interface MasteryPanelProps {
  classes: StudyClass[];
  classId: string | null;
  onClassChange?: (classId: string | null) => void;
  onDrill?: (topic: string) => void;
  className?: string;
}

export const WEAK_THRESHOLD = 0.6;

export function barTone(mastery: number): string {
  if (mastery >= 0.8) return 'bg-st-ok';
  if (mastery >= WEAK_THRESHOLD) return 'bg-st-warn';

  return 'bg-st-danger';
}

export function MasteryPanel({ classes, classId, onClassChange, onDrill, className = '' }: MasteryPanelProps) {
  const mastery = useLoad(() => getMastery(classId ?? undefined), [classId]);
  const topics = useMemo(() => [...(mastery.data?.topics ?? [])].sort((a, b) => a.mastery - b.mastery), [mastery.data]);
  const weak = topics.filter((t) => t.mastery < WEAK_THRESHOLD && t.attempts > 0);
  const overall = topics.length ? topics.reduce((sum, t) => sum + t.mastery, 0) / topics.length : 0;
  const dueTotal = topics.reduce((sum, t) => sum + t.dueCount, 0);

  return (
    <section className={`flex flex-col gap-4 ${className}`}>
      {classes.length > 1 && onClassChange ? (
        <div className='flex flex-wrap gap-2'>
          <Chip active={!classId} onPress={() => onClassChange(null)}>
            All
          </Chip>
          {classes.map((c) => (
            <Chip key={c.id} active={classId === c.id} dot={c.color} onPress={() => onClassChange(c.id)}>
              {c.code || c.name}
            </Chip>
          ))}
        </div>
      ) : null}

      <div className='grid grid-cols-3 gap-2'>
        <Stat label='Overall' value={`${pct(overall)}%`} />
        <Stat label='Topics' value={String(topics.length)} />
        <Stat label='Due' value={String(dueTotal)} />
      </div>

      {mastery.loading ? <p className='text-sm text-st-muted'>Loading mastery…</p> : null}
      {mastery.error ? (
        <p className='rounded-2xl bg-st-danger/10 p-3 text-sm text-st-danger'>
          {mastery.error}
        </p>
      ) : null}

      {weak.length ? (
        <div className='rounded-2xl border border-st-danger/30 bg-st-danger/10 p-4'>
          <p className='mb-2 flex items-center gap-2 text-sm font-semibold text-st-danger'>
            <Target className='h-4 w-4' /> Weak topics
          </p>
          <div className='flex flex-wrap gap-2'>
            {weak.map((t) => (
              <button
                key={t.topic}
                className='inline-flex h-10 items-center gap-2 rounded-full bg-st-surface px-3.5 text-sm font-medium text-st-danger hover:bg-st-danger/10'
                type='button'
                onClick={() => onDrill?.(t.topic)}
              >
                {t.topic} <span className='text-st-danger'>{pct(t.mastery)}%</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <ul className='space-y-2'>
        {topics.map((topic) => (
          <TopicRow key={topic.topic} topic={topic} onDrill={onDrill} />
        ))}
      </ul>

      {!mastery.loading && !topics.length ? (
        <p className='rounded-2xl border border-dashed border-st-line p-8 text-center text-sm text-st-muted'>
          Attempt a few questions and mastery per topic shows up here.
        </p>
      ) : null}
    </section>
  );
}

function TopicRow({ topic, onDrill }: { topic: MasteryTopic; onDrill?: (topic: string) => void }) {
  return (
    <li className='rounded-2xl border border-st-line bg-st-surface p-3'>
      <div className='flex items-center gap-3'>
        <div className='min-w-0 flex-1'>
          <div className='flex items-baseline justify-between gap-2'>
            <p className='truncate text-base font-medium text-st-fg'>{topic.topic}</p>
            <p className='shrink-0 text-sm tabular-nums text-st-muted'>{pct(topic.mastery)}%</p>
          </div>
          <div className='mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-st-raised'>
            <div
              className={`h-full rounded-full ${barTone(topic.mastery)}`}
              style={{ width: `${pct(topic.mastery)}%` }}
            />
          </div>
          <p className='mt-1 text-xs text-st-muted'>
            {topic.attempts} attempt{topic.attempts === 1 ? '' : 's'}
            {topic.dueCount ? ` · ${topic.dueCount} due` : ''}
          </p>
        </div>
        {onDrill ? (
          <button
            className='flex h-11 shrink-0 items-center gap-1.5 rounded-xl bg-st-raised px-3.5 text-sm font-medium text-st-fg hover:bg-st-raised'
            type='button'
            onClick={() => onDrill(topic.topic)}
          >
            <Target className='h-4 w-4' /> Drill
          </button>
        ) : null}
      </div>
    </li>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className='rounded-2xl border border-st-line p-3'>
      <p className='text-2xl font-semibold tabular-nums text-st-fg'>{value}</p>
      <p className='text-xs text-st-muted'>{label}</p>
    </div>
  );
}
