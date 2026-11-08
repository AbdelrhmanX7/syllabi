/**
 * Every user-visible string of "My handwriting". Placeholders are `{name}`.
 */
export const HANDWRITING_STRINGS = {
  title: 'My handwriting',
  pageTitle: 'My handwriting · Syllabi',
  subtitle: 'Write your letters once; the AI then writes its answers in your hand.',
  coverage: '{percent}% of your letters',
  coverageCount: '{done} of {total} cells',
  samples: '{count}/{max}',
  page: 'Page {page} of {total}',
  prevPage: 'Previous page',
  nextPage: 'Next page',
  jumpMissing: 'Missing',
  allDone: 'Every cell is written',
  clear: 'Clear',
  accept: 'Accept',
  writeHere: 'Write here with the pen',
  penOnly: 'The pen writes; a finger scrolls.',
  promptIsol: 'alone',
  promptInit: 'start of a word',
  promptMedi: 'middle of a word',
  promptFina: 'end of a word',
  promptDots: 'dots',
  promptDigit: 'digit',
  promptLatin: 'letter',
  continueSheet: 'Continue the sheet',
  startSheet: 'Start the sheet',
  clearBank: 'Clear my handwriting',
  clearConfirm: 'Removes every letter here and on the server. Sure?',
  confirm: 'Clear',
  cancel: 'Cancel',
  previewTitle: 'Preview',
  previewEmpty: 'No letters yet — write a few cells on the sheet.',
  remoteSynced: 'Synced with the server',
  remoteSyncing: 'Saving…',
  remoteLocalOnly: 'Saved on this tablet only',
  remoteError: 'Could not save to the server — kept on this tablet',
  remoteIdle: 'Saved on this tablet',
  backToSettings: 'Settings',
  cellDone: 'Done',
  sampleAdded: 'Saved',
} satisfies Record<string, string>;

export type HandwritingStringKey = keyof typeof HANDWRITING_STRINGS;

export function hwT(key: HandwritingStringKey, vars?: Record<string, string | number>): string {
  const text: string = HANDWRITING_STRINGS[key];

  if (!vars) return text;

  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

/** A whole number for the UI ("42"). */
export function hwNumber(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}
