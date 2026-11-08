// Lazy KaTeX (same approach as packages/whiteboard-react/.../ai/rasterize.ts, without the Fabric
// font plumbing): the chunk and its stylesheet load the first time a formula is rendered.

import { useEffect, useState } from 'react';

type KatexModule = typeof import('katex');

let katexPromise: Promise<KatexModule | null> | null = null;

export function loadKatex(): Promise<KatexModule | null> {
  if (!katexPromise) {
    katexPromise = Promise.all([import('katex'), import('katex/dist/katex.min.css').catch(() => null)])
      .then(([module]) => ((module as unknown as { default?: KatexModule }).default ?? module) as KatexModule)
      .catch(() => {
        katexPromise = null;

        return null;
      });
  }

  return katexPromise;
}

export function renderKatexHtml(katex: KatexModule | null, tex: string, displayMode: boolean): string | null {
  if (!katex) return null;

  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      output: 'html',
      strict: 'ignore',
      trust: false,
    });
  } catch {
    return null;
  }
}

export function useKatex(): KatexModule | null {
  const [katex, setKatex] = useState<KatexModule | null>(null);

  useEffect(() => {
    let alive = true;

    void loadKatex().then((module) => {
      if (alive) setKatex(module);
    });

    return () => {
      alive = false;
    };
  }, []);

  return katex;
}

export type { KatexModule };
