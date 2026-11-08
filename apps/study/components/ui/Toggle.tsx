import { cn } from '@repo/ui';

/** The app's on/off switch (clay: an edged track, a knob with a lip). Every boolean setting uses this. */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={cn(
        'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border-2 transition-colors disabled:opacity-50',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-st-accent',
        checked ? 'border-st-accent-lip bg-st-accent' : 'border-st-clay-edge bg-st-raised',
      )}
      disabled={disabled}
      role='switch'
      type='button'
      onClick={() => onChange(!checked)}
    >
      <span
        className={cn(
          'border-st-clay-edge bg-st-surface absolute left-0.5 h-5 w-5 rounded-full border-2 shadow-[0_2px_0_rgb(var(--st-clay-edge))] transition-transform',
          checked ? 'translate-x-5' : 'translate-x-0',
        )}
      />
    </button>
  );
}

/** A settings row: label + one-line hint on the left, the Toggle on the right. */
export function ToggleRow({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div className='flex min-h-11 items-center justify-between gap-3 py-3'>
      <span className='min-w-0'>
        <span className='text-st-fg block text-sm font-medium'>{label}</span>
        {hint && <span className='text-st-muted block text-xs'>{hint}</span>}
      </span>
      <Toggle checked={checked} disabled={disabled} label={label} onChange={onChange} />
    </div>
  );
}
