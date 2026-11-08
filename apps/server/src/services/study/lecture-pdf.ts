import dns from "dns";
import fs from "fs";
import https from "https";
import type { IncomingMessage } from "http";
import { BlockList, isIP } from "net";
import path from "path";
import puppeteer from "puppeteer";
import sanitizeHtml from "sanitize-html";
import { PDFDocument } from "pdf-lib";
import { Types } from "mongoose";
import sharp from "sharp";
import { z } from "zod";
import { IStudyInboxItem, StudyInboxItem } from "@/models/study/inbox";
import { MAX_INPUT_PIXELS } from "./inbox/media";
import { getStudyObject } from "./storage";
import { CANVAS_IMAGE_REF, storedCanvasImage } from "./canvas-images";

/**
 * Lecture slide decks for the MCP `create_lecture_pdf` tool → HTML → PDF, one slide per page.
 * The default look follows the owner's professor's slides: 4:3 landscape (10in × 7.5in),
 * Source Sans 3 (vendored, OFL — assets/fonts/source-sans-3), centred mauve title with a short
 * accent rule, warm brown text ≥ 20px, cream cards, tan callouts, rounded table rows, framed
 * photos with caption + credit, part-divider slides, a part label top-right, an [F] pill for
 * filled-in slides, and an empty dashed NOTES strip on the right for the pen.
 *
 * Safety: every piece of caller text is HTML-escaped before the small markdown renderer adds its
 * own tags, so markdown can never carry markup. SVG goes through a sanitize-html allowlist (no
 * script, no foreignObject, no href, no url() but local `url(#id)`). Images come from the owner's
 * own phone-inbox uploads (study_inbox_items), read straight from study storage, or — with a
 * required credit — from a short allowlist of open-license hosts (Wikimedia, USGS, NASA, NOAA,
 * NPS), fetched server-side over https to a DNS-vetted public address and re-encoded to JPEG.
 * Either way they are inlined as data: URIs: the browser itself aborts every request that is
 * not data:/about:, so nothing in the page can reach the network or the box.
 *
 * The look lives in ONE object (DeckStyle, DEFAULT_DECK_STYLE); a caller overrides any part of it
 * with `style`.
 */

// ─── limits + input schema ──────────────────────────────────────────────────────────────

export const DECK_MAX_SLIDES = 80;
export const DECK_MAX_IMAGES = 30;
export const SLIDE_MAX_IMAGES = 4;
export const IMAGE_MAX_BYTES = 15 * 1024 * 1024;
export const RENDER_TIMEOUT_MS = 90_000;

