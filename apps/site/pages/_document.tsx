import { Head, Html, Main, NextScript } from 'next/document';

// Dark mode follows the OS: the app's tokens (and HeroUI's) switch on `.dark`, so mirror
// prefers-color-scheme onto <html> before first paint and keep it in sync if the OS flips.
const THEME_SCRIPT = `(function(){try{var m=window.matchMedia('(prefers-color-scheme: dark)');var s=function(){document.documentElement.classList.toggle('dark',m.matches)};s();m.addEventListener?m.addEventListener('change',s):m.addListener(s)}catch(e){}})();`;

export default function Document() {
  return (
    <Html lang='en'>
      <Head>
        <link href='/favicon.ico' rel='icon' sizes='any' />
        <link href='/logo-icon.svg' rel='icon' type='image/svg+xml' />
        <link href='/apple-touch-icon.png' rel='apple-touch-icon' />
        <link as='font' crossOrigin='anonymous' href='/font/Inter-latin.woff2' rel='preload' type='font/woff2' />
        <link
          as='font'
          crossOrigin='anonymous'
          href='/font/BricolageGrotesque-latin.woff2'
          rel='preload'
          type='font/woff2'
        />
        <meta content='light dark' name='color-scheme' />
        <meta content='#fbfaf6' media='(prefers-color-scheme: light)' name='theme-color' />
        <meta content='#090d20' media='(prefers-color-scheme: dark)' name='theme-color' />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </Head>
      <body className='bg-st-bg text-st-fg antialiased'>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
