/* Turntable mode for the full-screen Now Playing view: markup and the
   mode switch. A top-down deck — plinth, platter, the record with the
   album cover as its label, a tonearm on its pivot — and the album's
   sleeve leaning beside it. DOM + CSS transforms only; nothing is drawn
   per frame. All playback access goes through ./playback. */

import { S, savePrefs } from '../../state';
import { esc } from '../../util';
import {
  ARM_L, C, DECK, PIVOT, REST_DEG, R_LABEL, R_PLATTER, R_RECORD, R_SPINDLE, SLEEVE, STAGE_H, STAGE_W, pctX, pctY,
} from './geometry';

export type NpMode = 'cover' | 'turntable';

export function npMode(): NpMode {
  return S.npMode === 'turntable' ? 'turntable' : 'cover';
}

export function setNpMode(m: NpMode): void {
  S.npMode = m;
  savePrefs();
}

/* ---------- markup ---------- */

function box(x: number, y: number, w: number, h: number): string {
  return 'left:' + pctX(x) + ';top:' + pctY(y) + ';width:' + pctX(w) + ';height:' + pctY(h) + ';';
}
function disc(cx: number, cy: number, r: number): string {
  return box(cx - r, cy - r, 2 * r, 2 * r);
}

/** The deck. Positions are stage-unit percentages, so the whole drawing
    scales with the stage box. */
export function turntableMarkup(): string {
  const sl = SLEEVE;
  return (
    '<div class="tt" id="tt" aria-label="Turntable">' +
    '<div class="tt-stage" style="aspect-ratio:' + STAGE_W + '/' + STAGE_H + '">' +
    '<div class="tt-world" id="ttWorld">' +
    /* plinth with its fittings */
    '<div class="tt-plinth" style="' + box(DECK.x, DECK.y, DECK.w, DECK.h) + '">' +
    '<span class="tt-lamp"></span><span class="tt-startbtn">START·STOP</span><span class="tt-pitch"><i></i></span>' +
    '</div>' +
    /* platter: rim with strobe dots and a rubber mat */
    '<div class="tt-platter" id="ttPlatter" style="' + disc(C.x, C.y, R_PLATTER) + '"><div class="tt-mat"></div></div>' +
    /* the record: the spinning disc (grooves + label) under a sheen that
       does not rotate */
    '<div class="tt-rec" id="ttRec" style="' + disc(C.x, C.y, R_RECORD) + '">' +
    '<div class="tt-rec-spin" id="ttRecSpin"><div class="tt-vinyl"></div><div class="tt-bands" id="ttBands"></div>' +
    '<div class="tt-label" style="' + labelBox() + '"><img id="ttLabel" alt=""><span class="tt-label-ph"></span></div>' +
    '</div>' +
    '<div class="tt-sheen"></div>' +
    '</div>' +
    '<div class="tt-spindle" style="' + disc(C.x, C.y, R_SPINDLE) + '"></div>' +
    /* the sleeve, leaning beside the deck */
    '<div class="tt-sleeve" id="ttSleeve" style="' + disc(sl.x, sl.y, sl.side / 2) + '--tilt:' + sl.tilt + 'deg">' +
    '<img id="ttSleeveImg" alt=""><span class="tt-sleeve-ph"></span></div>' +
    /* tonearm: base, rest post, the arm itself, the pivot cap */
    '<div class="tt-armbase" style="' + disc(PIVOT.x, PIVOT.y, 62) + '"></div>' +
    '<div class="tt-rest" style="' + disc(PIVOT.x + 360 * Math.cos((REST_DEG * Math.PI) / 180), PIVOT.y + 360 * Math.sin((REST_DEG * Math.PI) / 180), 16) + '"></div>' +
    '<div class="tt-arm" id="ttArm" style="left:' + pctX(PIVOT.x) + ';top:' + pctY(PIVOT.y) + ';width:' + pctX(ARM_L + 34) + '">' +
    '<div class="tt-arm-cw"></div><div class="tt-arm-tube"></div>' +
    '<div class="tt-head" id="ttHead" tabindex="0" role="slider" aria-label="Tonearm — drag or use the arrow keys to move through the record" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-valuetext="0:00">' +
    '<i class="tt-cart"></i><i class="tt-lift"></i></div>' +
    '</div>' +
    '<div class="tt-pivotcap" style="' + disc(PIVOT.x, PIVOT.y, 26) + '"></div>' +
    '</div></div></div>'
  );
}

/** The label box inside the spinning disc, as a percentage of the record. */
function labelBox(): string {
  const p = (R_LABEL / R_RECORD) * 50;
  return 'left:' + (50 - p).toFixed(4) + '%;top:' + (50 - p).toFixed(4) + '%;width:' + (2 * p).toFixed(4) + '%;height:' + (2 * p).toFixed(4) + '%;';
}

/** The speed control that lives beside the deck in turntable mode. */
export function speedMarkup(): string {
  return (
    '<div class="tt-speed" id="ttSpeed" role="group" aria-label="Turntable speed">' +
    '<div class="tt-speed-row">' +
    '<div class="tt-presets" role="group" aria-label="Speed presets">' +
    '<button type="button" class="seg-btn" data-rpm="33.333" aria-pressed="false">33⅓</button>' +
    '<button type="button" class="seg-btn" data-rpm="45" aria-pressed="false">45</button>' +
    '<button type="button" class="seg-btn" data-rpm="78" aria-pressed="false">78</button>' +
    '</div>' +
    '<span class="tt-rpm-read" id="ttRpmRead" aria-live="polite">33⅓ RPM</span>' +
    '<button type="button" class="pill-ghost tt-reset" id="ttRpmReset" title="Back to 33⅓ RPM">↺ 33⅓</button>' +
    '</div>' +
    '<input type="range" id="ttRpm" min="16" max="78" step="0.1" value="33.3" aria-label="Turntable speed in RPM">' +
    '<label class="tt-brake"><input type="checkbox" id="ttBrake"> Stop/start effect <span class="set-hint">— the platter brakes and spins up with the sound</span></label>' +
    '</div>'
  );
}

/** The mode toggle for the view's own controls. */
export function modeButtonMarkup(): string {
  const tt = npMode() === 'turntable';
  return (
    '<button type="button" class="pb-btn np-mode" id="npMode" aria-pressed="' + tt + '" title="' + esc(tt ? 'Cover view' : 'Turntable view') + '" aria-label="' + esc(tt ? 'Switch to the cover view' : 'Switch to the turntable view') + '">' +
    modeIcon(tt) +
    '</button>'
  );
}

function modeIcon(tt: boolean): string {
  /* In turntable mode the button offers the cover; otherwise a record. */
  return tt
    ? '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M4 15l4.5-4.5 4 4 2.5-2.5L20 17"/></svg>'
    : '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="12.5" r="7.5"/><circle cx="10.5" cy="12.5" r="2"/><path d="M19.5 3.5v8.5l-3.2 3.3"/></svg>';
}

export function syncModeButton(): void {
  const b = document.getElementById('npMode');
  if (!b) return;
  const tt = npMode() === 'turntable';
  b.setAttribute('aria-pressed', String(tt));
  b.title = tt ? 'Cover view' : 'Turntable view';
  b.setAttribute('aria-label', tt ? 'Switch to the cover view' : 'Switch to the turntable view');
  b.innerHTML = modeIcon(tt);
}
