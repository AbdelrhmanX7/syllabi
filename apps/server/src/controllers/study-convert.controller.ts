import { ConversionError, officeToPdf, resolveExt } from "@/services/study/office-to-pdf";
import { attachmentContentDisposition as rosterExportContentDisposition } from "@/utils/content-disposition";
import { fail, wrap } from "./study.controller";

/**
 * POST /study/convert/pdf — raw file bytes in (Content-Type = file mime, `X-File-Name` URI-encoded),
 * `application/pdf` out. Nothing is stored: the client imports the PDF itself.
 */
export const convertToPdf = wrap(async (req, res) => {
  let fileName: string | null = null;
  const rawName = req.get("x-file-name");
  if (rawName) {
    try {
      fileName = decodeURIComponent(rawName);
    } catch {
      return fail(res, 400, "VALIDATION_ERROR", "X-File-Name must be URI-encoded");
    }
  }
  const ext = resolveExt(fileName, req.get("content-type"));
  if (!ext) return fail(res, 415, "UNSUPPORTED_TYPE", "Unsupported file type. Use doc, docx, ppt, pptx, xls, xlsx, odt, odp, ods, rtf or txt.");
  const body: unknown = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) return fail(res, 400, "EMPTY_BODY", "Request body is empty");

  let pdf: Buffer;
  try {
    pdf = await officeToPdf(body, ext);
  } catch (e) {
    if (e instanceof ConversionError) return fail(res, 422, "CONVERSION_FAILED", e.message);
    // LibreOffice is an optional system dependency (the Docker image ships it).
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT")
      return fail(res, 503, "CONVERTER_UNAVAILABLE", "Office conversion is not available on this server (install LibreOffice: soffice).");
    throw e;
  }

  const base = (fileName ? fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "") : "") || "document";
  // A raw non-latin1 header value throws ERR_INVALID_CHAR — ASCII fallback + RFC 5987 filename*.
  const ascii = base.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", rosterExportContentDisposition(`${base}.pdf`, `${ascii}.pdf`));
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  res.send(pdf);
});
