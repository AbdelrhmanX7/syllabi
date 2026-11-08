import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button, Tooltip } from '@repo/ui';
import { BetweenHorizontalEnd, BetweenHorizontalStart, Copy, FileText, Plus, Trash2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';

import { RemakeOrb } from './ai/RemakeOrb';

import type { RemakeOrbState } from './ai/generatingState';
import type { WhiteboardPage } from './types';
import { pageInkKey } from './utils/pageThumbnail';
import { useWbStrings } from '../../i18n/context';

const PAGE_THUMBNAIL_ITEM_HEIGHT = 96;
const PAGE_LIST_OVERSCAN = 4;

interface PageManagerProps {
  pages: WhiteboardPage[];
  // Identity-based, NOT index-based. PageManager renders the DEFERRED pages list (useDeferredValue in
  // the editor), which can lag the live array by one or more frames on heavy PDFs. Addressing pages by
  // stable id — resolved against the live array inside the editor — guarantees every action targets the
  // exact page the user clicked, never a shifted neighbor during the deferral lag.
  currentPageId: string;
  onPageSelect: (pageId: string) => void;
  onAddPage: () => void;
  onDeletePage: (pageId: string) => void;
  onDuplicatePage: (pageId: string) => void;
  onInsertPage: (pageId: string, position: 'after' | 'before') => void;
  onReorderPages: (fromPageId: string, toPageId: string) => void;
  resolvePdfThumbnail?: (page: WhiteboardPage) => Promise<string | undefined>;
  /** A page the AI is making right now («Similar copy» draft): its thumbnail shows the thinking orb. */
  busyPage?: { pageId: string; orb: RemakeOrbState } | null;
  /** Controlled open state — when set, the host owns opening the list (e.g. from the toolbar's page group). */
  isExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** Drop the floating toggle button; the host opens the list from its own control. */
  hideToggle?: boolean;
  /** Overrides the panel's anchor (default: floating at the bottom end, above the pager). */
  anchorClassName?: string;
  anchorStyle?: React.CSSProperties;
}

const PageThumbnail: React.FC<{
  page: WhiteboardPage;
  index: number;
  isCurrent: boolean;
  isDragSource: boolean;
  isDropTarget: boolean;
  // Every handler takes the page id so the parent can pass STABLE callbacks: inline closures per row
  // defeated React.memo, and each idle snapshot (a new `pages` array ~700 ms after every stroke)
  // re-rendered every visible row.
  onSelect: (pageId: string) => void;
  onDelete: (pageId: string) => void;
  onDuplicate: (pageId: string) => void;
  onDragEnd: () => void;
  onDragOver: (pageId: string) => void;
  onDragStart: (pageId: string) => void;
  onDrop: (pageId: string) => void;
  onInsertAfter: (pageId: string) => void;
  onInsertBefore: (pageId: string) => void;
  canDelete: boolean;
  resolvePdfThumbnail?: (page: WhiteboardPage) => Promise<string | undefined>;
  busyOrb?: RemakeOrbState;
}> = ({
  page,
  index,
  isCurrent,
  isDragSource,
  isDropTarget,
  onSelect,
  onDelete,
  onDuplicate,
  onDragEnd,
  onDragOver,
  onDragStart,
  onDrop,
  onInsertAfter,
  onInsertBefore,
  canDelete,
  resolvePdfThumbnail,
  busyOrb,
}) => {
  const { t } = useWbStrings();
  const [isHovered, setIsHovered] = useState(false);
  const [thumbnailSrc, setThumbnailSrc] = useState<string | undefined>(page.thumbnail || page.pdfImageUrl);
  // Changes exactly when the page's saved ink does (cheap: length + a strided sample).
  const inkKey = useMemo(() => pageInkKey(page.canvasJSON), [page.canvasJSON]);

  useEffect(() => {
    let isActive = true;

    if (!resolvePdfThumbnail) {
      setThumbnailSrc(page.thumbnail || page.pdfImageUrl);

      return () => {
        isActive = false;
      };
    }

    // The previous picture stays up while the new one renders (no flash back to the page number).
    void resolvePdfThumbnail(page)
      .then((nextThumbnailSrc) => {
        if (isActive && nextThumbnailSrc) {
          setThumbnailSrc(nextThumbnailSrc);
        }
      })
      .catch(() => undefined);

    return () => {
      isActive = false;
    };
    // Keyed on the fields that decide the picture, NOT on the page object: the current page's object
    // is replaced by every idle snapshot (viewport included), and keying on it re-rendered after every
    // stroke while the panel was open (2026-09-13). `inkKey` re-renders only when the ink changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inkKey, page.backgroundType, page.pdfAssetId, page.pdfPageIndex, page.pdfRotation, page.pdfImageUrl, resolvePdfThumbnail]);

  return (
    <div
      className='relative flex h-[88px] flex-col items-center gap-1'
      draggable
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        event.preventDefault();
        onDragOver(page.id);
      }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        onDragStart(page.id);
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop(page.id);
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <button
        className={`relative h-20 w-[140px] cursor-pointer overflow-hidden rounded-md border-2 bg-white transition-all ${
          isDropTarget
            ? 'border-sky-400 ring-2 ring-sky-200'
            : isCurrent
              ? 'border-primary ring-primary/30 ring-2'
              : 'border-default-200 hover:border-default-400'
        }`}
        type='button'
        onClick={() => onSelect(page.id)}
      >
        {thumbnailSrc ? (
          <img
            alt={t('pages.pageN', { n: index + 1 })}
            className='h-full w-full object-contain'
            decoding='async'
            draggable={false}
            loading='lazy'
            src={thumbnailSrc}
          />
        ) : (
          <div className='bg-default-50 flex h-full w-full items-center justify-center'>
            <span className='text-default-300 text-2xl font-bold'>{index + 1}</span>
          </div>
        )}

        {busyOrb ? (
          <div aria-label={t('pages.generating')} className='bg-paper/80 absolute inset-0 flex items-center justify-center' data-page-busy role='img'>
            <RemakeOrb size={20} state={busyOrb} />
          </div>
        ) : null}

        {/* PDF badge */}
        {page.pdfPageIndex !== undefined && (
          <div className='bg-danger/90 absolute start-1 top-1 rounded p-0.5'>
            <FileText className='h-3 w-3 text-white' />
          </div>
        )}

        {/* Page number badge */}
        <div className='bg-default-800/70 absolute bottom-1 end-1 flex h-5 min-w-5 items-center justify-center rounded-full px-1'>
          <span className='text-[10px] font-medium text-white'>{index + 1}</span>
        </div>
      </button>

      {/* Hover actions */}
      {isHovered ? (
        <div className='absolute -top-1 end-0 flex gap-0.5'>
          <Tooltip content={t('pages.insertBefore')} size='sm'>
            <Button
              aria-label={t('pages.insertBefore')}
              className='bg-primary-100/90 text-primary h-6 min-w-6 backdrop-blur-sm'
              isIconOnly
              size='sm'
              variant='flat'
              onPress={() => onInsertBefore(page.id)}
            >
              <BetweenHorizontalStart aria-hidden className='h-3.5 w-3.5' />
            </Button>
          </Tooltip>
          <Tooltip content={t('pages.insertAfter')} size='sm'>
            <Button
              aria-label={t('pages.insertAfter')}
              className='bg-primary-100/90 text-primary h-6 min-w-6 backdrop-blur-sm'
              isIconOnly
              size='sm'
              variant='flat'
              onPress={() => onInsertAfter(page.id)}
            >
              <BetweenHorizontalEnd aria-hidden className='h-3.5 w-3.5' />
            </Button>
          </Tooltip>
          <Tooltip content={t('pages.duplicate')} size='sm'>
            <Button
              className='bg-default-100/90 h-6 min-w-6 backdrop-blur-sm'
              isIconOnly
              size='sm'
              variant='flat'
              onPress={() => onDuplicate(page.id)}
            >
              <Copy className='h-3 w-3' />
            </Button>
          </Tooltip>
          {canDelete ? (
            <Tooltip color='danger' content={t('pages.delete')} size='sm'>
              <Button
                className='bg-danger-100/90 text-danger h-6 min-w-6 backdrop-blur-sm'
                isIconOnly
                size='sm'
                variant='flat'
                onPress={() => onDelete(page.id)}
              >
                <Trash2 className='h-3 w-3' />
              </Button>
            </Tooltip>
          ) : null}
        </div>
      ) : null}

      {isDragSource ? (
        <div className='pointer-events-none absolute inset-0 rounded-xl border-2 border-dashed border-sky-300 bg-sky-50/60' />
      ) : null}
    </div>
  );
};

const MemoizedPageThumbnail = React.memo(PageThumbnail);

const PageManager: React.FC<PageManagerProps> = ({
  pages,
  currentPageId,
  onPageSelect,
  onAddPage,
  onDeletePage,
  onDuplicatePage,
  onInsertPage,
  onReorderPages,
  resolvePdfThumbnail,
  busyPage,
  isExpanded: controlledExpanded,
  onExpandedChange,
  hideToggle = false,
  anchorClassName = 'absolute bottom-20 end-3 z-30 flex flex-row-reverse items-end',
  anchorStyle,
}) => {
  const { t } = useWbStrings();
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(false);
  const isExpanded = controlledExpanded ?? uncontrolledExpanded;
  const isExpandedRef = useRef(isExpanded);

  isExpandedRef.current = isExpanded;
  const [dragSourceId, setDragSourceId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const pagesListRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  // The active page resolved against THIS (possibly deferred) list. Used only for scroll-into-view math
  // and is -1 for the frame after an insert before the deferred list catches up — guarded below.
  const currentPageIndex = useMemo(() => pages.findIndex((page) => page.id === currentPageId), [pages, currentPageId]);

  const toggleExpanded = useCallback(() => {
    const next = !isExpandedRef.current;

    setUncontrolledExpanded(next);
    onExpandedChange?.(next);
  }, [onExpandedChange]);

  // Stable row handlers (see PageThumbnail's prop comment). The drag source is mirrored in a ref so
  // onDrop never needs a fresh closure per render.
  const dragSourceIdRef = useRef<string | null>(null);

  dragSourceIdRef.current = dragSourceId;

  const handleRowDragEnd = useCallback(() => {
    setDragSourceId(null);
    setDropTargetId(null);
  }, []);
  const handleRowDragOver = useCallback((pageId: string) => {
    setDropTargetId(pageId);
  }, []);
  const handleRowDragStart = useCallback((pageId: string) => {
    setDragSourceId(pageId);
    setDropTargetId(pageId);
  }, []);
  const handleRowDrop = useCallback(
    (pageId: string) => {
      const sourceId = dragSourceIdRef.current;

      if (sourceId !== null) {
        onReorderPages(sourceId, pageId);
      }

      setDragSourceId(null);
      setDropTargetId(null);
    },
    [onReorderPages],
  );
  const handleInsertAfter = useCallback((pageId: string) => onInsertPage(pageId, 'after'), [onInsertPage]);
  const handleInsertBefore = useCallback((pageId: string) => onInsertPage(pageId, 'before'), [onInsertPage]);

  const visibleRange = useMemo(() => {
    const totalPages = pages.length;
    const startIndex = Math.max(0, Math.floor(scrollTop / PAGE_THUMBNAIL_ITEM_HEIGHT) - PAGE_LIST_OVERSCAN);
    const visibleCount =
      viewportHeight > 0
        ? Math.ceil(viewportHeight / PAGE_THUMBNAIL_ITEM_HEIGHT) + PAGE_LIST_OVERSCAN * 2
        : Math.min(totalPages, 10);
    const endIndex = Math.min(totalPages, startIndex + visibleCount);

    return {
      endIndex,
      paddingBottom: Math.max(0, (totalPages - endIndex) * PAGE_THUMBNAIL_ITEM_HEIGHT),
      paddingTop: startIndex * PAGE_THUMBNAIL_ITEM_HEIGHT,
      startIndex,
    };
  }, [pages.length, scrollTop, viewportHeight]);

  const visiblePages = useMemo(
    () =>
      pages.slice(visibleRange.startIndex, visibleRange.endIndex).map((page, offset) => ({
        index: visibleRange.startIndex + offset,
        page,
      })),
    [pages, visibleRange.endIndex, visibleRange.startIndex],
  );

  useEffect(() => {
    if (!isExpanded || !pagesListRef.current || currentPageIndex < 0) return;

    const container = pagesListRef.current;
    const itemTop = currentPageIndex * PAGE_THUMBNAIL_ITEM_HEIGHT;
    const itemBottom = itemTop + PAGE_THUMBNAIL_ITEM_HEIGHT;
    const viewportTop = container.scrollTop;
    const viewportBottom = viewportTop + container.clientHeight;

    if (itemTop < viewportTop) {
      container.scrollTo({ behavior: 'smooth', top: itemTop });
    } else if (itemBottom > viewportBottom) {
      container.scrollTo({ behavior: 'smooth', top: itemBottom - container.clientHeight });
    }
  }, [currentPageIndex, isExpanded]);

  useEffect(() => {
    if (!isExpanded || !pagesListRef.current) {
      return;
    }

    const container = pagesListRef.current;
    const ResizeObserverConstructor =
      typeof window !== 'undefined'
        ? (window as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver
        : undefined;
    const syncMeasurements = () => {
      setScrollTop(container.scrollTop);
      setViewportHeight(container.clientHeight);
    };
    const handleScroll = () => {
      setScrollTop(container.scrollTop);
    };
    const resizeObserver = ResizeObserverConstructor ? new ResizeObserverConstructor(syncMeasurements) : null;

    syncMeasurements();
    resizeObserver?.observe(container);
    container.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      resizeObserver?.disconnect();
      container.removeEventListener('scroll', handleScroll);
    };
  }, [isExpanded]);

  return (
    <div
      className={anchorClassName}
      style={anchorStyle}
      onContextMenu={(event) => {
        event.preventDefault();
      }}
    >
      <motion.div
        animate={{ width: isExpanded ? 180 : 0 }}
        className='overflow-hidden'
        initial={false}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      >
        <AnimatePresence>
          {isExpanded && (
            <motion.div
              animate={{ opacity: 1 }}
              className='border-default-200 bg-background/80 flex h-[min(60vh,calc(100vh-12rem))] w-[180px] flex-col rounded-xl border shadow-lg backdrop-blur-md'
              exit={{ opacity: 0 }}
              initial={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              {/* Header */}
              <div className='border-divider flex items-center justify-between border-b px-3 py-2'>
                <p className='text-foreground text-xs font-semibold'>{t('pages.title')}</p>
                <span className='text-default-400 text-[10px]'>{pages.length}</span>
              </div>

              {/* Pages list */}
              <div ref={pagesListRef} className='flex-1 overflow-y-auto p-2' style={{ contentVisibility: 'auto' }}>
                <div
                  className='space-y-2'
                  style={{ paddingBottom: visibleRange.paddingBottom, paddingTop: visibleRange.paddingTop }}
                >
                  {visiblePages.map(({ page, index }) => (
                    <MemoizedPageThumbnail
                      key={page.id}
                      canDelete={pages.length > 1}
                      index={index}
                      isDragSource={dragSourceId === page.id}
                      isCurrent={page.id === currentPageId}
                      isDropTarget={dropTargetId === page.id && dragSourceId !== page.id}
                      page={page}
                      busyOrb={busyPage && busyPage.pageId === page.id ? busyPage.orb : undefined}
                      resolvePdfThumbnail={resolvePdfThumbnail}
                      onDelete={onDeletePage}
                      onDuplicate={onDuplicatePage}
                      onDragEnd={handleRowDragEnd}
                      onDragOver={handleRowDragOver}
                      onDragStart={handleRowDragStart}
                      onDrop={handleRowDrop}
                      onInsertAfter={handleInsertAfter}
                      onInsertBefore={handleInsertBefore}
                      onSelect={onPageSelect}
                    />
                  ))}
                </div>
              </div>

              {/* Add page button */}
              <div className='border-divider border-t p-2'>
                <Button
                  className='w-full'
                  color='primary'
                  size='sm'
                  startContent={<Plus className='h-4 w-4' />}
                  variant='flat'
                  onPress={onAddPage}
                >
                  {t('pages.newPage')}
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* Toggle button */}
      {hideToggle ? null : (
      <Button
        className='border-default-200 bg-background/85 me-1 h-10 min-w-10 rounded-2xl border shadow-md backdrop-blur-md'
        isIconOnly
        size='sm'
        variant='flat'
        onPress={toggleExpanded}
      >
        <div className='relative flex items-center justify-center'>
          <FileText className='h-4 w-4' />
          <span className='bg-default-800 absolute -bottom-3 rounded-sm px-1.5 py-0.5 text-[9px] font-semibold text-white'>
            {pages.length}
          </span>
        </div>
      </Button>
      )}
    </div>
  );
};

const MemoizedPageManager = React.memo(PageManager);

export { MemoizedPageManager as PageManager };
export default MemoizedPageManager;
