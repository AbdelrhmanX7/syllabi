import type { ImgHTMLAttributes } from 'react';

// App screenshot that follows the page theme: /shots/x.png in light, /shots/x-dark.png in dark.
// Both are in the HTML; CSS (.shot-light / .shot-dark in globals.css) shows the right one, so no flash.
export function ThemedShot({ src, className, ...props }: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const dark = src.replace(/\.png$/, '-dark.png');
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img {...props} className={`shot-light ${className ?? ''}`} src={src} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img {...props} alt='' aria-hidden className={`shot-dark ${className ?? ''}`} fetchPriority='low' src={dark} />
    </>
  );
}
