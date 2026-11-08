// Performance log — the perf telemetry row in Settings: what is queued on this device, when it last
// reached the server, the on/off switch, and a share-as-file fallback for when the upload route is not
// live yet (the owner can still get the log off a student's tablet).
import type { PerfStatus } from '@/lib/perf';

import { useState, useSyncExternalStore } from 'react';
import { Check, Share2, UploadCloud } from 'lucide-react';

import { ActionButton, Badge, SectionTitle, Surface } from '@/components/ui/primitives';
import { Toggle } from '@/components/ui/Toggle';
import { formatRelative } from '@/lib/format';

type PerfModule = typeof import('@/lib/perf');

let perfModule: PerfModule | null = null;
const loadPerf = async (): Promise<PerfModule> => (perfModule ??= await import('@/lib/perf'));

const SERVER_STATUS: PerfStatus = {
  enabled: true,
  started: false,
  queued: 0,
  bytes: 0,
  dropped: 0,
  sent: 0,
  lastUploadAt: null,
  lastStatus: null,
  nextAttemptAt: 0,
  supports: { loaf: false, longtask: false, event: false, gzip: false },
};

let snapshot: PerfStatus = SERVER_STATUS;
const subscribers = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  let unsubscribe: (() => void) | null = null;
  let alive = true;

  void loadPerf().then((perf) => {
    if (!alive) return;
    const sync = () => {
      snapshot = perf.getPerfStatus();
      subscribers.forEach((notify) => notify());
    };

    unsubscribe = perf.subscribePerfStatus(sync);
    sync();
  });

  return () => {
    alive = false;
    subscribers.delete(listener);
    unsubscribe?.();
  };
}

function statusLine(status: PerfStatus): string {
  if (status.lastStatus === 404) return 'The server does not accept the log yet — kept on this tablet';
  if (status.lastStatus === -1 || status.lastStatus === 401) return 'Uploads after you sign in';
  if (status.lastStatus === 0) return 'Offline — uploads on its own later';

  return status.lastUploadAt ? `Last upload ${formatRelative(status.lastUploadAt)}` : 'Not uploaded yet';
}

// Always a FILE: the native share sheet when it takes files, otherwise a download. Never the
// clipboard — the log is thousands of lines nobody pastes by hand.
async function shareFile(text: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const name = `study-perf-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
  const file = new File([text], name, { type: 'application/json' });

  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });

      return 'shared';
    } catch (error) {
      if ((error as DOMException)?.name === 'AbortError') return 'cancelled';
      // share failed for another reason — fall through to a download
    }
  }

  const url = URL.createObjectURL(file);
  const link = document.createElement('a');

  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 5_000);

  return 'downloaded';
}

export function PerfLogSection() {
  const status = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => SERVER_STATUS,
  );
  const [busy, setBusy] = useState<'upload' | 'share' | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const kb = Math.round(status.bytes / 1024);

  const run = async (kind: 'upload' | 'share') => {
    setBusy(kind);
    setDone(null);

    try {
      const perf = await loadPerf();

      if (kind === 'upload') {
        await perf.uploadPerfNow();
      } else {
        const result = await shareFile(await perf.exportPerfLog());

        if (result === 'cancelled') return;
        setDone(result === 'shared' ? 'Shared' : 'Downloaded');
        window.setTimeout(() => setDone(null), 2_000);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <Surface className='p-5'>
      <SectionTitle
        action={
          <Toggle
            checked={status.enabled}
            label='Performance log'
            onChange={(on) => void loadPerf().then((perf) => perf.setPerfEnabled(on))}
          />
        }
      >
        Performance log
      </SectionTitle>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div className='min-w-0'>
          <p className='text-st-fg text-sm font-medium'>
            {status.queued} events waiting to upload{kb > 0 ? ` · ${kb} KB` : ''}
            {status.dropped > 0 && (
              <Badge className='ms-2' tone='warn'>
                {status.dropped} old dropped
              </Badge>
            )}
          </p>
          <p className='text-st-muted text-xs'>
            {statusLine(status)}
            {!status.supports.loaf && status.started ? ' · Older browser: longtask instead of LoAF' : ''}
          </p>
        </div>
        <div className='flex gap-2'>
          {status.queued > 0 && (
            <ActionButton
              className='min-h-9 px-3 text-xs'
              loading={busy === 'upload'}
              onClick={() => void run('upload')}
            >
              <UploadCloud className='h-3.5 w-3.5' /> Upload now
            </ActionButton>
          )}
          <ActionButton className='min-h-9 px-3 text-xs' loading={busy === 'share'} onClick={() => void run('share')}>
            {done ? <Check className='text-st-ok h-3.5 w-3.5' /> : <Share2 className='h-3.5 w-3.5' />}{' '}
            {done ?? 'Share log as file'}
          </ActionButton>
        </div>
      </div>
    </Surface>
  );
}
