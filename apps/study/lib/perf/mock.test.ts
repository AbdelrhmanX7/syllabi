import type { PerfBatch } from './types';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { perfMockRoutes, readPerfMockBatches, resetPerfMock } from './mock';

const batch = (device: string, t: number): PerfBatch => ({
  schema: 'study-perf/v1',
  batchId: `b${t}`,
  session: 's',
  sentAt: t,
  device: { id: device, ua: 'ua', screen: [800, 1280], dpr: 2, platform: 'android' },
  app: { version: '0.3.0', sha: 'abc', versionCode: 30 },
  dropped: 0,
  events: [{ k: 'nav', t, r: '/notebook' }],
});

test('mock stores batches and answers the owner read filtered by device + from', () => {
  resetPerfMock();
  assert.equal(perfMockRoutes.json('GET', '/today', undefined), undefined);
  assert.deepEqual(perfMockRoutes.json('POST', '/telemetry/perf', batch('d1', 10) as never)?.value, { accepted: 1 });
  perfMockRoutes.json('POST', '/telemetry/perf', batch('d2', 20) as never);
  assert.equal(readPerfMockBatches().length, 2);
  const read = perfMockRoutes.json('GET', '/telemetry/perf?device=d2&from=5', undefined)?.value as {
    events: { device: string }[];
    devices: unknown[];
  };

  assert.equal(read.events.length, 1);
  assert.equal(read.events[0].device, 'd2');
  assert.equal(read.devices.length, 2);
  assert.throws(() => perfMockRoutes.json('POST', '/telemetry/perf', { schema: 'nope' }), /Bad perf batch/);
});
