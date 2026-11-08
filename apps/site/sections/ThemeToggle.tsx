import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

const KEY = 'syllabi_theme';

/** Light/dark switch for the site. Remembers the choice; with no choice the page follows the device. */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const html = document.documentElement;
    setDark(html.classList.contains('dark'));
    const obs = new MutationObserver(() => setDark(html.classList.contains('dark')));
    obs.observe(html, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  const flip = () => {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem(KEY, next ? 'dark' : 'light');
    } catch {}
  };
  return (
    <button
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      className='border-st-clay-edge bg-st-surface text-st-fg shadow-clay hover:bg-st-accent-soft inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border-2 transition-[transform,box-shadow] duration-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-st-accent active:translate-y-[3px] active:shadow-none'
      onClick={flip}
      title={dark ? 'Light mode' : 'Dark mode'}
      type='button'
    >
      {dark ? <Sun aria-hidden className='h-5 w-5' /> : <Moon aria-hidden className='h-5 w-5' />}
    </button>
  );
}
