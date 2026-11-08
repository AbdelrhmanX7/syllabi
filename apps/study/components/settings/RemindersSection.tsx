import type { DueLead, Repeat } from '@/lib/reminders/plan';

import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { DateTimePicker } from '@repo/ui';

import { ConfirmSheet } from '@/components/ui/ConfirmSheet';
import { ActionButton, FilterChip, INPUT_CLASS, SectionTitle, Surface } from '@/components/ui/primitives';
import { ToggleRow } from '@/components/ui/Toggle';
import { remindersSupported, requestPermission } from '@/lib/reminders/notify';
import { DUE_LEADS } from '@/lib/reminders/plan';
import { getReminderSettings, MAX_CUSTOM, saveReminderSettings, useReminderSettings } from '@/lib/reminders/settings';
import { isTauriAndroid } from '@/lib/platform/runtime';

const LEAD_LABEL: Record<string, string> = {
  evening: 'Evening before',
  '1440': '1 day before',
  '180': '3 hours before',
  '60': '1 hour before',
};

const REPEAT_LABEL: Record<Repeat, string> = { none: 'Once', daily: 'Every day', weekly: 'Every week' };

const pad = (n: number) => String(n).padStart(2, '0');
/** `YYYY-MM-DDTHH:mm` for a local Date (what the date-time field shows). */
const localValue = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

const whenText = (at: string) =>
  new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function AddReminder({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState('');
  const [at, setAt] = useState(() => {
    const next = new Date(Date.now() + 60 * 60_000);

    next.setMinutes(0, 0, 0);

    return localValue(next);
  });
  const [repeat, setRepeat] = useState<Repeat>('none');
  const ok = text.trim().length > 0 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at);

  return (
    <div className='flex flex-col gap-3 py-3'>
      <input
        aria-label='Reminder'
        className={INPUT_CLASS}
        maxLength={120}
        placeholder='What to remind you about'
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <DateTimePicker
        aria-label='When'
        className='sm:max-w-md'
        min={localValue(new Date()).slice(0, 10)}
        value={at}
        onChange={setAt}
      />
      <div aria-label='Repeat' className='flex flex-wrap gap-2' role='group'>
        {(Object.keys(REPEAT_LABEL) as Repeat[]).map((value) => (
          <FilterChip key={value} active={repeat === value} onClick={() => setRepeat(value)}>
            {REPEAT_LABEL[value]}
          </FilterChip>
        ))}
      </div>
      <div className='flex gap-3'>
        <ActionButton
          disabled={!ok}
          variant='primary'
          onClick={() => {
            // The latest list at click time, not a render-time copy.
            const { custom } = getReminderSettings();

            saveReminderSettings({
              custom: [
                ...custom,
                { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text: text.trim(), at, repeat },
              ].slice(-MAX_CUSTOM),
            });
            onDone();
          }}
        >
          Add
        </ActionButton>
        <ActionButton variant='ghost' onClick={onDone}>
          Cancel
        </ActionButton>
      </div>
    </div>
  );
}

/** Settings → Reminders: deadlines, flashcards and the student's own reminders, per device. */
export function RemindersSection() {
  const settings = useReminderSettings();
  const [supported, setSupported] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const native = supported && isTauriAndroid();

  useEffect(() => setSupported(remindersSupported()), []);

  const toggleLead = (lead: DueLead) => {
    const has = settings.leads.includes(lead);

    // Keep at least one: no lead at all would silently mean «no deadline reminders».
    if (has && settings.leads.length === 1) return;
    saveReminderSettings({ leads: has ? settings.leads.filter((l) => l !== lead) : [...settings.leads, lead] });
  };
  const target = settings.custom.find((r) => r.id === removing);

  return (
    <Surface className='p-5'>
      <SectionTitle>Reminders</SectionTitle>
      <div className='divide-st-line divide-y'>
        <ToggleRow
          checked={settings.enabled}
          disabled={!supported || busy}
          hint={
            !supported
              ? "This browser can't show reminders."
              : blocked
                ? 'Notifications are blocked. Allow them for Syllabi in your device settings, then try again.'
                : native
                  ? 'A heads-up before work is due and when flashcards are ready, even with the app closed.'
                  : 'A heads-up before work is due and when flashcards are ready, while this tab is open.'
          }
          label='Reminders'
          onChange={async (on) => {
            if (!on) {
              saveReminderSettings({ enabled: false });

              return;
            }
            setBusy(true);
            const granted = await requestPermission();

            setBusy(false);
            setBlocked(!granted);
            if (granted) saveReminderSettings({ enabled: true });
          }}
        />
        {settings.enabled && (
          <>
            <ToggleRow
              checked={settings.due}
              hint="Assignments and quizzes you haven't handed in."
              label='Due dates'
              onChange={(due) => saveReminderSettings({ due })}
            />
            {settings.due && (
              <div className='flex flex-col gap-2 py-3'>
                <p className='text-st-fg text-sm font-medium'>How early</p>
                <div aria-label='How early' className='flex flex-wrap gap-2' role='group'>
                  {DUE_LEADS.map((lead) => (
                    <FilterChip key={lead} active={settings.leads.includes(lead)} onClick={() => toggleLead(lead)}>
                      {LEAD_LABEL[String(lead)]}
                    </FilterChip>
                  ))}
                </div>
              </div>
            )}
            <ToggleRow
              checked={settings.flashcards}
              hint='Once a day at 5 PM when cards are ready to review.'
              label='Flashcards'
              onChange={(flashcards) => saveReminderSettings({ flashcards })}
            />
            <div className='flex flex-col py-3'>
              <div className='flex items-center justify-between gap-3'>
                <p className='text-st-fg text-sm font-medium'>Your reminders</p>
                {!adding && settings.custom.length < MAX_CUSTOM && (
                  <ActionButton className='min-h-9 px-3 text-xs' variant='ghost' onClick={() => setAdding(true)}>
                    <Plus className='h-3.5 w-3.5' /> Add
                  </ActionButton>
                )}
              </div>
              {settings.custom.length === 0 && !adding && (
                <p className='text-st-muted text-xs'>Nothing here yet.</p>
              )}
              {settings.custom.length > 0 && (
                <ul className='mt-1 flex flex-col gap-1'>
                  {settings.custom.map((r) => (
                    <li key={r.id} className='flex min-h-11 items-center gap-3' data-own-reminder={r.id}>
                      <span className='text-st-fg min-w-[5rem] flex-1 truncate text-sm' title={r.text}>
                        {r.text}
                      </span>
                      <span className='text-st-muted shrink-0 text-xs tabular-nums'>
                        {whenText(r.at)}
                        {r.repeat === 'daily' && ' · Daily'}
                        {r.repeat === 'weekly' && ' · Weekly'}
                      </span>
                      <ActionButton
                        aria-label={`Delete «${r.text}»`}
                        className='min-h-9 shrink-0 px-2'
                        variant='ghost'
                        onClick={() => setRemoving(r.id)}
                      >
                        <Trash2 className='h-4 w-4' />
                      </ActionButton>
                    </li>
                  ))}
                </ul>
              )}
              {adding && <AddReminder onDone={() => setAdding(false)} />}
            </div>
          </>
        )}
      </div>
      {target && (
        <ConfirmSheet
          danger
          confirmLabel='Delete'
          title='Delete this reminder?'
          onClose={() => setRemoving(null)}
          onConfirm={() => saveReminderSettings({ custom: settings.custom.filter((r) => r.id !== target.id) })}
        >
          «{target.text}» won&apos;t remind you again.
        </ConfirmSheet>
      )}
    </Surface>
  );
}
