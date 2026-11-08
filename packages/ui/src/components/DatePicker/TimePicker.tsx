import React from 'react';

import { Button } from '../Button';
import { INK_MUTED } from '../tokens';
import type { HeroUISize } from '../tokens';
import { formatTime, formatTime12, from12h, minuteOptions, parseTime, to12h } from './dateMath';
import { Cell, ClockIcon, PickerShell, useFocusOnOpen, useIsPhone } from './pickerParts';

/**
 * TimePicker — our own time field. Value is 24h 'HH:mm' ('' = not set), the same string a native
 * `<input type='time'>` gives; the field shows "7:00 PM".
 *
 *   <TimePicker aria-label='Starts' value={start} onChange={setStart} />
 *
 * The panel is three button grids (AM/PM, hour 1–12, minute 00–55 in 5s plus the current minute if
 * it is off-step) — big enough for a finger on a tablet and easy with a pen. Each tap updates the
 * value; Done or a tap outside closes.
 */
export interface TimePickerProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Minute grid step. Default 5. */
  minuteStep?: number;
  isClearable?: boolean;
  isDisabled?: boolean;
  size?: HeroUISize;
  /** Accessible name; the chosen time is read out after it. Defaults to "Time". */
  'aria-label'?: string;
  id?: string;
  name?: string;
  className?: string;
  fullWidth?: boolean;
}

export function TimePicker({
  value,
  onChange,
  placeholder = 'Pick a time',
  minuteStep = 5,
  isClearable,
  isDisabled,
  size = 'md',
  'aria-label': ariaLabel,
  id,
  name,
  className,
  fullWidth = true,
}: TimePickerProps) {
  const [open, setOpen] = React.useState(false);
  const parsed = parseTime(value);
  const valid = parsed ? formatTime(parsed) : '';

  return (
    <>
      <PickerShell
        className={className}
        display={formatTime12(valid)}
        fullWidth={fullWidth}
        icon={ClockIcon}
        id={id}
        isDisabled={isDisabled}
        isOpen={open}
        label={ariaLabel ?? 'Time'}
        panelClassName='w-[312px]'
        panelHeight={TIME_PANEL_HEIGHT}
        placeholder={placeholder}
        size={size}
        onOpenChange={setOpen}
      >
        <TimePanel
          isClearable={isClearable}
          minuteStep={minuteStep}
          value={valid}
          onChange={onChange}
          onDone={() => setOpen(false)}
        />
      </PickerShell>
      {name ? <input name={name} type='hidden' value={valid} /> : null}
    </>
  );
}

TimePicker.displayName = 'TimePicker';

/** Rough open height of the time panel in a Popover (measured: see DatePicker for why it matters). */
const TIME_PANEL_HEIGHT = 356;

const HOURS = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

interface TimePanelProps {
  value: string;
  minuteStep: number;
  isClearable?: boolean;
  onChange: (value: string) => void;
  onDone: () => void;
}

function TimePanel({ value, minuteStep, isClearable, onChange, onDone }: TimePanelProps) {
  const comfy = useIsPhone();
  const parsed = parseTime(value);
  const current = parsed ? to12h(parsed.hours) : null;
  // Before anything is picked there is no value to read AM/PM from, so remember the choice here.
  const [pmDraft, setPmDraft] = React.useState(false);
  const pm = current ? current.pm : pmDraft;
  const rootRef = React.useRef<HTMLDivElement>(null);

  useFocusOnOpen(rootRef, '[data-start="true"]');

  const emit = (hour: number, minutes: number, isPm: boolean) =>
    onChange(formatTime({ hours: from12h(hour, isPm), minutes }));

  const setPm = (isPm: boolean) => {
    setPmDraft(isPm);
    if (current && parsed) emit(current.hour, parsed.minutes, isPm);
  };

  const minutes = minuteOptions(minuteStep, parsed?.minutes);
  const sectionLabel = 'text-[12px] font-bold ps-1';

  return (
    <div ref={rootRef} className='flex w-full flex-col gap-2'>
      <div aria-label='AM or PM' className='grid grid-cols-2 gap-1' role='group'>
        {[false, true].map((isPm) => (
          <Cell
            key={isPm ? 'pm' : 'am'}
            aria-pressed={pm === isPm}
            comfy={comfy}
            data-start={!current && !isPm ? 'true' : undefined}
            selected={pm === isPm}
            onClick={() => setPm(isPm)}
          >
            {isPm ? 'PM' : 'AM'}
          </Cell>
        ))}
      </div>

      <span className={sectionLabel} style={{ color: INK_MUTED }}>
        Hour
      </span>
      <div aria-label='Hour' className='grid grid-cols-6 gap-1' role='group'>
        {HOURS.map((hour) => (
          <Cell
            key={hour}
            aria-pressed={current?.hour === hour}
            comfy={comfy}
            data-start={current?.hour === hour ? 'true' : undefined}
            selected={current?.hour === hour}
            onClick={() => emit(hour, parsed?.minutes ?? 0, pm)}
          >
            {hour}
          </Cell>
        ))}
      </div>

      <span className={sectionLabel} style={{ color: INK_MUTED }}>
        Minute
      </span>
      <div aria-label='Minute' className='grid grid-cols-6 gap-1' role='group'>
        {minutes.map((m) => (
          <Cell
            key={m}
            aria-label={`${String(m).padStart(2, '0')} minutes`}
            aria-pressed={parsed?.minutes === m}
            comfy={comfy}
            selected={parsed?.minutes === m}
            onClick={() => emit(current?.hour ?? 12, m, pm)}
          >
            :{String(m).padStart(2, '0')}
          </Cell>
        ))}
      </div>

      <div className='flex items-center gap-2 pt-1'>
        {isClearable && value ? (
          <Button size='sm' variant='light' onPress={() => onChange('')}>
            Clear
          </Button>
        ) : null}
        <Button className='ms-auto' color='primary' size='sm' onPress={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
