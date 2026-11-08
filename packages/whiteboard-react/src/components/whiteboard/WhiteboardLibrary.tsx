import React, { useCallback, useMemo, useState } from 'react';

import {
  Button,
  Card,
  CardBody,
  CardFooter,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Spinner,
} from '@repo/ui';
import {
  FileText,
  FileUp,
  Image as ImageIcon,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
  Upload,
  UserPlus,
} from 'lucide-react';

import { wbIntlLocale, wbT, type WbLocale, type WbStringKey, type WbVars } from '../../i18n/strings';

import type { WhiteboardSummary } from './types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface WhiteboardLibraryProps {
  /** Kept for host compatibility; the library UI is English-only. */
  locale?: WbLocale;
  createButtonLabel?: string;
  emptyStateDescription?: string;
  emptyStateTitle?: string;
  isLoading: boolean;
  isCreateDisabled?: boolean;
  /** Disables the import buttons (header AND empty state) for the same reason `isCreateDisabled`
   *  disables create: an imported board is a NEW board, and a board with no teacher files its
   *  recording under nobody. Disabled rather than hidden — a button that vanishes reads as a broken
   *  build, while a disabled one next to the "pick your name" prompt reads as a precondition. */
  isImportDisabled?: boolean;
  statusBanner?: React.ReactNode;
  /** List rows, not documents: the card paints id / thumbnail / title / updatedAt, and nothing here
   *  reads a page. A studio device's boards carry hundreds of pages each, so requiring whole
   *  documents to render a title is what made the home screen slow. */
  whiteboards: WhiteboardSummary[];
  /** Move a board to a specific teacher. When provided, every board gets a "Move to teacher" action.
   *  (Synced boards are reassigned on the server; local boards are claimed under the chosen teacher.) */
  onAssignTeacher?: (id: string) => void;
  onCreateNew: () => void;
  onDelete: (id: string) => void;
  onImport?: () => void;
  /** Import a ViewSonic `.olf` file, converting it into a native board. */
  onImportOlf?: () => void;
  /** Import one or more IMAGES as a new board — one page per photo, the photo as the page's
   *  background. Button hidden when absent. */
  onImportImages?: () => void;
  /** Opens the teacher's cloud-PDF library (compose-a-board flow); button hidden when absent. */
  onOpenPdfLibrary?: () => void;
  onOpen: (id: string) => void;
  onRename: (id: string, newTitle: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(timestamp: number, locale: WbLocale): string {
  return new Intl.DateTimeFormat(wbIntlLocale(locale), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

// Section-header date formatters (module-level so the Intl objects are built once, not per render).
// Today/yesterday headers already carry the relative word ('Today'/'Yesterday'), so they show only day +
// month; older headers lead with the weekday ('Thursday, July 2').
const SECTION_FORMATS = new Map<WbLocale, { dayMonth: Intl.DateTimeFormat; weekdayDayMonth: Intl.DateTimeFormat }>();

function sectionFormats(locale: WbLocale) {
  let formats = SECTION_FORMATS.get(locale);

  if (!formats) {
    formats = {
      dayMonth: new Intl.DateTimeFormat(wbIntlLocale(locale), { day: 'numeric', month: 'long' }),
      weekdayDayMonth: new Intl.DateTimeFormat(wbIntlLocale(locale), { weekday: 'long', day: 'numeric', month: 'long' }),
    };
    SECTION_FORMATS.set(locale, formats);
  }

  return formats;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface WhiteboardSection {
  key: string;
  label: string;
  whiteboards: WhiteboardSummary[];
}

// Midnight (device-local) for the calendar day a timestamp falls in — the grouping key so boards land
// in "today"/"yesterday"/… by local day rather than by 24-hour windows.
function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);

  date.setHours(0, 0, 0, 0);

  return date.getTime();
}

function buildSectionLabel(dayStart: number, todayStart: number, locale: WbLocale): string {
  const formats = sectionFormats(locale);

  if (dayStart === todayStart) {
    return wbT(locale, 'library.today', { date: formats.dayMonth.format(dayStart) });
  }

  if (dayStart === todayStart - ONE_DAY_MS) {
    return wbT(locale, 'library.yesterday', { date: formats.dayMonth.format(dayStart) });
  }

  return formats.weekdayDayMonth.format(dayStart);
}

// Group the boards into timeline sections by local calendar day of `updatedAt`, newest day first,
// preserving the incoming order within each day. Boards with a missing/0 `updatedAt` fall into a
// trailing "Older" section so they never sort above dated boards.
function groupWhiteboardsByDay(whiteboards: WhiteboardSummary[], now: number, locale: WbLocale): WhiteboardSection[] {
  const todayStart = startOfLocalDay(now);
  const sectionByKey = new Map<string, WhiteboardSection>();
  const sections: WhiteboardSection[] = [];
  let olderSection: WhiteboardSection | null = null;

  for (const whiteboard of whiteboards) {
    if (!whiteboard.updatedAt) {
      if (!olderSection) {
        olderSection = { key: 'older', label: wbT(locale, 'library.older'), whiteboards: [] };
      }

      olderSection.whiteboards.push(whiteboard);
      continue;
    }

    const dayStart = startOfLocalDay(whiteboard.updatedAt);
    const key = String(dayStart);
    let section = sectionByKey.get(key);

    if (!section) {
      section = { key, label: buildSectionLabel(dayStart, todayStart, locale), whiteboards: [] };
      sectionByKey.set(key, section);
      sections.push(section);
    }

    section.whiteboards.push(whiteboard);
  }

  // Newest day first; the push order above already keeps each day's boards in their incoming order.
  sections.sort((a, b) => Number(b.key) - Number(a.key));

  if (olderSection) {
    sections.push(olderSection);
  }

  return sections;
}

// ---------------------------------------------------------------------------
// WhiteboardLibrary
// ---------------------------------------------------------------------------

export const WhiteboardLibrary: React.FC<WhiteboardLibraryProps> = ({
  locale = 'en',
  createButtonLabel: createButtonLabelProp,
  emptyStateDescription,
  emptyStateTitle: emptyStateTitleProp,
  isLoading,
  isCreateDisabled = false,
  isImportDisabled = false,
  statusBanner,
  whiteboards,
  onAssignTeacher,
  onCreateNew,
  onDelete,
  onImport,
  onImportOlf,
  onImportImages,
  onOpenPdfLibrary,
  onOpen,
  onRename,
}) => {
  const t = (key: WbStringKey, vars?: WbVars) => wbT(locale, key, vars);
  const createButtonLabel = createButtonLabelProp ?? t('library.newBoard');
  const emptyStateTitle = emptyStateTitleProp ?? t('library.empty');
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameId, setRenameId] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // Timeline sections by local calendar day (today / yesterday / older days / undated), newest first.
  // Recomputed only when the board list changes; `Date.now()` seeds "today" at that point.
  //
  // There is no separate "unassigned" section any more: the caller scopes the list to ONE population
  // before it gets here — a single teacher's boards, or the boards belonging to nobody — so every
  // board on screen already has the same answer to "whose is this", and a section splitting them
  // would either be empty or swallow the whole list.
  const sections = useMemo(() => groupWhiteboardsByDay(whiteboards, Date.now(), locale), [whiteboards, locale]);

  const handleRenameOpen = useCallback((id: string, currentTitle: string) => {
    setRenameId(id);
    setRenameValue(currentTitle);
    setRenameModalOpen(true);
  }, []);

  const handleRenameConfirm = useCallback(() => {
    if (renameId && renameValue.trim()) {
      onRename(renameId, renameValue.trim());
    }

    setRenameModalOpen(false);
    setRenameId('');
    setRenameValue('');
  }, [renameId, renameValue, onRename]);

  const handleDeleteConfirm = useCallback(() => {
    if (deleteConfirmId) {
      onDelete(deleteConfirmId);
    }

    setDeleteConfirmId(null);
  }, [deleteConfirmId, onDelete]);

  return (
    <div className='mx-auto max-w-6xl p-4 md:p-6'>
      {/* Header */}
      <div className='mb-6 flex items-center justify-between'>
        <h1 className='text-foreground text-2xl font-bold'>{t('library.title')}</h1>
        <div className='flex items-center gap-2'>
          {onImport ? (
            <Button
              className='font-medium'
              isDisabled={isImportDisabled}
              startContent={<Upload className='h-4 w-4' />}
              variant='flat'
              onPress={onImport}
            >
              {t('library.importFile')}
            </Button>
          ) : null}
          {onImportOlf ? (
            <Button
              className='font-medium'
              isDisabled={isImportDisabled}
              startContent={<FileUp className='h-4 w-4' />}
              variant='flat'
              onPress={onImportOlf}
            >
              {t('library.importOlf')}
            </Button>
          ) : null}
          {onImportImages ? (
            <Button
              className='font-medium'
              isDisabled={isImportDisabled}
              startContent={<ImageIcon className='h-4 w-4' />}
              variant='flat'
              onPress={onImportImages}
            >
              {t('library.importImages')}
            </Button>
          ) : null}
          {onOpenPdfLibrary ? (
            <Button
              className='font-medium'
              startContent={<FileText className='h-4 w-4' />}
              variant='flat'
              onPress={onOpenPdfLibrary}
            >
              {t('library.teacherPdfs')}
            </Button>
          ) : null}
          <Button
            className='font-medium'
            color='primary'
            isDisabled={isCreateDisabled}
            startContent={<Plus className='h-4 w-4' />}
            onPress={onCreateNew}
          >
            {createButtonLabel}
          </Button>
        </div>
      </div>

      {statusBanner ? <div className='mb-6'>{statusBanner}</div> : null}

      {/* Grid. The loading spinner replaces THIS region only — it used to early-return over the whole
          component, which took the reload button, the teacher picker and the status banner off screen
          exactly when a slow or stuck load is what the operator needs them for. */}
      {isLoading ? (
        <div className='flex min-h-[40vh] items-center justify-center'>
          <Spinner color='primary' label={t('library.loading')} size='lg' />
        </div>
      ) : whiteboards.length === 0 ? (
        <div className='flex flex-col items-center justify-center gap-4 py-20'>
          <p className='text-default-500 text-lg'>{emptyStateTitle}</p>
          {emptyStateDescription ? (
            <p className='text-default-400 max-w-md text-center text-sm'>{emptyStateDescription}</p>
          ) : null}
          <div className='flex items-center gap-2'>
            {onImport ? (
              <Button
                isDisabled={isImportDisabled}
                startContent={<Upload className='h-4 w-4' />}
                variant='flat'
                onPress={onImport}
              >
                {t('library.importFile')}
              </Button>
            ) : null}
            {onImportOlf ? (
              <Button
                isDisabled={isImportDisabled}
                startContent={<FileUp className='h-4 w-4' />}
                variant='flat'
                onPress={onImportOlf}
              >
                {t('library.importOlf')}
              </Button>
            ) : null}
            {onImportImages ? (
              <Button
                isDisabled={isImportDisabled}
                startContent={<ImageIcon className='h-4 w-4' />}
                variant='flat'
                onPress={onImportImages}
              >
                {t('library.importImages')}
              </Button>
            ) : null}
            <Button
              color='primary'
              isDisabled={isCreateDisabled}
              startContent={<Plus className='h-4 w-4' />}
              variant='flat'
              onPress={onCreateNew}
            >
              {createButtonLabel}
            </Button>
          </div>
        </div>
      ) : (
        <div className='space-y-8'>
          {sections.map((section) => (
            <section key={section.key}>
              {/* Timeline header: muted label + a hairline divider filling the row, matching the
                  library's default-token design language. */}
              <div className='mb-3 flex items-center gap-3'>
                <h2 className='text-default-500 whitespace-nowrap text-xs font-semibold'>{section.label}</h2>
                <div className='bg-default-200 h-px flex-1' />
              </div>
              <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4'>
                {section.whiteboards.map((wb) => (
                  <Card
                    key={wb.id}
                    className='cursor-pointer transition-shadow hover:shadow-lg'
                    isPressable
                    onPress={() => onOpen(wb.id)}
                  >
                    <CardBody className='p-0'>
                      <div className='bg-default-100 relative aspect-[4/3] w-full overflow-hidden rounded-t-lg'>
                        {wb.thumbnail ? (
                          // Thumbnails are inline base64; a teacher with hundreds of boards would
                          // otherwise decode every one of them at first paint.
                          <img
                            alt={wb.title}
                            className='h-full w-full object-cover'
                            loading='lazy'
                            src={wb.thumbnail}
                          />
                        ) : (
                          <div className='text-default-300 flex h-full w-full items-center justify-center'>
                            <span className='text-4xl'>📝</span>
                          </div>
                        )}
                      </div>
                    </CardBody>
                    <CardFooter className='flex items-center justify-between px-3 py-2'>
                      <div className='min-w-0 flex-1'>
                        <p className='text-foreground truncate text-sm font-medium'>{wb.title}</p>
                        <p className='text-default-400 text-xs'>{formatDate(wb.updatedAt, locale)}</p>
                      </div>
                      {/* Stop the menu's pointer/click from reaching the pressable Card (react-aria
                          usePress fires on pointerdown that bubbles from here) — otherwise opening the
                          menu or picking rename/delete also navigates into the board. */}
                      <div
                        role='presentation'
                        onClick={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                      >
                        <Dropdown>
                          <DropdownTrigger>
                            <Button isIconOnly className='min-w-6' size='sm' variant='light'>
                              <MoreVertical className='h-4 w-4' />
                            </Button>
                          </DropdownTrigger>
                          <DropdownMenu
                            aria-label={t('library.boardOptions')}
                            onAction={(key) => {
                              if (key === 'rename') {
                                handleRenameOpen(wb.id, wb.title);
                              } else if (key === 'delete') {
                                setDeleteConfirmId(wb.id);
                              } else if (key === 'assign') {
                                onAssignTeacher?.(wb.id);
                              }
                            }}
                          >
                            {onAssignTeacher ? (
                              <DropdownItem key='assign' startContent={<UserPlus className='h-4 w-4' />}>
                                {t('library.moveToTeacher')}
                              </DropdownItem>
                            ) : null}
                            <DropdownItem key='rename' startContent={<Pencil className='h-4 w-4' />}>
                              {t('library.rename')}
                            </DropdownItem>
                            <DropdownItem
                              key='delete'
                              className='text-danger'
                              color='danger'
                              startContent={<Trash2 className='h-4 w-4' />}
                            >
                              {t('library.delete')}
                            </DropdownItem>
                          </DropdownMenu>
                        </Dropdown>
                      </div>
                    </CardFooter>
                  </Card>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {/* Rename Modal */}
      <Modal isOpen={renameModalOpen} onClose={() => setRenameModalOpen(false)}>
        <ModalContent>
          <ModalHeader>{t('library.renameTitle')}</ModalHeader>
          <ModalBody>
            <Input
              autoFocus
              label={t('library.boardName')}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameConfirm();
              }}
            />
          </ModalBody>
          <ModalFooter>
            <Button variant='light' onPress={() => setRenameModalOpen(false)}>
              {t('library.cancel')}
            </Button>
            <Button color='primary' onPress={handleRenameConfirm}>
              {t('library.save')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* Delete Confirm Modal */}
      <Modal isOpen={!!deleteConfirmId} onClose={() => setDeleteConfirmId(null)}>
        <ModalContent>
          <ModalHeader>{t('library.deleteTitle')}</ModalHeader>
          <ModalBody>
            <p>{t('library.deleteConfirm')}</p>
          </ModalBody>
          <ModalFooter>
            <Button variant='light' onPress={() => setDeleteConfirmId(null)}>
              {t('library.cancel')}
            </Button>
            <Button color='danger' onPress={handleDeleteConfirm}>
              {t('library.delete')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
};

export default WhiteboardLibrary;
