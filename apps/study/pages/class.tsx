import type { Item, ItemType, ModuleNode, Page } from "@/lib/api/types";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { cn } from "@repo/ui";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  GraduationCap,
  Library,
  Mic,
  NotebookPen,
  Pencil,
  Plus,
  Target,
} from "lucide-react";
import dynamic from "next/dynamic";
import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";

import { ITEM_TYPE_PLURAL, ItemRow } from "@/components/items/ItemRow";
import { ClassFormSheet } from "@/components/classes/ClassFormSheet";
import { PageHeader } from "@/components/layout/PageHeader";
import { SampleDataBanner } from "@/components/ui/SampleDataBanner";
import { ClassTimesButton } from "@/features/lecturenotes/components/ClassTimes";
import { weekOfName } from "@/features/lecturenotes/lib/lectures";
import {
  ActionButton,
  Badge,
  EmptyState,
  DividerTabs,
  ErrorNote,
  FilterChip,
  GradeChip,
  LoadingRows,
  SectionTitle,
  Surface,
} from "@/components/ui/primitives";
import { createNotePage } from "@/lib/offline/jobs";
import { describeError } from "@/lib/api/errors";
import {
  studyKeys,
  useCanvasStatus,
  useClassItems,
  useClassModules,
  useClasses,
  usePages,
  useSampleRoute,
} from "@/lib/api/hooks";
import { formatRelative } from "@/lib/format";
import { rememberPages } from "@/lib/notebooks/pages-cache";
import { useAiEnabled } from "@/hooks/useAiEnabled";
import { AiOffNote } from "@/components/ui/AiOff";

// The bank's per-topic mastery card (client-only: it ships with the pen canvas).
// «Get an A»: the grade-goal plan for this class (features/aplan).
const APlanView = dynamic(() => import("@/features/aplan"), {
  ssr: false,
  loading: () => <LoadingRows rows={6} />,
});

// The class folder's library — features/library.
const LibraryView = dynamic(
  () => import("@/features/library").then((mod) => mod.LibraryView),
  {
    ssr: false,
    loading: () => <LoadingRows rows={6} />,
  },
);

// Guide & exams: countdown, exam schedule, real exam results, the class guide (features/guide).
const GuideTab = dynamic(() => import("@/features/guide"), {
  ssr: false,
  loading: () => <LoadingRows rows={4} />,
});

type ClassTab = "content" | "aplan" | "guide" | "library";

const CLASS_TABS: readonly ClassTab[] = [
  "content",
  "aplan",
  "guide",
  "library",
];

// «New lecture note» sheet + a week module's lecture notes (features/lecturenotes).
const LectureNoteSheet = dynamic(
  () =>
    import("@/features/lecturenotes/components/LectureNoteSheet").then(
      (mod) => mod.LectureNoteSheet,
    ),
  { ssr: false },
);
const WeekNotes = dynamic(
  () =>
    import("@/features/lecturenotes/components/NoteLinks").then(
      (mod) => mod.WeekNotes,
    ),
  {
    ssr: false,
  },
);

// Concept Map Studio card — every class (maps work for any class or topic).
const ConceptMapsPanel = dynamic(
  () => import("@/features/conceptmaps").then((mod) => mod.ConceptMapsPanel),
  {
    ssr: false,
  },
);

const hasConceptMaps = (_cls: { code: string; name: string }) => true;

// «Ask tutor» — the AI tutor sheet scoped to this class (features/tutor).
const AskTutorButton = dynamic(
  () => import("@/features/tutor").then((mod) => mod.AskTutorButton),
  { ssr: false },
);

// «Import pages»: a PDF / page images exported from another notes app, opened as a new notebook.
const ImportNotebookButton = dynamic(
  () => import("@/features/inbox").then((mod) => mod.ImportNotebookButton),
  { ssr: false },
);

const MasteryPanel = dynamic(
  () => import("@/features/bank").then((mod) => mod.MasteryPanel),
  { ssr: false },
);

const TOOL_LINK_CLASS =
  "rounded-st border-st-line bg-st-surface text-st-fg hover:bg-st-raised inline-flex min-h-11 items-center gap-2 border px-4 text-sm font-medium";

