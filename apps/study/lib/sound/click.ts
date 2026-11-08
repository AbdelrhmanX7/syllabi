// A soft «tock» when a button is pressed. Synthesized with the Web Audio API (no sound file, ~1 ms of
// work per press), one shared AudioContext made on the first press (browsers only allow audio after a
// gesture). Per device on/off in localStorage; on by default.

const KEY = 'study_click_sounds';
const EVENT = 'study-click-sounds';

type Ctx = AudioContext;

let ctx: Ctx | null = null;
let last = 0;

export function clickSoundsOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

export function setClickSounds(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // ignore
  }
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    // ignore
  }
}

export function subscribeClickSounds(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);

  return () => window.removeEventListener(EVENT, cb);
}

function audio(): Ctx | null {
  if (ctx) return ctx;
  const AC =
    (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  if (!AC) return null;
  try {
    ctx = new AC();
  } catch {
    ctx = null;
  }

  return ctx;
}

/** Play the click once. Rapid repeats (under 40 ms) are skipped. */
export function playClick(strong = false) {
  const now = Date.now();

  if (now - last < 40) return;
  last = now;
  const ac = audio();

  if (!ac) return;
  try {
    if (ac.state === 'suspended') void ac.resume();
    const t = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(strong ? 660 : 880, t);
    osc.frequency.exponentialRampToValueAtTime(strong ? 330 : 440, t + 0.06);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(strong ? 0.12 : 0.08, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    osc.connect(gain).connect(ac.destination);
    osc.start(t);
    osc.stop(t + 0.09);
  } catch {
    // ignore
  }
}

const PRESSABLE = 'button, [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="menuitem"], [role="option"], a[data-sound]';

/** One listener for the whole app: any enabled button-like control clicks. Returns the remover. */
export function installClickSounds(): () => void {
  const onDown = (event: PointerEvent) => {
    if (!event.isPrimary || event.button > 0) return;
    if (!clickSoundsOn()) return;
    const target = event.target as Element | null;
    const el = target?.closest?.(PRESSABLE) as HTMLElement | null;

    if (!el || el.matches(':disabled, [aria-disabled="true"]')) return;
    // The drawing board handles its own pointer; never tick while writing.
    if (el.closest('[data-no-click-sound], canvas')) return;
    playClick(el.matches('[type="submit"], [data-variant="primary"]'));
  };

  document.addEventListener('pointerdown', onDown, { capture: true, passive: true });

  return () => document.removeEventListener('pointerdown', onDown, { capture: true });
}
