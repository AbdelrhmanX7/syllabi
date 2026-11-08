import type { ConceptMapRecord } from './types';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Columns2, LayoutGrid, PenLine } from 'lucide-react';
import { useRouter } from 'next/router';

import { Compare } from './components/Compare';
import { Overview } from './components/Overview';
import { Practice } from './components/Practice';
import { Toast, useToast } from './components/Toast';
import { useConceptMaps, useMakeShortAnswers } from './hooks';
import { byNumber } from './lib/score';
import { browserStore } from './notes/links';
import { withLocalTerms } from './notes/terms-store';

import { useClasses } from '@/lib/api/hooks';
import { isSampleData } from '@/lib/api/sample';
import { describeError } from '@/lib/api/errors';
import { EmptyState, FilterChip } from '@/components/ui/primitives';

export { ConceptMapsPanel } from './components/ConceptMapsPanel';
export { conceptMapMockRoutes } from './mock';
export type { ConceptMapRecord, GradeVerdict, MapAttempt } from './types';

/**
 * `/concept-maps` — Concept Map Studio. One screen, three views (routing stays with the shell):
 * overview of the class's maps by week with the exam short-answer drill on top, practice on the pen
 * canvas with live grading, and a side-by-side compare against the model answer (when there is one)
 * and an AI reference map. Any class, any topic; a term list is optional.
 */

type Tab = 'overview' | 'practice' | 'compare';

const TABS: { id: Tab; label: string; icon: typeof LayoutGrid }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutGrid },
  { id: 'practice', label: 'Practice', icon: PenLine },
  { id: 'compare', label: 'Compare', icon: Columns2 },
];

/** The exam picks in order; when none are marked, every assigned map. */
export function drillQueue(maps: ConceptMapRecord[]): ConceptMapRecord[] {
  const assigned = maps.filter((map) => map.source !== 'practice').sort(byNumber);
  const picks = assigned.filter((map) => map.examReview);

  return picks.length > 0 ? picks : assigned;
}

export interface ConceptMapsHomeProps {
  classId?: string;
  className?: string;
}

