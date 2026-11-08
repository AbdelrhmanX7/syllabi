import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import { WB_STRINGS, wbT } from './strings';

const ARABIC = /[\u0600-\u06FF]/;
const SRC = join(__dirname, '..');

test('every dictionary entry has English copy', () => {
  for (const [key, text] of Object.entries(WB_STRINGS)) {
    assert.ok(text.trim(), `${key}: empty`);
  }
});

test('wbT fills placeholders', () => {
  assert.equal(wbT('en', 'pages.pageN', { n: 3 }), 'Page 3');
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) return entry.name === 'vendor' ? [] : sourceFiles(path);

    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

test('no Arabic text is left in the package source', () => {
  const offenders: string[] = [];

  for (const file of sourceFiles(SRC)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (ARABIC.test(line)) offenders.push(`${relative(SRC, file)}:${index + 1}: ${line.trim().slice(0, 100)}`);
      });
  }

  assert.deepEqual(offenders, []);
});
