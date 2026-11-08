/**
 * Test assets — a dependency-free PNG encoder plus a tiny static host.
 *
 * Figures are generated and served over a REAL loopback HTTP server on purpose:
 * `naturalWidth > 0` then means the browser actually fetched and decoded the
 * bytes. A `data:` URI would decode even if the app dropped the network layer,
 * and a missing file would render a broken-image box that still has an `<img>`.
 */
import http from 'node:http';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);

  for (let n = 0; n < 256; n++) {
    let c = n;

    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }

  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;

  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);

  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);

  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);

  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);

  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * An 8-bit truecolour PNG.
 *
 * @param {number} width
 * @param {number} height
 * @param {object} [options]
 * @param {[number,number,number]} [options.bg] background colour
 * @param {[number,number,number]} [options.accent] border / band colour
 * @param {boolean} [options.band] draw a diagonal band
 * @param {boolean} [options.border] draw a 4px border
 * @param {(x:number,y:number,w:number,h:number)=>[number,number,number]} [options.paint]
 *   full control — when given, `bg`/`accent`/`band`/`border` are ignored.
 */
export function makePng(width, height, options = {}) {
  const { bg = [236, 240, 248], accent = [37, 99, 235], band = true, border = true, paint = null } = options;
  const raw = Buffer.alloc(height * (1 + width * 3));

  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);

    raw[rowStart] = 0; // filter: none

    for (let x = 0; x < width; x++) {
      let color;

      if (paint) {
        color = paint(x, y, width, height);
      } else {
        const onBorder = border && (x < 4 || y < 4 || x >= width - 4 || y >= height - 4);
        const onBand = band && Math.abs(x - y * (width / height)) < 18;

        color = onBorder || onBand ? accent : bg;
      }

      const off = rowStart + 1 + x * 3;

      raw[off] = color[0];
      raw[off + 1] = color[1];
      raw[off + 2] = color[2];
    }
  }

  const ihdr = Buffer.alloc(13);

  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Serve a `{ '/path.png': Buffer }` table on loopback.
 *
 * Port 0 by default: the OS picks a free one and the caller builds fixture URLs
 * from the returned origin, so two runs never collide on a hard-coded port.
 */
export async function startAssetServer(files, { port = 0, host = '127.0.0.1' } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const key = (req.url || '').split('?')[0];

    hits.push(key);

    const body = files[key];

    if (!body) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('no such asset');

      return;
    }

    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const origin = `http://${host}:${server.address().port}`;

  return {
    origin,
    hits,
    url: (p) => `${origin}${p}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * The two-figure host every figure scenario uses: `/fig-1.png` and `/fig-3.png`,
 * deliberately different sizes AND colours so a swapped `src` is visible both in
 * an assertion (naturalWidth) and in a screenshot.
 */
export async function startFigureHost({ port = 0 } = {}) {
  const files = {
    '/fig-1.png': makePng(320, 200, { bg: [236, 240, 248], accent: [37, 99, 235] }),
    '/fig-3.png': makePng(320, 200, { bg: [253, 244, 234], accent: [217, 70, 40] }),
  };

  const server = await startAssetServer(files, { port });

  return { ...server, fig1: server.url('/fig-1.png'), fig3: server.url('/fig-3.png') };
}
