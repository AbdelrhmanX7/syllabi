import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { JSDOM } from 'jsdom';

import { CHROME_ATTR, CHROME_INSET_VAR, chromeInsetsFromRects, measureChromeInsets, observeChromeInset } from './chromeInsets';

type Callback = (entries: unknown[]) => void;

// jsdom ships no ResizeObserver and no layout: the observer is driven by hand and the width comes
// from a stubbed getBoundingClientRect, which is exactly the contract the helper relies on.
let callbacks: Callback[];
let observed: Element[];
let disconnected: number;

beforeEach(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const globals = globalThis as unknown as Record<string, unknown>;

  globals.window = dom.window;
  globals.document = dom.window.document;
  globals.HTMLElement = dom.window.HTMLElement;
  callbacks = [];
  observed = [];
  disconnected = 0;
  globals.ResizeObserver = class {
    constructor(callback: Callback) {
      callbacks.push(callback);
    }
    observe(element: Element) {
      observed.push(element);
    }
    unobserve() {}
    disconnect() {
      disconnected += 1;
    }
  };
});

afterEach(() => {
  const globals = globalThis as unknown as Record<string, unknown>;

  delete globals.ResizeObserver;
});

function chrome(width: number) {
  const host = document.createElement('div');
  const element = document.createElement('div');
  let current = width;

  element.getBoundingClientRect = () =>
    ({ x: 0, y: 0, width: current, height: 36, top: 0, left: 0, right: current, bottom: 36, toJSON: () => ({}) }) as DOMRect;
  host.appendChild(element);

  return { host, element, resize: (next: number) => (current = next) };
}

describe('observeChromeInset', () => {
  it('writes the chrome width to the host as the side variable, rounded up to whole px', () => {
    const { host, element } = chrome(184.4);

    observeChromeInset(element, 'end', host);

    assert.equal(host.style.getPropertyValue(CHROME_INSET_VAR.end), '185px');
    assert.equal(host.style.getPropertyValue(CHROME_INSET_VAR.start), '');
    assert.deepEqual(observed, [element]);
  });

  it('follows the chrome as it grows and shrinks', () => {
    const { host, element, resize } = chrome(100);

    observeChromeInset(element, 'start', host);
    resize(420);
    callbacks[0]([]);
    assert.equal(host.style.getPropertyValue(CHROME_INSET_VAR.start), '420px');

    resize(60);
    callbacks[0]([]);
    assert.equal(host.style.getPropertyValue(CHROME_INSET_VAR.start), '60px');
  });

  it('gives the space back on teardown', () => {
    const { host, element } = chrome(200);
    const teardown = observeChromeInset(element, 'end', host);

    teardown();

    assert.equal(host.style.getPropertyValue(CHROME_INSET_VAR.end), '');
    assert.equal(disconnected, 1);
  });

  it('marks the element as chrome while observed', () => {
    const { host, element } = chrome(200);
    const teardown = observeChromeInset(element, 'start', host);

    assert.equal(element.getAttribute(CHROME_ATTR), 'start');
    teardown();
    assert.equal(element.hasAttribute(CHROME_ATTR), false);
  });

  it('still writes the width once when ResizeObserver is missing', () => {
    delete (globalThis as unknown as Record<string, unknown>).ResizeObserver;
    const { host, element } = chrome(150);
    const teardown = observeChromeInset(element, 'end', host);

    assert.equal(host.style.getPropertyValue(CHROME_INSET_VAR.end), '150px');
    teardown();
    assert.equal(host.style.getPropertyValue(CHROME_INSET_VAR.end), '');
  });
});

describe('chromeInsetsFromRects', () => {
  const area = { left: 0, top: 0, width: 1000, height: 700 };

  it('a wrapped top toolbar and the title bar reserve the top strip down to the lowest of them', () => {
    const insets = chromeInsetsFromRects(area, [
      { left: 300, top: 12, width: 400, height: 110 }, // toolbar wrapped into rows
      { left: 900, top: 12, width: 88, height: 40 }, // title bar
    ]);

    assert.deepEqual(insets, { top: 122, right: 0, bottom: 0, left: 0 });
  });

  it('assigns each box to its nearest edge, and ignores hidden or off-area chrome', () => {
    const insets = chromeInsetsFromRects(area, [
      { left: 300, top: 640, width: 400, height: 48 }, // bottom dock
      { left: 8, top: 100, width: 60, height: 500 }, // left dock
      { left: 0, top: 0, width: 0, height: 0 }, // hidden
      { left: 1200, top: 10, width: 50, height: 50 }, // outside
    ]);

    assert.deepEqual(insets, { top: 0, right: 0, bottom: 60, left: 68 });
  });

  it('measureChromeInsets reads every marked element in the document', () => {
    const element = document.createElement('div');

    element.setAttribute(CHROME_ATTR, 'toolbar');
    element.getBoundingClientRect = () => ({ x: 200, y: 50, width: 300, height: 50, top: 50, left: 200, right: 500, bottom: 100, toJSON: () => ({}) }) as DOMRect;
    document.body.appendChild(element);

    assert.deepEqual(measureChromeInsets({ left: 0, top: 40, width: 1000, height: 700 }), { top: 60, right: 0, bottom: 0, left: 0 });
  });
});
