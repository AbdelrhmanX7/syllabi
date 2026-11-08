import React, { useCallback, useEffect, useRef, useState } from 'react';

import { Loader2, RotateCcw, X } from 'lucide-react';

import { stepCounts } from './stepCheck';
import { STEP_TONE, STEP_TONES } from './stepCheckObjects';
import { errorMessage, useOfflineReason, useOnline } from './useAiRun';
import { useWbStrings } from '../../../i18n/context';

import type { StepCheckResult, StepCheckSections, StepVerdict } from './stepCheck';
import type { BoardAiTone } from './types';
import type { WbStringKey } from '../../../i18n/strings';

/**
 * «Check this page» panel body (step checker). The layer does the work — capture the current page,
 * ask, put a ✓/✗/! next to each step — this shows it: one count line, the steps (mistakes first),
 * then the summary sections, each tinted by meaning (mistake red, missing amber, correct green,
 * note blue). Runs on open; «Check again» re-reads the page as it is now and replaces the marks.
 */

export interface StepCheckActions {
  checkSteps: (signal: AbortSignal, onStatus: (line: string | null) => void) => Promise<{ result: StepCheckResult; marked: number; preview: Blob }>;
  clearStepMarks: () => number;
}

// The answer view's semantic tones (AiAnswerView TONE_STYLE / tones.ts): the same sk-* tokens, so
// a mistake here looks like a mistake in the chat, in both themes.
const TONE_CLASS: Record<BoardAiTone, string> = {
  success: 'bg-sk-green-soft border-sk-green text-sk-green',
  wrong: 'bg-sk-red-soft border-sk-red text-sk-red',
  warning: 'bg-sk-amber-soft border-sk-amber text-sk-amber',
  info: 'bg-sk-blue-soft border-sk-blue text-sk-blue',
};

const ROW_TONE: Record<StepVerdict, string> = {
  wrong: TONE_CLASS[STEP_TONE.wrong],
  warning: TONE_CLASS[STEP_TONE.warning],
  correct: TONE_CLASS[STEP_TONE.correct],
};

const SECTIONS: Array<{ key: keyof StepCheckSections; label: WbStringKey; tone: string }> = [
  { key: 'mistakes', label: 'ai.check.mistakes', tone: TONE_CLASS.wrong },
  { key: 'missing', label: 'ai.check.missing', tone: TONE_CLASS.warning },
  { key: 'correct', label: 'ai.check.correct', tone: TONE_CLASS.success },
  { key: 'info', label: 'ai.check.info', tone: TONE_CLASS.info },
];

const primaryClass =
  'border-sk border-ink bg-ink text-paper shadow-sk-sm inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-45 active:translate-y-px';
const secondaryClass =
  'border-ink/25 bg-paper text-ink inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-semibold hover:border-ink/60 disabled:cursor-not-allowed disabled:opacity-45';

type Status = 'running' | 'done' | 'error';

