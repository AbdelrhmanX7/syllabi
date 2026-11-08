import type { Meta, StoryObj } from '@storybook/react-vite';
import React, { useState } from 'react';

import { Button } from '../Button';
import type { HeroUIColor, HeroUIVariant } from '../tokens';
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from './Modal';

const meta = {
  title: 'da-v2/Modal',
  component: Modal,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  args: { isOpen: false, children: null },
} satisfies Meta<typeof Modal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: () => {
    const Demo = () => {
      const [open, setOpen] = useState(false);

      return (
        <div className='clay-stage p-10'>
          <Button onPress={() => setOpen(true)}>Open</Button>
          <Modal isOpen={open} onClose={() => setOpen(false)}>
            <ModalContent>
              <ModalHeader>Confirm delete</ModalHeader>
              <ModalBody>Are you sure? This cannot be undone.</ModalBody>
              <ModalFooter>
                <Button onPress={() => setOpen(false)} variant='light'>
                  Cancel
                </Button>
                <Button color='danger' onPress={() => setOpen(false)}>
                  Delete
                </Button>
              </ModalFooter>
            </ModalContent>
          </Modal>
        </div>
      );
    };

    return <Demo />;
  },
};

/**
 * Regression card for the real footer-action layouts that appear across the
 * admin/web/teacher/accounting apps. Every card here reproduces one exact
 * combination of a `<ModalFooter className=...>` and its child
 * `<Button className=...>` widths, taken from actual call sites (call-site
 * counts in each label are the number of modals in the platform written
 * exactly this way).
 *
 * The invariant being guarded: no footer action button may extend past its
 * card's inline edge, at any viewport. That floor is enforced
 * by `min-w-fit` in Button's base class (see the long comment above
 * `baseClass` in `Button.tsx`) — NOT `shrink-0`, which is what regressed it:
 * `shrink-0` blocks the harmless shrink two `w-full` siblings need to divide
 * a row, so the pair demanded 2x the available width and the trailing
 * button walked off the edge. `min-w-fit` keeps
 * the same "never shrink below your own label" floor without blocking that
 * division. If this ever regresses, some button below will visibly clip
 * past its card border.
 */
interface FooterActionButtonSpec {
  label: string;
  className?: string;
  color?: HeroUIColor;
  variant?: HeroUIVariant;
}

interface FooterActionPattern {
  id: string;
  name: string;
  siteCount: number;
  footerClassName?: string;
  buttons: FooterActionButtonSpec[];
}

const FOOTER_ACTION_PATTERNS: FooterActionPattern[] = [
  {
    id: 'plain-2-buttons',
    name: 'plain 2 buttons, no className',
    siteCount: 80,
    buttons: [
      { label: 'Cancel', variant: 'light' },
      { label: 'Delete', color: 'danger' },
    ],
  },
  {
    id: 'wfull-pair-regression',
    name: "both w-full + footer 'flex w-full items-center gap-2' — THE regression case",
    siteCount: 16,
    footerClassName: 'flex w-full items-center gap-2',
    buttons: [
      { label: 'Cancel', className: 'w-full', variant: 'bordered' },
      { label: 'Save changes', className: 'w-full', color: 'primary' },
    ],
  },
  {
    id: 'flex1-pair',
    name: "both flex-1 + footer 'flex-row items-center'",
    siteCount: 7,
    footerClassName: 'flex-row items-center',
    buttons: [
      { label: 'Cancel', className: 'flex-1', color: 'danger', variant: 'flat' },
      { label: 'Create', className: 'flex-1', color: 'primary' },
    ],
  },
  {
    id: 'wfull-no-footer-class',
    name: 'both w-full, no footer className',
    siteCount: 6,
    buttons: [
      { label: 'Cancel', className: 'w-full', variant: 'bordered' },
      { label: 'Deactivate student', className: 'w-full', color: 'danger' },
    ],
  },
  {
    id: 'subscription-package-form',
    name: "footer 'border-primary w-full border-t-2', both w-full — subscription-package form",
    siteCount: 2,
    footerClassName: 'border-primary w-full border-t-2',
    buttons: [
      { label: 'Cancel', className: 'w-full', variant: 'bordered' },
      { label: 'Create plan', className: 'w-full', color: 'primary' },
    ],
  },
  {
    id: 'reset-exam-modal',
    name: 'w-full + w-fit — ResetExamModal',
    siteCount: 1,
    buttons: [
      { label: 'Cancel', className: 'w-full', variant: 'bordered' },
      { label: 'Reset', className: 'w-fit', color: 'warning' },
    ],
  },
  {
    id: 'whiteboard-document-modal',
    name: "4 buttons, footer 'flex flex-wrap justify-between gap-2' — WhiteboardDocumentModal",
    siteCount: 1,
    footerClassName: 'flex flex-wrap justify-between gap-2',
    buttons: [
      { label: 'Close', variant: 'light' },
      { label: 'Download PDF', variant: 'bordered', color: 'primary' },
      { label: 'Move to another teacher', variant: 'flat', color: 'secondary' },
      { label: 'Delete document permanently', color: 'danger' },
    ],
  },
  {
    id: 'three-long-labels',
    name: '3 buttons with long labels — the tightest remaining case',
    siteCount: 2,
    buttons: [
      { label: 'Cancel', variant: 'light' },
      { label: 'Save as draft and send for review', variant: 'bordered', color: 'primary' },
      { label: 'Publish the weekly question now', color: 'primary' },
    ],
  },
];

// The real <Modal> portals to document.body behind a backdrop, so several
// instances can never be stacked side by side for a visual/measurement
// comparison. This story renders the card CHROME inline instead — a plain
// div copying the class string off Modal.tsx's inner motion.div — wrapping
// the real ModalContent/ModalHeader/ModalBody/ModalFooter, which are plain
// divs with no portal behavior and work standalone.
const CARD_CHROME = 'bg-paper relative flex w-full max-w-[920px] flex-col [border:2.5px_solid_var(--line)]';

export const FooterActionWidths: Story = {
  parameters: { layout: 'fullscreen' },
  render: () => (
    <div className='flex flex-col gap-8 p-8'>
      {FOOTER_ACTION_PATTERNS.map((pattern) => (
        <div key={pattern.id} className='flex flex-col gap-2'>
          <p className='text-ink/70 text-sm font-bold'>
            {pattern.name}{' '}
            <span className='text-ink/70 font-normal'>
              ({pattern.siteCount} call site{pattern.siteCount === 1 ? '' : 's'})
            </span>
          </p>
          <div className={CARD_CHROME} data-pattern={pattern.id}>
            <ModalContent>
              <ModalHeader>{pattern.name}</ModalHeader>
              <ModalBody>Content preview.</ModalBody>
              <ModalFooter className={pattern.footerClassName} data-footer={pattern.id}>
                {pattern.buttons.map((button) => (
                  <Button key={button.label} className={button.className} color={button.color} variant={button.variant}>
                    {button.label}
                  </Button>
                ))}
              </ModalFooter>
            </ModalContent>
          </div>
        </div>
      ))}
    </div>
  ),
};