const hex = z.string().regex(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i, "must be a hex colour like #6b5f78");
// No ; { } < > — the value lands inside a <style> block.
const font = z.string().max(200).regex(/^[A-Za-z0-9 ,'"-]+$/, "must be a CSS font-family list");
const px = (min: number, max: number) => z.number().min(min).max(max);

export const deckStyleSchema = z
  .object({
    page: z.object({ widthIn: z.number().min(6).max(20), heightIn: z.number().min(4).max(20) }).strict(),
    fontFamily: font,
    colors: z
      .object({
        background: hex, title: hex, subtitle: hex, text: hex, strong: hex, muted: hex, credit: hex,
        line: hex, frame: hex, tan: hex, cream: hex, accent: hex, mauve: hex, rust: hex, highlight: hex, dash: hex,
      })
      .partial()
      .strict(),
    /** px at 96/in. Body text never goes under 20px. */
    sizes: z.object({ title: px(20, 72), subtitle: px(14, 40), body: px(20, 40), small: px(14, 30), caption: px(10, 24), footer: px(9, 20) }).partial().strict(),
    notes: z.object({ enabled: z.boolean(), widthPct: z.number().min(10).max(40), label: z.string().max(30) }).partial().strict(),
    footer: z.object({ enabled: z.boolean(), text: z.string().max(160).nullable(), showClass: z.boolean(), showLecture: z.boolean(), showTitle: z.boolean(), showDate: z.boolean(), showPageNumber: z.boolean() }).partial().strict(),
  })
  .partial()
  .strict();
export type DeckStyleInput = z.infer<typeof deckStyleSchema>;

const cell = z.string().max(200);
/** The owner's own inbox upload (its inbox item id, its storage key, or a url carrying that key), or an open-license https url. */
const inboxRef = z.string().min(1).max(2000);
export const deckImageSchema = z.object({ url: inboxRef, caption: z.string().max(200).optional(), credit: z.string().max(160).optional(), fit: z.enum(["cover", "contain"]).optional() }).strict();
export const deckSlideSchema = z
  .object({
    /** divider = a part-opening slide: part label, big title, bullets as the part's agenda, images[0] as a full-height photo. */
    kind: z.enum(["content", "divider"]).optional(),
    /** Part label (top-right on content slides, the kicker on a divider). */
    part: z.string().min(1).max(60).optional(),
    title: z.string().min(1).max(200),
    subtitle: z.string().max(200).optional(),
    bullets: z.array(z.string().min(1).max(500)).max(14).optional(),
    body: z.string().max(4000).optional(),
    cards: z.array(z.object({ title: z.string().max(120).optional(), text: z.string().min(1).max(800) }).strict()).min(1).max(4).optional(),
    callout: z.object({ label: z.string().max(60).optional(), text: z.string().min(1).max(800) }).strict().optional(),
    table: z
      .object({ head: z.array(cell).min(1).max(8), rows: z.array(z.array(cell).max(8)).min(1).max(14), highlightRow: z.number().int().min(0).optional() })
      .strict()
      .refine((t) => t.rows.every((r) => r.length <= t.head.length), "a table row has more cells than head")
      .refine((t) => t.highlightRow === undefined || t.highlightRow < t.rows.length, "highlightRow is past the last row")
      .optional(),
    flow: z.array(z.array(z.string().min(1).max(120)).min(1).max(6)).min(1).max(6).optional(),
    images: z.array(deckImageSchema).min(1).max(SLIDE_MAX_IMAGES).optional(),
    svg: z.string().max(200_000).optional(),
    svgCaption: z.string().max(300).optional(),
    /** Back-compat: {caption, imageUrl} folds into images, {caption, svg} into svg + svgCaption. */
    figure: z
      .object({ caption: z.string().max(300), imageUrl: inboxRef.optional(), svg: z.string().max(200_000).optional() })
      .strict()
      .refine((f) => !(f.imageUrl && f.svg), "figure takes imageUrl OR svg, not both")
      .optional(),
    /** Source label for a slide Claude filled in: the [F] pill «Filled in from <source>». */
    filled: z.string().min(1).max(120).optional(),
    notes: z.string().max(4000).optional(),
  })
  .strict()
  .refine((s) => !(s.svg && s.figure?.svg), "use svg or figure.svg, not both");
export type DeckSlide = z.infer<typeof deckSlideSchema>;

// ─── style ──────────────────────────────────────────────────────────────────────────────

export interface DeckStyle {
  /** Inches. Default 4:3. Layout offsets are in px at 96/in. */
  page: { widthIn: number; heightIn: number };
  fontFamily: string;
  /** Contrast-vetted on white / cream: muted #6e5f55, credit #76675d. */
  colors: {
    background: string; title: string; subtitle: string; text: string; strong: string; muted: string; credit: string;
    line: string; frame: string; tan: string; cream: string;
    /** Title rule, bullets, table highlight fill. */
    accent: string;
    mauve: string; rust: string; highlight: string; dash: string;
  };
  sizes: { title: number; subtitle: number; body: number; small: number; caption: number; footer: number };
  /** The empty dashed strip on the right, left for handwriting. */
  notes: { enabled: boolean; widthPct: number; label: string };
  /** Left: text ?? «CLASS · Lecture N · Title»; right: page number. */
  footer: { enabled: boolean; text: string | null; showClass: boolean; showLecture: boolean; showTitle: boolean; showDate: boolean; showPageNumber: boolean };
}

export const DEFAULT_DECK_STYLE: DeckStyle = {
  page: { widthIn: 10, heightIn: 7.5 },
  fontFamily: "'Source Sans 3', 'Liberation Sans', Arial, sans-serif",
  colors: {
    background: "#ffffff",
    title: "#6b5f78",
    subtitle: "#7d6b60",
    text: "#5a463b",
    strong: "#43322a",
    muted: "#6e5f55",
    credit: "#76675d",
    line: "#d8cabd",
    frame: "#cdbdaf",
    tan: "#f3ece2",
    cream: "#faf6f0",
    accent: "#dcc29a",
    mauve: "#e6cdc8",
    rust: "#9c5a3c",
    highlight: "#c9a24a",
    dash: "#c9b9ab",
  },
  sizes: { title: 36, subtitle: 20, body: 20, small: 18, caption: 14, footer: 14 },
  notes: { enabled: true, widthPct: 20, label: "Notes" },
  footer: { enabled: true, text: null, showClass: true, showLecture: true, showTitle: true, showDate: false, showPageNumber: true },
};

export const mergeDeckStyle = (o: DeckStyleInput = {}): DeckStyle => ({
  page: o.page ?? DEFAULT_DECK_STYLE.page,
  fontFamily: o.fontFamily ?? DEFAULT_DECK_STYLE.fontFamily,
  colors: { ...DEFAULT_DECK_STYLE.colors, ...o.colors },
  sizes: { ...DEFAULT_DECK_STYLE.sizes, ...o.sizes },
  notes: { ...DEFAULT_DECK_STYLE.notes, ...o.notes },
  footer: { ...DEFAULT_DECK_STYLE.footer, ...o.footer },
});

/** The vendored Source Sans 3 (upright 400–800, italic 400–600) as @font-face rules with data: URIs; read once. */
// cwd is apps/server under `pnpm dev|start` and in the image; __dirname covers `node apps/server/dist/index.js` from elsewhere.
const FONT_DIR = [process.cwd(), path.join(__dirname, "..", "..", "..")]
  .map((root) => path.join(root, "assets", "fonts", "source-sans-3"))
  .find((dir) => fs.existsSync(dir)) ?? path.join(process.cwd(), "assets", "fonts", "source-sans-3");
let fontCss: string | null = null;
export function sourceSansFontFaces(): string {
  if (fontCss !== null) return fontCss;
  const face = (file: string, style: string, weight: string) => {
    try {
      return `@font-face { font-family: 'Source Sans 3'; font-style: ${style}; font-weight: ${weight}; src: url(data:font/woff2;base64,${fs.readFileSync(path.join(FONT_DIR, file)).toString("base64")}) format('woff2'); }`;
    } catch {
      return ""; // missing asset → the Liberation Sans / Arial fallback, never a failed deck
    }
  };
  return (fontCss = face("SourceSans3-Upright.woff2", "normal", "400 800") + face("SourceSans3-Italic.woff2", "italic", "400 600"));
}

// ─── markdown (escape first, then a few tags) ───────────────────────────────────────────

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Inline markdown on ESCAPED text: `code`, **bold**, *italic* / _italic_, [text](url) → text. $math$ stays as written. */
export function inlineMd(raw: string): string {
  const codes: string[] = [];
  let s = escapeHtml(raw).replace(/`([^`]+)`/g, (_m, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    // ![alt](inbox:<id>) → an <img> the document renderer inlines (generated-pdf inlineInboxImages); only a 24-hex id can match.
    .replace(/!\[([^\]]*)\]\(inbox:([0-9a-f]{24})\)/gi, '<img alt="$1" src="inbox:$2">')
    .replace(/!\[([^\]]*)\]\(canvas-image:(\d{1,15})\)/gi, '<img alt="$1" src="canvas-image:$2">')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
}

/** Block markdown: #–### headings, - / * / 1. lists (one nesting level by indent), ``` fences, > quotes, | tables as preformatted, paragraphs. */
export function markdownToHtml(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inlineMd).join("<br>")}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      out.push(`<pre>${escapeHtml(code.join("\n"))}</pre>`);
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flush();
      const rows = [line];
      while (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1])) rows.push(lines[++i]);
      out.push(`<pre class="table">${escapeHtml(rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).join("\n"))}</pre>`);
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push(`<h${h[1].length + 2}>${inlineMd(h[2])}</h${h[1].length + 2}>`);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const items: { depth: number; ordered: boolean; text: string }[] = [];
      for (; i < lines.length; i++) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m) {
          i--;
          break;
        }
        items.push({ depth: m[1].length >= 2 ? 1 : 0, ordered: /\d/.test(m[2]), text: m[3] });
      }
      out.push(listHtml(items));
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      flush();
      out.push(`<blockquote>${inlineMd(q[1])}</blockquote>`);
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line.trim());
  }
  flush();
  return out.join("");
}

function listHtml(items: { depth: number; ordered: boolean; text: string }[]): string {
  const tag = items[0]?.ordered ? "ol" : "ul";
  let html = `<${tag}>`;
  let inLi = false;
  let inSub = false;
  for (const it of items) {
    if (it.depth === 1 && inLi) {
      if (!inSub) html += "<ul>";
      inSub = true;
      html += `<li>${inlineMd(it.text)}</li>`;
      continue;
    }
    if (inSub) html += "</ul>";
    if (inLi) html += "</li>";
    html += `<li>${inlineMd(it.text)}`;
    inLi = true;
    inSub = false;
  }
  return `${html}${inSub ? "</ul>" : ""}${inLi ? "</li>" : ""}</${tag}>`;
}

// ─── svg ───────────────────────────────────────────────────────────────────────────────

