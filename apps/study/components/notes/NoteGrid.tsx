import type { Page } from "@/lib/api/types";

import {
  Button,
  Chip,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
} from "@repo/ui";
import { MoreVertical, SlidersHorizontal, Trash2 } from "lucide-react";
import Link from "next/link";

import { NoteCover } from "@/components/notes/NoteCover";
import { useNoteActions } from "@/components/notes/useNoteActions";
import { Surface } from "@/components/ui/primitives";
import { notebookHref } from "@/features/lecturenotes/hooks";
import { formatRelative } from "@/lib/format";
import { cardTags } from "@/lib/notebooks/page-meta";

/**
 * Notebook cover grid: cover on top, name, one line of description, up to three tags. The whole card
 * opens the notebook; details and delete sit in the card's menu (delete asks first).
 */
export function NoteGrid({
  pages,
  labelFor,
}: {
  pages: Page[];
  labelFor?: (page: Page) => string | undefined;
}) {
  const { openDetails, askDelete, overlays } = useNoteActions();

  return (
    <>
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-[repeat(auto-fill,minmax(13rem,1fr))]">
        {pages.map((page) => (
          <li key={page.id} className="min-w-0">
            <NoteCard
              label={labelFor?.(page)}
              page={page}
              onDelete={askDelete}
              onDetails={openDetails}
            />
          </li>
        ))}
      </ul>
      {overlays}
    </>
  );
}

function NoteCard({
  page,
  label,
  onDetails,
  onDelete,
}: {
  page: Page;
  label?: string;
  onDetails: (page: Page) => void;
  onDelete: (page: Page) => void;
}) {
  const description = page.description?.trim();
  const line = [
    label,
    description || `Edited ${formatRelative(page.updatedAt)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const { shown, more } = cardTags(page.tags);

  return (
    // No overflow-hidden here: it would cut the tag chips' lips and the menu button.
    <Surface className="hover:bg-st-raised relative flex h-full flex-col gap-2 p-2 pb-3">
      <NoteCover page={page} size="card" />
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1 pl-1">
          {/* Stretched link: its ::after covers the card, so a tap anywhere opens the notebook. */}
          <Link
            className="text-st-fg focus-visible:after:outline-st-accent block truncate text-sm font-semibold after:absolute after:inset-0 after:rounded-st-lg focus-visible:outline-none focus-visible:after:outline focus-visible:after:outline-2"
            href={notebookHref(page)}
            title={page.title}
          >
            {page.title}
          </Link>
          <p className="text-st-muted truncate text-xs" title={line}>
            {line}
          </p>
        </div>
        <Dropdown placement="bottom-end">
          <DropdownTrigger>
            <Button
              isIconOnly
              aria-label={`More for ${page.title}`}
              className="relative z-10 -mr-1 shrink-0"
              size="sm"
              variant="light"
            >
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownTrigger>
          <DropdownMenu
            aria-label={`${page.title} actions`}
            onAction={(key) =>
              key === "delete" ? onDelete(page) : onDetails(page)
            }
          >
            {!page.shared && (
              <DropdownItem
                key="details"
                startContent={<SlidersHorizontal className="h-4 w-4" />}
              >
                Details
              </DropdownItem>
            )}
            <DropdownItem
              key="delete"
              color="danger"
              startContent={<Trash2 className="h-4 w-4" />}
            >
              Delete
            </DropdownItem>
          </DropdownMenu>
        </Dropdown>
      </div>
      {shown.length > 0 && (
        <div className="flex flex-wrap gap-x-1.5 gap-y-2 pl-1">
          {shown.map((tag) => (
            <Chip
              key={tag}
              className="max-w-full"
              classNames={{ content: "truncate" }}
              size="sm"
              title={tag}
              variant="flat"
            >
              {tag}
            </Chip>
          ))}
          {more > 0 && (
            <Chip size="sm" title={`${more} more`} variant="flat">
              +{more}
            </Chip>
          )}
        </div>
      )}
    </Surface>
  );
}
