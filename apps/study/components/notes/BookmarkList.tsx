import type { Page } from "@/lib/api/types";

import { useMemo, useState } from "react";
import { Button } from "@repo/ui";
import { Bookmark } from "lucide-react";
import Link from "next/link";

import { SectionTitle, Surface } from "@/components/ui/primitives";
import { allBookmarks, bookmarkHref } from "@/lib/notebooks/bookmarks";

/** Rows shown before «Show all». */
const FIRST = 5;

/**
 * Every bookmarked page across notebooks, one line each: its name (or «Page 3»), the notebook, the
 * page. A tap opens the notebook on that page. Bookmarks are made and removed on the board.
 */
export function BookmarkList({ pages }: { pages: readonly Page[] }) {
  const entries = useMemo(() => allBookmarks(pages), [pages]);
  const [showAll, setShowAll] = useState(false);

  if (entries.length === 0) return null;
  const shown = showAll ? entries : entries.slice(0, FIRST);

  return (
    <section data-bookmark-list>
      <SectionTitle
        action={
          entries.length > FIRST ? (
            <Button size="sm" variant="light" onPress={() => setShowAll(!showAll)}>
              {showAll ? "Show less" : `Show all ${entries.length}`}
            </Button>
          ) : undefined
        }
        count={entries.length}
      >
        Bookmarks
      </SectionTitle>
      <Surface className="flex flex-col gap-1 p-1">
        {shown.map(({ page, bookmark }) => {
          const name = bookmark.label || `Page ${bookmark.pageLabel}`;
          const notebook = page.title || "Notebook";

          return (
            <Link
              key={`${page.id}:${bookmark.boardPageId}`}
              className="rounded-st hover:bg-st-raised flex min-h-11 min-w-0 items-center gap-3 px-3 py-2"
              data-bookmark-row
              href={bookmarkHref(page, bookmark, 'notes')}
              title={`${name} · ${notebook}, page ${bookmark.pageLabel}`}
            >
              <Bookmark aria-hidden className="text-st-accent h-4 w-4 shrink-0" fill="currentColor" />
              <span className="text-st-fg min-w-0 shrink truncate text-sm font-medium">{name}</span>
              <span className="text-st-muted min-w-0 flex-1 truncate text-xs">{notebook}</span>
              <span className="text-st-muted shrink-0 text-xs tabular-nums">p.{bookmark.pageLabel}</span>
            </Link>
          );
        })}
      </Surface>
    </section>
  );
}
