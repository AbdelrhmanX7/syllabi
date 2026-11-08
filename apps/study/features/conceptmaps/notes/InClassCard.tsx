import type { ConceptMapRecord } from '../types';
import type { InClassDraft } from './NotesWorkspace';

import { useState } from 'react';
import { Presentation } from 'lucide-react';

import { addLink, browserStore, readLinks, writeLinks } from './links';
import { blankNotesPage } from './sources';

import { ActionButton, ErrorNote, Field, INPUT_CLASS, Surface } from '@/components/ui/primitives';
import { describeError } from '@/lib/api/errors';

/**
 * «In class» — a fresh notebook page and a blank map board side by side for today's lecture. The
 * concept list usually comes at the end of class; typing it in the workspace then creates the map.
 */
export function InClassCard({
  classId,
  defaultWeek,
  maps,
  onStart,
}: {
  classId: string;
  defaultWeek: number | null;
  /** Assigned maps; the ones without a concept list yet can be filled in class. */
  maps: ConceptMapRecord[];
  onStart: (draft: InClassDraft, map: ConceptMapRecord | null) => void;
}) {
  // Newest first: the map for today's lecture is usually the last one the import found.
  const termless = maps
    .filter((map) => map.source !== 'practice' && map.promptTerms.length === 0)
    .sort((a, b) => (b.number ?? 0) - (a.number ?? 0));
  const [target, setTarget] = useState<string>(() => termless[0]?.id ?? '');
  const picked = termless.find((map) => map.id === target) ?? null;
  const [lecture, setLecture] = useState('');
  const [week, setWeek] = useState(defaultWeek !== null ? String(defaultWeek) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    const title = lecture.trim() || picked?.lecture || `Lecture notes ${new Date().toLocaleDateString('en-GB')}`;
    const weekNumber = Number.parseInt(week, 10);
    const draft: InClassDraft = {
      // Filling an assigned map: everything (notes link, ink, ticks) is keyed by that map from the start.
      key: picked?.id ?? `draft_${Date.now().toString(36)}`,
      lecture: title,
      week: picked?.week ?? (Number.isFinite(weekNumber) ? weekNumber : null),
    };

    setBusy(true);
    setError(null);
    try {
      const page = await blankNotesPage(classId, title);
      const store = browserStore();

      writeLinks(store, draft.key, addLink(readLinks(store, draft.key), page));
      onStart(draft, picked);
    } catch (failure) {
      setError(describeError(failure, 'Could not start the notes page'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Surface className='flex flex-col gap-3 p-4'>
      <div className='flex items-center gap-2'>
        <Presentation className='text-st-accent h-5 w-5' />
        <h3 className='text-st-fg text-sm font-semibold'>In class</h3>
      </div>
      <p className='text-st-muted text-sm'>
        Notes on the left, map on the right. Snap or paste the slides into your notes; a term list is optional.
      </p>
      {termless.length > 0 && (
        <Field hint='Maps without a term list. Saving one in class fills it in.' label='For'>
          <select className={INPUT_CLASS} value={target} onChange={(event) => setTarget(event.target.value)}>
            {termless.map((map) => (
              <option key={map.id} value={map.id}>
                {map.number !== null ? `Concept map ${map.number}` : 'Concept map'}
                {map.lecture ? ` · ${map.lecture}` : ''}
                {map.week !== null ? ` · week ${map.week}` : ''}
              </option>
            ))}
            <option value=''>A new practice map</option>
          </select>
        </Field>
      )}
      <form
        className='grid grid-cols-[minmax(0,1fr)_5.5rem] gap-2'
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <Field label='Lecture'>
          <input
            className={INPUT_CLASS}
            placeholder={picked?.lecture ?? 'e.g. Lecture 5 — any topic'}
            value={lecture}
            onChange={(event) => setLecture(event.target.value)}
          />
        </Field>
        <Field label='Week'>
          <input
            className={INPUT_CLASS}
            disabled={picked !== null}
            inputMode='numeric'
            placeholder='—'
            value={picked ? String(picked.week ?? '') : week}
            onChange={(event) => setWeek(event.target.value.replace(/\D/g, '').slice(0, 2))}
          />
        </Field>
        <ActionButton className='col-span-2' loading={busy} type='submit' variant='primary'>
          Start notes + map
        </ActionButton>
      </form>
      {error && <ErrorNote message={error} />}
    </Surface>
  );
}
