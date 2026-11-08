import type { ReactNode } from 'react';

import { useRef } from 'react';

import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(useGSAP, ScrollTrigger);

const below = (el: Element) => el.getBoundingClientRect().top > window.innerHeight;

/**
 * Page entrances, all in one place. The markup is complete without JS: every initial state is set
 * here, only when motion is allowed, and only for things still below the fold (nothing on screen ever
 * blinks out). Transforms and opacity only; reduced motion = no motion at all.
 */
export function Motion({ children }: { children: ReactNode }) {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        const q = gsap.utils.selector(root);

        // Hero: the product shot rises into place, the value props follow. Movement only, no fade,
        // so the first paint stays fully readable.
        gsap.from(q('[data-hero-shot]'), { y: 28, duration: 0.7, ease: 'power3.out', delay: 0.05 });
        gsap.from(q('[data-hero-item]'), { y: 10, duration: 0.45, ease: 'power2.out', stagger: 0.06, delay: 0.2 });

        // Section reveals: items below the fold fade up in small staggered batches as they enter.
        const items = (q('[data-reveal-item]') as HTMLElement[]).filter(below);
        gsap.set(items, { opacity: 0, y: 20 });
        ScrollTrigger.batch(items, {
          start: 'top 90%',
          once: true,
          onEnter: (batch) =>
            gsap.to(batch, { opacity: 1, y: 0, duration: 0.45, ease: 'power2.out', stagger: 0.07, overwrite: true }),
        });

        // Phone → tablet: the "new photo" toast flies from the phone into the tablet's Inbox.
        q('[data-inbox-scene]').forEach((scene) => {
          const phone = scene.firstElementChild as HTMLElement | null;
          const toast = scene.querySelector<HTMLElement>('[data-inbox-toast]');
          if (!phone || !toast || !below(scene)) return;
          const p = phone.getBoundingClientRect();
          const t = toast.getBoundingClientRect();
          gsap.from(toast, {
            x: p.left + p.width / 2 - (t.left + t.width / 2),
            y: p.top + p.height / 2 - (t.top + t.height / 2),
            scale: 0.5,
            opacity: 0,
            duration: 0.8,
            ease: 'power3.inOut',
            scrollTrigger: { trigger: scene, start: 'top 70%', once: true },
          });
        });

        // MCP: the AI's marks draw themselves onto the student's page, then its note appears.
        q('[data-ai-page]').forEach((page) => {
          if (!below(page)) return;
          const strokes = page.querySelectorAll<SVGPathElement>('[data-draw]');
          const labels = page.querySelectorAll('[data-draw-label]');
          gsap.set(strokes, { strokeDasharray: 1, strokeDashoffset: 1 });
          gsap.set(labels, { opacity: 0 });
          gsap
            .timeline({ scrollTrigger: { trigger: page, start: 'top 70%', once: true }, delay: 0.3 })
            .to(strokes, { strokeDashoffset: 0, duration: 0.35, ease: 'power1.inOut', stagger: 0.25 })
            .to(labels, { opacity: 1, duration: 0.3, stagger: 0.1 }, '-=0.1');
        });
      });
    },
    { scope: root },
  );

  return <main ref={root}>{children}</main>;
}
