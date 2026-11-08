import type { ConceptMapRecord } from '../types';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Columns2, ExternalLink, ImageOff, ListChecks, PenLine } from 'lucide-react';
import Link from 'next/link';

import { useSetMapScore } from '../hooks';
import { formatScore, isValidHerScore, mapTitle, scoreSourceLabel, scoreTone } from '../lib/score';

import { ActionButton, Badge, INPUT_CLASS, Surface } from '@/components/ui/primitives';
import { MapLectureNotes } from '@/features/lecturenotes/components/NoteLinks';
import { describeError } from '@/lib/api/errors';
import { formatDate } from '@/lib/format';

/**
 * «Enter her score» (paper / not on Canvas yet), or an override of the Canvas grade. 0–10 in steps
 * of 0.5. Canvas wins again the next time its grade changes — the map's `scoreNote` then says so.
 */
function HerScore({ map }: { map: ConceptMapRecord }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(map.score === null ? '' : String(map.score));
  const [message, setMessage] = useState<string | null>(null);
  const save = useSetMapScore(map.classId);
  const parsed = value.trim() === '' ? null : Number(value);
  const valid = parsed === null || isValidHerScore(parsed, map.maxScore);
  const fromCanvas = map.scoreSource === 'canvas';
  const manual = map.scoreSource === 'manual';

  const submit = async (score: number | null) => {
    setMessage(null);
    try {
      await save.mutateAsync({ mapId: map.id, score });
      setOpen(false);
    } catch (error) {
      setMessage(describeError(error, 'Could not save the score'));
    }
  };

  if (!open) {
    return (
      <button
        className='text-st-accent self-start text-xs font-medium underline-offset-2 hover:underline'
        type='button'
        onClick={() => setOpen(true)}
      >
        {map.score === null ? 'Enter score' : fromCanvas ? 'Override' : 'Edit score'}
      </button>
    );
  }

  return (
    <form
      className='flex flex-col gap-1.5'
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) void submit(parsed);
      }}
    >
      <div className='flex items-center gap-2'>
        <label className='text-st-muted text-xs' htmlFor={`score-${map.id}`}>
          Score
        </label>
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          className={`${INPUT_CLASS} min-h-9 w-20 tabular-nums`}
          id={`score-${map.id}`}
          inputMode='decimal'
          max={map.maxScore}
          min={0}
          step={0.5}
          type='number'
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <span className='text-st-muted text-xs'>/ {map.maxScore}</span>
        <ActionButton
          className='min-h-9 px-3 text-xs'
          disabled={!valid}
          loading={save.isPending}
          type='submit'
          variant='primary'
        >
          Save
        </ActionButton>
        {manual && (
          <ActionButton
            className='min-h-9 px-2 text-xs'
            disabled={save.isPending}
            title={map.canvasScore !== null ? `Back to the Canvas grade (${map.canvasScore})` : 'Remove your score'}
            variant='ghost'
            onClick={() => void submit(null)}
          >
            Clear
          </ActionButton>
        )}
        <ActionButton className='min-h-9 px-2 text-xs' variant='ghost' onClick={() => setOpen(false)}>
          Cancel
        </ActionButton>
      </div>
      {!valid && <p className='text-st-warn text-xs'>0–{map.maxScore}, in steps of 0.5.</p>}
      {(fromCanvas || map.canvasScore !== null) && (
        <p className='text-st-muted text-xs'>
          Canvas has {map.canvasScore ?? map.score}. Your score replaces it until Canvas changes the grade — then Canvas
          wins.
        </p>
      )}
      {message && <p className='text-st-danger text-xs'>{message}</p>}
    </form>
  );
}

/** One map in the overview grid: terms, the submission picture, the score, the instructor's notes. */
export interface MapCardProps {
  map: ConceptMapRecord;
  onPractice: (map: ConceptMapRecord) => void;
  onCompare: (map: ConceptMapRecord) => void;
  onQuestions: (map: ConceptMapRecord) => void;
  questionsBusy?: boolean;
}

