import type { MetaField, Page } from '@/lib/api/types';

import { useState } from 'react';
import { TagInput } from '@repo/ui';
import { Sparkles } from 'lucide-react';

import { NoteCover } from '@/components/notes/NoteCover';
import { ConfirmSheet } from '@/components/ui/ConfirmSheet';
import { ShaderGlow } from '@/components/ui/ShaderGlow';
import { ActionButton, ErrorNote, INPUT_CLASS } from '@/components/ui/primitives';
import { Sheet } from '@/features/inbox/components/Sheet';
import { describePage, patchPage } from '@/lib/api/endpoints';
import { describeError } from '@/lib/api/errors';
import { adoptDescribed } from '@/lib/notebooks/auto-describe';
import { editedOf, META_DESCRIPTION_MAX, META_TAGS_MAX, normalizeTag } from '@/lib/notebooks/page-meta';
import { rememberPages } from '@/lib/notebooks/pages-cache';
import { updatePageInLists } from '@/lib/offline/jobs';

type Busy = null | 'save' | 'redo' | 'cover' | 'remove' | MetaField;

/**
 * Notebook details: name, description, tags and cover. AI fills them in; anything the
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

  /** A tag typed but not «entered» still counts: Save adds it instead of dropping it. */
  const draftTag = normalizeTag(tagDraft);
  const finalTags = draftTag && !tags.includes(draftTag) && tags.length < META_TAGS_MAX ? [...tags, draftTag] : tags;

  const changed = {
    title: title.trim() !== current.title && title.trim().length > 0,
    description: description.trim() !== (current.description ?? ''),
    tags: JSON.stringify(finalTags) !== JSON.stringify(current.tags ?? []),
  };
  const dirty = changed.title || changed.description || changed.tags;

  const save = () =>
    run('save', async () => {
      const next = await patchPage(current.id, {
        ...(changed.title ? { title: title.trim() } : {}),
        ...(changed.description ? { description: description.trim() || null } : {}),
        ...(changed.tags ? { tags: finalTags } : {}),
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

  return (
    <>
      <Sheet
        footer={
          <div className='flex flex-wrap justify-end gap-3'>
            {supported && (
              <ActionButton
                aria-busy={busy === 'redo' || undefined}
                // isolate: the glow sits at z -1 inside the button, over its face and under the label.
                // While the redo itself runs, the button keeps full strength (the busy glow is the point);
                // disabled because something else is running, it fades as usual.
                className={`relative isolate ${busy === 'redo' ? 'disabled:opacity-100' : ''}`}
                disabled={busy !== null}
                loading={busy === 'redo'}
                title='AI looks at your pages again. Anything you changed yourself stays.'
                onClick={() => void run('redo', async () => void (await describe({ force: true })))}
              >
                <ShaderGlow busy={busy === 'redo'} />
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
                <TagInput
                  id='nb-tag'
                  maxLength={24}
                  maxTags={META_TAGS_MAX}
                  normalize={normalizeTag}
                  value={tags}
                  onChange={setTags}
                  onDraftChange={setTagDraft}
                />
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
