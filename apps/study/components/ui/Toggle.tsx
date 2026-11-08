import { cn } from '@repo/ui';

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
        'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50',
        checked ? 'border-st-accent bg-st-accent' : 'border-st-line bg-st-raised',
      )}
      disabled={disabled}
      role='switch'
      type='button'
      onClick={() => onChange(!checked)}
    >
      <span
        className={cn(
          'absolute left-0.5 h-5 w-5 rounded-full border-2 border-st-clay-edge bg-st-surface transition-transform',
          checked ? 'translate-x-5' : 'translate-x-0',
        )}
      />
    </button>
  );
}
