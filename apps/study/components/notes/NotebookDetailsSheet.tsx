import type { MathToolsMode, MetaField, Page } from '@/lib/api/types';

import { useState } from 'react';
import { Chip, Tab, Tabs } from '@repo/ui';
import { Plus, Sparkles } from 'lucide-react';

import { NoteCover } from '@/components/notes/NoteCover';
import { ConfirmSheet } from '@/components/ui/ConfirmSheet';
import { ActionButton, ErrorNote, INPUT_CLASS } from '@/components/ui/primitives';
import { Sheet } from '@/features/inbox/components/Sheet';
import { describePage, patchPage } from '@/lib/api/endpoints';
import { describeError } from '@/lib/api/errors';
import { adoptDescribed } from '@/lib/notebooks/auto-describe';
import { editedOf, mathToolsOn, META_DESCRIPTION_MAX, META_TAGS_MAX, normalizeTag } from '@/lib/notebooks/page-meta';
import { rememberPages } from '@/lib/notebooks/pages-cache';
import { updatePageInLists } from '@/lib/offline/jobs';

const MATH_MODES: { key: MathToolsMode; label: string }[] = [
  { key: 'auto', label: 'Auto' },
  { key: 'on', label: 'On' },
  { key: 'off', label: 'Off' },
];

type Busy = null | 'save' | 'redo' | 'cover' | 'remove' | MetaField;

/**
 * Notebook details: name, description, tags, cover and math tools. AI fills them in; anything the
 * owner changes here stays his (AI never touches it again) until he taps «Let AI pick» on it.
 */
