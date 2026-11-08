import { Head, Html, Main, NextScript } from 'next/document';

// Theme: the visitor's saved choice (ThemeToggle, localStorage syllabi_theme) wins; otherwise follow the OS.
// The app's tokens (and HeroUI's) switch on `.dark`; set it before first paint so there's no flash.
const THEME_SCRIPT = `(function(){try{var m=window.matchMedia('(prefers-color-scheme: dark)');var k='syllabi_theme';var s=function(){var v=null;try{v=localStorage.getItem(k)}catch(e){}document.documentElement.classList.toggle('dark',v?v==='dark':m.matches)};s();m.addEventListener?m.addEventListener('change',s):m.addListener(s)}catch(e){}})();`;

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
