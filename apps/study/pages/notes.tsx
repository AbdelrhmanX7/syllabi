
import { useEffect, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { NotebookPen, Plus } from "lucide-react";
import dynamic from "next/dynamic";
import Head from "next/head";
import { useRouter } from "next/router";

import { PageHeader } from "@/components/layout/PageHeader";
import {
  ActionButton,
  EmptyState,
  ErrorNote,
  LoadingRows,
  SectionTitle,
  Surface,
} from "@/components/ui/primitives";
import { notebookHref } from "@/features/lecturenotes/hooks";
import { createNotePage } from "@/lib/offline/jobs";
import { NoteList } from "@/components/notes/NoteList";
import { describeError } from "@/lib/api/errors";
import { useClasses, usePages } from "@/lib/api/hooks";
import { rememberPages } from "@/lib/notebooks/pages-cache";

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
  const own =
    pages.data?.filter((page) => !page.classId && page.kind === "note") ?? [];
  const inClasses = pages.data?.filter((page) => page.classId) ?? [];

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
        <div className="flex flex-col gap-3">
          {own.length === 0 ? (
            <EmptyState
              hint="Write anything here: ideas, lists, notes for a club. Coming from Samsung Notes, GoodNotes or OneNote? Export a note as a PDF there, then tap Import pages."
              icon={NotebookPen}
              title="No notes yet"
            />
          ) : (
            <Surface className="p-4">
              <SectionTitle count={own.length}>My notes</SectionTitle>
              <NoteList pages={own} />
            </Surface>
          )}

          {inClasses.length > 0 && (
            <Surface className="p-4">
              <SectionTitle count={inClasses.length}>
                Class notebooks
              </SectionTitle>
              <NoteList
                labelFor={(page) => classNames.get(page.classId as string) ?? "Class"}
                pages={inClasses}
              />
            </Surface>
          )}
        </div>
      )}

    </>
  );
}
