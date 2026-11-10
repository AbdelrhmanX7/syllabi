import React from 'react';

import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@repo/ui';
import { X } from 'lucide-react';

import { useWbStrings } from '../../i18n/context';

/**
 * The one «delete this page?» dialog of the board: the page manager's delete and the blank-page menu's
 * delete both open it. It names the page and says what goes with it (writing, a PDF page). The red button is the
 * only footer action; the X (or tapping outside) cancels.
 */
export interface ConfirmDeletePageModalProps {
  /** `null` = closed. */
  target: { label: string; content: 'blank' | 'ink' | 'pdf' } | null;
  portalContainer?: Element;
  onCancel: () => void;
  onConfirm: () => void;
}

const ConfirmDeletePageModal: React.FC<ConfirmDeletePageModalProps> = ({ onCancel, onConfirm, portalContainer, target }) => {
  const { t } = useWbStrings();

  return (
    <Modal isOpen={target !== null} placement='center' portalContainer={portalContainer} size='sm' onClose={onCancel}>
      <ModalContent>
        <ModalHeader className='flex-row items-center gap-2 text-start'>
          <span className='min-w-0 flex-1' data-wb-delete-page-title>
            {t('editor.sheet.confirmTitle', { page: target?.label ?? '' })}
          </span>
          <Button isIconOnly aria-label={t('editor.sheet.close')} size='sm' variant='light' onPress={onCancel}>
            <X className='h-5 w-5' />
          </Button>
        </ModalHeader>
        <ModalBody>
          <p className='text-sm'>
            {t(target?.content === 'pdf' ? 'editor.sheet.confirmPdf' : target?.content === 'ink' ? 'editor.sheet.confirmInk' : 'editor.sheet.confirmEmpty')}
          </p>
        </ModalBody>
        <ModalFooter>
          <Button color='danger' data-wb-delete-page-confirm onPress={onConfirm}>
            {t('editor.sheet.confirmDelete')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};

export default ConfirmDeletePageModal;
