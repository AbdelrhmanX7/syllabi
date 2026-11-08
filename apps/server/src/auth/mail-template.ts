/**
 * Branded HTML for account emails. Table layout + inline styles so it renders the same in Gmail,
 * Outlook and Apple Mail; the plain-text part is always sent alongside it.
 * Colours follow the app's Notebook Blue palette (no pure black); radius ladder 12px buttons / 16px cards.
 */
const BRAND = "#2F5BEA";
const BRAND_LIP = "#1E3FB8";
const INK = "#1B2350";
const MUTED = "#5A6390";
const PAGE = "#F1F4FC";
const CARD = "#FFFFFF";
const LINE = "#D9E0F5";
const FONT = "Inter, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const LOGO = "https://syllabi.studio/apple-touch-icon.png";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface MailContent {
  /** Inbox preview line (hidden in the body). */
  preheader: string;
  title: string;
  body: string;
  action: string;
  link: string;
  /** e.g. "This link works once and expires in 15 minutes." */
  expiry: string;
  /** Shown under the card; defaults to the "didn't ask for this" line. */
  footnote?: string;
}

export function renderMailHtml(c: MailContent): string {
  const footnote = c.footnote ?? "If you didn't ask for this, you can ignore this email. Nothing changes until the link is opened.";
  const link = esc(c.link);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(c.title)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${PAGE};">${esc(c.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE};">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
      <tr><td style="padding:0 4px 16px 4px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="vertical-align:middle;"><img src="${LOGO}" width="36" height="36" alt="" style="display:block;border:0;border-radius:8px;"></td>
          <td style="vertical-align:middle;padding-left:10px;font-family:${FONT};font-size:20px;font-weight:800;color:${INK};letter-spacing:-0.2px;">Syllabi</td>
        </tr></table>
      </td></tr>
      <tr><td style="background:${CARD};border:2px solid ${LINE};border-bottom-width:5px;border-radius:16px;padding:28px 28px 24px 28px;">
        <h1 style="margin:0 0 10px 0;font-family:${FONT};font-size:22px;line-height:1.3;font-weight:800;color:${INK};">${esc(c.title)}</h1>
        <p style="margin:0 0 22px 0;font-family:${FONT};font-size:15px;line-height:1.6;color:${INK};">${esc(c.body)}</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="background:${BRAND};border-radius:12px;border-bottom:4px solid ${BRAND_LIP};">
            <a href="${link}" style="display:inline-block;padding:13px 24px;font-family:${FONT};font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:12px;">${esc(c.action)}</a>
          </td>
        </tr></table>
        <p style="margin:18px 0 0 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${MUTED};">${esc(c.expiry)}</p>
        <p style="margin:16px 0 0 0;padding-top:14px;border-top:1px solid ${LINE};font-family:${FONT};font-size:12px;line-height:1.5;color:${MUTED};">
          Button not working? Paste this into your browser:<br>
          <a href="${link}" style="color:${BRAND};word-break:break-all;">${link}</a>
        </p>
      </td></tr>
      <tr><td style="padding:16px 4px 0 4px;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED};">
        ${esc(footnote)}<br>
        <a href="https://syllabi.studio" style="color:${MUTED};">syllabi.studio</a> · the open-source study app ·
        <a href="https://syllabi.studio/privacy/" style="color:${MUTED};">Privacy</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}
