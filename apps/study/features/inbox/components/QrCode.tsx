import { useMemo } from 'react';

import { encodeQr, qrSvgPath } from '../lib/qr';

/** Dark-on-white always (brand navy, never pure black) (phone cameras read inverted codes badly), whatever the app theme. */
export function QrCode({ value, size = 220, label }: { value: string; size?: number; label?: string }) {
  const { path, modules } = useMemo(() => {
    const code = encodeQr(value, { ecc: 'M' });

    return { path: qrSvgPath(code, 4), modules: code.size + 8 };
  }, [value]);

  return (
    <svg
      aria-label={label ?? 'QR code'}
      className='rounded-st block shrink-0 bg-white'
      height={size}
      role='img'
      shapeRendering='crispEdges'
      viewBox={`0 0 ${modules} ${modules}`}
      width={size}
    >
      <rect fill='#ffffff' height={modules} width={modules} />
      <path d={path} fill='#18204A' />
    </svg>
  );
}
