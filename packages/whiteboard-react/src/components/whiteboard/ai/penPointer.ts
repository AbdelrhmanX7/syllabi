/**
 * The AI's pointer: an animated dot that pops in where the tutor «points», with a short note bubble
 * beside it. Pure DOM over the board (never a Fabric object, never saved) — it fades out on its own
 * after {@link POINTER_TTL_MS}. `prefers-reduced-motion` keeps the dot still (no pulse).
 */

import { PENCIL_SVG } from './writeOn';

export const POINTER_TTL_MS = 2500;
const FADE_MS = 350;
const STYLE_ID = 'wb-ai-pointer-style';

function ensurePointerStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');

  style.id = STYLE_ID;
  style.textContent = `
@keyframes wb-ai-pointer-pop { 0% { transform: translate(-50%, -50%) scale(0.2); opacity: 0; } 60% { transform: translate(-50%, -50%) scale(1.25); opacity: 1; } 100% { transform: translate(-50%, -50%) scale(1); opacity: 1; } }
@keyframes wb-ai-pointer-pulse { 0% { transform: translate(-50%, -50%) scale(0.6); opacity: 0.55; } 100% { transform: translate(-50%, -50%) scale(2.6); opacity: 0; } }
@keyframes wb-ai-pointer-note { 0% { opacity: 0; transform: translateY(4px); } 100% { opacity: 1; transform: translateY(0); } }
.wb-ai-pointer { position: absolute; pointer-events: none; z-index: 42; transition: opacity ${FADE_MS}ms ease; }
.wb-ai-pointer-dot { position: absolute; left: 0; top: 0; width: 14px; height: 14px; border-radius: 9999px; background: #18204a; border: 2.5px solid #fbfaf6; box-shadow: 0 1px 0 1px #18204a; animation: wb-ai-pointer-pop 420ms cubic-bezier(.2,.9,.3,1.3) both; }
.wb-ai-pointer-ring { position: absolute; left: 0; top: 0; width: 14px; height: 14px; border-radius: 9999px; border: 2px solid #18204a; animation: wb-ai-pointer-pulse 1100ms ease-out 200ms infinite; }
.wb-ai-pointer-note { position: absolute; bottom: 12px; max-width: 220px; padding: 4px 10px; border: 2px solid #18204a; border-radius: 9999px; background: #fbfaf6; color: #18204a; font-size: 12px; font-weight: 600; line-height: 1.35; white-space: normal; box-shadow: 2px 2px 0 0 #18204a; animation: wb-ai-pointer-note 260ms ease-out 180ms both; }
@media (prefers-reduced-motion: reduce) { .wb-ai-pointer-dot, .wb-ai-pointer-ring, .wb-ai-pointer-note { animation: none; } .wb-ai-pointer-ring { display: none; } .wb-ai-pointer-dot { transform: translate(-50%, -50%); } }
`;
  document.head.appendChild(style);
}

export interface PointerSpriteOptions {
  ttlMs?: number;
  /** Show the buddy's pencil (tip on the spot) instead of the dot. */
  pencil?: boolean;
  /** Fly in from this point (px inside `host`, e.g. the buddy button) instead of popping in place. */
  from?: { left: number; top: number };
}

const FLY_MS = 520;

/**
 * Shows the pointer at `(left, top)` px inside `host` (positioned). Returns a disposer; the sprite
 * removes itself after the TTL anyway.
 */
export function showPointerSprite(host: HTMLElement, at: { left: number; top: number }, note: string | undefined, { ttlMs = POINTER_TTL_MS, from, pencil }: PointerSpriteOptions = {}): () => void {
  ensurePointerStyle();

  const root = document.createElement('div');
  const dot = document.createElement('span');
  const ring = document.createElement('span');

  root.className = 'wb-ai-pointer';
  root.setAttribute('aria-hidden', 'true');
  root.style.left = `${Math.round(at.left)}px`;
  root.style.top = `${Math.round(at.top)}px`;
  dot.className = 'wb-ai-pointer-dot';
  ring.className = 'wb-ai-pointer-ring';
  if (pencil) {
    const icon = document.createElement('span');

    icon.style.cssText = 'position:absolute;left:0;top:-28px;width:28px;height:28px;';
    icon.innerHTML = PENCIL_SVG;
    root.append(ring, icon);
  } else {
    root.append(ring, dot);
  }

  if (note) {
    const bubble = document.createElement('span');

    bubble.className = 'wb-ai-pointer-note';
    bubble.textContent = note;
    bubble.style.left = pencil ? '26px' : '12px';

    root.appendChild(bubble);
  }

  const fly = from && !(typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

  if (fly) {
    // Transform only: start at the buddy, glide to the spot.
    root.style.transform = `translate(${Math.round(from.left - at.left)}px, ${Math.round(from.top - at.top)}px)`;
    root.style.transition = `transform ${FLY_MS}ms cubic-bezier(.3,.8,.3,1), opacity ${FADE_MS}ms ease`;
  }

  host.appendChild(root);

  if (fly) {
    void root.offsetWidth;
    root.style.transform = 'translate(0px, 0px)';
  }

  let removed = false;
  const remove = () => {
    if (removed) return;

    removed = true;
    root.remove();
  };
  const fade = setTimeout(() => {
    root.style.opacity = '0';
    setTimeout(remove, FADE_MS + 20);
  }, ttlMs);

  return () => {
    clearTimeout(fade);
    remove();
  };
}
