import type { AnalyticsClient } from './core';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAnalytics, megabyteBucket, pageBucket, scrubEvent, SHARE_USAGE_KEY } from './core';

function memoryStorage() {
  const data = new Map<string, string>();

  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

function fakeClient() {
  const calls: string[] = [];
  let optedOut = false;
  const client: AnalyticsClient = {
    init: () => calls.push('init'),
    capture: (event) => calls.push(`capture:${event}`),
    identify: (id) => calls.push(`identify:${id}`),
    reset: () => calls.push('reset'),
    register: () => calls.push('register'),
    opt_out_capturing: () => {
      optedOut = true;
      calls.push('opt_out');
    },
    opt_in_capturing: () => {
      optedOut = false;
      calls.push('opt_in');
    },
    has_opted_out_capturing: () => optedOut,
  };

  return { client, calls };
}

test('no key: a complete no-op that never loads the client', async () => {
  let loads = 0;
  const analytics = createAnalytics({
    key: '',
    host: 'https://example.test',
    load: async () => {
      loads += 1;
      throw new Error('must not load');
    },
    storage: memoryStorage,
  });

  analytics.track('app_opened', { a: 1 });
  analytics.identify('user-1');
  analytics.pageview('/bank');
  analytics.captureError(new Error('boom'));
  analytics.reset();
  analytics.setSharing(false);
  analytics.setSharing(true);
  await analytics.start();
  assert.equal(analytics.enabled, false);
  assert.equal(loads, 0);
});

test('the app-wide wrapper is a no-op without a build-time key', async () => {
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const mod = await import('./index');

  assert.equal(mod.analyticsConfigured, false);
  mod.track('app_opened');
  mod.identify('user-1');
  mod.captureError(new Error('boom'));
  mod.reset();
  assert.equal(typeof mod.installAnalytics()(), 'undefined');
});

test('events queue until the client loads, then flush in order', async () => {
  const { client, calls } = fakeClient();
  const analytics = createAnalytics({ key: 'k', host: 'h', load: async () => client, storage: memoryStorage });

  analytics.track('app_opened');
  analytics.identify('user-1');
  await analytics.start();
  analytics.track('notebook_opened');
  assert.deepEqual(calls, ['init', 'register', 'capture:app_opened', 'identify:user-1', 'capture:notebook_opened']);
});

test('switching sharing off opts out and stops sending; off before start never loads', async () => {
  const storage = memoryStorage();
  const { client, calls } = fakeClient();
  const analytics = createAnalytics({ key: 'k', host: 'h', load: async () => client, storage: () => storage });

  await analytics.start();
  analytics.setSharing(false);
  assert.equal(storage.getItem(SHARE_USAGE_KEY), '0');
  analytics.track('after_off');
  assert.ok(calls.includes('opt_out'));
  assert.ok(!calls.includes('capture:after_off'));

  analytics.setSharing(true);
  analytics.track('after_on');
  assert.ok(calls.includes('opt_in'));
  assert.ok(calls.includes('capture:after_on'));

  let loads = 0;
  const offStorage = memoryStorage();

  offStorage.setItem(SHARE_USAGE_KEY, '0');
  const off = createAnalytics({
    key: 'k',
    host: 'h',
    load: async () => {
      loads += 1;

      return fakeClient().client;
    },
    storage: () => offStorage,
  });

  off.track('x');
  await off.start();
  assert.equal(loads, 0);
});

test('a client that fails to load is swallowed', async () => {
  const analytics = createAnalytics({
    key: 'k',
    host: 'h',
    load: async () => {
      throw new SyntaxError('old WebView');
    },
    storage: memoryStorage,
  });

  analytics.track('app_opened');
  await analytics.start();
  analytics.track('later');
});

test('errors: stack trimmed to 2 KB and repeats sent once', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const { client } = fakeClient();

  client.capture = (_event, props) => sent.push(props ?? {});
  const analytics = createAnalytics({ key: 'k', host: 'h', load: async () => client, storage: memoryStorage });

  await analytics.start();
  const error = new Error('boom');

  error.stack = 'x'.repeat(10_000);
  analytics.captureError(error, { route: '/bank' });
  analytics.captureError(error, { route: '/bank' });
  assert.equal(sent.length, 1);
  assert.equal((sent[0].stack as string).length, 2_000);
  assert.equal(sent[0].route, '/bank');
});

test('URLs lose their query string and fragment; buckets are coarse', () => {
  const event = scrubEvent({
    properties: { $current_url: 'https://app.test/login/?next=/x#token=secret', $ip: '1.2.3.4', other: 'kept' },
    $set_once: { $initial_current_url: 'https://app.test/item/?id=1' },
  });

  assert.equal(event.properties.$current_url, 'https://app.test/login/');
  assert.equal('$ip' in event.properties, false);
  assert.equal(event.properties.other, 'kept');
  assert.equal(event.$set_once.$initial_current_url, 'https://app.test/item/');
  assert.equal(pageBucket(1), '1');
  assert.equal(pageBucket(120), '51-200');
  assert.equal(megabyteBucket(3 * 1_048_576), '1-5');
});
