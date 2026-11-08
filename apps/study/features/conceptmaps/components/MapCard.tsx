import type { ConceptMapRecord } from '../types';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Columns2, ExternalLink, ImageOff, ListChecks, PenLine } from 'lucide-react';
import Link from 'next/link';

import { formatScore, mapTitle } from '../lib/score';

import { ActionButton, Badge, Surface } from '@/components/ui/primitives';
import { MapLectureNotes } from '@/features/lecturenotes/components/NoteLinks';
import { formatDate } from '@/lib/format';

/**
 * One map in the overview grid: terms, the submission picture, the instructor's notes. A map is a study
 * tool, not a grade: a Canvas grade shows only when the map is linked to a graded Canvas assignment, as a
 * small fact beside that link.
 */
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
  const canvasGrade = map.canvasItemId && map.scoreSource === 'canvas' && map.score !== null;

  return (
    <Surface as='article' className='flex flex-col gap-3 p-4'>
      <header className='min-w-0'>
        <p className='text-st-muted flex flex-wrap items-center gap-1.5 text-xs font-medium uppercase tracking-wide'>
          {practice ? 'Practice' : map.number !== null ? `Map ${map.number}` : 'Concept map'}
          {map.dueAt && <span>· {formatDate(map.dueAt)}</span>}
          {map.examReview && <Badge tone='accent'>Exam review</Badge>}
        </p>
        <h3 className='text-st-fg mt-0.5 text-sm font-semibold [overflow-wrap:anywhere]'>{mapTitle(map)}</h3>
      </header>

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

      {!practice && map.canvasItemId && (
        <Link
          className='text-st-muted hover:text-st-fg inline-flex items-center gap-1 self-start text-xs font-medium'
          href={`/item/?id=${encodeURIComponent(map.canvasItemId)}`}
        >
          <ExternalLink className='h-3.5 w-3.5' /> On Canvas
          {canvasGrade && <span className='tabular-nums'>· graded {formatScore(map.score, map.maxScore)}</span>}
        </Link>
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