export function StepCheckBody({ actions, run }: { actions: StepCheckActions; run: number }) {
  const { t, dir, locale } = useWbStrings();
  const online = useOnline();
  const offlineReason = useOfflineReason();
  const [status, setStatus] = useState<Status>('running');
  const [line, setLine] = useState<string | null>(null);
  const [result, setResult] = useState<StepCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);

  const start = useCallback(() => {
    controllerRef.current?.abort();

    const controller = new AbortController();

    controllerRef.current = controller;
    setStatus('running');
    setLine(null);
    setError(null);
    setNotice(null);

    actions
      .checkSteps(controller.signal, setLine)
      .then(({ result: next, preview: blob }) => {
        if (controller.signal.aborted) return;

        setResult(next);
        setPreview((old) => {
          if (old) URL.revokeObjectURL(old);

          return URL.createObjectURL(blob);
        });
        setStatus('done');
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;

        setError(errorMessage(failure, locale));
        setStatus('error');
      })
      .finally(() => {
        if (controllerRef.current === controller) controllerRef.current = null;
      });
  }, [actions, locale]);

  // Once per opened check (re-picking «Check this page» bumps `run`).
  useEffect(() => {
    if (online) start();
    else {
      setStatus('error');
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  useEffect(() => {
    if (status !== 'running') return;

    setSeconds(0);

    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);

    return () => clearInterval(timer);
  }, [status]);

  const cancel = () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setStatus(result ? 'done' : 'error');
  };

  const counts = result ? stepCounts(result.steps) : null;
  const sections = result ? SECTIONS.filter((section) => result.sections[section.key].length > 0) : [];

  return (
    <div className='space-y-2.5' data-step-check={status} dir={dir}>
      {!online ? <p className='text-xs text-[#be123c]'>{offlineReason}</p> : null}

      {status === 'running' ? (
        <div className='flex items-center justify-between gap-2'>
          <div className='min-w-0 space-y-0.5' role='status'>
            <p className='text-ink/75 flex items-center gap-2 text-xs'>
              <Loader2 aria-hidden className='h-3.5 w-3.5 shrink-0 animate-spin' />
              {line ?? t('ai.check.capturing')}
            </p>
            <p className='text-ink/50 text-[11px]'>{t('ai.check.slow', { n: seconds })}</p>
          </div>
          <button className={secondaryClass} type='button' onClick={cancel}>
            <X aria-hidden className='h-3.5 w-3.5' />
            {t('ai.cancel')}
          </button>
        </div>
      ) : null}

      {status === 'error' && error ? <p className='text-xs text-[#be123c]'>{error}</p> : null}

      {result && counts && status !== 'running' ? (
        <>
          <div className='flex items-center gap-2'>
            {preview ? <img alt={t('ai.currentPage')} className='border-ink/10 h-10 w-auto max-w-16 shrink-0 rounded-md border bg-white object-contain' src={preview} /> : null}
            <p className='text-ink text-xs font-semibold leading-5'>
              {result.steps.length > 0 ? (
                <>
                  <span className='text-sk-red'>{counts.wrong} ✗</span>
                  <span className='text-ink/40'> · </span>
                  <span className='text-sk-amber'>{counts.warning} !</span>
                  <span className='text-ink/40'> · </span>
                  <span className='text-sk-green'>{counts.correct} ✓</span>
                  <span className='text-ink/60 block text-[11px] font-normal'>{t('ai.check.marked')}</span>
                </>
              ) : (
                t('ai.check.noSteps')
              )}
            </p>
          </div>

          <div className='scroll-shadow-y max-h-[min(44vh,24rem)] space-y-1.5 overflow-y-auto pe-1'>
            {result.steps.length > 0 ? (
              <ul className='space-y-1'>
                {result.steps.map((step) => (
                  <li key={step.lineId} className={`flex items-start gap-2 rounded-lg border px-2 py-1.5 text-xs leading-5 ${ROW_TONE[step.verdict]}`} data-step-verdict={step.verdict}>
                    <span aria-hidden className='w-4 shrink-0 text-center text-sm font-bold leading-5'>
                      {STEP_TONES[step.verdict].glyph}
                    </span>
                    <p className='min-w-0'>
                      <span className='font-semibold'>{t('ai.check.line', { n: step.n })}</span>
                      {step.note ? <span> — {step.note}</span> : null}
                    </p>
                  </li>
                ))}
              </ul>
            ) : null}

            {sections.map((section) => (
              <div key={section.key} className={`rounded-lg border px-2 py-1.5 text-xs leading-5 ${section.tone}`} data-step-section={section.key}>
                <p className='font-bold'>{t(section.label)}</p>
                <ul className='list-inside list-disc'>
                  {result.sections[section.key].map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {notice ? <p className='text-ink/70 text-xs'>{notice}</p> : null}

      {status !== 'running' ? (
        <div className='border-ink/10 flex flex-wrap gap-1.5 border-t pt-2'>
          <button className={primaryClass} data-step-check-again disabled={!online} type='button' onClick={start}>
            <RotateCcw aria-hidden className='h-3.5 w-3.5' />
            {t('ai.check.again')}
          </button>
          {result && result.steps.length > 0 ? (
            <button
              className={secondaryClass}
              type='button'
              onClick={() => {
                actions.clearStepMarks();
                setNotice(t('ai.check.cleared'));
              }}
            >
              {t('ai.check.clear')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
