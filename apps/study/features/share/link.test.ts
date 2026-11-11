import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isLinkToken, linkPreviewUrl, loginHref, readLinkPreview, sharedPath } from './link';

const TOKEN = 'abcDEF0123456789_-abcDEF0123456789_-abcDEF0';

test('isLinkToken: 43 base64url chars only, never a share id', () => {
  assert.equal(TOKEN.length, 43);
  assert.equal(isLinkToken(TOKEN), true);
  assert.equal(isLinkToken('6af3d740e952d745fe45f40e'), false);
  assert.equal(isLinkToken(`${TOKEN}x`), false);
  assert.equal(isLinkToken(TOKEN.replace('_', '/')), false);
  assert.equal(isLinkToken(undefined), false);
});

test('readLinkPreview: takes title, kind, first name; rejects anything else', () => {
  assert.deepEqual(readLinkPreview({ preview: { title: 'Cells', resourceType: 'deck', ownerName: 'Maya', extra: 1 } }), {
    title: 'Cells',
    resourceType: 'deck',
    ownerName: 'Maya',
  });
  assert.equal(readLinkPreview({ preview: { title: 'Cells', resourceType: 'grades', ownerName: 'Maya' } }), null);
  assert.equal(readLinkPreview({ preview: { title: 3, resourceType: 'deck', ownerName: 'Maya' } }), null);
  assert.equal(readLinkPreview(null), null);
  assert.equal(readLinkPreview('nope'), null);
});

test('linkPreviewUrl: under /study, trailing slashes trimmed', () => {
  assert.equal(linkPreviewUrl('https://api.syllabi.studio/', TOKEN), `https://api.syllabi.studio/study/share/preview/${TOKEN}`);
});

test('loginHref: comes back to the link, on the right tab', () => {
  assert.equal(sharedPath(TOKEN), `/shared/?id=${TOKEN}`);
  const next = encodeURIComponent(`/shared/?id=${TOKEN}`);

  assert.equal(loginHref(TOKEN, 'create'), `/login/?tab=create&next=${next}`);
  assert.equal(loginHref(TOKEN, 'signin'), `/login/?next=${next}`);
  assert.equal(decodeURIComponent(new URLSearchParams(loginHref(TOKEN, 'create').split('?')[1]).get('next') ?? ''), `/shared/?id=${TOKEN}`);
});
