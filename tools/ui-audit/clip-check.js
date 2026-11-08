// Paste into page.evaluate(CLIP_CHECK) — returns a list of clipped/overflowing elements on the current page.
// Usage in a Playwright script:
//   const CLIP_CHECK = require('fs').readFileSync('<scratchpad>/clip-check.js', 'utf8');
//   const issues = await page.evaluate(CLIP_CHECK);
// Catches: content wider than its overflow-hidden box (cut text, cut Select values, cut chips/buttons),
// elements poking outside the viewport, page-level sideways scroll, text squeezed under 1 char,
// and controls hidden under the fixed phone bottom bar.
(() => {
  const vw = document.documentElement.clientWidth;
  const out = [];
  const label = (el) => {
    const t = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    const cls = (el.className && typeof el.className === 'string' ? el.className : '').split(' ').slice(0, 3).join('.');
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} «${t}»`;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  if (document.documentElement.scrollWidth > vw + 1) out.push(`PAGE scrolls sideways: ${document.documentElement.scrollWidth}/${vw}`);
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    // Screen-reader-only text is clipped on purpose.
    if (el.closest('.sr-only') || (r.width <= 1 && r.height <= 1) || s.clip.startsWith('rect(0')) continue;
    // 1. Content cut by its own box (text-overflow ellipsis counts — owner wants it reported).
    const clipsX = ['hidden', 'clip'].includes(s.overflowX) || s.textOverflow === 'ellipsis';
    const clipsY = ['hidden', 'clip'].includes(s.overflowY);
    // One-line list/nav titles truncate by rule (ui-rules §3) when the full text is on the element.
    const ruleTruncate = s.textOverflow === 'ellipsis' && el.closest('[title]');
    if (clipsX && !ruleTruncate && el.scrollWidth > el.clientWidth + 2 && (el.innerText || '').trim()) {
      out.push(`CUT-X ${label(el)} content ${el.scrollWidth}px in ${el.clientWidth}px`);
    }
    if (clipsY && el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0 && el.clientHeight < 200 && (el.innerText || '').trim()) {
      out.push(`CUT-Y ${label(el)} content ${el.scrollHeight}px in ${el.clientHeight}px`);
    }
    // 2. Pokes outside the viewport horizontally (but not inside an intentional scroll container).
    if ((r.right > vw + 1 || r.left < -1) && el.children.length === 0 && (el.innerText || '').trim()) {
      let p = el.parentElement, scroller = false;
      while (p) { const ps = getComputedStyle(p); if (['auto', 'scroll'].includes(ps.overflowX) && p.scrollWidth > p.clientWidth) { scroller = true; break; } p = p.parentElement; }
      if (!scroller) out.push(`OFFSCREEN ${label(el)} x=${Math.round(r.left)}..${Math.round(r.right)} vw=${vw}`);
    }
  }
  // 2b. Card edges / lips / shadows sliced by a scroll or overflow ancestor (the owner's repeat complaint).
  const shadowExtent = (s) => {
    const sh = s.boxShadow;
    if (!sh || sh === 'none') return { top: 0, bottom: 0, side: 0, lip: 0 };
    let top = 0, bottom = 0, side = 0, lip = 0;
    for (const part of sh.split(/,(?![^(]*\))/)) {
      if (part.includes('inset')) continue;
      const n = (part.replace(/rgba?\([^)]*\)|oklch\([^)]*\)|#[0-9a-f]+/gi, '').match(/-?\d+(\.\d+)?px/g) || []).map(parseFloat);
      const [x = 0, y = 0, blur = 0, spread = 0] = n;
      if (blur === 0) lip = Math.max(lip, y + spread);
      bottom = Math.max(bottom, y + blur + spread);
      top = Math.max(top, -y + blur + spread);
      side = Math.max(side, Math.abs(x) + blur + spread);
    }
    return { top, bottom, side, lip };
  };
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const s = getComputedStyle(el);
    const hasBorder = parseFloat(s.borderTopWidth) > 0 || parseFloat(s.borderBottomWidth) > 0;
    const ext = shadowExtent(s);
    if (!hasBorder && ext.bottom < 2 && ext.top < 2) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 20 || r.width < 40) continue;
    let p = el.parentElement;
    while (p && p !== document.body) {
      const ps = getComputedStyle(p);
      if (/(hidden|auto|scroll|clip)/.test(ps.overflowX + ps.overflowY)) {
        const pr = p.getBoundingClientRect();
        const bt = parseFloat(ps.borderTopWidth), bb = parseFloat(ps.borderBottomWidth);
        const clipTop = pr.top + bt, clipBottom = pr.bottom - bb;
        // Only edges that sit at the scroll boundary right now (not rows scrolled out of view on purpose).
        // A box that scrolls only slices items at its resting ends (scrolled to top / to the end); mid-scroll
        // the cut is the scroll itself, covered by the scroll shadow.
        const scrollsY = /(auto|scroll)/.test(ps.overflowY) && p.scrollHeight > p.clientHeight + 1;
        const atTop = !scrollsY || p.scrollTop <= 0;
        const atEnd = !scrollsY || p.scrollTop + p.clientHeight >= p.scrollHeight - 1;
        const cutTop = atTop && r.top < clipTop - 0.5 + (ext.top > 2 ? ext.top : 0) && r.bottom > clipTop && r.top > clipTop - 40;
        const cutBottom = atEnd && r.bottom + (ext.bottom > 2 ? ext.bottom : 0) > clipBottom + 0.5 && r.top < clipBottom && r.bottom < clipBottom + 40;
        if (cutTop || cutBottom) out.push(`EDGE-CUT ${label(el)} ${cutTop ? 'top' : 'bottom'} edge/lip/shadow sliced by ${label(p)} (shadow ${Math.round(ext.top)}/${Math.round(ext.bottom)}px)`);
        break;
      }
      p = p.parentElement;
    }
  }
  // The part of an element its scroll/overflow ancestors let through (a row scrolled out of view
  // can't overlap anything on screen). null when nothing of it shows.
  const visibleRect = (e) => {
    const b = e.getBoundingClientRect();
    let r = { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (!/(hidden|auto|scroll|clip)/.test(ps.overflowX + ps.overflowY)) continue;
      const pr = p.getBoundingClientRect();
      r = { top: Math.max(r.top, pr.top), bottom: Math.min(r.bottom, pr.bottom), left: Math.max(r.left, pr.left), right: Math.min(r.right, pr.right) };
    }
    r.width = r.right - r.left; r.height = r.bottom - r.top;
    return r.width > 0 && r.height > 0 ? r : null;
  };
  const pinned = (e) => {
    for (let p = e; p && p !== document.body; p = p.parentElement) {
      const pos = getComputedStyle(p).position;
      if (pos === 'fixed' || pos === 'sticky') return p;
    }
    return null;
  };
  // 2c. OVERLAP and TIGHT GAP between interactive or elevated siblings: one button's lip/shadow drawn
  // over the next one, or two controls touching. Uses the VISUAL box (rect + shadow extent).
  const items = [...document.querySelectorAll('button, a[href], [role=button], [role=tab], input, [data-slot=base], .rounded-xl, .rounded-2xl, .rounded-lg')]
    .filter((e) => visible(e) && !e.closest('[aria-hidden=true]'))
    .map((e) => { const r = visibleRect(e); const x = shadowExtent(getComputedStyle(e)); return { e, r, x }; })
    .filter(({ r }) => r)
    .filter(({ r }) => r.width >= 24 && r.height >= 16);
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], c = items[j];
      if (a.e.contains(c.e) || c.e.contains(a.e)) continue;
      // A dialog/popover is meant to sit over the page; only compare items in the same layer.
      const layer = (e) => e.closest('[role=dialog],[role=listbox],[role=menu],[role=tooltip],[data-slot=popover]');
      if (layer(a.e) !== layer(c.e)) continue;
      // A fixed/sticky layer (phone bottom bar, pinned table column, sticky header) sits over scrolling
      // content by design; whether it hides something for good is the COVERED check's job.
      if (pinned(a.e) !== pinned(c.e)) continue;
      // Same row or same column only (neighbours), and not inside an open popover over the page.
      const hOverlap = Math.min(a.r.right, c.r.right) - Math.max(a.r.left, c.r.left);
      const vOverlap = Math.min(a.r.bottom, c.r.bottom) - Math.max(a.r.top, c.r.top);
      const [up, down] = a.r.top <= c.r.top ? [a, c] : [c, a];
      if (hOverlap > 8) {
        const gap = down.r.top - up.r.bottom;               // box gap
        // The SOLID lip (blur-0 shadow) is the hard edge; a soft glow may overlap a neighbour. Rule: the
        // next item starts at least 4px below the lip (gap-3 between stacked clay controls).
        const visGap = down.r.top - (up.r.bottom + up.x.lip + 4);
        if (gap < 0 && vOverlap > 2) out.push(`OVERLAP ${label(up.e)} and ${label(down.e)} boxes overlap by ${Math.round(-gap)}px`);
        else if (gap >= 0 && gap < 60 && visGap < 0 && up.x.lip > 1) out.push(`OVERLAP ${label(up.e)} lip runs into ${label(down.e)} (box gap ${Math.round(gap)}px, needs ≥${Math.round(up.x.lip + 4)}px)`);
        else if (gap >= 0 && gap < 4 && (up.e.matches('button,a,[role=button]') && down.e.matches('button,a,[role=button]'))) out.push(`TIGHT-GAP ${label(up.e)} / ${label(down.e)} only ${Math.round(gap)}px apart`);
      }
      const [l, rr] = a.r.left <= c.r.left ? [a, c] : [c, a];
      if (vOverlap > 8 && hOverlap < 0) {
        const gapX = rr.r.left - l.r.right;
        if (gapX >= 0 && gapX < 4 && l.e.matches('button,a,[role=button]') && rr.e.matches('button,a,[role=button]')) out.push(`TIGHT-GAP ${label(l.e)} / ${label(rr.e)} only ${Math.round(gapX)}px apart side by side`);
      }
    }
  }
  // 3. Interactive elements covered by something else (bottom bar, sticky headers).
  for (const el of document.querySelectorAll('button, a[href], input, [role=button], [role=tab]')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) continue;
    // Judge the part its scroll boxes let through: a row scrolled past a nav's edge isn't covered.
    const vr = visibleRect(el);
    if (!vr) continue;
    const cx = vr.left + vr.width / 2, cy = vr.top + vr.height / 2;
    if (cx < 0 || cx > vw) continue;
    const top = document.elementFromPoint(cx, cy);
    if (top && !el.contains(top) && !top.contains(el) && !top.closest('[role=dialog],[role=listbox],[role=menu],[role=tooltip],[data-slot=popover]') && getComputedStyle(top).position !== 'static') {
      // Judge by computed position, not class names (`[&>td]:sticky` on a row is not a sticky row).
      let fixed = null;
      for (let n = top; n && n !== document.body; n = n.parentElement) {
        const pos = getComputedStyle(n).position;
        if (pos === 'fixed' || pos === 'sticky') { fixed = n; break; }
      }
      // Under the bottom bar but the page can still scroll it clear: fine. Only content stuck under it counts.
      const scrollLeft = document.documentElement.scrollHeight - scrollY - innerHeight;
      if (fixed && fixed.getBoundingClientRect().top > innerHeight / 2 && scrollLeft >= r.bottom - fixed.getBoundingClientRect().top) continue;
      if (fixed) out.push(`COVERED ${label(el)} under ${label(fixed)}`);
    }
  }
  return [...new Set(out)].slice(0, 60);
})()
