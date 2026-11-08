import { Head, Html, Main, NextScript } from 'next/document';

export default function Document() {
  return (
    <Html lang='en'>
      <Head>
        <link href='/favicon.ico' rel='icon' sizes='any' />
        <link href='/logo-icon.svg' rel='icon' type='image/svg+xml' />
        <link href='/apple-touch-icon.png' rel='apple-touch-icon' />
        <meta content='#2F5BEA' name='theme-color' />
      </Head>
      <body className='bg-st-bg text-st-fg antialiased'>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
