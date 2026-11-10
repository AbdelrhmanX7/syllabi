import type { Page } from "@/lib/api/types";
import type { ReactNode } from "react";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { NotebookDetailsSheet } from "@/components/notes/NotebookDetailsSheet";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { ErrorNote } from "@/components/ui/primitives";
import { describeError } from "@/lib/api/errors";
import { deleteNotePage } from "@/lib/offline/jobs";

/** Details + delete for notebook lists: the open sheets, and the delete always asks first. */
export function useNoteActions(): {
  openDetails: (page: Page) => void;
  askDelete: (page: Page) => void;
  /** Error note + the open sheet; render once next to the list. */
  overlays: ReactNode;
} {
  const queryClient = useQueryClient();
  const [toDelete, setToDelete] = useState<Page | null>(null);
  const [details, setDetails] = useState<Page | null>(null);
  const remove = useMutation({
    mutationFn: (page: Page) => deleteNotePage(page.id),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: ["study", "pages"] }),
  });

  const overlays = (
    <>
      {remove.error && <ErrorNote message={describeError(remove.error)} />}

      {details && (
        <NotebookDetailsSheet page={details} onClose={() => setDetails(null)} />
      )}

      {toDelete && (
        <ConfirmSheet
          danger
          confirmLabel="Delete notebook"
          title="Delete this notebook?"
          onClose={() => setToDelete(null)}
          onConfirm={() => remove.mutate(toDelete)}
        >
          <p>
            «<span className="text-st-fg font-semibold">{toDelete.title}</span>»
            and all its pages and writing will be deleted on every device. This
            can’t be undone.
          </p>
        </ConfirmSheet>
      )}
    </>
  );

  return { openDetails: setDetails, askDelete: setToDelete, overlays };
}
