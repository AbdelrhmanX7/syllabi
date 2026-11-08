import React, { useState } from 'react';

import { Button, Popover, PopoverContent, PopoverTrigger } from '@repo/ui';
import { ArrowDownToLine, BetweenHorizontalEnd, FilePlus2, Trash2 } from 'lucide-react';

import { useWbStrings } from '../../i18n/context';

/**
 * The pager's «blank page» menu (`WhiteboardEditor.allowInsertBlankPages`): insert an empty writing
 * sheet after the page in view or at the end, and delete the sheet in view (inserted sheets only —
 * a PDF page is never offered). Deleting always asks first; the question says so when the sheet has
 * ink. Rows are 48px tall: this is driven with a finger or an S Pen on a tablet.
 */
export interface BlankPageMenuProps {
  /** Label of the page in view («3», «3a»). */
  currentLabel: string;
  /** The page in view is an inserted sheet (so it can be deleted). */
  canDelete: boolean;
  overlayPortalContainer?: Element;
  onInsertAfter: () => void;
  onInsertAtEnd: () => void;
  /** Flushes and answers whether the sheet in view carries ink (asked when the confirm opens). */
  hasInk: () => boolean;
  onDelete: () => void;
  /** Where the menu opens from its trigger. Default `'top-end'` (the floating pager at the bottom). */
  placement?: 'top-end' | 'bottom-end';
  /** Replaces the trigger's default citrine floating-button look (e.g. inside the toolbar row). */
  triggerClassName?: string;
  triggerStyle?: React.CSSProperties;
}

const ROW_CLASS = 'text-ink h-12 w-full justify-start gap-3 rounded-xl px-3 text-sm font-semibold';

const BlankPageMenu: React.FC<BlankPageMenuProps> = ({
  canDelete,
  currentLabel,
  hasInk,
  onDelete,
  onInsertAfter,
  onInsertAtEnd,
  overlayPortalContainer,
  placement = 'top-end',
  triggerClassName = 'border-sk border-ink bg-citrine text-ink shadow-sk h-11 min-w-11',
  triggerStyle,
}) => {
  const { t } = useWbStrings();
  const [isOpen, setIsOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | { ink: boolean }>(null);

  const close = () => {
    setIsOpen(false);
    setConfirm(null);
  };

  return (
    <Popover
      isOpen={isOpen}
      placement={placement}
      portalContainer={overlayPortalContainer}
      onOpenChange={(open) => {
        setIsOpen(open);
        if (!open) setConfirm(null);
      }}
    >
      <PopoverTrigger>
        <Button
          aria-label={t('editor.sheet.menu')}
          className={triggerClassName}
          data-wb-sheet-menu
          isIconOnly
          style={triggerStyle}
          variant='flat'
        >
          <FilePlus2 className='h-5 w-5' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-72 p-2'>
        {confirm ? (
          <div className='flex w-full flex-col gap-3 p-2' data-wb-sheet-confirm>
            <p className='text-ink text-sm font-semibold'>
              {t(confirm.ink ? 'editor.sheet.confirmInk' : 'editor.sheet.confirmEmpty', { page: currentLabel })}
            </p>
            <div className='flex gap-2'>
              <Button className='h-11 flex-1' variant='flat' onPress={() => setConfirm(null)}>
                {t('editor.sheet.cancel')}
              </Button>
              <Button
                className='h-11 flex-1'
                color='danger'
                data-wb-sheet-confirm-delete
                onPress={() => {
                  close();
                  onDelete();
                }}
              >
                {t('editor.sheet.confirmDelete')}
              </Button>
            </div>
          </div>
        ) : (
          <div className='flex w-full flex-col gap-1'>
            <Button
              className={ROW_CLASS}
              data-wb-sheet-insert-after
              variant='light'
              onPress={() => {
                close();
                onInsertAfter();
              }}
            >
              <BetweenHorizontalEnd aria-hidden className='h-5 w-5 shrink-0' />
              {t('editor.sheet.insertAfter', { page: currentLabel })}
            </Button>
            <Button
              className={ROW_CLASS}
              data-wb-sheet-insert-end
              variant='light'
              onPress={() => {
                close();
                onInsertAtEnd();
              }}
            >
              <ArrowDownToLine className='h-5 w-5 shrink-0' />
              {t('editor.sheet.insertAtEnd')}
            </Button>
            {canDelete && (
              <Button
                className={`${ROW_CLASS} text-danger`}
                data-wb-sheet-delete
                variant='light'
                onPress={() => setConfirm({ ink: hasInk() })}
              >
                <Trash2 className='h-5 w-5 shrink-0' />
                {t('editor.sheet.delete', { page: currentLabel })}
              </Button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};

export default BlankPageMenu;
