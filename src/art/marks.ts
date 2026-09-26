/* Which Blobs came from the catalog, and at what requested size. A tiny
   leaf module (no imports) so net/catalog.ts can mark what it downloads
   without importing the artwork machinery that depends on it. */

const catalogBlobs = new WeakMap<Blob, number>();

export function markCatalogBlob(blob: Blob, requestedPx: number): void {
  catalogBlobs.set(blob, requestedPx);
}

/** The size the catalog was asked for, or 0 when the blob is not catalog art. */
export function catalogRequestedPx(blob: Blob): number {
  return catalogBlobs.get(blob) || 0;
}