export function MapCard({ map, onPractice, onCompare, onQuestions, questionsBusy = false }: MapCardProps) {
  const [notesOpen, setNotesOpen] = useState(false);
  const practice = map.source === 'practice';
  const hasNotes = Boolean(map.instructor?.comment || map.instructor?.modelAnswer);
  const tone = scoreTone(map.score, map.maxScore);
  const source = scoreSourceLabel(map);

  return (
    <Surface as='article' className='flex flex-col gap-3 p-4'>
      <header className='flex items-start justify-between gap-3'>
        <div className='min-w-0'>
          <p className='text-st-muted flex flex-wrap items-center gap-1.5 text-xs font-medium uppercase tracking-wide'>
            {practice ? 'Practice' : map.number !== null ? `Map ${map.number}` : 'Concept map'}
            {map.dueAt && <span>· {formatDate(map.dueAt)}</span>}
            {map.examReview && <Badge tone='accent'>Exam review</Badge>}
          </p>
          <h3 className='text-st-fg mt-0.5 text-sm font-semibold [overflow-wrap:anywhere]'>{mapTitle(map)}</h3>
        </div>
        <div className='flex shrink-0 flex-col items-end gap-0.5'>
          <Badge className='tabular-nums' tone={tone}>
            {formatScore(map.score, map.maxScore)}
          </Badge>
          {source && <span className='text-st-muted text-[11px]'>Grade · {source}</span>}
        </div>
      </header>

      {map.scoreNote && <p className='rounded-st bg-st-warn/10 text-st-fg px-3 py-2 text-xs'>{map.scoreNote}</p>}

      {map.promptTerms.length > 0 && (
        <div className='flex flex-wrap gap-1.5'>
          {map.promptTerms.map((term) => (
            <span
              key={term}
              className='rounded-st border-st-line bg-st-raised text-st-fg border px-2 py-0.5 text-xs font-medium'
            >
              {term}
            </span>
          ))}
        </div>
      )}

      {map.submission?.imageUrl ? (
        <button
          aria-label='Compare this map'
          className='rounded-st overflow-hidden border border-st-clay-edge bg-st-shadow'
          type='button'
          onClick={() => onCompare(map)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt={`${mapTitle(map)} submission`}
            className='h-36 w-full object-contain'
            src={map.submission.imageUrl}
          />
        </button>
      ) : (
        <div className='rounded-st border-st-line text-st-muted flex h-20 items-center justify-center gap-2 border border-dashed text-xs'>
          <ImageOff className='h-4 w-4' />
          {practice ? 'No attempt yet' : 'No submission'}
        </div>
      )}

      {!practice && <MapLectureNotes classId={map.classId} lecture={map.lecture} mapId={map.id} />}

      {!practice && (
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <HerScore key={`${map.id}-${map.score ?? ''}`} map={map} />
          {map.canvasItemId && (
            <Link
              className='text-st-muted hover:text-st-fg inline-flex items-center gap-1 text-xs font-medium'
              href={`/item/?id=${encodeURIComponent(map.canvasItemId)}`}
            >
              <ExternalLink className='h-3.5 w-3.5' /> Canvas assignment
            </Link>
          )}
        </div>
      )}

      {hasNotes && (
        <div className='border-st-line border-t pt-2'>
          <button
            aria-expanded={notesOpen}
            className='text-st-fg flex w-full items-center gap-1.5 py-1 text-left text-sm font-medium'
            type='button'
            onClick={() => setNotesOpen((open) => !open)}
          >
            {notesOpen ? (
              <ChevronDown className='text-st-muted h-4 w-4' />
            ) : (
              <ChevronRight className='text-st-muted h-4 w-4' />
            )}
            Model answer
          </button>
          {notesOpen && (
            <div className='mt-1 flex flex-col gap-2 text-sm'>
              {map.instructor?.comment && (
                <p className='rounded-st bg-st-warn/10 text-st-fg px-3 py-2'>
                  <span className='text-st-warn mr-1 font-medium'>Comment:</span>
                  {map.instructor.comment}
                </p>
              )}
              {map.instructor?.modelAnswer && (
                <p className='rounded-st border-st-accent/30 bg-st-accent/5 text-st-fg whitespace-pre-wrap border px-3 py-2 leading-relaxed'>
                  {map.instructor.modelAnswer}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <footer className='mt-auto flex flex-wrap gap-2'>
        <ActionButton className='min-h-10 flex-1 px-3' variant='primary' onClick={() => onPractice(map)}>
          <PenLine className='h-4 w-4' /> Practice
        </ActionButton>
        <ActionButton className='min-h-10 px-3' onClick={() => onCompare(map)}>
          <Columns2 className='h-4 w-4' /> Compare
        </ActionButton>
        <ActionButton
          className='min-h-10 px-3'
          loading={questionsBusy}
          title='Make short-answer questions'
          onClick={() => onQuestions(map)}
        >
          <ListChecks className='h-4 w-4' /> Questions
        </ActionButton>
      </footer>
    </Surface>
  );
}