export default function ConceptMapsHome({ classId: initialClassId, className = '' }: ConceptMapsHomeProps) {
  const router = useRouter();
  const classes = useClasses('all');
  const classList = useMemo(() => classes.data ?? [], [classes.data]);
  const [pickedClassId, setPickedClassId] = useState<string | null>(initialClassId ?? null);
  const classId = useMemo(() => {
    if (initialClassId) return initialClassId;
    if (pickedClassId && classList.some((cls) => cls.id === pickedClassId)) return pickedClassId;

    return classList[0]?.id ?? '';
  }, [classList, initialClassId, pickedClassId]);
  const maps = useConceptMaps(classId);
  // A map whose concept list was saved in class but not yet accepted by the server reads it from the device.
  const mapList = useMemo(() => (maps.data ?? []).map((map) => withLocalTerms(map, browserStore())), [maps.data]);
  const [tab, setTab] = useState<Tab>('overview');
  const [selected, setSelected] = useState<ConceptMapRecord | null>(null);
  const [practiceMap, setPracticeMap] = useState<ConceptMapRecord | null>(null);
  const [drill, setDrill] = useState<ConceptMapRecord[] | null>(null);
  const { toast, show, dismiss } = useToast();
  const shortAnswers = useMakeShortAnswers();
  const [questionsBusyId, setQuestionsBusyId] = useState<string | null>(null);
  const [examQuestionsBusy, setExamQuestionsBusy] = useState(false);

  // `?practice=<mapId>` (from the class card) opens a session straight away.
  useEffect(() => {
    const wanted = typeof router.query.practice === 'string' ? router.query.practice : '';

    if (!wanted || mapList.length === 0) return;
    const map = mapList.find((item) => item.id === wanted);

    if (map) {
      setPracticeMap(map);
      setTab('practice');
    }
  }, [mapList, router.query.practice]);

  // `?compare=<mapId>[&attempt=<attemptId>]` (a notebook's «Concept map» sheet) opens Compare on that attempt.
  const compareAttemptId = typeof router.query.attempt === 'string' ? router.query.attempt : undefined;

  useEffect(() => {
    const wanted = typeof router.query.compare === 'string' ? router.query.compare : '';

    if (!wanted || mapList.length === 0) return;
    const map = mapList.find((item) => item.id === wanted);

    if (map) {
      setSelected(map);
      setTab('compare');
    }
  }, [mapList, router.query.compare]);

  // The selected map goes stale when the list refreshes (a practice score lands); re-resolve it by id.
  useEffect(() => {
    if (selected) {
      const fresh = mapList.find((item) => item.id === selected.id);

      if (fresh && fresh !== selected) setSelected(fresh);
    }
  }, [mapList]);

  const openPractice = useCallback((map: ConceptMapRecord) => {
    setDrill(null);
    setPracticeMap(map);
    setTab('practice');
  }, []);

  const openCompare = useCallback((map: ConceptMapRecord) => {
    setSelected(map);
    setTab('compare');
  }, []);

  const startDrill = useCallback(() => {
    const queue = drillQueue(mapList);

    if (queue.length === 0) return;
    setDrill(queue);
    setPracticeMap(queue[0]!);
    setTab('practice');
  }, [mapList]);

  const bankHref = useCallback(
    (map: ConceptMapRecord, topic?: string) =>
      `/bank/?classId=${encodeURIComponent(map.classId)}${topic ? `&topic=${encodeURIComponent(topic)}` : ''}`,
    [],
  );

  const makeQuestions = useCallback(
    async (map: ConceptMapRecord) => {
      setQuestionsBusyId(map.id);
      try {
        const questions = await shortAnswers.mutateAsync(map.id);
        const topic = questions[0]?.topic ?? map.lecture ?? undefined;

        // Sample answers come from the on-device preview — nothing reaches the real bank, so say so.
        const where = isSampleData(questions)
          ? 'drafted (sample preview — not saved to your bank)'
          : 'added to the bank';

        show(`${questions.length} short-answer question${questions.length === 1 ? '' : 's'} ${where}`, {
          tone: 'ok',
          href: bankHref(map, topic),
          hrefLabel: 'Open bank',
        });
      } catch (error) {
        show(describeError(error, 'Could not make questions'), { tone: 'danger' });
      } finally {
        setQuestionsBusyId(null);
      }
    },
    [bankHref, shortAnswers, show],
  );

  /** Every exam pick → the bank, one call per map; a failure on one map does not stop the rest. */
  const makeExamQuestions = useCallback(async () => {
    const queue = drillQueue(mapList);

    if (queue.length === 0) return;
    setExamQuestionsBusy(true);
    let count = 0;
    let failed = 0;
    let sample = false;

    for (const map of queue) {
      try {
        const made = await shortAnswers.mutateAsync(map.id);

        sample = sample || isSampleData(made);
        count += made.length;
      } catch {
        failed += 1;
      }
    }
    setExamQuestionsBusy(false);
    show(
      `${count} exam-style short-answer questions ${sample ? 'drafted (sample preview — not saved to your bank)' : 'added'} from ${queue.length - failed} map${queue.length - failed === 1 ? '' : 's'}${failed ? ` (${failed} failed)` : ''}`,
      { tone: failed === queue.length ? 'danger' : 'ok', href: bankHref(queue[0]!), hrefLabel: 'Open bank' },
    );
  }, [bankHref, mapList, shortAnswers, show]);

  const toastText = useCallback(
    (text: string, tone: 'ok' | 'danger' | 'neutral' = 'neutral') => show(text, { tone }),
    [show],
  );

  return (
    <div className={`flex flex-col gap-4 p-4 sm:p-6 ${className}`}>
      <header className='flex flex-col gap-3'>
        <div className='flex flex-wrap items-center justify-between gap-3'>
          <div>
            <h1 className='text-st-fg text-xl font-semibold'>Concept maps</h1>
            <p className='text-st-muted text-sm'>
              Any class, any topic — from notes, a lecture or a photo. The AI builds or checks them.
            </p>
          </div>
          <nav aria-label='Concept map views' className='flex gap-1.5'>
            {TABS.map((item) => (
              <FilterChip key={item.id} active={tab === item.id} onClick={() => setTab(item.id)}>
                <item.icon className='h-4 w-4' />
                {item.label}
              </FilterChip>
            ))}
          </nav>
        </div>
        {!initialClassId && classList.length > 1 && (
          <div className='flex flex-wrap gap-2'>
            {classList.map((cls) => (
              <FilterChip
                key={cls.id}
                active={classId === cls.id}
                onClick={() => {
                  setPickedClassId(cls.id);
                  setSelected(null);
                  setPracticeMap(null);
                  setDrill(null);
                }}
              >
                <span className='inline-block h-2 w-2 rounded-full' style={{ background: cls.color }} />
                {cls.code || cls.name}
              </FilterChip>
            ))}
          </div>
        )}
      </header>

      {!classId ? (
        <EmptyState
          hint='Connect Canvas in Settings, or pick a class above.'
          title={classes.isLoading ? 'Loading classes…' : 'No class selected'}
        />
      ) : tab === 'overview' ? (
        <Overview
          error={maps.error ? describeError(maps.error) : null}
          examQuestionsBusy={examQuestionsBusy}
          loading={maps.isLoading}
          maps={mapList}
          questionsBusyId={questionsBusyId}
          onCompare={openCompare}
          onDrill={startDrill}
          onExamQuestions={() => void makeExamQuestions()}
          onPractice={openPractice}
          onQuestions={(map) => void makeQuestions(map)}
          onRetry={() => void maps.refetch()}
        />
      ) : tab === 'practice' ? (
        <Practice
          classId={classId}
          drill={drill}
          initial={practiceMap}
          maps={mapList}
          onCompare={openCompare}
          onToast={toastText}
        />
      ) : (selected ?? practiceMap) ? (
        // The Compare tab from a practice session compares the map being practised.
        <Compare
          classId={classId}
          initialAttemptId={selected && selected.id === router.query.compare ? compareAttemptId : undefined}
          map={(selected ?? practiceMap)!}
          onBack={() => setTab('overview')}
          onPractice={openPractice}
          onToast={toastText}
        />
      ) : (
        <EmptyState
          hint='Pick a map in the overview to see it beside the model answer and an AI reference.'
          icon={Columns2}
          title='Nothing to compare yet'
        />
      )}

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