const SVG_TAGS = ["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "defs", "marker", "title", "desc", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern"];
const SVG_ATTRS = [
  "xmlns", "viewBox", "preserveAspectRatio", "width", "height", "id", "class", "transform", "d", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "dx", "dy", "points",
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "opacity", "clip-path", "clip-rule", "mask",
  "font-size", "font-family", "font-weight", "font-style", "text-anchor", "dominant-baseline", "alignment-baseline", "letter-spacing",
  "marker-start", "marker-mid", "marker-end", "markerWidth", "markerHeight", "markerUnits", "refX", "refY", "orient",
  "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "fx", "fy", "patternUnits", "patternTransform",
];

export class DeckInputError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/** Allowlisted SVG, or a DeckInputError (INVALID_SVG) when nothing svg-shaped survives. */
export function sanitizeSvg(svg: string): string {
  const clean = sanitizeHtml(svg, {
    allowedTags: SVG_TAGS,
    allowedAttributes: { "*": SVG_ATTRS },
    nonTextTags: ["script", "style", "textarea", "option", "noscript", "foreignObject", "foreignobject"],
    parser: { lowerCaseTags: false, lowerCaseAttributeNames: false },
    transformTags: {
      "*": (tagName, attribs) => ({
        tagName,
        // only local references survive: url(#id) yes, url(http…) / javascript: / data: no
        attribs: Object.fromEntries(Object.entries(attribs).filter(([, v]) => !/url\s*\(\s*(?!['"]?#)|javascript:|data:|expression\s*\(/i.test(v))),
      }),
    },
  }).trim();
  if (!/^<svg[\s>]/.test(clean)) throw new DeckInputError("INVALID_SVG", "figure.svg must be an <svg> element");
  return clean;
}


// ─── inbox images ───────────────────────────────────────────────────────────────────────

const sniffImage = (b: Buffer): string | null => {
  if (b.length > 8 && b[0] === 0x89 && b.toString("ascii", 1, 4) === "PNG") return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 6 && b.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  if (b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
};

const INBOX_KEY_IN = /study\/[0-9a-f]{24}\/inbox\/[0-9a-f-]{36}\.[a-z0-9]+/i;

/**
 * figure.imageUrl → the owner's inbox image as a data: URI. Accepted: the inbox item id, its
 * storage key, or any url that carries that key (our signed storage url, the dev static url). The row
 * is looked up under THIS owner, so another owner's key, a deleted item, a PDF, or any other host
 * is a DeckInputError — nothing is fetched over the network.
 */
export async function inboxImageDataUri(userId: Types.ObjectId, ref: string): Promise<string> {
  const r = ref.trim();
  // A Canvas page figure cached by sync (get_item_images → ref), looked up under THIS owner.
  const canvas = CANVAS_IMAGE_REF.exec(r);
  if (canvas) {
    const row = await storedCanvasImage(userId, Number(canvas[1]));
    if (!row) throw new DeckInputError("NOT_FOUND", "Canvas image not found (not synced yet, or not an image)");
    if (row.bytes > IMAGE_MAX_BYTES) throw new DeckInputError("IMAGE_TOO_LARGE", "That Canvas image is over 15 MB");
    const buf = await getStudyObject(row.storageKey!);
    const mime = sniffImage(buf);
    if (!mime) throw new DeckInputError("IMAGE_NOT_ALLOWED", "That Canvas image is not a PNG/JPEG/GIF/WebP image");
    return `data:${mime};base64,${buf.toString("base64")}`;
  }
  let decoded = r;
  try {
    decoded = decodeURIComponent(r);
  } catch {
    // keep the raw string
  }
  const key = INBOX_KEY_IN.exec(decoded)?.[0] ?? null;
  const filter = /^[0-9a-f]{24}$/i.test(r) ? { _id: r } : key ? { key } : null;
  if (!filter) throw new DeckInputError("IMAGE_NOT_ALLOWED", "imageUrl must be one of your inbox uploads (its inbox item id or our media url)");
  const item = await StudyInboxItem.findOne({ ...filter, userId, deletedAt: null }, { key: 1, kind: 1, bytes: 1 }).lean<IStudyInboxItem>();
  if (!item) throw new DeckInputError("NOT_FOUND", "Inbox image not found");
  if (item.kind !== "image") throw new DeckInputError("IMAGE_NOT_ALLOWED", "That inbox upload is not an image");
  if (item.bytes > IMAGE_MAX_BYTES) throw new DeckInputError("IMAGE_TOO_LARGE", "That inbox image is over 15 MB");
  const buf = await getStudyObject(item.key);
  const mime = sniffImage(buf);
  if (!mime) throw new DeckInputError("IMAGE_NOT_ALLOWED", "That inbox upload is not a PNG/JPEG/GIF/WebP image");
  return `data:${mime};base64,${buf.toString("base64")}`;
}


// ─── open-license images ────────────────────────────────────────────────────────────────

const OPEN_IMAGE_HOSTS = ["upload.wikimedia.org", "thumb.wikimedia.org", "commons.wikimedia.org"];
/** The domain itself or any subdomain of it. */
const OPEN_IMAGE_DOMAINS = ["usgs.gov", "nasa.gov", "noaa.gov", "nps.gov"];
export const OPEN_IMAGE_MAX_BYTES = 8 * 1048576;
/** Time budgets (tests shrink them): one image, one connect attempt, and ALL of a deck's image fetching. */
export const OPEN_IMAGE_TIMING = { perImageMs: 10_000, connectMs: 4_000, deckMs: 25_000, concurrency: 4 };
export const OPEN_IMAGE_MAX_REDIRECTS = 3;
export const OPEN_IMAGE_LONG_SIDE = 1600;
export const OPEN_IMAGE_JPEG_QUALITY = 82;

export const isOpenImageHost = (hostname: string) => {
  const h = hostname.toLowerCase();
  return OPEN_IMAGE_HOSTS.includes(h) || OPEN_IMAGE_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
};

/** An http(s) url on an allowlisted host (any scheme/port — fetchOpenImage enforces those), else null → inbox path. */
export function openImageUrl(ref: string): URL | null {
  let u: URL;
  try {
    u = new URL(ref);
  } catch {
    return null;
  }
  return /^https?:$/.test(u.protocol) && isOpenImageHost(u.hostname) ? u : null;
}

// Everything a public image host must NOT resolve to: private, loopback, link-local, CGNAT,
// multicast, unspecified, reserved, and every v6 form that can smuggle a v4 address.
// Two lists: a BlockList checks an IPv4 address against its IPv6 rules too (as ::ffff:a.b.c.d),
// so the v6 ::ffff:0:0/96 rule would otherwise block every IPv4 address.
const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED_V4.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) BLOCKED_V6.addSubnet(net, prefix, "ipv6");

export const isPublicAddress = (address: string) => {
  const family = isIP(address);
  return family === 4 ? !BLOCKED_V4.check(address, "ipv4") : family === 6 && !BLOCKED_V6.check(address, "ipv6");
};

/** The network seam (tests swap these). */
export const openImageNet = {
  lookup: (host: string) => dns.promises.lookup(host, { all: true, verbatim: true }),
  request: https.request,
};

const notAllowed = (msg: string) => new DeckInputError("IMAGE_NOT_ALLOWED", msg);
const fetchFailed = (msg: string) => new DeckInputError("IMAGE_FETCH_FAILED", msg);

function vetOpenImageUrl(u: URL) {
  if (!isOpenImageHost(u.hostname)) throw notAllowed(`${u.hostname} is not an allowed image host`);
  if (u.protocol !== "https:") throw notAllowed("image urls must be https");
  if (u.username || u.password) throw notAllowed("image urls must not carry credentials");
  if (u.port) throw notAllowed("image urls must use the default port");
}

/**
 * One GET straight to `address` (an IP that was already vetted), with TLS SNI, certificate check
 * and Host all on the hostname: the address that passed isPublicAddress IS the one connected
 * to, so a second DNS answer (rebinding) never gets a say. No response within connectMs is an
 * ECONNECT_TIMEOUT.
 */
const getAt = (u: URL, address: string, signal: AbortSignal) =>
  new Promise<IncomingMessage>((resolve, reject) => {
    let answered = false;
    const req = openImageNet.request(
      { host: address, servername: u.hostname, port: 443, path: `${u.pathname}${u.search}`, method: "GET", agent: false, signal, timeout: OPEN_IMAGE_TIMING.connectMs, headers: { host: u.hostname, accept: "image/*", "user-agent": "Syllabi/1.0 (lecture decks)" } },
      (res) => {
        answered = true;
        resolve(res);
      }
    );
    req.on("timeout", () => {
      if (!answered) req.destroy(Object.assign(new Error(`connect to ${address} timed out`), { code: "ECONNECT_TIMEOUT" }));
    });
    req.on("error", reject);
    req.end();
  });

/** Connection-level failures, where the next vetted address may still answer. An HTTP response never retries. */
const RETRY_NEXT_ADDRESS = new Set(["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ECONNECT_TIMEOUT"]);

/** Connecting to an IP skips the client's own address fallback, so walk the vetted addresses in DNS order. */
async function getAny(u: URL, addresses: string[], signal: AbortSignal): Promise<IncomingMessage> {
  for (const [i, address] of addresses.entries()) {
    try {
      return await getAt(u, address, signal);
    } catch (e) {
      if (signal.aborted || i === addresses.length - 1 || !RETRY_NEXT_ADDRESS.has(String((e as NodeJS.ErrnoException)?.code))) throw e;
    }
  }
  throw fetchFailed(`${u.hostname} did not resolve`);
}

async function fetchOpenImageBytes(start: URL, signal: AbortSignal): Promise<Buffer> {
  let u = start;
  for (let hop = 0; ; hop++) {
    vetOpenImageUrl(u);
    if (signal.aborted) throw fetchFailed(`${u.hostname} timed out`);
    const aborted = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(fetchFailed(`${u.hostname} timed out`)), { once: true }));
    aborted.catch(() => undefined); // the race may settle first; a later abort must not be an unhandled rejection
    const addrs = await Promise.race([openImageNet.lookup(u.hostname), aborted]);
    if (!addrs.length) throw fetchFailed(`${u.hostname} did not resolve`);
    if (addrs.some((a) => !isPublicAddress(a.address))) throw notAllowed(`${u.hostname} resolves to a non-public address`);
    const res = await getAny(u, addrs.map((a) => a.address), signal);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.destroy();
      if (hop >= OPEN_IMAGE_MAX_REDIRECTS) throw fetchFailed(`more than ${OPEN_IMAGE_MAX_REDIRECTS} redirects`);
      u = new URL(res.headers.location, u);
      continue;
    }
    if (status !== 200) {
      res.destroy();
      throw fetchFailed(`${u.hostname} answered HTTP ${status}`);
    }
    if (!/^image\//i.test(String(res.headers["content-type"] ?? ""))) {
      res.destroy();
      throw fetchFailed(`${u.hostname} did not return an image (Content-Type ${res.headers["content-type"] ?? "missing"})`);
    }
    const tooLarge = () => new DeckInputError("IMAGE_TOO_LARGE", `the image at ${u.hostname} is over ${OPEN_IMAGE_MAX_BYTES / 1048576} MB`);
    if (Number(res.headers["content-length"]) > OPEN_IMAGE_MAX_BYTES) {
      res.destroy();
      throw tooLarge();
    }
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of res) {
      n += (c as Buffer).length;
      if (n > OPEN_IMAGE_MAX_BYTES) {
        res.destroy();
        throw tooLarge();
      }
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks);
  }
}

/** External images: at most 40 MP decoded (e.g. 8000×5000), and one sharp decode at a time per process. */
export const OPEN_IMAGE_MAX_PIXELS = 40_000_000;
let openImageDecodeChain: Promise<unknown> = Promise.resolve();
function openImageDecode<T>(fn: () => Promise<T>): Promise<T> {
  const run = openImageDecodeChain.then(fn, fn);
  openImageDecodeChain = run.catch(() => undefined);
  return run;
}

/**
 * An allowlisted open-license image url → a JPEG data: URI (≤ 1600 px long side, q82, no
 * metadata). https only, every hop (≤ 3 redirects) re-vetted for host and resolved address,
 * 10 s for the whole fetch (and never past `deck`, the deck's shared deadline), 8 MB streamed
 * cap, bytes must sniff as an image. Policy failures are IMAGE_NOT_ALLOWED, anything else
 * IMAGE_FETCH_FAILED (or IMAGE_TOO_LARGE).
 */
export async function openImageDataUri(u: URL, deck?: AbortSignal): Promise<string> {
  const own = new AbortController();
  const timer = setTimeout(() => own.abort(), OPEN_IMAGE_TIMING.perImageMs);
  const signal = deck ? AbortSignal.any([deck, own.signal]) : own.signal;
  let buf: Buffer;
  try {
    buf = await fetchOpenImageBytes(u, signal);
  } catch (e) {
    if (deck?.aborted) throw fetchFailed("image fetching took too long");
    if (own.signal.aborted) throw fetchFailed(`${u.hostname} timed out`);
    if (e instanceof DeckInputError) throw e;
    throw fetchFailed(`could not fetch the image from ${u.hostname}`);
  } finally {
    clearTimeout(timer);
  }
  if (!sniffImage(buf)) throw fetchFailed(`the file at ${u.hostname} is not a PNG/JPEG/GIF/WebP image`);
  if (deck?.aborted) throw fetchFailed("image fetching took too long");
  let jpeg: Buffer;
  try {
    // one decode at a time per process (across decks), and a far smaller pixel cap than inbox
    // photos: an 8 MB download can still decompress to a huge bitmap
    jpeg = await openImageDecode(() =>
      sharp(buf, { limitInputPixels: OPEN_IMAGE_MAX_PIXELS })
        .rotate()
        .resize({ width: OPEN_IMAGE_LONG_SIDE, height: OPEN_IMAGE_LONG_SIDE, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: OPEN_IMAGE_JPEG_QUALITY })
        .toBuffer()
    );
  } catch {
    throw fetchFailed(`the image at ${u.hostname} could not be decoded`);
  }
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

// ─── html ───────────────────────────────────────────────────────────────────────────────

export interface DeckMeta {
  title: string;
  /** The class label for the footer (course code, else name). */
  className?: string | null;
  lecture?: { number?: number | null; key?: string; date?: string } | null;
}
export interface PreparedImage {
  dataUri: string;
  caption: string | null;
  credit: string | null;
  fit: "cover" | "contain";
}
/** A slide's media after preparation: inlined inbox images + sanitized svg. */
export interface PreparedMedia {
  images: PreparedImage[];
  svg: string | null;
  svgCaption: string | null;
}
export const NO_MEDIA: PreparedMedia = { images: [], svg: null, svgCaption: null };

const css = (s: DeckStyle) => {
  const c = s.colors;
  const W = Math.round(s.page.widthIn * 96);
  const H = Math.round(s.page.heightIn * 96);
  const notesW = s.notes.enabled ? Math.round((W * s.notes.widthPct) / 100) : 0;
  return `${sourceSansFontFaces()}
@page { size: ${s.page.widthIn}in ${s.page.heightIn}in; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: ${c.background}; }
body { font-family: ${s.fontFamily}; color: ${c.text}; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
svg text { font-family: ${s.fontFamily}; }
.slide { width: ${W}px; height: ${H}px; position: relative; overflow: hidden; background: ${c.background}; break-after: page; page-break-after: always; }
.slide:last-child { break-after: auto; page-break-after: auto; }
header { position: absolute; left: 150px; right: 150px; top: 38px; text-align: center; }
h1 { font-size: ${s.sizes.title}px; line-height: 1.1; font-weight: 700; color: ${c.title}; letter-spacing: -.2px; }
.sub { font-size: ${s.sizes.subtitle}px; line-height: 1.25; color: ${c.subtitle}; margin-top: 6px; }
header::after { content: ""; display: block; width: 56px; height: 3px; border-radius: 2px; background: ${c.accent}; margin: 12px auto 0; }
.kicker { position: absolute; top: 16px; right: 24px; max-width: 40%; font-size: 14px; letter-spacing: .08em; text-transform: uppercase; color: ${c.muted}; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ftag { position: absolute; top: 13px; left: 22px; max-width: 45%; display: flex; align-items: center; gap: 8px; background: #f1e6d6; border: 1px solid #d9c3a8; border-radius: 16px; padding: 2px 12px 2px 3px; font-size: 14px; color: #6b4a35; font-style: italic; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ftag i { font-style: normal; flex: none; display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: ${c.rust}; color: #fff; font-weight: 700; font-size: 14px; }
.foot { position: absolute; left: 48px; right: 90px; bottom: 16px; font-size: ${s.sizes.footer}px; color: ${c.credit}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pnum { position: absolute; right: 24px; bottom: 16px; font-size: ${s.sizes.footer}px; color: ${c.credit}; font-weight: 600; }
.body { position: absolute; left: 48px; right: 24px; top: 150px; bottom: 50px; display: flex; gap: 20px; }
.body.nosub { top: 124px; }
.content { flex: 1 1 auto; min-width: 0; overflow: hidden; display: flex; flex-direction: column; gap: 14px; font-size: ${s.sizes.body}px; line-height: 1.38; }
.notes { flex: 0 0 ${notesW}px; border-left: 1.5px dashed ${c.dash}; position: relative; }
.notes span { position: absolute; top: -3px; left: 12px; font-size: 14px; letter-spacing: .14em; text-transform: uppercase; color: #9a8c81; }
.content b, .content strong { color: ${c.strong}; font-weight: 700; }
.content p { margin: 0 0 8px; }
.content ul { list-style: none; }
.content ul > li { position: relative; padding-left: 22px; margin: 0 0 9px; }
.content ul > li::before { content: ""; position: absolute; left: 3px; top: .55em; width: 8px; height: 8px; border-radius: 2px; background: ${c.accent}; outline: 1px solid #c8a978; }
.content ul ul { margin-top: 6px; font-size: ${s.sizes.small}px; }
.content ul ul > li::before { border-radius: 50%; width: 6px; height: 6px; outline: none; background: ${c.muted}; }
.content ol { list-style: none; counter-reset: n; }
.content ol > li { counter-increment: n; position: relative; padding-left: 38px; margin: 0 0 10px; }
.content ol > li::before { content: counter(n); position: absolute; left: 0; top: 1px; width: 26px; height: 26px; border-radius: 50%; background: ${c.title}; color: #fff; font-size: 16px; font-weight: 700; display: grid; place-items: center; }
.content h3, .content h4, .content h5 { font-size: 1em; line-height: 1.2; color: ${c.strong}; margin: 0 0 4px; }
.content code, .content pre { font-family: 'DejaVu Sans Mono', Consolas, monospace; background: ${c.cream}; border-radius: 4px; }
.content code { padding: 0 .2em; font-size: .9em; }
.content pre { padding: 8px 12px; font-size: ${s.sizes.caption + 2}px; white-space: pre-wrap; border: 1px solid ${c.line}; }
.callout, .content blockquote { background: ${c.tan}; border-left: 4px solid #c9a27a; border-radius: 0 6px 6px 0; padding: 9px 16px; font-size: ${s.sizes.small}px; line-height: 1.4; }
.lbl { display: block; font-size: 14px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: ${c.muted}; margin-bottom: 2px; }
.cards { display: flex; gap: 14px; align-items: stretch; }
.card { flex: 1 1 0; min-width: 0; background: ${c.cream}; border: 1px solid ${c.line}; border-radius: 6px; padding: 11px 15px; font-size: ${s.sizes.small}px; line-height: 1.4; }
.card h3 { font-size: ${s.sizes.body}px; line-height: 1.2; color: ${c.strong}; margin-bottom: 4px; }
.row { display: flex; gap: 18px; align-items: flex-start; }
.row > .text { flex: 1 1 0; min-width: 0; }
.media { flex: 0 0 46%; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.media.alone { flex: 1 1 100%; flex-direction: row; }
.media.alone > figure { flex: 1 1 0; }
figure { margin: 0; min-width: 0; }
figure.ph img { display: block; width: 100%; height: var(--h, 240px); border: 1px solid ${c.frame}; border-radius: 6px; background: ${c.cream}; }
figcaption { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-top: 5px; font-size: ${s.sizes.caption}px; line-height: 1.3; color: ${c.muted}; }
figcaption .cr { font-size: 10px; color: ${c.credit}; padding-top: 3px; margin-left: auto; text-align: right; }
figure.dg svg { display: block; width: 100%; height: auto; max-height: 420px; }
figure.dg figcaption { display: block; }
table.t { border-collapse: separate; border-spacing: 0 4px; width: 100%; }
table.t th { font-size: 15px; font-weight: 700; color: ${c.muted}; text-transform: uppercase; letter-spacing: .05em; padding: 6px 10px; background: ${c.tan}; text-align: center; line-height: 1.2; }
table.t th:first-child, table.t td:first-child { border-radius: 6px 0 0 6px; }
table.t th:last-child, table.t td:last-child { border-radius: 0 6px 6px 0; }
table.t td { font-size: ${s.sizes.small}px; line-height: 1.25; padding: 9px 10px; text-align: center; color: ${c.text}; background: ${c.cream}; }
table.t td:first-child { font-weight: 700; color: ${c.strong}; }
table.t tr.hl td { background: ${c.accent}; font-weight: 700; color: ${c.strong}; }
table.t tr.hl { outline: 3px solid ${c.highlight}; }
.flow { display: flex; flex-direction: column; gap: 10px; }
.flow .fr { display: flex; align-items: center; justify-content: center; gap: 8px; }
.flow .fb { background: ${c.cream}; border: 1px solid ${c.line}; border-radius: 6px; padding: 6px 12px; text-align: center; font-size: ${s.sizes.small}px; line-height: 1.25; color: ${c.strong}; }
.flow .fa { color: ${c.rust}; font-size: 22px; font-weight: 700; }
.cover { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; padding: 0 110px; }
.cover h1 { font-size: ${Math.round(s.sizes.title * 1.4)}px; }
.cover .rule { width: 64px; height: 4px; border-radius: 2px; background: ${c.accent}; margin: 22px auto; }
.divider .dv-photo { position: absolute; right: 0; top: 0; width: ${Math.round(W * 0.45)}px; height: ${H}px; }
.divider .dv-photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
.divider .dv-photo .cr { position: absolute; left: 10px; bottom: 8px; max-width: 90%; font-size: 10px; color: #fff; background: rgba(40,30,25,.55); padding: 1px 6px; border-radius: 3px; }
.divider .dv-text { position: absolute; left: 64px; top: 150px; width: ${Math.round(W * 0.45)}px; }
.divider .foot { right: ${Math.round(W * 0.45) + 24}px; }
.divider .pnum { color: #fff; text-shadow: 0 0 3px rgba(40,30,25,.8); }
.divider .dv-text.wide { width: ${W - 128}px; }
.divider.nophoto .pnum { color: ${c.credit}; text-shadow: none; }
.divider.nophoto .foot { right: 90px; }
.divider .pn { font-size: 20px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: ${c.rust}; }
.divider h1 { font-size: 50px; line-height: 1.05; margin-top: 10px; text-align: left; }
.divider .sub { text-align: left; }
.divider .rule { width: 64px; height: 4px; border-radius: 2px; background: ${c.accent}; margin: 22px 0; }
.divider ol { list-style: none; }
.divider ol li { font-size: ${s.sizes.body}px; line-height: 1.35; padding: 7px 0; border-bottom: 1px solid #ece3d9; }
`;
};

const lectureText = (m: DeckMeta) => (m.lecture ? (m.lecture.number != null ? `Lecture ${m.lecture.number}` : m.lecture.key ?? "") : "");
const footerText = (m: DeckMeta, s: DeckStyle) =>
  s.footer.text ??
  [s.footer.showClass ? m.className ?? "" : "", s.footer.showLecture ? lectureText(m) : "", s.footer.showTitle ? m.title : "", s.footer.showDate ? m.lecture?.date ?? "" : ""]
    .filter(Boolean)
    .join(" · ");
const multiline = (t: string) => t.split(/\r?\n/).map(inlineMd).join("<br>");

const tableHtml = (t: NonNullable<DeckSlide["table"]>) =>
  `<table class="t"><thead><tr>${t.head.map((h) => `<th>${inlineMd(h)}</th>`).join("")}</tr></thead><tbody>${t.rows
    .map((r, i) => `<tr${i === t.highlightRow ? ' class="hl"' : ""}>${t.head.map((_, j) => `<td>${inlineMd(r[j] ?? "")}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
const flowHtml = (rows: string[][]) => `<div class="flow">${rows.map((r) => `<div class="fr">${r.map((b) => `<div class="fb">${inlineMd(b)}</div>`).join('<span class="fa">→</span>')}</div>`).join("")}</div>`;
const cardsHtml = (cards: NonNullable<DeckSlide["cards"]>) =>
  `<div class="cards">${cards.map((k) => `<div class="card">${k.title ? `<h3>${inlineMd(k.title)}</h3>` : ""}${multiline(k.text)}</div>`).join("")}</div>`;
const calloutHtml = (k: NonNullable<DeckSlide["callout"]>) => `<div class="callout">${k.label ? `<span class="lbl">${escapeHtml(k.label)}</span>` : ""}${multiline(k.text)}</div>`;
const imageHtml = (im: PreparedImage, h: number) =>
  `<figure class="ph"><img src="${im.dataUri}" alt="" style="--h:${h}px;object-fit:${im.fit}">${
    im.caption || im.credit ? `<figcaption><span>${im.caption ? inlineMd(im.caption) : ""}</span>${im.credit ? `<span class="cr">${escapeHtml(im.credit)}</span>` : ""}</figcaption>` : ""
  }</figure>`;
const svgHtml = (m: PreparedMedia) => (m.svg ? `<figure class="dg">${m.svg}${m.svgCaption ? `<figcaption>${inlineMd(m.svgCaption)}</figcaption>` : ""}</figure>` : "");

/** The deck page. Pure: media must already be prepared (sanitized / inlined). One `<section class="slide…">` per slide. */
export function buildDeckHtml(meta: DeckMeta, slides: DeckSlide[], media: PreparedMedia[], style: DeckStyle): string {
  const foot = footerText(meta, style);
  const sections = slides.map((sl, i) => {
    const m = media[i] ?? NO_MEDIA;
    const ftag = sl.filled ? `<div class="ftag"><i>F</i>Filled in from ${escapeHtml(sl.filled)}</div>` : "";
    const footer = style.footer.enabled ? `${foot ? `<div class="foot">${escapeHtml(foot)}</div>` : ""}${style.footer.showPageNumber ? `<div class="pnum">${i + 1}</div>` : ""}` : "";
    const sub = sl.subtitle ? `<div class="sub">${inlineMd(sl.subtitle)}</div>` : "";

    if (sl.kind === "divider") {
      const photo = m.images[0];
      return `<section class="slide divider${photo ? "" : " nophoto"}">${ftag}${
        photo ? `<div class="dv-photo"><img src="${photo.dataUri}" alt="">${photo.credit ? `<span class="cr">${escapeHtml(photo.credit)}</span>` : ""}</div>` : ""
      }<div class="dv-text${photo ? "" : " wide"}">${sl.part ? `<div class="pn">${escapeHtml(sl.part)}</div>` : ""}<h1>${inlineMd(sl.title)}</h1>${sub}<div class="rule"></div>${
        sl.bullets?.length ? `<ol>${sl.bullets.map((b) => `<li>${inlineMd(b)}</li>`).join("")}</ol>` : ""
      }</div>${footer}</section>`;
    }

    const kicker = sl.part ? `<div class="kicker">${escapeHtml(sl.part)}</div>` : "";
    const hasText = !!(sl.bullets?.length || sl.body?.trim());
    const hasMedia = m.images.length > 0 || !!m.svg;
    if (!hasText && !hasMedia && !sl.table && !sl.flow && !sl.cards && !sl.callout) {
      const coverSub = sl.subtitle ?? (i === 0 ? [meta.className, lectureText(meta), meta.lecture?.date].filter(Boolean).join(" · ") : "");
      return `<section class="slide">${ftag}${kicker}<div class="cover"><h1>${inlineMd(sl.title)}</h1><div class="rule"></div>${coverSub ? `<div class="sub">${inlineMd(coverSub)}</div>` : ""}</div>${footer}</section>`;
    }
    const text = hasText
      ? `<div class="text">${sl.bullets?.length ? `<ul>${sl.bullets.map((b) => `<li>${inlineMd(b)}</li>`).join("")}</ul>` : ""}${sl.body?.trim() ? markdownToHtml(sl.body) : ""}</div>`
      : "";
    const n = m.images.length;
    const mediaHtml = hasMedia
      ? hasText
        ? `<div class="media">${m.images.map((im) => imageHtml(im, n === 1 ? 250 : n === 2 ? 160 : 110)).join("")}${svgHtml(m)}</div>`
        : `<div class="media alone">${m.images.map((im) => imageHtml(im, n === 1 ? 380 : n === 2 ? 300 : 220)).join("")}${svgHtml(m)}</div>`
      : "";
    const top = text && mediaHtml ? `<div class="row">${text}${mediaHtml}</div>` : text || mediaHtml;
    const content = `${top}${sl.cards ? cardsHtml(sl.cards) : ""}${sl.callout ? calloutHtml(sl.callout) : ""}${sl.table ? tableHtml(sl.table) : ""}${sl.flow ? flowHtml(sl.flow) : ""}`;
    const notes = style.notes.enabled ? `<div class="notes"><span>${escapeHtml(style.notes.label)}</span></div>` : "";
    return `<section class="slide">${ftag}${kicker}<header><h1>${inlineMd(sl.title)}</h1>${sub}</header><div class="body${sl.subtitle ? "" : " nosub"}"><div class="content" data-base="${style.sizes.body}">${content}</div>${notes}</div>${footer}</section>`;
  });
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(meta.title)}</title><style>${css(style)}</style></head><body>${sections.join("")}</body></html>`;
}

/** A plain-text outline of everything on the slides plus speaker notes — stored on the file item for search and get_item. */
export function deckOutlineHtml(meta: DeckMeta, slides: DeckSlide[]): string {
  const e = escapeHtml;
  const br = (t: string) => e(t).replace(/\n/g, "<br>");
  return [
    `<h1>${e(meta.title)}</h1>`,
    ...slides.map((s, i) => {
      const images = [...(s.images ?? []), ...(s.figure?.imageUrl ? [{ caption: s.figure.caption, credit: undefined }] : [])];
      return (
        `<h2>${i + 1}. ${s.part ? `[${e(s.part)}] ` : ""}${e(s.title)}</h2>` +
        (s.subtitle ? `<p>${e(s.subtitle)}</p>` : "") +
        (s.bullets?.length ? `<ul>${s.bullets.map((b) => `<li>${e(b)}</li>`).join("")}</ul>` : "") +
        (s.body?.trim() ? `<p>${br(s.body)}</p>` : "") +
        (s.cards ?? []).map((k) => `<p>${k.title ? `${e(k.title)}: ` : ""}${br(k.text)}</p>`).join("") +
        (s.callout ? `<p>${s.callout.label ? `${e(s.callout.label)}: ` : ""}${br(s.callout.text)}</p>` : "") +
        (s.table ? `<p>${[s.table.head, ...s.table.rows].map((r) => r.map(e).join(" | ")).join("<br>")}</p>` : "") +
        (s.flow ? `<p>${s.flow.map((r) => r.map(e).join(" → ")).join("<br>")}</p>` : "") +
        images.map((im) => (im.caption || im.credit ? `<p>Image: ${e(im.caption ?? "")}${im.credit ? ` (${e(im.credit)})` : ""}</p>` : "")).join("") +
        (s.svgCaption || (s.figure?.svg && s.figure.caption) ? `<p>Figure: ${e(s.svgCaption ?? s.figure!.caption)}</p>` : "") +
        (s.filled ? `<p>Filled in from ${e(s.filled)}</p>` : "") +
        (s.notes?.trim() ? `<p>Speaker notes: ${br(s.notes)}</p>` : "")
      );
    }),
  ].join("");
}

/** Resolve every slide's images (inbox or open-license) and sanitize its svg; any bad one is a DeckInputError naming its slide. */
/** All of a deck's inlined images together, every occurrence (decoded bytes). */
export const DECK_MAX_IMAGE_BYTES = 40 * 1048576;

export async function prepareMedia(userId: Types.ObjectId, slides: DeckSlide[]): Promise<PreparedMedia[]> {
  const imagesOf = (s: DeckSlide) => [...(s.images ?? []), ...(s.figure?.imageUrl ? [{ url: s.figure.imageUrl, caption: s.figure.caption }] : [])];
  if (slides.some((s) => imagesOf(s).length > SLIDE_MAX_IMAGES)) throw new DeckInputError("VALIDATION_ERROR", `At most ${SLIDE_MAX_IMAGES} images per slide`);
  if (slides.reduce((n, s) => n + imagesOf(s).length, 0) > DECK_MAX_IMAGES) throw new DeckInputError("VALIDATION_ERROR", `At most ${DECK_MAX_IMAGES} images per deck`);
  const named = (i: number, e: unknown) => (e instanceof DeckInputError ? new DeckInputError(e.code, `slide ${i + 1}: ${e.message}`) : e);
  // Open-license urls: credits first (nothing is fetched for a deck that will be refused), then
  // every distinct url starts fetching in slide order, a few at a time, all under ONE deck-wide
  // deadline. The loop below still awaits them in slide order, so the slide an error names
  // doesn't depend on which fetch happened to finish first.
  const fetches = new Map<string, Promise<string>>();
  for (const [i, s] of slides.entries()) {
    for (const im of imagesOf(s)) {
      if (openImageUrl(im.url.trim()) && !("credit" in im && im.credit?.trim())) throw named(i, new DeckInputError("VALIDATION_ERROR", "an open-license image url needs a credit (author, licence, source)"));
    }
  }
  const deck = new AbortController();
  const deadline = setTimeout(() => deck.abort(), OPEN_IMAGE_TIMING.deckMs);
  const slot = limiter(OPEN_IMAGE_TIMING.concurrency);
  for (const s of slides) {
    for (const im of imagesOf(s)) {
      const ref = im.url.trim();
      const external = openImageUrl(ref);
      if (!external || fetches.has(ref)) continue;
      const p = slot(() => (deck.signal.aborted ? Promise.reject(fetchFailed("image fetching took too long")) : openImageDataUri(external, deck.signal)));
      p.catch(() => undefined); // awaited (or abandoned) in slide order below
      fetches.set(ref, p);
    }
  }
  try {
    return await resolveMedia(userId, slides, imagesOf, fetches, named);
  } finally {
    clearTimeout(deadline);
    deck.abort(); // a refused deck stops whatever is still in flight
  }
}

/** At most `n` of the returned function's tasks run at once; the rest start in call order. */
function limiter(n: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => waiting.push(r));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

async function resolveMedia(
  userId: Types.ObjectId,
  slides: DeckSlide[],
  imagesOf: (s: DeckSlide) => Array<{ url: string; caption?: string; credit?: string; fit?: "cover" | "contain" }>,
  fetches: Map<string, Promise<string>>,
  named: (i: number, e: unknown) => unknown
): Promise<PreparedMedia[]> {
  const cache = new Map<string, string>();
  let bytes = 0;
  const out: PreparedMedia[] = [];
  for (const [i, s] of slides.entries()) {
    try {
      const images: PreparedImage[] = [];
      for (const im of imagesOf(s)) {
        const ref = im.url.trim();
        const dataUri = cache.get(ref) ?? (await (fetches.get(ref) ?? inboxImageDataUri(userId, ref)));
        cache.set(ref, dataUri);
        // every occurrence is inlined in the HTML, so each one counts (base64 → bytes); refuse
        // before the deck's inlined images can exhaust the worker's memory
        bytes += Math.floor((dataUri.length - dataUri.indexOf(",") - 1) * 0.75);
        if (bytes > DECK_MAX_IMAGE_BYTES) throw new DeckInputError("VALIDATION_ERROR", `Images total more than ${DECK_MAX_IMAGE_BYTES / 1048576} MB — use fewer or smaller images`);
        images.push({ dataUri, caption: im.caption ?? null, credit: im.credit ?? null, fit: im.fit ?? "cover" });
      }
      const rawSvg = s.svg ?? s.figure?.svg ?? null;
      out.push({ images, svg: rawSvg ? sanitizeSvg(rawSvg) : null, svgCaption: s.svgCaption ?? (s.figure?.svg ? s.figure.caption || null : null) });
    } catch (e) {
      throw named(i, e);
    }
  }
  return out;
}

// ─── render ─────────────────────────────────────────────────────────────────────────────

/**
 * Shrinks a slide's content in 5 % steps while it overflows, never below 20px body text, and
 * returns the 1-based numbers of the slides that still overflow (their bottom is clipped) —
 * title/divider slides (no .content) are measured as a whole. A
 * string, not a function: this tsconfig downlevels to es2016 and only the page's own source
 * crosses into the browser (see services/whiteboard-ink-raster.service.ts).
 */
const FIT_SCRIPT = `(function () {
  var over = [];
  document.querySelectorAll('.slide').forEach(function (s, i) {
    var c = s.querySelector('.content');
    // title / divider layouts have no .content to shrink: still report them when the slide clips
    if (!c) { if (s.scrollHeight > s.clientHeight + 1 || s.scrollWidth > s.clientWidth + 1) over.push(i + 1); return; }
    var base = Number(c.getAttribute('data-base')) || 20, f = 100, floor = Math.max(55, 2000 / base);
    var fits = function () { return c.scrollHeight <= c.clientHeight + 1 && c.scrollWidth <= c.clientWidth + 1; };
    while (!fits() && f - 5 >= floor) {
      f -= 5;
      c.style.fontSize = (base * f / 100) + 'px';
    }
    if (!fits()) over.push(i + 1);
  });
  return over;
})()`;

// One Chromium at a time for the whole process: concurrent calls queue here instead of each launching a browser.
let queue: Promise<unknown> = Promise.resolve();

/** HTML → PDF bytes at the style's page size, plus the slides that overflow (one browser, closed after use; no network except data:/about:). */
export const renderDeckPdf = (html: string, page: DeckStyle["page"] = DEFAULT_DECK_STYLE.page) => renderHtmlPdf(html, page, { fit: true, scripts: true });

/**
 * The one Chromium path (shared queue). `fit` runs the deck's slide-overflow pass; `scripts: false`
 * keeps JavaScript off for the whole render (print handlers included), so caller HTML can never run
 * or spin; our own `evaluate` calls still work with page scripts disabled.
 */
export function renderHtmlPdf(
  html: string,
  page: DeckStyle["page"],
  opts: { fit: boolean; scripts: boolean }
): Promise<{ pdf: Buffer; overflow: number[] }> {
  const job = queue.then(async () => {
    const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"] });
    try {
      const tab = await browser.newPage();
      await tab.setRequestInterception(true);
      tab.on("request", (r) => (/^(data|about):/i.test(r.url()) ? r.continue() : r.abort()));
      if (!opts.scripts) await tab.setJavaScriptEnabled(false);
      await tab.setContent(html, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
      await tab.evaluate("document.fonts.ready");
      const over = opts.fit ? await tab.evaluate(FIT_SCRIPT) : [];
      const pdf = await tab.pdf({ width: `${page.widthIn}in`, height: `${page.heightIn}in`, printBackground: true, preferCSSPageSize: true, timeout: RENDER_TIMEOUT_MS });
      return { pdf: Buffer.from(pdf), overflow: Array.isArray(over) ? over.map(Number) : [] };
    } finally {
      await browser.close();
    }
  });
  queue = job.catch(() => undefined);
  return job;
}

export const pdfPageCount = async (pdf: Buffer) => (await PDFDocument.load(pdf)).getPageCount();
