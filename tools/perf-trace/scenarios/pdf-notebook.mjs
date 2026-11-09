/**
 * A PDF opened as a notebook, then used like a student does: scroll through it with a finger, write with
 * the pen, write straight after scrolling (while new pages are still being drawn), and zoom.
 *
 *   node tools/perf-trace/fixtures/make-pdf.mjs     # once: builds the test PDFs
 *   node tools/perf-trace/run.mjs pdf-notebook --device s10u [--pdf textbook|scanned] [--base http://localhost:3022]
 *
 * Runs on demo data (no server needed). Input goes through CDP so the board sees real touch and pen events:
 * a finger pans the continuous PDF layout once the board has «seen a pen» (localStorage flag).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const settle = (page, ms) => page.waitForTimeout(ms);

/** The board's drawing surface centre, in CSS px. */
async function boardBox(page) {
  const box = await page.locator('canvas.upper-canvas').first().boundingBox();

  if (!box) throw new Error('board canvas not found');

  return box;
}

/** One finger flick: `distance` px upward over ~`duration` ms, at 60 Hz. */
async function flick(cdp, x, y, distance, duration = 400) {
  const steps = Math.max(2, Math.round(duration / 16));

  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: y - (distance * i) / steps, id: 1 }],
    });
    await new Promise((r) => setTimeout(r, 16));
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** One handwritten-looking pen stroke (a wavy line) at ~120 Hz, like an S Pen. */
async function penStroke(cdp, x, y, width = 260, points = 48) {
  const at = (i) => ({ x: x + (width * i) / points, y: y + Math.sin(i / 3) * 14 });
  const base = { pointerType: 'pen', button: 'left', force: 0.5 };

  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', ...at(0), buttons: 1, clickCount: 1 });
  for (let i = 1; i <= points; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', ...at(i), buttons: 1 });
    await new Promise((r) => setTimeout(r, 8));
  }
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', ...at(points), buttons: 0, clickCount: 1 });
}

export const phases = [
  {
    name: 'open notes',
    run: async (page, { base }) => {
      // A finger pans (instead of drawing) once a pen has been seen on this device.
      await page.addInitScript(() => localStorage.setItem('whiteboard-has-seen-pen', '1'));
      await page.goto(`${base}/notes/`, { waitUntil: 'load' });
      await page.getByRole('button', { name: 'Import pages' }).waitFor();
      await settle(page, 1500);
    },
  },
  {
    name: 'import PDF + first page',
    run: async (page, { flag }) => {
      const file = path.join(HERE, '..', 'fixtures', `${flag('pdf', 'textbook')}.pdf`);
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.getByRole('button', { name: 'Import pages' }).click(),
      ]);

      await chooser.setFiles(file);
      await page.getByRole('button', { name: 'Open notebook' }).click({ timeout: 60000 });
      await page.waitForURL(/\/notebook\//, { timeout: 120000 });
      await page.locator('canvas.upper-canvas').first().waitFor({ timeout: 60000 });
      await settle(page, 6000);
    },
  },
  {
    name: 'scroll 12 flicks',
    run: async (page, { cdp }) => {
      const box = await boardBox(page);

      for (let i = 0; i < 12; i += 1) {
        await flick(cdp, box.x + box.width * 0.6, box.y + box.height * 0.8, box.height * 0.6);
        await settle(page, 250);
      }
      await settle(page, 1500);
    },
  },
  {
    name: 'write 12 strokes',
    run: async (page, { cdp }) => {
      const box = await boardBox(page);

      for (let i = 0; i < 12; i += 1) await penStroke(cdp, box.x + 120, box.y + 120 + i * 40);
      await settle(page, 1500);
    },
  },
  {
    name: 'scroll then write at once',
    run: async (page, { cdp }) => {
      const box = await boardBox(page);

      for (let i = 0; i < 6; i += 1) {
        await flick(cdp, box.x + box.width * 0.6, box.y + box.height * 0.8, box.height * 0.7, 300);
        await penStroke(cdp, box.x + 160, box.y + box.height * 0.4);
        await penStroke(cdp, box.x + 160, box.y + box.height * 0.4 + 40);
      }
      await settle(page, 1500);
    },
  },
  {
    name: 'zoom in + out',
    run: async (page) => {
      const box = await boardBox(page);

      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.keyboard.down('Control');
      for (let i = 0; i < 8; i += 1) (await page.mouse.wheel(0, -120), await settle(page, 60));
      await settle(page, 1200);
      for (let i = 0; i < 8; i += 1) (await page.mouse.wheel(0, 120), await settle(page, 60));
      await page.keyboard.up('Control');
      await settle(page, 1500);
    },
  },
];