const TYPE_ORDER: ItemType[] = [
  "assignment",
  "quiz",
  "file",
  "page",
  "video",
  "announcement",
  "link",
];

export function notebookHref(page: Pick<Page, "id">): string {
  return `/notebook/?id=${encodeURIComponent(page.id)}`;
}

function ModuleBlock({
  classId,
  module,
  filter,
  defaultOpen,
}: {
  classId: string;
  module: ModuleNode;
  filter: ItemType | "all";
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const items = module.items.filter(
    (item) => filter === "all" || item.type === filter,
  );

  // A type filter is a request to SEE those items: a collapsed module would hide every match behind
  // its header (the chip says "Quizzes 13", the list shows nothing), so filtering opens the modules.
  useEffect(() => {
    if (filter !== "all") setOpen(true);
  }, [filter]);

  if (items.length === 0) return null;
  const unseen = items.filter((item) => !item.seenAt).length;

  return (
    <Surface className="overflow-hidden">
      <button
        aria-expanded={open}
        className="flex min-h-12 w-full items-center gap-2 px-4 py-3 text-left"
        type="button"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? (
          <ChevronDown className="text-st-muted h-4 w-4" />
        ) : (
          <ChevronRight className="text-st-muted h-4 w-4" />
        )}
        <span className="text-st-fg flex-1 truncate text-sm font-semibold">
          {module.name}
        </span>
        {unseen > 0 && <Badge tone="accent">{unseen} new</Badge>}
        <span className="text-st-muted text-xs tabular-nums">
          {items.length}
        </span>
      </button>
      {open && (
        <div className="border-st-line border-t px-1 py-1">
          <WeekNotes classId={classId} week={weekOfName(module.name)} />
          {items.map((item) => (
            <ItemRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </Surface>
  );
}

export default function ClassPage() {
  const router = useRouter();
  const classId = typeof router.query.id === "string" ? router.query.id : "";
  const [filter, setFilter] = useState<ItemType | "all">("all");
  // `?tab=aplan` (aPlanHref) grade goal, `?tab=guide` guide & exams, `?tab=library` the library; else the content tree.
  const tab: ClassTab =
    CLASS_TABS.find((name) => name === router.query.tab) ?? "content";
  const aplanIsSample = useSampleRoute(`/classes/${classId}/a-plan`);
  const aiOn = useAiEnabled();
  const contentIsSample = useSampleRoute(`/classes/${classId}/modules`);
  const selectTab = (next: ClassTab) => {
    const rest: Record<string, string | string[] | undefined> = {
      ...router.query,
    };

    delete rest.tab;

    void router.replace(
      {
        pathname: router.pathname,
        query: next === "content" ? rest : { ...rest, tab: next },
      },
      undefined,
      {
        shallow: true,
      },
    );
  };
  const { data: classes } = useClasses("all");
  const cls = classes?.find((candidate) => candidate.id === classId);
  const modules = useClassModules(classId);
  const items = useClassItems(classId);
  const pages = usePages({ classId });
  const queryClient = useQueryClient();
  const [lectureSheet, setLectureSheet] = useState(false);
  const [editSheet, setEditSheet] = useState(false);
  const manual = cls?.source === "manual";
  const canvasBase =
    useCanvasStatus(!manual).data?.baseUrl?.replace(/\/+$/, "") ?? "";

  useEffect(() => {
    if (pages.data) rememberPages(pages.data);
  }, [pages.data]);

  const createNotebook = useMutation({
    mutationFn: async () => {
      const title = `${cls?.code ?? "Notes"} · ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date())}`;
      // Offline: a note on this device at once, created on the server when it is back.
      const page = await createNotePage({ classId, title, kind: "note" });

      rememberPages([page]);

      return page;
    },
    onSuccess: (page) => {
      void queryClient.invalidateQueries({
        queryKey: studyKeys.pages(classId),
      });
      void router.push(notebookHref(page));
    },
  });

  const counts = useMemo(() => {
    const map = new Map<ItemType, number>();

    for (const item of items.data ?? [])
      map.set(item.type, (map.get(item.type) ?? 0) + 1);

    return map;
  }, [items.data]);

  const inModules = useMemo(
    () =>
      new Set(
        (modules.data ?? []).flatMap((module) =>
          module.items.map((item) => item.id),
        ),
      ),
    [modules.data],
  );
  const loose: Item[] = useMemo(
    () =>
      (items.data ?? []).filter(
        (item) =>
          !inModules.has(item.id) && (filter === "all" || item.type === filter),
      ),
    [filter, inModules, items.data],
  );

  if (!classId) {
    return <EmptyState title="No class selected" />;
  }

  return (
    <>
      <Head>
        <title>{cls ? `${cls.code} · Syllabi` : "Class · Syllabi"}</title>
      </Head>
      <PageHeader
        actions={
          <>
            {cls && <ClassTimesButton cls={cls} />}
            {cls && <AskTutorButton classId={cls.id} label="Ask tutor" />}
            {cls && manual && (
              <ActionButton onClick={() => setEditSheet(true)}>
                <Pencil className="h-4 w-4" /> Edit
              </ActionButton>
            )}
            {cls && !manual && canvasBase && (
              <a
                className="rounded-st border-st-clay-edge bg-st-surface shadow-clay text-st-fg hover:bg-st-accent-soft inline-flex min-h-11 items-center gap-2 border-2 px-4 text-sm font-semibold transition-transform active:translate-y-[3px] active:shadow-none"
                href={`${canvasBase}/courses/${cls.canvasCourseId}`}
                rel="noreferrer"
                target="_blank"
              >
                <ExternalLink className="h-4 w-4" /> Canvas
              </a>
            )}
            <Link
              className={TOOL_LINK_CLASS}
              href={`/bank/?classId=${encodeURIComponent(classId)}`}
            >
              <BookOpen className="h-4 w-4" /> Question bank
            </Link>
            <Link
              className={TOOL_LINK_CLASS}
              href={`/lectures/?classId=${encodeURIComponent(classId)}`}
            >
              <Mic className="h-4 w-4" /> Lectures
            </Link>
            <ActionButton
              loading={createNotebook.isPending}
              onClick={() => createNotebook.mutate()}
            >
              <Plus className="h-4 w-4" /> New notebook
            </ActionButton>
            <ImportNotebookButton classId={classId} />
            <ActionButton
              data-testid="new-lecture-note"
              variant="primary"
              onClick={() => setLectureSheet(true)}
            >
              <NotebookPen className="h-4 w-4" /> New lecture note
            </ActionButton>
          </>
        }
        back="/classes/"
        eyebrow={
          cls ? (
            <span className="inline-flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: cls.color }}
              />
              {[cls.code, cls.term].filter(Boolean).join(" · ") || "Your class"}
            </span>
          ) : undefined
        }
        subtitle={
          cls && !manual ? (
            <span className="inline-flex flex-wrap items-center gap-3">
              <GradeChip
                letter={cls.grade.letter}
                score={cls.grade.score}
                trend={cls.grade.trend}
              />
              {cls.counts.overdue > 0 && (
                <Badge tone="danger">{cls.counts.overdue} overdue</Badge>
              )}
              {cls.counts.due > 0 && (
                <Badge tone="warn">{cls.counts.due} due soon</Badge>
              )}
              {cls.counts.unseen > 0 && (
                <Badge tone="accent">{cls.counts.unseen} new</Badge>
              )}
            </span>
          ) : undefined
        }
        title={cls?.name ?? "Class"}
      />

      {createNotebook.error && (
        <ErrorNote message={describeError(createNotebook.error)} />
      )}

      {editSheet && cls && (
        <ClassFormSheet cls={cls} onClose={() => setEditSheet(false)} />
      )}

      {lectureSheet && (
        <LectureNoteSheet
          classId={classId}
          cls={cls}
          onClose={() => setLectureSheet(false)}
        />
      )}

      <DividerTabs<ClassTab>
        aria-label="Class sections"
        className="mb-5"
        tabs={[
          {
            key: "content",
            label: "Content",
            icon: <FileText className="h-4 w-4" />,
          },
          ...(manual || !aiOn
            ? []
            : [
                {
                  key: "aplan" as const,
                  label: "Get an A",
                  icon: <Target className="h-4 w-4" />,
                },
              ]),
          {
            key: "guide",
            label: "Guide & exams",
            icon: <GraduationCap className="h-4 w-4" />,
          },
          {
            key: "library",
            label: "Library",
            icon: <Library className="h-4 w-4" />,
          },
        ]}
        value={tab}
        onChange={selectTab}
      />

      {tab === "guide" && <GuideTab classId={classId} />}

      {tab === "library" && (
        <LibraryView classId={classId} />
      )}

      {tab === "aplan" && (
        <>
          {aplanIsSample && (
            <SampleDataBanner className="mb-5" what="grade-goal data" />
          )}
          {aiOn ? <APlanView classId={classId} /> : <AiOffNote />}
        </>
      )}

      {tab === "content" && contentIsSample && (
        <SampleDataBanner className="mb-5" what="class content" />
      )}

      <div
        className={cn(
          "grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]",
          tab !== "content" && "hidden",
        )}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <FilterChip
              active={filter === "all"}
              count={items.data?.length}
              onClick={() => setFilter("all")}
            >
              All
            </FilterChip>
            {TYPE_ORDER.filter((type) => counts.get(type)).map((type) => (
              <FilterChip
                key={type}
                active={filter === type}
                count={counts.get(type)}
                onClick={() => setFilter(type)}
              >
                {ITEM_TYPE_PLURAL[type]}
              </FilterChip>
            ))}
          </div>

          {!manual && (modules.error || items.error) && (
            <ErrorNote
              message={describeError(modules.error ?? items.error)}
              onRetry={() => {
                void modules.refetch();
                void items.refetch();
              }}
            />
          )}
          {modules.isLoading && !modules.data && <LoadingRows rows={5} />}

          {modules.data?.map((module, index) => (
            <ModuleBlock
              key={module.id}
              classId={classId}
              defaultOpen={index < 2}
              filter={filter}
              module={module}
            />
          ))}

          {loose.length > 0 && (
            <Surface className="overflow-hidden">
              <div className="text-st-fg px-4 py-3 text-sm font-semibold">
                Not in a module
              </div>
              <div className="border-st-line border-t px-1 py-1">
                {loose.map((item) => (
                  <ItemRow key={item.id} item={item} />
                ))}
              </div>
            </Surface>
          )}

          {modules.data &&
            modules.data.length === 0 &&
            loose.length === 0 &&
            !items.isLoading && (
              <EmptyState
                hint={
                  manual
                    ? "Start a notebook, add questions to the bank, record a lecture or open Code — everything lands in this class."
                    : "Run a Canvas sync from Settings."
                }
                title="Nothing here yet"
              />
            )}
        </div>

        <aside className="flex flex-col gap-4">
          {cls && hasConceptMaps(cls) && <ConceptMapsPanel classId={classId} />}

          <MasteryPanel
            classId={classId}
            classes={classes ?? []}
            onDrill={() =>
              void router.push(`/bank/?classId=${encodeURIComponent(classId)}`)
            }
          />

          <Surface className="p-4">
            <SectionTitle
              action={
                <ActionButton
                  className="min-h-9 px-3 text-xs"
                  variant="primary"
                  onClick={() => setLectureSheet(true)}
                >
                  <Plus className="h-3.5 w-3.5" /> Lecture note
                </ActionButton>
              }
              count={pages.data?.length}
            >
              <NotebookPen className="text-st-muted mr-1 inline h-4 w-4" />{" "}
              Notebooks
            </SectionTitle>
            {pages.isLoading && !pages.data && <LoadingRows rows={3} />}
            {pages.data && pages.data.length === 0 && (
              <p className="text-st-muted px-1 text-sm">
                No handwritten notes for this class yet.
              </p>
            )}
            <ul className="flex flex-col">
              {pages.data?.map((page) => (
                <li key={page.id}>
                  <Link
                    className="rounded-st hover:bg-st-raised flex min-h-12 items-center gap-3 px-2 py-2"
                    href={notebookHref(page)}
                  >
                    <span className="border-st-line bg-st-raised text-st-muted flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border">
                      <NotebookPen className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="text-st-fg block truncate text-sm font-medium">
                        {page.title}
                      </span>
                      <span className="text-st-muted block text-xs">
                        {page.kind} · {formatRelative(page.updatedAt)}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Surface>
        </aside>
      </div>
    </>
  );
}
