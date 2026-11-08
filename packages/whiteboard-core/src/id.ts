/**
 * True when `id` looks like a Mongo `_id` (24 lowercase/uppercase hex chars) rather than a
 * client-minted local UUID (from {@link createWhiteboardId}). Cloud sync is only meaningful for
 * documents the backend knows about — i.e. ones with a real ObjectId. Local/imported boards keep
 * a UUID until they're linked to a server `_id`, so the syncer uses this to skip them entirely
 * (no network, no 400-spam, no polluting the open board's status).
 */
export function isLikelyMongoObjectId(id: string): boolean {
  return /^[a-f0-9]{24}$/i.test(id);
}

export function createWhiteboardId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;

  if (typeof randomUUID === 'function') {
    return randomUUID.call(globalThis.crypto);
  }

  const randomValues = globalThis.crypto?.getRandomValues;

  if (typeof randomValues === 'function') {
    const bytes = new Uint8Array(16);

    randomValues.call(globalThis.crypto, bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));

    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex
      .slice(8, 10)
      .join('')}-${hex.slice(10, 16).join('')}`;
  }

  return `wb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}
