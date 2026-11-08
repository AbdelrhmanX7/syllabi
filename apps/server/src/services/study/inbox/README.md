# Study phone inbox

Send photos and PDFs from the phone to the Study app on the tablet.

Base URL: your Syllabi server, e.g. `https://syllabi.example.com` (below: `<SERVER>`).

## Endpoints

| Route | Auth | Notes |
|---|---|---|
| `POST /study/inbox/tokens {label}` | admin JWT | → `201 {id, token:'sk_drop_…', label, createdAt}`. The token is shown **once**. |
| `GET /study/inbox/tokens` | admin JWT | → `[{id, label, prefix, createdAt, lastUsedAt}]` |
| `DELETE /study/inbox/tokens/:id` | admin JWT | → `204`. The next request with that token gets a 401. |
| `POST /study/inbox` | admin JWT, `Authorization: Bearer sk_drop_…`, or `?t=sk_drop_…` | multipart: `file` (required, one file), `note` (≤ 500 chars), `classId` (an owned class), `pageId` (an owned page — queue it for that note). → `201` item |
| `GET /study/inbox?since=<ISO>` | admin JWT | newest 50, `createdAt > since` |
| `GET /study/inbox?pageId=<id>` | admin JWT | every item still queued for that page (`usedAt: null`), not capped by recency |
| `GET /study/inbox/:id` | admin JWT | one item, fresh `url`, **even if soft-deleted**; 404 when not yours or the file is gone |
| `PATCH /study/inbox/:id {usedAt?, pageId?}` | admin JWT | at least one; ISO string / id, or `null` (`pageId: null` drops the queued placement) |
| `DELETE /study/inbox/:id` | admin JWT | → `204`, soft delete (the object is kept) |
| `GET /study/inbox/stream` | admin JWT | SSE, `event: item` per upload, `: ping` every 10 s |
| `GET /study/drop?t=sk_drop_…` | drop token | the phone upload page (401 page when invalid/revoked) |

Item: `{id, kind:'image'|'pdf', url, thumbUrl, width, height, bytes, note, classId, pageId, createdAt, usedAt}`.

`pageId` = the notebook page the item is queued for (MCP `add_inbox_to_page`, or `pageId` on the
upload / `get_inbox_upload_link` / `render_pdf_to_inbox`). The BE never writes board JSON: when that
page opens, the notebook fetches `?pageId=`, appends each PDF's pages to the end of the note and
places each photo, then `PATCH {usedAt}`.
`url` and `thumbUrl` are signed and valid for 1 h, so refetch the list for fresh URLs.

Errors (`{message, code}`): `400 VALIDATION_ERROR`, `401 UNAUTHORIZED`, `404 NOT_FOUND`,
`413 PAYLOAD_TOO_LARGE` (> 25 MB), `415 UNSUPPORTED_TYPE` / `HEIC_UNSUPPORTED`, `429` (more
than 60 uploads per 10 min per token).

Accepted: JPEG, PNG, HEIC/HEIF, WebP, PDF. The type is detected from the file's bytes, so the
`Content-Type` and the filename don't matter. Images are auto-rotated, scaled down to a 3000 px
long side, stripped of all metadata (EXIF and GPS), and re-encoded as JPEG q85. PNGs that have
real transparency stay PNG. PDFs are stored unchanged, and the thumb is page 1.

## iOS Shortcut ("Send to Study")

Text for Settings → Phone inbox. Replace `<TOKEN>` with the drop token you just created.

1. Create a new Shortcut. In its settings (ⓘ), turn on **Show in Share Sheet** and set
   **Receive** to *Images* and *PDFs*.
2. Add **Get Contents of URL**:
   - URL: `<SERVER>/study/inbox`
   - Method: **POST**
   - Headers: add `Authorization` = `Bearer <TOKEN>`
   - Request Body: **Form**. Add a field of type **File** named `file`, value **Shortcut Input**.
   - Optional: a **Text** field `note`.
3. Optional: add **Show Notification** "Sent to Study".

To share several photos at once, wrap step 2 in **Repeat with Each** (item = Shortcut Input) and
set the `file` field to **Repeated Item**. The server takes one file per request.

HEIC needs no conversion step; the server converts it to JPEG. If a request ever comes back
`415 HEIC_UNSUPPORTED`, add **Convert Image** (format JPEG) before step 2.

## Browser fallback

Open `<SERVER>/study/drop?t=<TOKEN>` on the phone (for example, scan a
QR code shown on the tablet). The page removes the token from the address bar as soon as it loads,
so a Home Screen bookmark made afterwards won't include it. For repeat use, the Shortcut above is
the better path.

## Implementation notes

- `tokens.ts`: sha256 hash + lookup prefix, constant-time compare. Revoking deletes the row.
- `media.ts`: magic-byte sniffing and the sharp pipeline. `heic.ts`: HEVC-coded HEIC is decoded
  by the **system libheif + libde265 plugin through an inline python3 ctypes shim**. The prebuilt
  sharp has no HEVC decoder, and ffmpeg 6.1 can't read HEIF image grids.
- `bus.ts`: Redis pub/sub on `study:inbox:<userId>`. It's cross-fork and fails open (the FE also
  polls).
- Indexes: prod runs `autoIndex: false`, so run `yarn add-study-indexes` after deploying. It picks
  up `study_inbox_tokens` and `study_inbox_items` automatically.
