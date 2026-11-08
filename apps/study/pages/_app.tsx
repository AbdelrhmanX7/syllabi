import type { AppProps } from 'next/app';

import { useEffect, useState } from 'react';
import { HeroUIProvider, ToastProvider } from '@repo/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Head from 'next/head';
import { ThemeProvider as NextThemesProvider } from 'next-themes';
import { useRouter } from 'next/router';

import { AppShell } from '@/components/layout/AppShell';
import { AppLinkRouter } from '@/features/auth/components/AppLinkRouter';
import { installStudyTransport } from '@/lib/api/client';
import { retryUnlessAiQuota } from '@/lib/api/errors';
import { useAuthInit } from '@/lib/auth';
import { installPdfAssetMigrationHelper } from '@/lib/notebooks/pdf-assets-migrate';
import { IS_ANDROID_BUILD } from '@/lib/platform/runtime';
import '@/styles/globals.css';

// Module scope: features call the API from their first render, so the transport must exist before
// React mounts anything.
installStudyTransport();
// Devtools helper: move this device's notebook PDFs to the signed-in server account.
installPdfAssetMigrationHelper();

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        retry: retryUnlessAiQuota,
        refetchOnWindowFocus: false,
      },
    },
  });
}

function Shell({ Component, pageProps }: { Component: AppProps['Component']; pageProps: AppProps['pageProps'] }) {
  const router = useRouter();

  // Hydrates the axios client + cookie from the stored token (and drops an expired one).
  useAuthInit();

  return (
    <AppShell pathname={router.pathname}>
      <Component {...pageProps} />
    </AppShell>
  );
}

export default function App({ Component, pageProps }: AppProps) {
  const router = useRouter();
  const [queryClient] = useState(makeQueryClient);

  // Perf telemetry (lib/perf): client-only, loaded after first paint so it never weighs on start-up.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void import('@/lib/perf').then((perf) => perf.startPerfTelemetry());
    }, 1_000);

    return () => window.clearTimeout(timer);
  }, []);

  // Android static export: a hard load of a path that has no HTML file falls back to index.html.
  // Routes here are query-param based (`/item/?id=`) so this only matters for a stale deep link.
  useEffect(() => {
    if (!IS_ANDROID_BUILD || router.pathname !== '/') return;
    const path = window.location.pathname.replace(/\/$/, '');

    if (path && path !== '/' && path !== '/index.html') {
      // Keep the fragment: the Google callback carries its session token there (#token=).
      void router.replace(path + '/' + window.location.search + window.location.hash);
    }
  }, [router]);

  return (
    <>
      <Head>
        <title>Syllabi</title>
        <meta
          content='Personal study app: Canvas classes, handwritten notes, question bank, code, lectures.'
          name='description'
        />
        <meta
          content='minimum-scale=1, initial-scale=1, width=device-width, shrink-to-fit=no, user-scalable=no, viewport-fit=cover'
          name='viewport'
        />
      </Head>
      <QueryClientProvider client={queryClient}>
        <HeroUIProvider className='h-full w-full' locale='en-US' navigate={router.push}>
          <NextThemesProvider enableSystem attribute='class' defaultTheme='system' themes={['light', 'dark']}>
            <ToastProvider placement='top-right' />
            <AppLinkRouter />
            <Shell Component={Component} pageProps={pageProps} />
          </NextThemesProvider>
        </HeroUIProvider>
      </QueryClientProvider>
    </>
  );
}
