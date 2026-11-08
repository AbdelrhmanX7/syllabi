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

        // Phone → tablet, on a loop while it's on screen: the camera frames the worksheet, the shutter
        // clicks, a copy of the page flies along the arc into the tablet, and the "New photo" toast pops.
        q('[data-inbox-scene]').forEach((scene) => {
          const pick = (sel: string) => scene.querySelector<HTMLElement>(sel);
          const paper = pick('[data-inbox-paper]');
          const toast = pick('[data-inbox-toast]');
          const flyer = pick('[data-inbox-flyer]');
          const flash = pick('[data-inbox-flash]');
          const shutter = pick('[data-inbox-shutter]');
          const path = scene.querySelector<SVGPathElement>('[data-inbox-path]');
          const corners = scene.querySelectorAll('[data-inbox-corner]');
          if (!paper || !toast || !flyer || !flash || !shutter || !path) return;

          const centre = (el: Element) => {
            const s = scene.getBoundingClientRect();
            const r = el.getBoundingClientRect();
            return { x: r.left - s.left + r.width / 2, y: r.top - s.top + r.height / 2 };
          };
          let from = { x: 0, y: 0 };
          let to = { x: 0, y: 0 };
          const trip = { t: 0 };
          const half = { w: flyer.offsetWidth / 2, h: flyer.offsetHeight / 2 };

          const tl = gsap.timeline({ paused: true, repeat: -1, repeatDelay: 2.4 });
          tl.set(toast, { opacity: 0, scale: 0.7 })
            .fromTo(corners, { scale: 1.3, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.35, stagger: 0.04, ease: 'power2.out' })
            .to(shutter, { scale: 0.78, duration: 0.09, yoyo: true, repeat: 1, ease: 'power1.inOut' }, '+=0.15')
            .fromTo(flash, { opacity: 0 }, { opacity: 0.85, duration: 0.07, yoyo: true, repeat: 1 }, '<0.05')
            .fromTo(
              trip,
              { t: 0 },
              {
                t: 1,
                duration: 0.95,
                ease: 'power2.inOut',
                onStart: () => {
                  from = centre(paper);
                  to = centre(toast);
                },
                onUpdate: () => {
                  const t = trip.t;
                  const lift = Math.min(from.y, to.y) - 40;
                  const cx = (from.x + to.x) / 2;
                  const x = (1 - t) ** 2 * from.x + 2 * (1 - t) * t * cx + t ** 2 * to.x;
                  const y = (1 - t) ** 2 * from.y + 2 * (1 - t) * t * lift + t ** 2 * to.y;
                  gsap.set(flyer, { x: x - half.w, y: y - half.h, rotation: -4 + 10 * t, scale: 1.5 - 0.8 * t, opacity: t < 0.92 ? 1 : (1 - t) / 0.08 });
                },
              },
            )
            .to(toast, { opacity: 1, scale: 1, duration: 0.45, ease: 'back.out(2.4)' }, '-=0.12')
            .to(corners, { opacity: 0, duration: 0.3 }, '+=0.6');

          const march = gsap.to(path, { strokeDashoffset: -16, duration: 0.9, ease: 'none', repeat: -1, paused: true });
          ScrollTrigger.create({
            trigger: scene,
            start: 'top 85%',
            end: 'bottom top',
            onToggle: (self) => {
              if (self.isActive) {
                tl.play();
                march.play();
              } else {
                tl.pause();
                march.pause();
              }
            },
          });
        });

        // "Share and study together": the box rises, the New badge pops, then each item comes in and its
        // icon acts out what it does (a fork draws itself, the clock winds back, a second person joins).
        // Hovering an item plays its icon again.
        const playIcon = (holder: Element) => {
          const svg = holder.querySelector('svg');
          if (!svg) return;
          const kind = (holder as HTMLElement).dataset.shareIcon;
          if (kind === 'history') {
            gsap.fromTo(svg, { rotation: 0 }, { rotation: -360, duration: 0.9, ease: 'power3.inOut', transformOrigin: '50% 50%' });
          } else if (kind === 'users') {
            const parts = svg.querySelectorAll('path, circle');
            const second = Array.from(parts).slice(2);
            gsap.fromTo(second, { x: 6, opacity: 0 }, { x: 0, opacity: 1, duration: 0.5, ease: 'back.out(2)', stagger: 0.05 });
            gsap.fromTo(Array.from(parts).slice(0, 2), { y: 0 }, { y: -2, duration: 0.18, yoyo: true, repeat: 1, delay: 0.3 });
          } else {
            svg.querySelectorAll<SVGGeometryElement>('path, circle, line').forEach((el, i) => {
              const len = el.getTotalLength();
              gsap.fromTo(
                el,
                { strokeDasharray: len, strokeDashoffset: len },
                { strokeDashoffset: 0, duration: 0.55, delay: i * 0.09, ease: 'power2.out', clearProps: 'strokeDasharray,strokeDashoffset' },
              );
            });
          }
        };
        const unhover: (() => void)[] = [];
        q('[data-share-box]').forEach((box) => {
          const items = Array.from(box.querySelectorAll('[data-share-item]'));
          const icons = Array.from(box.querySelectorAll('[data-share-icon]'));
          items.forEach((item) => {
            const icon = item.querySelector('[data-share-icon]');
            if (!icon) return;
            const onEnter = () => playIcon(icon);
            item.addEventListener('mouseenter', onEnter);
            unhover.push(() => item.removeEventListener('mouseenter', onEnter));
          });
          if (!below(box)) return;
          gsap
            .timeline({ scrollTrigger: { trigger: box, start: 'top 85%', once: true } })
            .from(box, { y: 24, opacity: 0, duration: 0.5, ease: 'power3.out' })
            .from(box.querySelector('[data-share-badge]'), { scale: 0.4, opacity: 0, duration: 0.5, ease: 'back.out(3)' }, '-=0.2')
            .from(box.querySelector('[data-share-title]'), { x: -12, opacity: 0, duration: 0.4, ease: 'power2.out' }, '<0.05')
            .from(items, { y: 16, opacity: 0, duration: 0.45, stagger: 0.12, ease: 'power2.out' }, '-=0.15')
            .add(() => icons.forEach((icon, i) => gsap.delayedCall(0.1 + i * 0.12, () => playIcon(icon))), '<');
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

        return () => unhover.forEach((off) => off());
      });
    },
    { scope: root },
  );

  return <main ref={root}>{children}</main>;
}
