import React from 'react';

import { Button } from '../Button';
import { INK_MUTED } from '../tokens';
import type { HeroUISize } from '../tokens';
import {
  addDays,
  addMonths,
  formatDateLong,
  formatDateShort,
  formatMonthTitle,
  isOutOfRange,
  monthGrid,
  moveByKey,
  parseDate,
  startOfMonth,
  todayISO,
  WEEKDAYS_LONG,
  WEEKDAYS_SHORT,
} from './dateMath';
import {
  CalendarIcon,
  Cell,
  ChevronLeft,
  ChevronRight,
  PickerShell,
  useFocusOnOpen,
  useIsPhone,
} from './pickerParts';

/**
 * DatePicker — our own date field. Value is a local calendar date 'YYYY-MM-DD' ('' = not set),
 * the same string a native `<input type='date'>` gives, so it drops in for one.
 *
 *   <DatePicker aria-label='Exam date' value={date} onChange={setDate} isClearable />
 *
 * Opens a month calendar in a Popover, or a bottom sheet under 640px. Arrow keys move a day/week,
 * PageUp/PageDown a month, Home/End the week, Enter picks, Esc closes.
 */
export interface DatePickerProps {
  value: string;
  onChange: (value: string) => void;
  /** Earliest pickable day, 'YYYY-MM-DD'. */
  min?: string;
  /** Latest pickable day, 'YYYY-MM-DD'. */
  max?: string;
  placeholder?: string;
  /** Show a "Clear" choice in the panel. */
  isClearable?: boolean;
  isDisabled?: boolean;
  size?: HeroUISize;
  /** Accessible name; the chosen date is read out after it. Defaults to "Date". */
  'aria-label'?: string;
  id?: string;
  /** Adds a hidden input so the value posts with a form. */
  name?: string;
  className?: string;
  fullWidth?: boolean;
}

export function DatePicker({
  value,
  onChange,
  min,
  max,
  placeholder = 'Pick a date',
  isClearable,
  isDisabled,
  size = 'md',
  'aria-label': ariaLabel,
  id,
  name,
  className,
  fullWidth = true,
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false);
  const valid = parseDate(value) ? value : '';
  const label = ariaLabel ?? 'Date';

  return (
    <>
      <PickerShell
        className={className}
        display={valid ? formatDateShort(valid) : ''}
        fullWidth={fullWidth}
        icon={CalendarIcon}
        id={id}
        isDisabled={isDisabled}
        isOpen={open}
        label={label}
        panelClassName='w-[336px]'
        panelHeight={412}
        placeholder={placeholder}
        size={size}
        onOpenChange={setOpen}
      >
        <Calendar
          isClearable={isClearable}
          max={max}
          min={min}
          value={valid}
          onPick={(next) => {
            onChange(next);
            setOpen(false);
          }}
        />
      </PickerShell>
      {name ? <input name={name} type='hidden' value={valid} /> : null}
    </>
  );
}

DatePicker.displayName = 'DatePicker';

interface CalendarProps {
  value: string;
  min?: string;
  max?: string;
  isClearable?: boolean;
  onPick: (value: string) => void;
}

function clampInto(iso: string, min?: string, max?: string) {
  if (min && parseDate(min) && iso < min) return min;
  if (max && parseDate(max) && iso > max) return max;

  return iso;
}

function Calendar({ value, min, max, isClearable, onPick }: CalendarProps) {
  const comfy = useIsPhone();
  const today = todayISO();
  const tomorrow = addDays(today, 1);
  const [focused, setFocused] = React.useState(() => value || clampInto(today, min, max));
  const [view, setView] = React.useState(() => startOfMonth(value || clampInto(today, min, max)));
  const rootRef = React.useRef<HTMLDivElement>(null);
  const keyMoved = React.useRef(false);
  const titleId = React.useId();

  useFocusOnOpen(rootRef, '[data-roving="true"]');

  // After an arrow key, follow the roving tab stop with real focus.
  React.useEffect(() => {
    if (!keyMoved.current) return;
    keyMoved.current = false;
    rootRef.current?.querySelector<HTMLElement>(`[data-iso="${focused}"]`)?.focus({ preventScroll: true });
  }, [focused, view]);

  const viewParts = parseDate(view)!;
  const days = monthGrid(viewParts.year, viewParts.month);
  const weeks = [0, 1, 2, 3, 4, 5].map((w) => days.slice(w * 7, w * 7 + 7));
  const monthPrefix = view.slice(0, 7);

  const shiftMonth = (by: number) => {
    setView((v) => addMonths(v, by));
    setFocused((f) => addMonths(f, by));
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const next = moveByKey(focused, event.key, event.shiftKey);

    if (!next) return;
    event.preventDefault();
    keyMoved.current = true;
    setFocused(next);
    if (next.slice(0, 7) !== monthPrefix) setView(startOfMonth(next));
  };

  return (
    <div ref={rootRef} className='flex w-full flex-col gap-2'>
      <div className='flex items-center justify-between gap-2'>
        <span aria-live='polite' className='ps-1 text-[15px] font-extrabold' id={titleId}>
          {formatMonthTitle(viewParts.year, viewParts.month)}
        </span>
        <div className='flex items-center gap-1'>
          <Button isIconOnly aria-label='Previous month' size='sm' variant='light' onPress={() => shiftMonth(-1)}>
            {ChevronLeft}
          </Button>
          <Button isIconOnly aria-label='Next month' size='sm' variant='light' onPress={() => shiftMonth(1)}>
            {ChevronRight}
          </Button>
        </div>
      </div>

      <div aria-labelledby={titleId} className='flex flex-col gap-1' role='grid' onKeyDown={onKeyDown}>
        <div className='grid grid-cols-7 gap-1' role='row'>
          {WEEKDAYS_SHORT.map((d, i) => (
            <abbr
              key={d}
              className='flex h-6 items-center justify-center text-[12px] font-bold no-underline'
              role='columnheader'
              style={{ color: INK_MUTED }}
              title={WEEKDAYS_LONG[i]}
            >
              {d}
            </abbr>
          ))}
        </div>
        {weeks.map((week) => (
          <div key={week[0]} className='grid grid-cols-7 gap-1' role='row'>
            {week.map((iso) => {
              const selected = iso === value;
              const off = isOutOfRange(iso, min, max);

              return (
                <div key={iso} role='gridcell' aria-selected={selected}>
                  <Cell
                    aria-current={iso === today ? 'date' : undefined}
                    aria-label={formatDateLong(iso)}
                    comfy={comfy}
                    data-iso={iso}
                    data-roving={iso === focused ? 'true' : undefined}
                    muted={!iso.startsWith(monthPrefix)}
                    ringed={iso === today}
                    selected={selected}
                    tabIndex={iso === focused ? 0 : -1}
                    unavailable={off}
                    onClick={() => onPick(iso)}
                    onFocus={() => setFocused(iso)}
                  >
                    {Number(iso.slice(8))}
                  </Cell>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className='flex flex-wrap items-center gap-2 pt-1'>
        <Button isDisabled={isOutOfRange(today, min, max)} size='sm' variant='flat' onPress={() => onPick(today)}>
          Today
        </Button>
        <Button isDisabled={isOutOfRange(tomorrow, min, max)} size='sm' variant='flat' onPress={() => onPick(tomorrow)}>
          Tomorrow
        </Button>
        {isClearable && value ? (
          <Button className='ms-auto' size='sm' variant='light' onPress={() => onPick('')}>
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}
