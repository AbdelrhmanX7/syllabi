import type { BankFilters } from "./lib/filters";
import type { Question, StudyClass } from "@/lib/api/types";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  ListChecks,
  NotebookPen,
  Plus,
  Sparkles,
  Target,
} from "lucide-react";
import dynamic from "next/dynamic";

import { deleteQuestion, listClasses, listQuestions } from "./api";
import { AddQuestionsModal } from "./components/AddQuestions";
import { BankBrowser } from "./components/BankBrowser";
import { MasteryPanel } from "./components/MasteryPanel";
import { MockExam } from "./components/MockExam";
import { QuestionCard } from "./components/QuestionCard";
import { ReviewSession } from "./components/ReviewSession";
import { SolveView } from "./components/SolveView";
import { useLoad } from "./hooks/useLoad";
import { readBoardSession } from "./lib/boardSession";
import { EMPTY_FILTERS, mergeQuestions } from "./lib/filters";
import { isDue } from "./lib/verdict";

import { DividerTabs } from "@/components/ui/primitives";
import { AiOffNote } from "@/components/ui/AiOff";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { ForkedFromNote, ShareButton } from "@/features/share/components/ShareButton";
import { useAiEnabled } from '@/hooks/useAiEnabled';

export { ExtractButton, AddQuestionsModal } from "./components/AddQuestions";
export { QuestionCard } from "./components/QuestionCard";
export { SolveView } from "./components/SolveView";
export { MasteryPanel } from "./components/MasteryPanel";
export { ReviewSession } from "./components/ReviewSession";
export { MockExam } from "./components/MockExam";
export { InkCanvas } from "./components/InkCanvas";
export { Markdown } from "./components/Markdown";
export type { InkCanvasHandle } from "./components/InkCanvas";
export type { AttemptOutcome, SolveViewProps } from "./components/SolveView";
export type { ExtractButtonProps } from "./components/AddQuestions";

/**
 * `/bank` — the question bank home. One screen with internal views (routing stays with the shell):
 * browse → solve, review session, mastery, mock exam, add.
 */

type View =
  | { kind: "browse" }
  | { kind: "solve"; question: Question }
  | { kind: "review"; topic?: string }
  | { kind: "mastery" }
  | { kind: "exam"; topics?: string[]; blueprint?: boolean }
  /** `questions` = a new board exam from them; absent = resume the saved one. */
  | { kind: "board"; questions?: Question[] };

// The notebook board (whiteboard engine) loads only when a board exam opens.
const BoardExam = dynamic(
  () => import("./components/BoardExam").then((mod) => mod.BoardExam),
  { ssr: false },
);

type Tab = "bank" | "mastery";

const PAGE_SIZE = 60;

export interface BankHomeProps {
  classId?: string;
  /** Preselects the topic chip (e.g. from `?topic=` on /bank). */
  initialTopic?: string;
  /** Opens straight into the mock-exam setup with these topics picked (`?mock=1&topics=a,b`). */
  initialMock?: { topics: string[]; blueprint?: boolean } | null;
  /** Opens straight into a review session (`?review=1`), drilling `initialTopic` when set. */
  initialReview?: boolean;
  className?: string;
}

