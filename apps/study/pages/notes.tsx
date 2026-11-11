import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { NotebookPen, Plus } from "lucide-react";
import dynamic from "next/dynamic";
import Head from "next/head";
import { useRouter } from "next/router";
import { ScrollShadow } from "@repo/ui";

import { PageHeader } from "@/components/layout/PageHeader";
import {
  ActionButton,
  EmptyState,
  ErrorNote,
  FilterChip,
  LoadingRows,
  SectionTitle,
} from "@/components/ui/primitives";
import { notebookHref } from "@/features/lecturenotes/hooks";
import { createNotePage } from "@/lib/offline/jobs";
import { NoteGrid } from "@/components/notes/NoteGrid";
import { BookmarkList } from "@/components/notes/BookmarkList";
import { describeError } from "@/lib/api/errors";
import { useClasses, usePages } from "@/lib/api/hooks";
import { isMyNote } from "@/lib/notebooks/my-notes";
import { tagsInUse, withTag } from "@/lib/notebooks/page-meta";
import { rememberPages } from "@/lib/notebooks/pages-cache";

/** The tag picked in the filter strip, remembered on this device. */
const TAG_KEY = "study_notes_tag";

function readTag(): string | null {
  try {
    return window.localStorage.getItem(TAG_KEY) || null;
  } catch {
    return null;
  }
}

function saveTag(tag: string | null): void {
  try {
    if (tag) window.localStorage.setItem(TAG_KEY, tag);
    else window.localStorage.removeItem(TAG_KEY);
  } catch {
    // Storage blocked (private window): the filter just isn't remembered.
  }
}

const ImportNotebookButton = dynamic(
  () => import("@/features/inbox").then((mod) => mod.ImportNotebookButton),
  { ssr: false },
);

/** `/notes/` — notebooks of your own, not tied to a class, plus every class notebook in one place. */
export default function NotesPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const pages = usePages({});
  const { data: classes } = useClasses();

  useEffect(() => {
    if (pages.data) rememberPages(pages.data);
  }, [pages.data]);

  const classNames = useMemo(
    () => new Map((classes ?? []).map((cls) => [cls.id, cls.code || cls.name])),
    [classes],
  );
  const own = pages.data?.filter(isMyNote) ?? [];
  const inClasses = pages.data?.filter((page) => page.classId) ?? [];
  const tags = useMemo(() => tagsInUse(pages.data ?? []), [pages.data]);

  // Read after mount: the page is prerendered, so reading storage while rendering would mismatch.
  const [savedTag, setSavedTag] = useState<string | null>(null);

  useEffect(() => setSavedTag(readTag()), []);
  // A remembered tag no notebook has any more falls back to All, so the page never looks empty.
  const tag = savedTag && tags.includes(savedTag) ? savedTag : null;
  const pickTag = (next: string | null) => {
    setSavedTag(next);
    saveTag(next);
  };
  const ownShown = withTag(own, tag);
  const classShown = withTag(inClasses, tag);

  const create = useMutation({
    mutationFn: async () => {
      const title = `Note · ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date())}`;
      // Offline: a note on this device at once, created on the server when it is back.
      const page = await createNotePage({ classId: null, title, kind: "note" });

      rememberPages([page]);

      return page;
    },
    onSuccess: (page) => {
      void queryClient.invalidateQueries({ queryKey: ["study", "pages"] });
      void router.push(notebookHref(page));
    },
  });

  return (
    <>
      <Head>
        <title>Notes · Syllabi</title>
      </Head>
      <PageHeader
        actions={
          <div className="flex flex-wrap gap-3">
            <ImportNotebookButton classId={null} />
            <ActionButton
              disabled={create.isPending}
              variant="primary"
              onClick={() => create.mutate()}
            >
              <Plus className="h-4 w-4" /> New note
            </ActionButton>
          </div>
        }
        title="Notes"
      />
      {create.error && <ErrorNote message={describeError(create.error)} />}
      {pages.error && (
        <ErrorNote
          message={describeError(pages.error)}
          onRetry={() => void pages.refetch()}
        />
      )}
      {pages.isLoading && !pages.data && <LoadingRows rows={4} />}

      {pages.data && (
        <div className="flex flex-col gap-4">
          {tags.length > 0 && (
            <ScrollShadow hideScrollBar orientation="horizontal">
              {/* Padding inside the scroller: the chips' lip and press travel must not be cut. */}
              <div
                aria-label="Filter by tag"
                className="flex w-max gap-2 px-0.5 pb-1.5 pt-0.5"
                role="group"
              >
                <FilterChip active={!tag} onClick={() => pickTag(null)}>
                  All
                </FilterChip>
                {tags.map((name) => (
                  <FilterChip
                    key={name}
                    active={tag === name}
                    onClick={() => pickTag(name)}
                  >
                    {name}
                  </FilterChip>
                ))}
              </div>
            </ScrollShadow>
          )}

          <BookmarkList pages={withTag(pages.data, tag)} />

          {own.length === 0 ? (
            <EmptyState
              hint="Write anything here: ideas, lists, notes for a club. Coming from Samsung Notes, GoodNotes or OneNote? Export a note as a PDF there, then tap Import pages."
              icon={NotebookPen}
              title="No notes yet"
            />
          ) : (
            ownShown.length > 0 && (
              <section>
                <SectionTitle count={ownShown.length}>My notes</SectionTitle>
                <NoteGrid from="notes" pages={ownShown} />
              </section>
            )
          )}

          {classShown.length > 0 && (
            <section>
              <SectionTitle count={classShown.length}>
                Class notebooks
              </SectionTitle>
              <NoteGrid
                from="notes"
                labelFor={(page) =>
                  classNames.get(page.classId as string) ?? "Class"
                }
                pages={classShown}
              />
            </section>
          )}
        </div>
      )}
    </>
  );
}
