/* One interface over the two folder-access backends. Phase 2 implements the
   full adapter (fsa.ts / webkitdir.ts selection, capability surface, handle
   persistence). Phase 1 uses the webkitdirectory picker directly, as v1 did. */

/** File System Access is only viable when the page is actually served:
    a file:// document has an opaque origin and showDirectoryPicker always
    rejects there. Safari implements no local-disk pickers at all, so it
    always lands on the webkitdirectory fallback — expected, not an error. */
export function canUseFsa(): boolean {
  return location.protocol !== 'file:' && 'showDirectoryPicker' in window;
}
