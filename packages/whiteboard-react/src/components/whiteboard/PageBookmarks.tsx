import React, { useEffect, useRef, useState } from 'react';

import { Button, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Popover, PopoverContent, PopoverTrigger, Tooltip } from '@repo/ui';
import { Bookmark, BookmarkMinus, BookmarkPlus, BookmarkX, X } from 'lucide-react';

import { TOOLBAR_SURFACE } from './toolbarSurfaces';
import { useWbStrings } from '../../i18n/context';

/**
 * Page bookmarks in the pager: ONE key (filled when the page in view is bookmarked) that opens a small
 * list — «Bookmark page 3» on top, then every bookmarked page: tap a row to go there, type a short
 * name for it, or drop it. Dropping a bookmark that has a name asks first (the name would be lost);
 * an unnamed one comes back with one tap, so it goes at once. Rows address pages by id: the host
 * resolves the id against its live page list (the list may lag an insert/delete by a frame).
 */
export interface PageBookmarkRow {
  pageId: string;
  /** The page's label in the pager («3», «3a»). */
  pageLabel: string;
  name?: string;
}

export interface PageBookmarksProps {
  isBookmarked: boolean;
  /** The pager label of the page in view («3»). */
  currentLabel: string;
  /** The page in view's id (to find its bookmark row). */
  currentPageId: string;
  rows: readonly PageBookmarkRow[];
  overlayPortalContainer?: Element;
  onToggle: () => void;
  onJump: (pageId: string) => void;
  onRename: (pageId: string, name: string) => void;
  onRemove: (pageId: string) => void;
  /** Size/shape of the trigger (the pager group's 40px keys). */
  buttonClassName: string;
  placement?: 'top-end' | 'bottom-end';
}

/** One row's name field: edits locally, saves on Enter or when the field loses focus. */
function BookmarkName({ name, onSave, pageLabel }: { name: string; pageLabel: string; onSave: (value: string) => void }) {
  const { t } = useWbStrings();
  const [draft, setDraft] = useState(name);
  // The latest draft/name/save for the unmount below (closing the list by tapping the board may never
  // blur the field, and the typed name must not be lost).
  const latest = useRef({ draft, name, onSave });

  latest.current = { draft, name, onSave };

  useEffect(() => setDraft(name), [name]);
  useEffect(
    () => () => {
      const { draft: last, name: saved, onSave: save } = latest.current;

      if (last.trim() !== saved) save(last);
    },
    [],
  );

  const commit = () => {
    if (draft.trim() !== name) onSave(draft);
  };

  return (
    <Input
      aria-label={t('editor.bookmark.nameLabel', { page: pageLabel })}
      className='min-w-0 flex-1'
      data-wb-bookmark-name
      maxLength={60}
      placeholder={t('editor.bookmark.namePlaceholder')}
      size='sm'
      value={draft}
      // Flat (no clay lip): it sits in a scrolling list, where a lip would be cut by the scroll box.
      variant='underlined'
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
          (event.target as HTMLInputElement).blur();
        }
      }}
      onValueChange={setDraft}
    />
  );
}

