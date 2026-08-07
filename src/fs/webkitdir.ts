/* The `<input webkitdirectory>` picker — read-only, session-scoped. This is
   the only picker in Phase 1, exactly as in v1; Phase 2 adds the File System
   Access backend behind fs/adapter.ts. */

import { $ } from '../util';

export function pickFolder(): void {
  const input = $<HTMLInputElement>('#picker');
  input.value = '';
  input.click();
}
