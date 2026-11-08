import type { KatexModule } from '../lib/katex';

import React, { useMemo } from 'react';

import { TOKEN_CLASS, tokenizeCode } from '../lib/codeHighlight';
import { renderKatexHtml, useKatex } from '../lib/katex';
import { parseInline, parseMarkdown } from '../lib/markdown';

/**
 * Renders question markdown: paragraphs, headings, lists, images, fenced code (tokenised), `$…$`
 * inline and `$$…$$` display math through KaTeX. Everything is LTR English, so no bidi wrapping.
 */

export function InlineMd({ text, katex }: { text: string; katex: KatexModule | null }) {
  const parts = useMemo(() => parseInline(text), [text]);

  return (
    <>
      {parts.map((part, index) => {
        switch (part.kind) {
          case 'bold':
            return <strong key={index}>{part.value}</strong>;
          case 'em':
            return <em key={index}>{part.value}</em>;
          case 'code':
            return (
              <code key={index} className='rounded bg-st-raised px-1.5 py-0.5 font-mono text-[0.9em]'>
                {part.value}
              </code>
            );
          case 'math': {
            const html = renderKatexHtml(katex, part.value, false);

            return html ? (
              <span dangerouslySetInnerHTML={{ __html: html }} key={index} className='inline-block align-middle' />
            ) : (
              <code key={index} className='rounded bg-st-raised px-1 font-mono text-[0.9em]'>
                {part.value}
              </code>
            );
          }
          case 'link':
            return (
              <a
                key={index}
                className='text-st-accent underline-offset-2 hover:underline'
                href={part.href}
                rel='noreferrer'
                target='_blank'
              >
                {part.value}
              </a>
            );
          default:
            return <React.Fragment key={index}>{part.value}</React.Fragment>;
        }
      })}
    </>
  );
}

export function MathBlock({ tex, katex }: { tex: string; katex: KatexModule | null }) {
  const html = renderKatexHtml(katex, tex, true);

  return html ? (
    <div dangerouslySetInnerHTML={{ __html: html }} className='my-2 overflow-x-auto text-center text-[1.05em]' />
  ) : (
    <pre className='my-2 overflow-x-auto rounded-xl bg-st-raised p-3 font-mono text-sm'>{tex}</pre>
  );
}

export function CodeBlock({ code, lang, className = '' }: { code: string; lang?: string; className?: string }) {
  const tokens = useMemo(() => tokenizeCode(code), [code]);

  return (
    <pre
      className={`my-2 overflow-x-auto rounded-xl border border-st-line bg-st-bg p-3 font-mono text-sm leading-6 text-st-fg ${className}`}
      data-lang={lang}
    >
      <code>
        {tokens.map((token, index) => (
          <span key={index} className={TOKEN_CLASS[token.kind]}>
            {token.text}
          </span>
        ))}
      </code>
    </pre>
  );
}

export interface MarkdownProps {
  text: string;
  className?: string;
  /** Larger type for the question stem. */
  size?: 'md' | 'lg';
}

export function Markdown({ text, className = '', size = 'md' }: MarkdownProps) {
  const katex = useKatex();
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const base = size === 'lg' ? 'text-lg leading-8' : 'text-base leading-7';

  return (
    <div className={`${base} text-st-fg ${className}`}>
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'h':
            return (
              <p key={index} className='mb-1 mt-3 text-[1.05em] font-semibold first:mt-0'>
                <InlineMd katex={katex} text={block.text} />
              </p>
            );
          case 'code':
            return <CodeBlock key={index} code={block.code} lang={block.lang} />;
          case 'math':
            return <MathBlock key={index} katex={katex} tex={block.tex} />;
          case 'img':
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={index}
                alt={block.alt}
                className='my-2 max-h-[420px] w-auto max-w-full rounded-xl'
                src={block.src}
              />
            );
          case 'list':
            return block.ordered ? (
              <ol key={index} className='my-1 list-decimal space-y-0.5 ps-6'>
                {block.items.map((item, i) => (
                  <li key={i}>
                    <InlineMd katex={katex} text={item} />
                  </li>
                ))}
              </ol>
            ) : (
              <ul key={index} className='my-1 list-disc space-y-0.5 ps-6'>
                {block.items.map((item, i) => (
                  <li key={i}>
                    <InlineMd katex={katex} text={item} />
                  </li>
                ))}
              </ul>
            );
          default:
            return (
              <p key={index} className='my-1 whitespace-pre-wrap first:mt-0'>
                <InlineMd katex={katex} text={block.text} />
              </p>
            );
        }
      })}
    </div>
  );
}