const PageBookmarks: React.FC<PageBookmarksProps> = ({
  buttonClassName,
  currentLabel,
  currentPageId,
  isBookmarked,
  onJump,
  onRemove,
  onRename,
  onToggle,
  overlayPortalContainer,
  placement = 'top-end',
  rows,
}) => {
  const { t } = useWbStrings();
  const [isOpen, setIsOpen] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<PageBookmarkRow | null>(null);
  const triggerLabel = isBookmarked ? t('editor.bookmark.open') : t('editor.bookmark.list');
  const currentRow = rows.find((row) => row.pageId === currentPageId) ?? null;

  // A named bookmark asks first (in a modal, after the list closes); an unnamed one goes at once.
  const askRemove = (row: PageBookmarkRow | null, remove: () => void) => {
    if (row?.name?.trim()) {
      setIsOpen(false);
      setPendingRemove(row);
    } else remove();
  };

  return (
    <>
      <Popover isOpen={isOpen} placement={placement} portalContainer={overlayPortalContainer} onOpenChange={setIsOpen}>
        <PopoverTrigger>
          <Button
            aria-label={triggerLabel}
            aria-pressed={isBookmarked}
            className={buttonClassName}
            data-wb-bookmark-list
            isIconOnly
            style={TOOLBAR_SURFACE[isOpen || isBookmarked ? 'active' : 'idle']}
            title={triggerLabel}
            variant='flat'
          >
            <Bookmark aria-hidden className='h-5 w-5' fill={isBookmarked ? 'currentColor' : 'none'} />
          </Button>
        </PopoverTrigger>
        <PopoverContent className='w-80 max-w-[calc(100vw-2rem)] p-2'>
          <div className='flex w-full flex-col gap-1' data-wb-bookmark-panel>
            <Button
              className='h-9 justify-start px-2 text-sm font-semibold !shadow-none'
              data-wb-bookmark-toggle
              startContent={
                isBookmarked ? <BookmarkMinus aria-hidden className='h-4 w-4' /> : <BookmarkPlus aria-hidden className='h-4 w-4' />
              }
              variant='light'
              onPress={() => (isBookmarked ? askRemove(currentRow, onToggle) : onToggle())}
            >
              {t(isBookmarked ? 'editor.bookmark.removePage' : 'editor.bookmark.addPage', { page: currentLabel })}
            </Button>
            <div className='border-default-200 mx-1 border-t' />
            {rows.length === 0 ? (
              <p className='text-default-500 px-1 py-1 text-sm'>{t('editor.bookmark.empty')}</p>
            ) : (
              <div className='scroll-shadow-y flex max-h-[min(50vh,22rem)] flex-col gap-1 overflow-y-auto'>
                {rows.map((row) => (
                  <div key={row.pageId} className='flex items-center gap-1' data-wb-bookmark-row={row.pageId}>
                    <Button
                      aria-label={t('editor.bookmark.goTo', { page: row.pageLabel })}
                      className='h-9 min-w-14 shrink-0 px-2 text-sm font-semibold tabular-nums !shadow-none'
                      data-wb-bookmark-jump
                      variant='light'
                      onPress={() => {
                        setIsOpen(false);
                        onJump(row.pageId);
                      }}
                    >
                      {t('editor.bookmark.page', { page: row.pageLabel })}
                    </Button>
                    <BookmarkName name={row.name ?? ''} pageLabel={row.pageLabel} onSave={(value) => onRename(row.pageId, value)} />
                    <Tooltip content={t('editor.bookmark.removeOne', { page: row.pageLabel })} delay={400} portalContainer={overlayPortalContainer} size='sm'>
                      <Button
                        aria-label={t('editor.bookmark.removeOne', { page: row.pageLabel })}
                        className='h-9 w-9 min-w-9 shrink-0 !shadow-none'
                        data-wb-bookmark-remove
                        isIconOnly
                        variant='light'
                        onPress={() => askRemove(row, () => onRemove(row.pageId))}
                      >
                        <BookmarkX aria-hidden className='h-4 w-4' />
                      </Button>
                    </Tooltip>
                  </div>
                ))}
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <Modal
        isOpen={pendingRemove !== null}
        placement='center'
        portalContainer={overlayPortalContainer}
        size='sm'
        onClose={() => setPendingRemove(null)}
      >
        <ModalContent>
          <ModalHeader className='flex-row items-center gap-2 text-start'>
            <span className='min-w-0 flex-1'>{t('editor.bookmark.confirmTitle', { name: pendingRemove?.name?.trim() ?? '' })}</span>
            <Button isIconOnly aria-label={t('editor.sheet.close')} size='sm' variant='light' onPress={() => setPendingRemove(null)}>
              <X className='h-5 w-5' />
            </Button>
          </ModalHeader>
          <ModalBody>
            <p className='text-sm'>{t('editor.bookmark.confirmBody', { page: pendingRemove?.pageLabel ?? '' })}</p>
          </ModalBody>
          <ModalFooter>
            <Button
              color='danger'
              data-wb-bookmark-confirm
              onPress={() => {
                if (pendingRemove) onRemove(pendingRemove.pageId);
                setPendingRemove(null);
              }}
            >
              {t('editor.bookmark.confirmRemove')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
};

export default React.memo(PageBookmarks);
