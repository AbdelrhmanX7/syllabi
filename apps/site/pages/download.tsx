import { LinkButton } from '@/components/ui/primitives';
import { Download } from 'lucide-react';
import { Seo } from '~/sections/Seo';
import { useEffect, useState } from 'react';

import { Footer } from '~/sections/Footer';
import { FEED, FEED_PAGE } from '~/sections/links';
import { Nav } from '~/sections/Nav';

interface Latest {
  version: string;
  url: string;
  sha256: string;
  size: number;
  publishedAt: string;
  notes?: string;
}

const GREEN =
  'border-[#155C3F] bg-[#1F7A55] text-white shadow-[0_4px_0_0_#155C3F] hover:bg-[#1F7A55] hover:brightness-110 active:translate-y-[3px] active:shadow-none dark:border-[#2E9E6E] dark:hover:bg-[#4FD69C] dark:bg-[#4FD69C] dark:text-[#06281A] dark:shadow-[0_4px_0_0_#2E9E6E]';

export default function DownloadPage() {
  const [latest, setLatest] = useState<Latest | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch(FEED, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: Latest) => setLatest(data))
      .catch(() => setFailed(true));
  }, []);

  const mb = latest ? `${(latest.size / 1024 / 1024).toFixed(1)} MB` : '';
  const date = latest ? new Date(latest.publishedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '';

  return (
    <>
      <Seo
        description='Download Syllabi for Android tablets: free, scanned for viruses, and updates itself. Install steps and how to check your download.'
        path='/download/'
        title='Download Syllabi for Android tablets'
      />
      <Nav />
      <main className='mx-auto max-w-3xl px-4 py-8'>
        <h1 className='font-display text-st-fg text-3xl font-bold'>Syllabi for Android tablets</h1>
        <p className='text-st-muted mt-1 text-sm'>
          {latest ? `Version ${latest.version} · ${mb} · ${date}` : failed ? 'Could not load the latest version.' : 'Loading the latest version…'}
        </p>

        <div className='mt-6 flex flex-wrap items-center gap-3'>
          <LinkButton className={GREEN} href={latest?.url ?? FEED_PAGE} variant='ghost'>
            <Download aria-hidden className='h-4 w-4' />
            Download the app
          </LinkButton>
          <a className='text-st-accent text-sm underline' href='https://app.syllabi.studio'>
            Or use it in your browser
          </a>
        </div>
        {latest?.notes && <p className='text-st-fg mt-4'>What&apos;s new: {latest.notes}</p>}

        <div className='text-st-fg mt-8 flex flex-col gap-4 leading-relaxed [&_a]:text-st-accent [&_a]:underline [&_h2]:font-display [&_h2]:text-xl [&_h2]:font-bold [&_ul]:list-disc [&_ul]:pl-5'>
          <h2>How to install</h2>
          <ul>
            <li>Open the downloaded file on your tablet.</li>
            <li>If your tablet asks, allow installing apps from your browser or files app.</li>
            <li>After that, new versions show up inside the app.</li>
          </ul>
          <h2>Is it safe?</h2>
          <p>
            Every version is scanned by dozens of antivirus engines on VirusTotal.{' '}
            {latest && <a href={`https://www.virustotal.com/gui/file/${latest.sha256}`}>See the scan for this version</a>}
          </p>
          {latest && (
            <>
              <p>To check your download is exactly this file, compare its fingerprint (SHA-256):</p>
              <code className='bg-st-surface border-st-line rounded-st block border p-3 text-xs break-all'>{latest.sha256}</code>
              <ul>
                <li>
                  Mac or Linux: <code>shasum -a 256</code> followed by the file name
                </li>
                <li>
                  Windows: <code>certutil -hashfile</code> followed by the file name and <code>SHA256</code>
                </li>
              </ul>
            </>
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}
