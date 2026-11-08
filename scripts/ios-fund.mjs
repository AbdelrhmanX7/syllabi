// Renders .github/ios-fund.svg (the README's iOS fund progress bar) from .github/ios-fund.json.
// Usage: edit "raised" in .github/ios-fund.json, then `node scripts/ios-fund.mjs`.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { goal, raised } = JSON.parse(readFileSync(`${root}.github/ios-fund.json`, 'utf8'));
const pct = Math.max(0, Math.min(1, raised / goal));
const W = 640, H = 92, PAD = 20, BAR_Y = 52, BAR_H = 16, BAR_W = W - PAD * 2;
const fill = Math.round(BAR_W * pct);
const label = pct >= 1 ? 'Funded — iPad app coming' : `$${raised} of $${goal} raised`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="iOS fund: ${label}">
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="16" fill="#F4F6FD" stroke="#C9D3F5" stroke-width="2"/>
  <text x="${PAD}" y="34" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="17" font-weight="700" fill="#1B2350">iOS / iPad fund</text>
  <text x="${W - PAD}" y="34" text-anchor="end" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="15" font-weight="600" fill="#3A4370">${label} · ${Math.round(pct * 100)}%</text>
  <rect x="${PAD}" y="${BAR_Y}" width="${BAR_W}" height="${BAR_H}" rx="8" fill="#DCE3FA"/>
  ${fill > 0 ? `<rect x="${PAD}" y="${BAR_Y}" width="${Math.max(fill, BAR_H)}" height="${BAR_H}" rx="8" fill="#2F5BEA"/>` : ''}
</svg>
`;
writeFileSync(`${root}.github/ios-fund.svg`, svg);
console.log(`ios-fund.svg: ${label} (${Math.round(pct * 100)}%)`);
