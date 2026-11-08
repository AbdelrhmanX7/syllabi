// Canvas hands back the raw body of a page / announcement / assignment: instructor HTML that often
// carries Canvas's own `<link rel="stylesheet">` and `<script>` tags (the mobile stylesheet, LTI
// embeds). Rendered as-is through `dangerouslySetInnerHTML`, the stylesheet LOADS and restyles the
// app around it, and any `onerror=` would run. Keep the content, drop everything that executes or
// leaks out of the box.
const DROP_SELECTOR = 'script, style, link, meta, base, object, embed, form, input, button, textarea, select';

function stripWithoutDom(html: string): string {
  return html
    .replace(/<(script|style|object|form)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(link|meta|base|embed|input)\b[^>]*>/gi, '');
}

export function sanitizeCanvasHtml(html: string): string {
  if (!html) return '';
  if (typeof DOMParser === 'undefined') return stripWithoutDom(html);

  const doc = new DOMParser().parseFromString(html, 'text/html');

  doc.querySelectorAll(DROP_SELECTOR).forEach((element) => element.remove());
  doc.querySelectorAll('iframe').forEach((frame) => {
    if (!/^https:\/\//i.test(frame.getAttribute('src') ?? '')) frame.remove();
  });
  doc.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();

      if (name.startsWith('on')) element.removeAttribute(attribute.name);
      else if ((name === 'href' || name === 'src' || name === 'xlink:href') && /^\s*javascript:/i.test(attribute.value))
        element.removeAttribute(attribute.name);
    }
  });

  return doc.body.innerHTML;
}
