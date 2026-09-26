/* The thumb tier's size, measured from the display rather than fixed.
   The largest thumb AMC renders is an album grid tile; its box times the
   device pixel ratio (capped at 2×) is what a thumb must cover to stay
   sharp. Clamped to 320–400 px: below that, a window resize or a move to
   a denser screen would outgrow the cache; above it, the grid gains
   nothing and IndexedDB pays for it.

   No state import — state.ts's makeThumb uses this. */

const MIN_PX = 320;
const MAX_PX = 400;
/* .grid in views.css: repeat(auto-fill, minmax(158px, 1fr)), 18px column gap. */
const TILE_MIN = 158;
const TILE_GAP = 18;

let measured = 0;

function estimateTileBox(): number {
  const view = document.getElementById('view');
  /* #view has 22px + 26px horizontal padding. */
  const w = view && view.clientWidth ? view.clientWidth - 48 : Math.max(320, (window.innerWidth || 1365) - 278);
  const cols = Math.max(1, Math.floor((w + TILE_GAP) / (TILE_MIN + TILE_GAP)));
  return (w - (cols - 1) * TILE_GAP) / cols;
}

function measure(): number {
  let box = 0;
  const tiles = document.querySelectorAll('.tile .cover');
  for (let i = 0; i < tiles.length; i++) box = Math.max(box, (tiles[i] as HTMLElement).clientWidth);
  if (!box) box = estimateTileBox();
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const px = Math.ceil((box * dpr) / 8) * 8;
  return Math.min(MAX_PX, Math.max(MIN_PX, px));
}

/** Target longest side for a stored thumb. Grows with the window during a
    session, never shrinks — a smaller window does not need smaller thumbs. */
export function thumbTargetPx(): number {
  try {
    measured = Math.max(measured, measure());
  } catch {
    if (!measured) measured = MIN_PX;
  }
  return measured;
}

/** A stored thumb this far below the target is regenerated the next time
    its source is read. Legacy 300 px thumbs fall under it. */
export function thumbIsStale(longestSide: number): boolean {
  return longestSide < thumbTargetPx() * 0.95;
}
