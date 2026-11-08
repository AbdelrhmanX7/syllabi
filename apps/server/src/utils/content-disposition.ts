const encodeRfc5987 = (value: string) =>
  encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** `attachment` Content-Disposition with an ASCII fallback plus the RFC 5987 UTF-8 filename. */
export const attachmentContentDisposition = (filename: string, asciiFallback: string) =>
  `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
