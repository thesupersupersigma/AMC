/* Hero artwork in rendered views — the album page header. The header is
   rendered with whatever is already on hand (the held hero, else the
   thumb) so a re-render never flashes, then upgraded to the hero once it
   is minted and decoded. */

import { coverURL } from '../state';
import { icon } from '../ui/icons';
import { esc } from '../util';
import { heroFor, heroURLNow, setImgDecoded } from './hero';

let upgradeQueued = false;

function upgradeAll(): void {
  upgradeQueued = false;
  const boxes = document.querySelectorAll<HTMLElement>('[data-hero]');
  boxes.forEach((box) => {
    const key = box.getAttribute('data-hero') || '';
    if (!key) return;
    void heroFor(key).then((h) => {
      if (!h || !box.isConnected || box.getAttribute('data-hero') !== key) return;
      let img = box.querySelector('img');
      if (!img) {
        box.innerHTML = '<img alt="">';
        img = box.querySelector('img') as HTMLImageElement;
      }
      setImgDecoded(img, h.url);
    });
  });
}

/** Queues the hero upgrade for every [data-hero] box once the current
    render has reached the DOM. */
export function scheduleHeroUpgrade(): void {
  if (upgradeQueued) return;
  upgradeQueued = true;
  /* A macrotask: the render that called us has reached the DOM by then
     (and unlike rAF it still runs in a hidden tab). */
  setTimeout(upgradeAll, 0);
}

/** The album header's art box: hero if held, else the thumb, else the
    placeholder — upgraded to the hero after render. */
export function heroArtBox(key: string, cls: string, phIcon: string): string {
  const u = heroURLNow(key) || coverURL(key);
  scheduleHeroUpgrade();
  return (
    '<div class="' + cls + '" data-hero="' + esc(key) + '">' +
    (u ? '<img src="' + esc(u) + '" alt="">' : '<div class="ph">' + icon(phIcon) + '</div>') +
    '</div>'
  );
}
