/* One interface over the two folder-access backends (the FsBackend type in
   types.ts). fsa.ts is Chrome/Edge served-page only; webkitdir.ts is the
   Safari and file:// path — read-only and session-scoped, which is expected
   there, not an error. folders.ts owns the registry and picks the backend
   through detectBackendKind() on every add. */

/** File System Access is only viable when the page is actually served:
    a file:// document has an opaque origin and showDirectoryPicker always
    rejects there. Safari implements no local-disk pickers at all, so it
    always lands on the webkitdirectory fallback. */
export function canUseFsa(): boolean {
  return location.protocol !== 'file:' && 'showDirectoryPicker' in window;
}

export function detectBackendKind(): 'fsa' | 'webkitdir' {
  return canUseFsa() ? 'fsa' : 'webkitdir';
}
