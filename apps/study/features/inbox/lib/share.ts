// Android share target — the page half of ShareReceiver.kt. Files shared into Study (Gallery, Files,
// screenshots, Quick Share) are copied into the app cache natively; here they are listed
// (`StudyShare.pending()`), read one at a time as base64 (`read(id)`) and dropped once used
// (`remove(id)`). A `study-share` window event announces new ones while the app is open.

export const SHARE_EVENT = 'study-share';

export interface SharedFile {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  receivedAt: number;
}

/** `window.StudyShare` (addJavascriptInterface): synchronous, strings only. */
export interface ShareBridge {
  pending(): string;
  read(id: string): string;
  remove(id: string): boolean;
}

export function getShareBridge(): ShareBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as { StudyShare?: ShareBridge }).StudyShare;

  return bridge && typeof bridge.pending === 'function' ? bridge : null;
}

const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** The bridge's JSON list → well-formed entries, oldest first. Anything malformed is dropped. */
export function parsePending(json: string): SharedFile[] {
  let raw: unknown;

  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  return raw
    .filter(
      (entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === 'object' && isString((entry as { id?: unknown }).id),
    )
    .map((entry) => ({
      id: String(entry.id),
      name: isString(entry.name) ? entry.name : 'shared',
      mime: isString(entry.mime) ? entry.mime.toLowerCase() : 'application/octet-stream',
      bytes: Number(entry.bytes) || 0,
      receivedAt: Number(entry.receivedAt) || 0,
    }))
    .filter((file) => isSharedImage(file) || isSharedPdf(file))
    .sort((a, b) => a.receivedAt - b.receivedAt);
}

export const isSharedImage = (file: Pick<SharedFile, 'mime'>) => file.mime.startsWith('image/');
export const isSharedPdf = (file: Pick<SharedFile, 'mime'>) => file.mime === 'application/pdf';

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return bytes;
}

/** A display name with an extension the backend / FileReader understand. */
export function sharedFileName(file: Pick<SharedFile, 'name' | 'mime'>): string {
  if (/\.[a-z0-9]{2,5}$/i.test(file.name)) return file.name;
  const ext = isSharedPdf(file) ? 'pdf' : (file.mime.split('/')[1] ?? 'jpg').replace('jpeg', 'jpg').replace('+xml', '');

  return `${file.name}.${ext}`;
}

/** Read one shared file through the bridge as a `File`. Throws if it is gone. */
export function readSharedFile(bridge: ShareBridge, file: SharedFile): File {
  const b64 = bridge.read(file.id);

  if (!b64) throw new Error(`“${file.name}” is no longer on this tablet. Share it again.`);
  const bytes = base64ToBytes(b64);

  return new File([bytes.buffer as ArrayBuffer], sharedFileName(file), { type: file.mime });
}
