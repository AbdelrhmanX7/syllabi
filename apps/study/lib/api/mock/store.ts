// Blob side of the mock: what a presigned `mock://` PUT stores and a `mock://` GET returns.
const blobs = new Map<string, Blob>();

export function getMockBlobStore(): Map<string, Blob> {
  return blobs;
}
