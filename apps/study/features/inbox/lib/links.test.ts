import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bearerHeader,
  dropUrl,
  inboxIdFromPdfFileName,
  inboxPdfFileName,
  inboxUploadErrorMessage,
  inboxUploadUrl,
  isDropToken,
  shortcutSteps,
} from './links';

const API = 'https://api.example.com';
const TOKEN = 'sk_drop_3f9a1c2e7b4d5a6f';

test('drop + upload URLs: trailing slashes trimmed, token encoded', () => {
  assert.equal(dropUrl(API, TOKEN), `${API}/study/drop?t=${TOKEN}`);
  assert.equal(dropUrl(`${API}//`, TOKEN), `${API}/study/drop?t=${TOKEN}`);
  assert.equal(dropUrl(API, 'a b&c'), `${API}/study/drop?t=a%20b%26c`);
  assert.equal(inboxUploadUrl(` ${API}/ `), `${API}/study/inbox`);
  assert.equal(bearerHeader(TOKEN), `Bearer ${TOKEN}`);
});

test('isDropToken', () => {
  assert.ok(isDropToken(TOKEN));
  assert.ok(!isDropToken('sk_live_123456789'));
  assert.ok(!isDropToken('sk_drop_'));
});

test('shortcut steps: the backend recipe with the real URL, header and form field', () => {
  const steps = shortcutSteps(API, TOKEN);
  const values = Object.fromEntries(steps.flatMap((step) => step.values ?? []).map((v) => [v.label, v]));

  assert.equal(steps.length, 5);
  assert.match(steps[0].title, /Show in Share Sheet/);
  assert.match(steps[0].detail!, /Images and PDFs/);
  assert.match(steps[1].title, /Repeat with Each.*Shortcut Input/);
  assert.match(steps[2].title, /Convert Image.*JPEG/);
  assert.match(steps[3].title, /Get Contents of URL.*POST.*File/);
  assert.equal(values.URL.value, `${API}/study/inbox`);
  assert.equal(values.Header.value, 'Authorization');
  assert.equal(values['Header value'].value, `Bearer ${TOKEN}`);
  assert.equal(values['Header value'].secret, true);
  assert.equal(values['File'].value, 'Converted Image');
  assert.match(steps[3].detail!, /Repeat Item/);
});

test('without a fresh token the secret is the <TOKEN> placeholder', () => {
  const header = shortcutSteps(API, null)
    .flatMap((step) => step.values ?? [])
    .find((v) => v.label === 'Header value');

  assert.equal(header!.value, 'Bearer <TOKEN>');
});

test('upload errors read as plain advice', () => {
  assert.match(inboxUploadErrorMessage(413, 'PAYLOAD_TOO_LARGE', 'x'), /25 MB/);
  assert.match(inboxUploadErrorMessage(415, 'HEIC_UNSUPPORTED', 'x'), /Convert Image/);
  assert.match(inboxUploadErrorMessage(415, 'UNSUPPORTED_TYPE', 'x'), /JPEG, PNG, HEIC, WebP and PDF/);
  assert.match(inboxUploadErrorMessage(429, undefined, 'Too many requests'), /60 every 10 minutes/);
  assert.equal(inboxUploadErrorMessage(400, 'VALIDATION_ERROR', 'file is required'), 'file is required');
});

test('inbox PDF file name round-trips to the item id', () => {
  assert.equal(inboxIdFromPdfFileName(inboxPdfFileName('65f0c1a2b3c4d5e6f7a8b9c0')), '65f0c1a2b3c4d5e6f7a8b9c0');
  assert.equal(inboxIdFromPdfFileName('Lecture 8.pdf'), null);
  assert.equal(inboxIdFromPdfFileName('phone-abc.jpg'), null);
  assert.equal(inboxIdFromPdfFileName(undefined), null);
});