export function NotebookDetailsSheet({
  page,
  onClose,
  onChange,
}: {
  page: Page;
  onClose: () => void;
  onChange?: (page: Page) => void;
}) {
  const [current, setCurrent] = useState(page);
  const [title, setTitle] = useState(page.title);
  const [description, setDescription] = useState(page.description ?? '');
  const [tags, setTags] = useState<string[]>(page.tags ?? []);
  const [tagDraft, setTagDraft] = useState('');
  const [mathTools, setMathTools] = useState<MathToolsMode>(page.mathTools ?? 'auto');
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const edited = editedOf(current);
  const supported = 'metaAiVersion' in current;

  const adopt = (next: Page) => {
    setCurrent(next);
    rememberPages([next]);
    updatePageInLists(next);
    onChange?.(next);
  };
  /**
   * After AI wrote: a field follows the new value only when its draft was untouched (or it was just
   * handed back to AI) — typing not saved yet is never thrown away.
   */
  const syncFields = (before: Page, next: Page, handedBack?: MetaField) => {
    if (handedBack === 'title' || title.trim() === before.title) setTitle(next.title);
    if (handedBack === 'description' || description.trim() === (before.description ?? '')) setDescription(next.description ?? '');
    if (handedBack === 'tags' || JSON.stringify(tags) === JSON.stringify(before.tags ?? [])) setTags(next.tags ?? []);
  };

  const run = async (kind: Busy, task: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    setNote(null);
    try {
      await task();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(null);
    }
  };

  const describe = (body: { force?: boolean; only?: 'cover' }, before: Page = current, handedBack?: MetaField) =>
    describePage(current.id, body).then((described) => {
      const next = adoptDescribed(described);

      adopt(next);
      syncFields(before, next, handedBack);
      if (described.coverPending) setNote('Your new cover is being drawn. It shows up in a minute.');

      return next;
    });

  const addTag = () => {
    const value = normalizeTag(tagDraft);

    if (value && !tags.includes(value) && tags.length < META_TAGS_MAX) setTags([...tags, value]);
    setTagDraft('');
  };

  const changed = {
    title: title.trim() !== current.title && title.trim().length > 0,
    description: description.trim() !== (current.description ?? ''),
    tags: JSON.stringify(tags) !== JSON.stringify(current.tags ?? []),
    mathTools: mathTools !== (current.mathTools ?? 'auto'),
  };
  const dirty = changed.title || changed.description || changed.tags || changed.mathTools;

  const save = () =>
    run('save', async () => {
      const next = await patchPage(current.id, {
        ...(changed.title ? { title: title.trim() } : {}),
        ...(changed.description ? { description: description.trim() || null } : {}),
        ...(changed.tags ? { tags } : {}),
        ...(changed.mathTools ? { mathTools } : {}),
      });

      adopt(next);
      onClose();
    });

  const letAiPick = (field: MetaField) =>
    run(field, async () => {
      const before = current;

      adopt(await patchPage(current.id, { aiPick: [field] }));
      await describe(field === 'cover' ? { only: 'cover' } : { force: true }, before, field);
    });

  const aiPickLink = (field: MetaField) =>
    edited[field] && supported ? (
      <button
        className='text-st-accent shrink-0 text-xs font-semibold underline-offset-2 hover:underline disabled:opacity-50'
        disabled={busy !== null}
        type='button'
        onClick={() => void letAiPick(field)}
      >
        {busy === field ? 'Thinking…' : 'Let AI pick'}
      </button>
    ) : null;

  const label = (text: string, field?: MetaField, htmlFor?: string) => (
    <div className='flex items-center justify-between gap-3'>
      <label className='text-st-fg text-sm font-semibold' htmlFor={htmlFor}>
        {text}
      </label>
      {field && aiPickLink(field)}
    </div>
  );

  const mathOn = mathToolsOn(mathTools, tags);

  return (
    <>
      <Sheet
        footer={
          <div className='flex flex-wrap justify-end gap-3'>
            {supported && (
              <ActionButton
                disabled={busy !== null}
                loading={busy === 'redo'}
                title='AI looks at your pages again. Anything you changed yourself stays.'
                onClick={() => void run('redo', async () => void (await describe({ force: true })))}
              >
                <Sparkles className='h-4 w-4' /> Redo with AI
              </ActionButton>
            )}
            <ActionButton disabled={!dirty || busy !== null} loading={busy === 'save'} variant='primary' onClick={() => void save()}>
              Save
            </ActionButton>
          </div>
        }
        title='Notebook details'
        onClose={onClose}
      >
        <div className='flex flex-col gap-4' data-notebook-details>
          {error && <ErrorNote message={error} />}
          {note && <p className='text-st-muted text-sm'>{note}</p>}

          {supported && (
            <div className='flex items-center gap-3'>
              <NoteCover page={current} size='lg' />
              <div className='flex min-w-0 flex-1 flex-col gap-2'>
                <div className='flex items-center justify-between gap-3'>
                  <span className='text-st-fg text-sm font-semibold'>Cover</span>
                  {aiPickLink('cover')}
                </div>
                <div className='flex flex-wrap gap-3 pb-1'>
                  <ActionButton
                    className='min-h-9 px-3 text-xs'
                    disabled={busy !== null}
                    loading={busy === 'cover'}
                    onClick={() => void run('cover', async () => void (await describe({ only: 'cover' })))}
                  >
                    Make a new cover
                  </ActionButton>
                  {current.cover && (
                    <ActionButton
                      className='min-h-9 px-3 text-xs'
                      disabled={busy !== null}
                      loading={busy === 'remove'}
                      variant='ghost'
                      onClick={() => setConfirmRemove(true)}
                    >
                      Remove cover
                    </ActionButton>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className='flex flex-col gap-1.5'>
            {label('Name', 'title', 'nb-title')}
            <input
              className={INPUT_CLASS}
              id='nb-title'
              maxLength={200}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          {supported && (
            <>
              <div className='flex flex-col gap-1.5'>
                {label('What it covers', 'description', 'nb-description')}
                <textarea
                  className={`${INPUT_CLASS} min-h-20 py-2`}
                  id='nb-description'
                  maxLength={META_DESCRIPTION_MAX}
                  placeholder='Not set'
                  rows={3}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>

              <div className='flex flex-col gap-1.5'>
                {label('Tags', 'tags', 'nb-tag')}
                {tags.length > 0 && (
                  <div className='flex flex-wrap gap-2 py-1'>
                    {tags.map((tag) => (
                      <Chip key={tag} isClosable size='sm' variant='flat' onClose={() => setTags(tags.filter((other) => other !== tag))}>
                        {tag}
                      </Chip>
                    ))}
                  </div>
                )}
                {tags.length < META_TAGS_MAX && (
                  <div className='flex items-center gap-3 pb-1'>
                    <input
                      className={INPUT_CLASS}
                      id='nb-tag'
                      maxLength={24}
                      placeholder='Add a tag'
                      value={tagDraft}
                      onChange={(event) => setTagDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          addTag();
                        }
                      }}
                    />
                    <ActionButton aria-label='Add tag' className='w-11 shrink-0 px-0' disabled={!normalizeTag(tagDraft)} onClick={addTag}>
                      <Plus className='h-4 w-4' />
                    </ActionButton>
                  </div>
                )}
              </div>

              <div className='flex flex-col gap-1.5'>
                <span className='text-st-fg text-sm font-semibold'>Math tools</span>
                <div className='flex flex-wrap items-center gap-3 pb-1'>
                  <Tabs
                    aria-label='Math tools'
                    selectedKey={mathTools}
                    size='sm'
                    variant='light'
                    onSelectionChange={(key) => setMathTools(key as MathToolsMode)}
                  >
                    {MATH_MODES.map((mode) => (
                      <Tab key={mode.key} title={mode.label} />
                    ))}
                  </Tabs>
                  <span className='text-st-muted text-xs'>
                    {mathTools === 'auto'
                      ? mathOn
                        ? 'On, because the tags look like math'
                        : 'Turns on when the tags look like math'
                      : mathOn
                        ? 'A bar of math symbols to tap onto the page'
                        : 'No math bar on the page'}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      </Sheet>

      {confirmRemove && (
        <ConfirmSheet
          danger
          confirmLabel='Remove cover'
          title='Remove the cover?'
          onClose={() => setConfirmRemove(false)}
          onConfirm={() =>
            void run('remove', async () => {
              adopt(await patchPage(current.id, { cover: null }));
            })
          }
        >
          <p>The notebook goes back to the plain icon. AI won’t make a new cover unless you ask for one.</p>
        </ConfirmSheet>
      )}
    </>
  );
}
