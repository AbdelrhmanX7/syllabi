// In-memory `/telemetry/perf` for Force-mock mode (in Auto the route is LIVE: a 404 from a backend
// that has not shipped it keeps the events on the device). POST stores the batch; GET answers the
// owner read shape from lib/perf/api.ts so an admin viewer can be built against it.
import type { PerfBatch } from './types';

import { StudyApiError } from '@/lib/api/errors';

type Body = Record<string, unknown> | undefined;

const MAX_BATCHES = 200;
let batches: PerfBatch[] = [];

/** Tests / dev: what the mock has received. */
export function readPerfMockBatches(): PerfBatch[] {
  return [...batches];
}

export function resetPerfMock(): void {
  batches = [];
}

function parseQuery(path: string): URLSearchParams {
  const query = path.split('?')[1] ?? '';

  return new URLSearchParams(query);
}

export const perfMockRoutes = {
  /** `undefined` = not this path. */
  json(method: string, path: string, body: Body): { value: unknown } | undefined {
    const segments = path.split('?')[0].split('/').filter(Boolean);

    if (segments[0] !== 'telemetry') return undefined;
    if (segments[1] !== 'perf' || segments.length !== 2) throw new StudyApiError(404, 'Not found', 'NOT_FOUND');

    if (method === 'POST') {
      const batch = body as unknown as PerfBatch | undefined;

      if (!batch || batch.schema !== 'study-perf/v1' || !Array.isArray(batch.events)) {
        throw new StudyApiError(400, 'Bad perf batch', 'BAD_REQUEST');
      }
      batches = [...batches, batch].slice(-MAX_BATCHES);

      return { value: { accepted: batch.events.length } };
    }

    if (method === 'GET') {
      const query = parseQuery(path);
      const device = query.get('device');
      const from = Number(query.get('from') ?? 0) || 0;
      const events = batches
        .filter((batch) => !device || batch.device.id === device)
        .flatMap((batch) =>
          batch.events.map((event) => ({ ...event, device: batch.device.id, session: batch.session, app: batch.app })),
        )
        .filter((event) => event.t >= from)
        .sort((a, b) => b.t - a.t);
      const devices = new Map<string, { id: string; ua: string; lastSeen: number }>();

      for (const batch of batches)
        devices.set(batch.device.id, { id: batch.device.id, ua: batch.device.ua, lastSeen: batch.sentAt });

      return { value: { events, devices: [...devices.values()] } };
    }

    throw new StudyApiError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED');
  },
};
