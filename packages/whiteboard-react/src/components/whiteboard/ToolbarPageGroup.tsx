import React from 'react';

import { Button, Tooltip } from '@repo/ui';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, FileText } from 'lucide-react';

import { TOOLBAR_SURFACE } from './toolbarSurfaces';
import { useWbStrings } from '../../i18n/context';

/**
 * Page navigation as one group at the end of the full-width toolbar row (`toolbarLayout='full-scroll'`):
 * ‹ prev · «n / total» (opens the page list) · next › · add page. It replaces the floating pager pill,
 * the floating add-page button and the floating page-list toggle, so nothing hovers over the page.
 * Every target is 40px — this row is driven with a finger or an S Pen.
 */
export interface ToolbarPageGroupProps {
  dir: 'ltr' | 'rtl';
  currentLabel: string;
  total: number;
  canPrev: boolean;
  canNext: boolean;
  isPageListOpen: boolean;
  overlayPortalContainer?: Element;
  onPrev: () => void;
  onNext: () => void;
  onTogglePageList: () => void;
  /** The add-page control: the blank-sheet menu where the host offers it, otherwise a plain button. */
  addControl: React.ReactNode;
  /** A side-docked bar: stack the group as a column and show the page as «n» over «/ total». */
  vertical?: boolean;
}

export const PAGE_GROUP_BUTTON_CLASS = 'h-10 w-10 min-w-10 shrink-0 rounded-xl p-0';

const ToolbarPageGroup: React.FC<ToolbarPageGroupProps> = ({
  addControl,
  canNext,
  canPrev,
  currentLabel,
  isPageListOpen,
  onNext,
  onPrev,
  onTogglePageList,
  overlayPortalContainer,
  total,
  vertical = false,
}) => {
  const { t } = useWbStrings();
  const PrevIcon = vertical ? ChevronUp : ChevronLeft;
  const NextIcon = vertical ? ChevronDown : ChevronRight;

  return (
    <div className={vertical ? 'flex flex-col items-center gap-1.5' : 'flex items-center gap-1'} data-wb-page-group>
      <Tooltip content={t('editor.prevPage')} delay={400} portalContainer={overlayPortalContainer} size='sm'>
        <Button
          aria-label={t('editor.prevPage')}
          className={PAGE_GROUP_BUTTON_CLASS}
          data-wb-page-prev
          isDisabled={!canPrev}
          isIconOnly
          style={TOOLBAR_SURFACE.idle}
          variant='flat'
          onPress={onPrev}
        >
          <PrevIcon className='h-5 w-5' />
        </Button>
      </Tooltip>
      <Tooltip content={t('pages.title')} delay={400} portalContainer={overlayPortalContainer} size='sm'>
        <Button
          aria-expanded={isPageListOpen}
          aria-label={t('pages.title')}
          className={
            vertical
              ? `${PAGE_GROUP_BUTTON_CLASS} font-semibold leading-none tabular-nums`
              : 'h-10 min-w-[4.5rem] shrink-0 gap-1.5 rounded-xl px-2.5 text-xs font-semibold tabular-nums'
          }
          data-wb-page-list-toggle
          style={TOOLBAR_SURFACE[isPageListOpen ? 'active' : 'idle']}
          variant='flat'
          onPress={onTogglePageList}
        >
          {vertical ? (
            // A key the size of the arrows: the page number over a small «/total». The Button's inner
            // span is a row, so the two lines stack in their own column.
            <span className='flex flex-col items-center gap-0.5' data-wb-page-label dir='ltr'>
              <span className='text-sm'>{currentLabel}</span>
              <span className='text-[10px] opacity-60'>/{total}</span>
            </span>
          ) : (
            <>
            <FileText className='h-4 w-4 shrink-0' />
            <span data-wb-page-label dir='ltr'>
              {currentLabel} / {total}
            </span>
            </>
          )}
        </Button>
      </Tooltip>
      <Tooltip content={t('editor.nextPage')} delay={400} portalContainer={overlayPortalContainer} size='sm'>
        <Button
          aria-label={t('editor.nextPage')}
          className={PAGE_GROUP_BUTTON_CLASS}
          data-wb-page-next
          isDisabled={!canNext}
          isIconOnly
          style={TOOLBAR_SURFACE.idle}
          variant='flat'
          onPress={onNext}
        >
          <NextIcon className='h-5 w-5' />
        </Button>
      </Tooltip>
      {addControl}
    </div>
  );
};

export default React.memo(ToolbarPageGroup);
