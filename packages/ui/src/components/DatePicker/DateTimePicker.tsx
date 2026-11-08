import React from 'react';

import { cn } from '../../cn';
import type { HeroUISize } from '../tokens';
import { DatePicker } from './DatePicker';
import { joinDateTime, splitDateTime, todayISO } from './dateMath';
import { TimePicker } from './TimePicker';

/**
 * DateTimePicker — a DatePicker and a TimePicker side by side (stacked under 640px). Value is a local
 * 'YYYY-MM-DDTHH:mm' ('' = not set), the same string a native `<input type='datetime-local'>` gives.
 *
 * It always hands back a full value: pick a date with no time yet and the time becomes
 * `defaultTime` (9:00 AM); pick a time with no date and the date becomes today.
 */
export interface DateTimePickerProps {
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  /** Time used when a date is picked first. Default '09:00'. */
  defaultTime?: string;
  minuteStep?: number;
  isClearable?: boolean;
  isDisabled?: boolean;
  size?: HeroUISize;
  /** Accessible name, e.g. "When"; the two fields are named "When, date" and "When, time". */
  'aria-label'?: string;
  name?: string;
  className?: string;
}

export function DateTimePicker({
  value,
  onChange,
  min,
  max,
  defaultTime = '09:00',
  minuteStep,
  isClearable,
  isDisabled,
  size = 'md',
  'aria-label': ariaLabel = 'Date and time',
  name,
  className,
}: DateTimePickerProps) {
  const { date, time } = splitDateTime(value);
  const minDate = min ? min.slice(0, 10) : undefined;
  const maxDate = max ? max.slice(0, 10) : undefined;

  return (
    <div className={cn('flex w-full flex-col gap-3 sm:flex-row', className)}>
      <div className='min-w-0 sm:flex-[3]'>
        <DatePicker
          aria-label={`${ariaLabel}, date`}
          isClearable={isClearable}
          isDisabled={isDisabled}
          max={maxDate}
          min={minDate}
          size={size}
          value={date}
          onChange={(next) => onChange(next ? joinDateTime(next, time || defaultTime) : '')}
        />
      </div>
      <div className='min-w-0 sm:flex-[2]'>
        <TimePicker
          aria-label={`${ariaLabel}, time`}
          isDisabled={isDisabled}
          minuteStep={minuteStep}
          size={size}
          value={time}
          onChange={(next) => onChange(next ? joinDateTime(date || todayISO(), next) : '')}
        />
      </div>
      {name ? <input name={name} type='hidden' value={joinDateTime(date, time)} /> : null}
    </div>
  );
}

DateTimePicker.displayName = 'DateTimePicker';
