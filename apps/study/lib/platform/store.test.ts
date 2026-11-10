import assert from 'node:assert/strict';
import { test } from 'node:test';

// The Google Play build (NEXT_PUBLIC_STORE=play) must never look for or install an update itself.
// The flag is baked at build time, so it is set before the modules load.
process.env.NEXT_PUBLIC_STORE = 'play';
process.env.NEXT_PUBLIC_VERSION_CODE = '450920';

const calls: string[] = [];
const fakeWindow = {
  __TAURI_INTERNALS__: {
    invoke: (command: string) => {
      calls.push(`invoke:${command}`);

      return Promise.resolve({});
    },
  },
  StudyUpdater: {
    versionCode: () => 450920,
    start: () => {
      calls.push('native:start');

      return true;
    },
  },
  localStorage: { getItem: () => null, setItem: () => undefined },
  addEventListener: () => undefined,
  open: () => {
    calls.push('window:open');
  },
};

(globalThis as unknown as { window: unknown }).window = fakeWindow;
globalThis.fetch = (() => {
  calls.push('fetch');

  return Promise.reject(new Error('no network in tests'));
}) as typeof fetch;

test('the Play build turns self-update off', async () => {
  const { IS_PLAY_BUILD, SELF_UPDATE_ENABLED } = await import('./store');

  assert.equal(IS_PLAY_BUILD, true);
  assert.equal(SELF_UPDATE_ENABLED, false);
});

test('the Play build never reads the release feed or starts an install', async () => {
  const { checkForUpdates, getUpdateSnapshot, startUpdate } = await import('./app-update');

  await checkForUpdates();
  await checkForUpdates({ ifOlderThan: 0 });
  startUpdate();

  assert.deepEqual(calls, []);
  assert.equal(getUpdateSnapshot().available, false);
  assert.equal(getUpdateSnapshot().checking, false);
});

test('the Play build renders no update banner', async () => {
  const { UpdateBanner } = await import('@/components/layout/UpdateBanner');

  assert.equal(UpdateBanner(), null);
});
