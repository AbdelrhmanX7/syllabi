import { Head, Html, Main, NextScript } from 'next/document';

import { IS_ANDROID_BUILD } from '@/lib/platform/runtime';

export default function Document() {
  return (
    <Html className={IS_ANDROID_BUILD ? 'tauri-android' : undefined} dir='ltr' lang='en'>
      <Head>
        <meta content='#FBFAF6' name='theme-color' />
        <link href='/apple-touch-icon.png' rel='apple-touch-icon' />
        <link href='/favicon.ico' rel='icon' />
        <meta content='yes' name='mobile-web-app-capable' />
        <meta content='Syllabi' name='application-name' />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
