import type { LibraryDoc, StudyClass } from "@/lib/api/types";

import { useEffect, useMemo, useState } from "react";
import { Library } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/router";

import { DocViewer } from "./components/DocViewer";
import { LibraryPanel } from "./components/LibraryPanel";
import { useLibraryDoc } from "./hooks";

import {
  DividerTabs,
  EmptyState,
  FilterChip,
  LoadingRows,
} from "@/components/ui/primitives";
import { useClasses } from "@/lib/api/hooks";

export { LibraryPanel } from "./components/LibraryPanel";
export { DocViewer } from "./components/DocViewer";

// The pen notebook pulls in the whole board engine — only when a PDF is opened in it.
const LibraryPdfBoard = dynamic(
  () =>
    import("./components/LibraryPdfBoard").then((mod) => mod.LibraryPdfBoard),
  {
    ssr: false,
    loading: () => <LoadingRows rows={6} />,
  },
);

/** `?doc=<libraryId>` deep link → the doc (its list row may not be loaded yet). */
function useDeepLinkedDoc(docId: string): LibraryDoc | null {
  const detail = useLibraryDoc(docId || null);

  return detail.data ?? null;
}

/**
 * The library for one class: documents (by week, searchable) → a doc (note / PDF / image, with the
 * AI actions) → a PDF opened as a notebook.
 */
export function LibraryView({ classId }: { classId: string }) {
  const router = useRouter();
  const docParam = typeof router.query.doc === "string" ? router.query.doc : "";
  const [open, setOpen] = useState<LibraryDoc | null>(null);
  const [notebook, setNotebook] = useState(false);
  const linked = useDeepLinkedDoc(open ? "" : docParam);
  const current = open ?? linked;
  const detail = useLibraryDoc(notebook && current ? current.id : null);

  useEffect(() => {
    setOpen(null);
    setNotebook(false);
  }, [classId]);

  const close = () => {
    setOpen(null);
    setNotebook(false);
    if (docParam) {
      const rest = { ...router.query };

      delete rest.doc;
      void router.replace(
        { pathname: router.pathname, query: rest },
        undefined,
        { shallow: true },
      );
    }
  };

  if (current && notebook) {
    return detail.data ? (
      <LibraryPdfBoard
        classId={classId}
        doc={detail.data}
        onBack={() => setNotebook(false)}
      />
    ) : (
      <LoadingRows rows={6} />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {current ? (
        <DocViewer
          classId={classId}
          doc={current}
          onBack={close}
          onOpenNotebook={() => setNotebook(true)}
        />
      ) : (
        <LibraryPanel classId={classId} onOpen={setOpen} />
      )}
    </div>
  );
}

/** `/library?classId=` — the library with a class picker (defaults to the first class). */
export default function LibraryHome({
  classId: initialClassId,
}: {
  classId?: string;
}) {
  const classes = useClasses("all");
  const classList = useMemo(() => classes.data ?? [], [classes.data]);
  const [picked, setPicked] = useState<string | null>(null);
  const classId = useMemo(() => {
    if (picked && classList.some((cls) => cls.id === picked)) return picked;
    if (initialClassId) return initialClassId;

    return classList[0]?.id ?? "";
  }, [classList, initialClassId, picked]);
  const cls = classList.find((item) => item.id === classId);

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-col gap-3">
        <div>
          <h1 className="text-st-fg text-xl font-semibold">Library</h1>
          <p className="text-st-muted text-sm">
            Notes, slides and photos from each class folder, by week.
          </p>
        </div>
        {classList.length > 1 && (
          <div className="flex flex-wrap gap-2">
            {classList.map((item) => (
              <FilterChip
                key={item.id}
                active={classId === item.id}
                onClick={() => setPicked(item.id)}
              >
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: item.color }}
                />
                {item.code || item.name}
              </FilterChip>
            ))}
          </div>
        )}
      </header>
      {classId ? (
        <LibraryView key={classId} classId={classId} />
      ) : (
        <EmptyState
          hint="Connect Canvas in Settings to see your classes."
          icon={Library}
          title={classes.isLoading ? "Loading classes…" : "No class"}
        />
      )}
    </div>
  );
}
