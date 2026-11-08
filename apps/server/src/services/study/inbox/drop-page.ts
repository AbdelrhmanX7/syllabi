import { randomBytes } from "crypto";
import type { Response } from "express";

/**
 * `GET /study/drop?t=sk_drop_…` — a tiny, self-contained upload page for the phone's browser.
 * No external assets; inline style/script are allowed by a per-response CSP nonce only.
 *
 * The token is NOT rendered into the HTML: the script reads it from its own URL, then strips
 * `?t=` from the address bar with history.replaceState (so it never lands in a screenshot, a
 * shared link or the history entry). Each file is its own `POST inbox` (relative to this page,
 * so nginx's `/api` prefix needs no knowledge here) with `Authorization: Bearer <token>`.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function setDropPageHeaders(res: Response, nonce: string) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "img-src 'self' blob: data:",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; ")
  );
}

export const newNonce = () => randomBytes(16).toString("base64");

const STYLE = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#14171c;--muted:#5d6673;--line:#dfe3e8;--accent:#2457d6;--ok:#13804b;--bad:#c62828}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#181b21;--ink:#eef1f5;--muted:#9aa4b2;--line:#2a2f38;--accent:#7aa2ff;--ok:#4cc38a;--bad:#ff7b7b}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%}
main{max-width:520px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:22px;margin:0 0 4px}
p.sub{margin:0 0 20px;color:var(--muted);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
label.pick{display:block;text-align:center;padding:22px 12px;border:2px dashed var(--line);border-radius:12px;font-weight:600;color:var(--accent);cursor:pointer}
label.pick input{position:absolute;opacity:0;width:1px;height:1px}
textarea{width:100%;margin-top:14px;min-height:64px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--ink);font:inherit;font-size:16px;resize:vertical}
.hint{font-size:12px;color:var(--muted);margin-top:4px}
ul{list-style:none;margin:16px 0 0;padding:0}
li{padding:10px 0;border-top:1px solid var(--line)}
li:first-child{border-top:0}
.row{display:flex;justify-content:space-between;gap:12px;font-size:14px}
.name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.st{flex:none;color:var(--muted)}
.st.ok{color:var(--ok);font-weight:600}
.st.bad{color:var(--bad)}
.err{font-size:13px;color:var(--bad);margin-top:4px}
progress{width:100%;height:6px;margin-top:6px;accent-color:var(--accent)}
`;

const SCRIPT = `
(function(){
  var q = new URLSearchParams(location.search);
  var token = q.get('t') || '';
  if (q.has('t')) { q.delete('t'); var s = q.toString(); history.replaceState(null, '', location.pathname + (s ? '?' + s : '') + location.hash); }
  var input = document.getElementById('files');
  var note = document.getElementById('note');
  var list = document.getElementById('list');
  var queue = [];
  var busy = false;
  function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function size(n){ return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function add(file){
    var li = el('li'); var row = el('div', 'row');
    var name = el('span', 'name', file.name || 'file'); var st = el('span', 'st', 'Waiting');
    var bar = el('progress'); bar.max = 100; bar.value = 0;
    row.appendChild(name); row.appendChild(st); li.appendChild(row); li.appendChild(bar);
    list.insertBefore(li, list.firstChild);
    queue.push({ file: file, st: st, bar: bar, li: li });
  }
  function fail(job, msg){ job.st.textContent = 'Failed'; job.st.className = 'st bad'; job.bar.remove(); job.li.appendChild(el('div', 'err', msg)); }
  function next(){
    if (busy) return; var job = queue.shift(); if (!job) return; busy = true;
    if (job.file.size > ${25 * 1024 * 1024}) { fail(job, 'Too large (' + size(job.file.size) + '). The limit is 25 MB.'); busy = false; return next(); }
    var fd = new FormData(); fd.append('file', job.file, job.file.name || 'upload');
    var n = note.value.trim(); if (n) fd.append('note', n.slice(0, 500));
    var x = new XMLHttpRequest(); x.open('POST', location.pathname.replace(/\\/drop\\/?$/, '/inbox'));
    x.setRequestHeader('Authorization', 'Bearer ' + token);
    job.st.textContent = '0%';
    x.upload.onprogress = function(e){ if (e.lengthComputable) { var p = Math.round(e.loaded / e.total * 100); job.bar.value = p; job.st.textContent = p < 100 ? p + '%' : 'Processing…'; } };
    x.onload = function(){
      if (x.status >= 200 && x.status < 300) { job.st.textContent = 'Sent \\u2713'; job.st.className = 'st ok'; job.bar.remove(); }
      else { var m = 'Upload failed (' + x.status + ')'; try { var b = JSON.parse(x.responseText); if (b && b.message) m = b.message; } catch (e) {}
        if (x.status === 401) m = 'This drop link is no longer valid. Create a new one in Study settings.'; fail(job, m); }
      busy = false; next();
    };
    x.onerror = function(){ fail(job, 'Network error. Check your connection and try again.'); busy = false; next(); };
    x.send(fd);
  }
  input.addEventListener('change', function(){ for (var i = 0; i < input.files.length; i++) add(input.files[i]); input.value = ''; next(); });
})();
`;

export function renderDropPage(nonce: string, label: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>Send to Study</title><style nonce="${nonce}">${STYLE}</style></head>
<body><main>
<h1>Send to Study</h1>
<p class="sub">Photos and PDFs go straight to your Study inbox · ${esc(label)}</p>
<div class="card">
<label class="pick">Choose photos or PDFs<input id="files" type="file" accept="image/*,application/pdf" multiple></label>
<textarea id="note" maxlength="500" placeholder="Note (optional)"></textarea>
<div class="hint">Each file is sent separately, up to 25 MB each.</div>
<ul id="list" aria-live="polite"></ul>
</div>
</main><script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}

export function renderInvalidDropPage(nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>Link not valid</title><style nonce="${nonce}">${STYLE}</style></head>
<body><main>
<h1>This link isn’t valid</h1>
<p class="sub">The drop link is missing, mistyped or has been revoked.</p>
<div class="card">Open Study on your tablet, go to <b>Settings → Phone inbox</b>, and create a new drop link.</div>
</main></body></html>`;
}
