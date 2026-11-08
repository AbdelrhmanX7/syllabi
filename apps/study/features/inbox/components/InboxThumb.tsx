import type { InboxItem } from '../types';

import { cn } from '@repo/ui';
import { FileText } from 'lucide-react';

/** The item's thumbnail (or a PDF glyph), cropped to its box. */
export function InboxThumb({ item, className }: { item: InboxItem; className?: string }) {
  if (item.kind === 'pdf' || !(item.thumbUrl ?? item.url)) {
    return (
      <div className={cn('bg-st-raised text-st-muted flex items-center justify-center', className)}>
        <FileText className='h-8 w-8' strokeWidth={1.5} />
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- signed B2 / data URLs; next/image adds nothing here
    <img
      alt={item.note ?? 'Photo from phone'}
      className={cn('bg-st-raised object-cover', className)}
      decoding='async'
      draggable={false}
      loading='lazy'
      src={item.thumbUrl ?? item.url}
    />
  );
}
