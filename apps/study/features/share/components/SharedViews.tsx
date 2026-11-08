import type { WhiteboardDocument } from '@repo/whiteboard-core';
import type { ConceptMapContent, NotebookContent, QuestionSetContent, SharedView } from '../types';

import { useEffect, useState } from 'react';
import { Chip } from '@repo/ui';
import { createBlankWhiteboardDocument, normalizeWhiteboardDocument } from '@repo/whiteboard-core';
import { useWhiteboardStorage } from '@repo/whiteboard-react';
import dynamic from 'next/dynamic';

import { Toggle } from '@/components/ui/Toggle';
import { fetchJsonFromUrl } from '@/lib/api/upload';
import { useBoardTheme } from '@/lib/notebooks/board-theme';

const WhiteboardEditor = dynamic(() => import('@repo/whiteboard-react').then((mod) => mod.WhiteboardEditor), {
  ssr: false,
  loading: () => <BoardNote>Loading the board…</BoardNote>,
});
// Markdown + KaTeX renderer shared with the question bank (client-only).
const Markdown = dynamic(() => import('@/features/bank').then((mod) => mod.Markdown), { ssr: false });

function BoardNote({ children }: { children: React.ReactNode }) {
  return <div className='text-st-muted flex h-full items-center justify-center text-sm'>{children}</div>;
}

/**
 * A shared notebook, view only: the snapshot's board JSON is written to this device's board storage
 * under its own id (`shared-<shareId>`, rewritten on every open) and the editor runs read-only on it:
 * pan, zoom and scroll, no tools, no sync. PDF backgrounds live on the owner's device and do not
 * travel with the share, so only the ink and paper show.
 */
function NotebookView({ shareId, content }: { shareId: string; content: NotebookContent }) {
  const storage = useWhiteboardStorage();
  const boardTheme = useBoardTheme();
  const boardId = `shared-${shareId}`;
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let live = true;

    setState('loading');
    (async () => {
      const doc = content.contentUrl
        ? normalizeWhiteboardDocument(await fetchJsonFromUrl<WhiteboardDocument>(content.contentUrl))
        : createBlankWhiteboardDocument({ id: boardId, title: content.title, backgroundType: 'blank' });

      if (!doc) throw new Error('empty');
      await storage.saveWhiteboard({ ...doc, id: boardId, title: content.title });
      if (live) setState('ready');
    })().catch(() => live && setState('error'));

    return () => {
      live = false;
    };
  }, [boardId, content.contentUrl, content.title, content.version, storage]);

  return (
    <div className='border-st-line bg-st-bg relative h-[70vh] min-h-[360px] w-full overflow-hidden rounded-lg border'>
      {state === 'ready' ? (
        <WhiteboardEditor
          embedded
          hideChrome
          paperOverPdf
          readOnly
          verticalNotebook
          boardTheme={boardTheme}
          locale='en'
          whiteboardId={boardId}
        />
      ) : (
        <BoardNote>{state === 'error' ? 'Couldn’t load this notebook. Try again in a moment.' : 'Loading the board…'}</BoardNote>
      )}
    </div>
  );
}

/** Cards (front / back) or questions (stem / answer): flat rows, answers behind one switch. */
function QuestionSetView({ content, cards }: { content: QuestionSetContent; cards: boolean }) {
  const [showAnswers, setShowAnswers] = useState(cards);

  if (!content.questions.length) return <p className='text-st-muted text-sm'>Nothing here yet.</p>;

  return (
    <div className='flex flex-col gap-2'>
      <div className='flex flex-wrap items-center gap-x-3 gap-y-1'>
        <p className='text-st-muted min-w-0 flex-1 basis-56 text-sm'>
          {content.questions.length} {cards ? 'cards' : 'questions'}
          {content.topic ? ` · ${content.topic}` : ''} · {content.className}
        </p>
        <span className='text-st-fg text-sm'>{cards ? 'Show backs' : 'Show answers'}</span>
        <Toggle checked={showAnswers} label={cards ? 'Show backs' : 'Show answers'} onChange={setShowAnswers} />
      </div>
      <ol className='border-st-line divide-st-line bg-st-surface flex flex-col divide-y rounded-lg border'>
        {content.questions.map((question, index) => (
          <li key={question.id} className='flex gap-3 px-4 py-3'>
            <span className='text-st-muted w-6 shrink-0 pt-0.5 text-right text-xs tabular-nums'>{index + 1}</span>
            <div className='min-w-0 flex-1'>
              <div className='text-st-fg text-sm'>
                <Markdown text={question.stem} />
              </div>
              {(question.choices?.length ?? 0) > 0 && (
                <ul className='text-st-muted mt-1 list-disc pl-5 text-sm'>
                  {(question.choices ?? []).map((choice) => (
                    <li key={choice}>{choice}</li>
                  ))}
                </ul>
              )}
              {showAnswers && question.answer && (
                <div className='border-st-line text-st-muted mt-2 border-l-2 pl-3 text-sm'>
                  <Markdown text={question.answer} />
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ConceptMapView({ content }: { content: ConceptMapContent }) {
  const facts = [
    content.className,
    content.week ? `Week ${content.week}` : null,
    content.number ? `Map ${content.number}` : null,
  ].filter(Boolean);

  return (
    <div className='flex flex-col gap-3'>
      {facts.length > 0 && <p className='text-st-muted text-sm'>{facts.join(' · ')}</p>}
      <p className='text-st-fg text-sm font-semibold'>Terms to connect</p>
      {content.promptTerms.length ? (
        <div className='flex flex-wrap gap-3'>
          {content.promptTerms.map((term) => (
            <Chip key={term} size='md' variant='flat'>
              {term}
            </Chip>
          ))}
        </div>
      ) : (
        <p className='text-st-muted text-sm'>No terms yet.</p>
      )}
      <p className='text-st-muted text-xs'>Make a copy to draw your own map from these terms and get it graded.</p>
    </div>
  );
}

export function SharedContent({ view }: { view: SharedView }) {
  switch (view.share.resourceType) {
    case 'notebook':
      return <NotebookView content={view.content as NotebookContent} shareId={view.share.id} />;
    case 'deck':
      return <QuestionSetView cards content={view.content as QuestionSetContent} />;
    case 'questions':
      return <QuestionSetView cards={false} content={view.content as QuestionSetContent} />;
    case 'conceptMap':
      return <ConceptMapView content={view.content as ConceptMapContent} />;
  }
}
