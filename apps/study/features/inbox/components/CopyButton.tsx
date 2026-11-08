import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

import { ActionButton } from '@/components/ui/primitives';

export function CopyButton({ text, label = 'Copy', disabled }: { text: string; label?: string; disabled?: boolean }) {
  const [copied, setCopied] = useState(false);

  return (
    <ActionButton
      className='min-h-9 shrink-0 px-3 text-xs'
      disabled={disabled}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_500);
        } catch {
          // clipboard blocked — the text is visible to select
        }
      }}
    >
      {copied ? <Check className='text-st-ok h-3.5 w-3.5' /> : <Copy className='h-3.5 w-3.5' />}{' '}
      {copied ? 'Copied' : label}
    </ActionButton>
  );
}
