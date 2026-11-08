import type { Page } from "@/lib/api/types";

import { useEffect, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { NotebookPen, Plus } from "lucide-react";
import Head from "next/head";
import Link from "next/link";
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
import { createPage } from "@/lib/api/endpoints";
import { describeError } from "@/lib/api/errors";
import { useClasses, usePages } from "@/lib/api/hooks";
import { formatRelative } from "@/lib/format";
import { rememberPages } from "@/lib/notebooks/pages-cache";

function NoteRow({ page, label }: { page: Page; label?: string }) {
  return (
    <li>
      <Link
        className="rounded-st hover:bg-st-raised flex min-h-12 items-center gap-3 px-2 py-2"
        href={notebookHref(page)}
        title={page.title}
      >
        <span className="border-st-line bg-st-raised text-st-muted flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border">
          <NotebookPen className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="text-st-fg block truncate text-sm font-medium">
            {page.title}
          </span>
          <span className="text-st-muted block truncate text-xs">
            {label ? `${label} · ` : ""}
            {formatRelative(page.updatedAt)}
          </span>
        </span>
      </Link>
    </li>
  );
}

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
      const page = await createPage({ classId: null, title, kind: "note" });

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
          <ActionButton
            disabled={create.isPending}
            variant="primary"
            onClick={() => create.mutate()}
          >
            <Plus className="h-4 w-4" /> New note
          </ActionButton>
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
              hint="Write anything here: ideas, to-do lists, notes for a club. They don’t need a class."
              icon={NotebookPen}
              title="No notes yet"
            />
          ) : (
            <Surface className="p-4">
              <SectionTitle count={own.length}>My notes</SectionTitle>
              <ul className="flex flex-col gap-1">
                {own.map((page) => (
                  <NoteRow key={page.id} page={page} />
                ))}
              </ul>
            </Surface>
          )}

          {inClasses.length > 0 && (
            <Surface className="p-4">
              <SectionTitle count={inClasses.length}>
                Class notebooks
              </SectionTitle>
              <ul className="flex flex-col gap-1">
                {inClasses.map((page) => (
                  <NoteRow
                    key={page.id}
                    label={classNames.get(page.classId as string) ?? "Class"}
                    page={page}
                  />
                ))}
              </ul>
            </Surface>
          )}
        </div>
      )}
    </>
  );
}