export default function BankHome({
  classId: initialClassId,
  initialTopic,
  initialMock,
  initialReview,
  className = "",
}: BankHomeProps) {
  const aiOn = useAiEnabled();
  const classesLoad = useLoad(listClasses, [], true, 'classes');
  const classes = useMemo(() => classesLoad.data ?? [], [classesLoad.data]);
  const [filters, setFilters] = useState<BankFilters>({
    ...EMPTY_FILTERS,
    classId: initialClassId ?? null,
    topic: initialTopic ?? null,
  });
  const [savedBoard, setSavedBoard] = useState(false);
  const [view, setView] = useState<View>(() =>
    initialMock
      ? {
          kind: "exam",
          topics: initialMock.topics,
          blueprint: initialMock.blueprint,
        }
      : initialReview
        ? { kind: "review", topic: initialTopic }
        : { kind: "browse" },
  );
  const [tab, setTab] = useState<Tab>("bank");
  const [pendingDelete, setPendingDelete] = useState<Question | null>(null);
  const [adding, setAdding] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // A board exam left open (device storage — read after mount so the static render stays stable).
  useEffect(() => {
    if (view.kind === "browse") setSavedBoard(Boolean(readBoardSession()));
  }, [view.kind]);

  useEffect(() => {
    if (initialClassId) setFilters((f) => ({ ...f, classId: initialClassId }));
  }, [initialClassId]);

  useEffect(() => {
    if (initialTopic) setFilters((f) => ({ ...f, topic: initialTopic }));
  }, [initialTopic]);

  // Server narrows by class only; everything else is client-side so chips feel instant.
  const questions = useLoad(async () => {
    const page = await listQuestions({
      classId: filters.classId ?? undefined,
      limit: PAGE_SIZE,
    });

    setCursor(page.next);

    return page.items;
  }, [filters.classId], true, 'questions');
  const items = useMemo(() => questions.data ?? [], [questions.data]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listQuestions({
        classId: filters.classId ?? undefined,
        limit: PAGE_SIZE,
        cursor,
      });

      questions.setData((current) => [...(current ?? []), ...page.items]);
      setCursor(page.next);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, filters.classId, loadingMore, questions]);

  const onAdded = useCallback(
    (added: Question[]) =>
      questions.setData((current) => mergeQuestions(current ?? [], added)),
    [questions],
  );

  const onDelete = useCallback(
    async (question: Question) => {
      questions.setData((current) =>
        (current ?? []).filter((q) => q.id !== question.id),
      );
      try {
        await deleteQuestion(question.id);
      } catch {
        questions.reload();
      }
    },
    [questions],
  );

  const dueCount = useMemo(
    () => items.filter((q) => isDue(q.srs.dueAt)).length,
    [items],
  );
  const classById = useMemo(
    () => new Map(classes.map((c) => [c.id, c])),
    [classes],
  );
  const activeClass: StudyClass | null = filters.classId
    ? (classById.get(filters.classId) ?? null)
    : null;

  const exit = () => {
    setView({ kind: "browse" });
    questions.reload();
  };

  if (view.kind === "solve") {
    return (
      <div className={`px-4 py-4 ${className}`}>
        <SolveView
          question={view.question}
          studyClass={classById.get(view.question.classId) ?? null}
          onAttempted={({ question, done }) =>
            questions.setData((current) =>
              (current ?? []).map((q) =>
                q.id === question.id
                  ? { ...q, stats: done.stats, srs: done.srs }
                  : q,
              ),
            )
          }
          onBack={() => setView({ kind: "browse" })}
        />
      </div>
    );
  }
  if (view.kind === "review") {
    return (
      <div className={`px-4 py-4 ${className}`}>
        <ReviewSession
          classId={filters.classId}
          classes={classes}
          topic={view.topic ?? null}
          onExit={exit}
        />
      </div>
    );
  }
  if (view.kind === "board") {
    return (
      <div className={`px-4 py-4 ${className}`}>
        <BoardExam
          classId={filters.classId}
          questions={view.questions}
          onAttempted={(question, done) =>
            questions.setData((current) =>
              (current ?? []).map((q) =>
                q.id === question.id
                  ? { ...q, stats: done.stats, srs: done.srs }
                  : q,
              ),
            )
          }
          onExit={() => setView({ kind: "browse" })}
        />
      </div>
    );
  }
  if (view.kind === "exam") {
    return (
      <div className={`px-4 py-4 ${className}`}>
        {!aiOn ? (
          <AiOffNote />
        ) : (
        <MockExam
          classId={filters.classId}
          classes={classes}
          initialBlueprint={view.blueprint}
          initialTopics={view.topics}
          onExit={exit}
          onPractice={() => setView({ kind: "review" })}
        />
        )}
      </div>
    );
  }

  return (
    <div
      className={`mx-auto flex w-full max-w-6xl flex-col gap-5 md:px-4 md:py-4 ${className}`}
    >
      {pendingDelete ? (
        <ConfirmSheet
          danger
          confirmLabel="Delete"
          title="Delete this question?"
          onClose={() => setPendingDelete(null)}
          onConfirm={() => void onDelete(pendingDelete)}
        >
          It leaves the bank along with its review history. This can&apos;t be undone.
        </ConfirmSheet>
      ) : null}
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-[12rem] flex-1">
          <h1 className="text-2xl font-bold text-st-fg [overflow-wrap:anywhere]">
            {activeClass ? activeClass.name : "Question bank"}
          </h1>
          <p className="text-sm text-st-muted">
            {questions.loading
              ? "Loading…"
              : `${items.length} question${items.length === 1 ? "" : "s"} · ${dueCount} due`}
          </p>
          {activeClass ? (
            <ForkedFromNote
              resourceId={activeClass.id}
              resourceType="questions"
              topic={filters.topic}
            />
          ) : null}
        </div>
        {activeClass ? (
          <ShareButton
            className="h-12"
            target={{
              resourceType: "questions",
              resourceId: activeClass.id,
              topic: filters.topic,
              title: filters.topic
                ? `${filters.topic} (${activeClass.name})`
                : `${activeClass.name} questions`,
            }}
          />
        ) : null}
        <button
          className="flex h-12 items-center gap-2 rounded-st border-2 border-st-clay-edge bg-st-surface px-4 text-sm font-medium text-st-fg hover:bg-st-accent-soft shadow-clay transition-transform active:translate-y-[3px] active:shadow-none"
          type="button"
          onClick={() => setAdding(true)}
        >
          <Plus className="h-4 w-4" /> Add
        </button>
        {aiOn && (
          <button
            className="flex h-12 items-center gap-2 rounded-st border-2 border-st-clay-edge bg-st-surface px-4 text-sm font-medium text-st-fg hover:bg-st-accent-soft shadow-clay transition-transform active:translate-y-[3px] active:shadow-none"
            type="button"
            onClick={() => setView({ kind: "exam" })}
          >
            <ListChecks className="h-4 w-4" /> Mock exam
          </button>
        )}
        <button
          className="flex h-12 items-center gap-2 rounded-st border-2 border-st-clay-edge bg-st-surface px-4 text-sm font-medium text-st-fg hover:bg-st-accent-soft disabled:opacity-50 shadow-clay transition-transform active:translate-y-[3px] active:shadow-none"
          disabled={!items.length && !savedBoard}
          title="Every question on screen on a notebook board; submit and the AI reviews them all"
          type="button"
          onClick={() =>
            setView(
              savedBoard
                ? { kind: "board" }
                : { kind: "board", questions: items },
            )
          }
        >
          <NotebookPen className="h-4 w-4" />{" "}
          {savedBoard ? "Resume board exam" : "Board exam"}
        </button>
        <button
          className="flex h-12 items-center gap-2 rounded-st border-2 border-st-accent-lip bg-st-accent px-5 text-sm font-semibold text-st-accent-fg hover:bg-st-accent/90 shadow-clay-accent transition-transform active:translate-y-[3px] active:shadow-none"
          type="button"
          onClick={() => setView({ kind: "review" })}
        >
          <Sparkles className="h-4 w-4" /> Review now
          {dueCount ? ` · ${dueCount}` : ""}
        </button>
      </header>

      <DividerTabs<Tab>
        aria-label="Question bank sections"
        tabs={[
          {
            key: "bank",
            label: "Questions",
            icon: <BookOpen className="h-4 w-4" />,
          },
          {
            key: "mastery",
            label: "Mastery",
            icon: <Target className="h-4 w-4" />,
          },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "bank" ? (
        <BankBrowser
          classes={classes}
          error={questions.error}
          filters={filters}
          hasMore={Boolean(cursor)}
          loading={questions.loading || loadingMore}
          questions={items}
          onDelete={setPendingDelete}
          onFilters={setFilters}
          onLoadMore={() => void loadMore()}
          onOpen={(question) => setView({ kind: "solve", question })}
        />
      ) : (
        <MasteryPanel
          classId={filters.classId}
          classes={classes}
          onClassChange={(id) =>
            setFilters((f) => ({ ...f, classId: id, topic: null }))
          }
          onDrill={(topic) => setView({ kind: "review", topic })}
        />
      )}

      {adding ? (
        <AddQuestionsModal
          classId={filters.classId ?? undefined}
          classes={classes}
          onAdded={onAdded}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </div>
  );
}

// Re-exported for hosts that render a single card outside the bank (e.g. search results).
export type { Question } from "@/lib/api/types";
export { QuestionCard as BankQuestionCard };
