# thinking-orbs (vendored)

- Package: `thinking-orbs` **v0.3.2** — MIT © Jakub Antalik (see `LICENSE`).
- Source: https://registry.npmjs.org/thinking-orbs/-/thinking-orbs-0.3.2.tgz
  (sha256 `2032b34cf1c336c395c65d46803eb5830b7e79064986ccde5c7308fdb4a43080`),
  repo https://github.com/Jakubantalik/Libraries.dev/tree/main/packages/thinking-orbs, demo https://libraries.dev/orbs.
- Files: the published `dist/` ESM build, unmodified — `index.es.js` renamed to `index.js`, plus the
  `.d.ts` files so TypeScript resolves the types next to it. The CJS build is not copied.

Why vendored instead of a dependency: this worktree installs with yarn 1 and no yarn binary was
available to update `yarn.lock`; adding an unlocked dependency would break frozen-lockfile installs
(desktop / APK builds). The package has zero dependencies (peer: `react >= 18`), so the copy is
self-contained. To switch to the registry package later: `yarn add thinking-orbs@0.3.2` in
`packages/whiteboard-react`, delete this folder, and change the one import in
`components/whiteboard/ai/RemakeOrb.tsx`.

Brand colour comes from the library's own `color` prop (a tint that keeps the depth ramp) — no patch.
