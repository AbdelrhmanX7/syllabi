import { RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { ActionButton, Badge, SectionTitle, Surface } from '@/components/ui/primitives';
import { formatRelative } from '@/lib/format';
import { BUILD_STAMP } from '@/lib/platform/runtime';

type Check = { at: number; latest: string | null; error: string | null };

/** The site's current build, written by scripts/deploy-web.sh next to index.html. */
async function fetchDeployedBuild(): Promise<string | null> {
  const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });

  if (!res.ok) return null;
  const body = (await res.json()) as { sha?: unknown };

  return typeof body.sha === 'string' ? body.sha : null;
}

/** Web app: there is nothing to install — a newer deploy is one reload away. */
export function WebUpdatesSection() {
  const [check, setCheck] = useState<Check | null>(null);
  const [checking, setChecking] = useState(false);
  const newer = !!check?.latest && !!BUILD_STAMP && check.latest !== BUILD_STAMP;
  const run = async () => {
    setChecking(true);
    try {
      setCheck({ at: Date.now(), latest: await fetchDeployedBuild(), error: null });
    } catch (error) {
      setCheck({ at: Date.now(), latest: null, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setChecking(false);
    }
  };

  return (
    <Surface className='p-5'>
      <SectionTitle
        action={
          newer ? <Badge tone='accent'>Update available</Badge> : check?.latest ? <Badge tone='ok'>Up to date</Badge> : undefined
        }
      >
        App updates
      </SectionTitle>
      <div className='flex flex-wrap items-center justify-between gap-4'>
        <div className='min-w-0'>
          <p className='text-st-fg text-sm font-medium'>
            Syllabi web{BUILD_STAMP ? ` · build ${BUILD_STAMP}` : ' · development build'}
          </p>
          <p className='text-st-muted text-xs'>
            {check ? `Checked ${formatRelative(new Date(check.at).toISOString())}` : 'The web app updates itself when you reload.'}
            {newer ? ` · build ${check?.latest} is out` : ''}
          </p>
          {check?.error && <p className='text-st-danger text-xs'>Check failed: {check.error}</p>}
        </div>
        <div className='flex gap-2'>
          {newer ? (
            <ActionButton variant='primary' onClick={() => window.location.reload()}>
              <RefreshCw className='h-4 w-4' /> Reload to update
            </ActionButton>
          ) : (
            <ActionButton loading={checking} onClick={() => void run()}>
              <RefreshCw className='h-4 w-4' /> Check for updates
            </ActionButton>
          )}
        </div>
      </div>
    </Surface>
  );
}
