import type { Provenance } from '../lib/provenance';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Layers } from 'lucide-react';
import Link from 'next/link';

import { chipText, groupSources, hasProvenance, modelLabel } from '../lib/provenance';

/**
 * «Built from»: one chip per source kind with its count, opening to the titles (an item the app has
 * links to it), and the model in small muted type. Renders nothing for old results without either.
 */
export function BuiltFrom({ provenance, className }: { provenance?: Provenance | null; className?: string }) {
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => groupSources(provenance?.sources ?? []), [provenance?.sources]);
  const model = modelLabel(provenance?.model);

  if (!provenance || !hasProvenance(provenance)) return null;

  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ''}`}>
      <div className='flex flex-wrap items-center gap-1.5 text-xs'>
        {groups.length > 0 ? (
          <button
            aria-expanded={open}
            className='text-st-muted hover:text-st-fg inline-flex items-center gap-1 font-medium'
            type='button'
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <ChevronDown className='h-3.5 w-3.5' /> : <ChevronRight className='h-3.5 w-3.5' />}
            <Layers className='h-3.5 w-3.5' /> Built from
          </button>
        ) : (
          <span className='text-st-muted inline-flex items-center gap-1 font-medium'>
            <Layers className='h-3.5 w-3.5' /> Built by
          </span>
        )}
        {groups.map((group) => (
          <button
            key={group.kind}
            className='border-st-line bg-st-raised text-st-fg hover:border-st-accent/50 rounded-full border px-2 py-0.5 leading-5'
            type='button'
            onClick={() => setOpen(true)}
          >
            {chipText(group)}
          </button>
        ))}
        {model && <span className='text-st-muted ml-auto text-[11px]'>{model}</span>}
      </div>
      {open && groups.length > 0 && (
        <div className='rounded-st border-st-line bg-st-bg/60 flex flex-col gap-2 border px-3 py-2'>
          {groups.map((group) => (
            <div key={group.kind}>
              <p className='text-st-muted text-[11px] font-medium uppercase tracking-wide'>{group.label}</p>
              <ul className='mt-0.5 flex flex-col gap-0.5'>
                {group.items.map((item, index) => (
                  <li key={`${item.itemId ?? item.title}-${index}`} className='text-st-fg truncate text-xs'>
                    {item.itemId ? (
                      <Link
                        className='text-st-accent hover:underline'
                        href={`/item/?id=${encodeURIComponent(item.itemId)}`}
                      >
                        {item.title}
                      </Link>
                    ) : (
                      item.title
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
