/* Speed: 32 / 33⅓ / 45 / 78 presets, continuous 16–78 RPM sliders, the
   deck's own pitch fader and 33 / 45 buttons, and the stop/start effect.
   Playback rate = rpm / 33⅓ with the pitch following the speed, like a
   real record.

   The speed is a playback setting, not a view setting: it persists as a
   pref and stays in force everywhere — turntable mode, Cover mode, the
   minimised player bar (which gets its own speed slider next to the
   volume), the mini player — until you change it. ↺ 33⅓ puts it back.

   The stop/start effect: while turntable mode is open, pause ramps the
   rate down to ~0.1× over ~0.8 s (the platter, driven by playback time,
   slows with it) and only then pauses; play from a stopped deck starts at
   ~0.1× and ramps up over ~0.4 s. It wraps the element's own
   pause()/play(), so the player bar, Space, PiP and the Media Session /
   media keys all get it. */

import { S, savePrefs } from '../../state';
import * as pb from './playback';
import { NOMINAL_RPM } from './geometry';

export const MIN_RPM = 16;
export const MAX_RPM = 78;
export const PRESETS = [MIN_RPM, 32, NOMINAL_RPM, 45, MAX_RPM];
const SNAP_RPM = 0.6;
const BRAKE_MS = 800;
const SPINUP_MS = 400;
const FLOOR_RATE = 0.1;

/** Turntable mode is open (the stop/start effect applies only there). */
let active = false;

export function rpmNow(): number {
  const v = S.ttRpm;
  return typeof v === 'number' && v >= MIN_RPM && v <= MAX_RPM ? v : NOMINAL_RPM;
}

export function rateFor(rpm: number): number {
  return rpm / NOMINAL_RPM;
}

export function isNominal(rpm = rpmNow()): boolean {
  return Math.abs(rpm - NOMINAL_RPM) < 0.05;
}

export function fmtRpm(rpm: number): string {
  if (isNominal(rpm)) return '33⅓';
  const r = Math.round(rpm * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** Slider values land exactly on a preset when they come within ~½ RPM
    of one (hold Alt for a free value). */
export function snapRpm(rpm: number, free?: boolean): number {
  const v = Math.max(MIN_RPM, Math.min(MAX_RPM, rpm));
  if (free) return v;
  for (const p of PRESETS) if (Math.abs(v - p) <= SNAP_RPM) return p;
  return v;
}

function frac(rpm: number): number {
  return (rpm - MIN_RPM) / (MAX_RPM - MIN_RPM);
}

/* ---------- UI (every speed control mirrors the one setting) ---------- */

let lastCustom = 45;

export function syncSpeedUI(): void {
  const rpm = rpmNow();
  const label = fmtRpm(rpm) + ' RPM · ' + rateFor(rpm).toFixed(2) + '×';
  const read = document.getElementById('ttRpmRead');
  if (read) read.textContent = label;
  for (const id of ['ttRpm', 'spdRange']) {
    const slider = document.getElementById(id) as HTMLInputElement | null;
    if (!slider) continue;
    slider.value = String(Math.round(rpm * 10) / 10);
    slider.style.setProperty('--p', (frac(rpm) * 100).toFixed(2) + '%');
    slider.setAttribute('aria-valuetext', fmtRpm(rpm) + ' RPM');
  }
  document.querySelectorAll<HTMLElement>('[data-rpm]').forEach((b) => {
    const on = Math.abs(Number(b.getAttribute('data-rpm')) - rpm) < 0.05;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  const reset = document.getElementById('ttRpmReset') as HTMLButtonElement | null;
  if (reset) reset.disabled = isNominal(rpm);
  const brake = document.getElementById('ttBrake') as HTMLInputElement | null;
  if (brake) brake.checked = S.ttBrake !== false;
  /* the deck: pitch fader position and its readout */
  const world = document.getElementById('ttWorld');
  if (world) world.style.setProperty('--pitch-frac', frac(rpm).toFixed(4));
  const led = document.getElementById('ttLed');
  if (led) led.textContent = fmtRpm(rpm);
  const knob = document.getElementById('ttFaderKnob');
  if (knob) {
    knob.setAttribute('aria-valuenow', String(Math.round(rpm * 10) / 10));
    knob.setAttribute('aria-valuetext', fmtRpm(rpm) + ' RPM');
  }
  /* the player bar */
  const btn = document.getElementById('btnSpeed');
  if (btn) {
    btn.classList.toggle('on', !isNominal(rpm));
    const badge = btn.querySelector('b');
    if (badge) badge.textContent = isNominal(rpm) ? '' : fmtRpm(rpm);
    const t = isNominal(rpm) ? 'Speed: 33⅓ RPM (normal) — click for ' + fmtRpm(lastCustom) : 'Speed: ' + label + ' — click for normal speed';
    btn.title = t;
    btn.setAttribute('aria-label', t);
  }
}

export function setRpm(rpm: number): void {
  const v = Math.max(MIN_RPM, Math.min(MAX_RPM, rpm));
  S.ttRpm = isNominal(v) ? NOMINAL_RPM : v;
  if (!isNominal(v)) lastCustom = S.ttRpm;
  savePrefs();
  if (!braking) pb.setRate(rateFor(S.ttRpm));
  syncSpeedUI();
}

export function setBrake(on: boolean): void {
  S.ttBrake = on;
  savePrefs();
  if (active) interceptIfWanted();
  syncSpeedUI();
}

/* ---------- the stop/start effect ---------- */

let braking = false;
let rampTimer: ReturnType<typeof setTimeout> | null = null;
/** The deck was STOPPED (braked to a halt, or found paused on entering the
    mode): the next play spins up. A play that only follows a track load —
    load() pauses the element, then the player plays it — must not, or
    every skip and auto-advance would warble. */
let stopped = false;
pb.onEnded(() => {
  stopped = false;
});

function clearRamp(): void {
  if (rampTimer) clearTimeout(rampTimer);
  rampTimer = null;
}

/** Ramps playbackRate from→to over ms (eased), then calls done. Timer
    based, not rAF: it must finish in a hidden tab too. */
function ramp(from: number, to: number, ms: number, done: () => void): void {
  clearRamp();
  const t0 = performance.now();
  const step = (): void => {
    const p = Math.min(1, (performance.now() - t0) / ms);
    /* ease-in for the brake (slow at first, then the drag bites), ease-out
       for the spin-up */
    const e = to < from ? p * p : 1 - (1 - p) * (1 - p);
    pb.setInstantRate(from + (to - from) * e);
    if (p >= 1) {
      rampTimer = null;
      done();
      return;
    }
    rampTimer = setTimeout(step, 16);
  };
  step();
}

function spinUpFrom(r0: number): void {
  const target = rateFor(rpmNow());
  ramp(Math.max(FLOOR_RATE, r0), target, SPINUP_MS, () => pb.setRate(target));
}

const hooks: pb.TransportHooks = {
  pause(realPause) {
    if (pb.isPaused()) {
      realPause();
      return;
    }
    if (braking) {
      /* A second press while it brakes: start back up, like a deck. */
      braking = false;
      spinUpFrom(pb.getRate());
      return;
    }
    braking = true;
    document.getElementById('npview')?.classList.add('tt-braking');
    ramp(pb.getRate(), FLOOR_RATE, BRAKE_MS, () => {
      braking = false;
      stopped = true;
      document.getElementById('npview')?.classList.remove('tt-braking');
      realPause();
      pb.setRate(rateFor(rpmNow()));
    });
  },
  play(realPlay) {
    if (braking) {
      braking = false;
      document.getElementById('npview')?.classList.remove('tt-braking');
      spinUpFrom(pb.getRate());
      return Promise.resolve();
    }
    if (!pb.isPaused() || !stopped) return realPlay();
    stopped = false;
    pb.setInstantRate(FLOOR_RATE);
    const p = realPlay();
    spinUpFrom(FLOOR_RATE);
    return p;
  },
};

function interceptIfWanted(): void {
  if (active && S.ttBrake !== false) pb.interceptTransport(hooks);
  else pb.interceptTransport(null);
}

export function brakingNow(): boolean {
  return braking;
}

/* ---------- entering / leaving turntable mode ---------- */

export function speedEnter(): void {
  active = true;
  stopped = pb.isPaused() && !pb.isEnded() && pb.getTime() > 0;
  interceptIfWanted();
  syncSpeedUI();
}

/** The speed itself stays — only the stop/start effect is a turntable
    thing. A brake in progress completes at once (the pause was asked for)
    and lands on the chosen speed. */
export function speedLeave(): void {
  active = false;
  pb.interceptTransport(null);
  if (rampTimer) {
    clearRamp();
    if (braking) pb.realPause();
  }
  braking = false;
  document.getElementById('npview')?.classList.remove('tt-braking');
  pb.setRate(rateFor(rpmNow()));
  syncSpeedUI();
}

/* ---------- clicks (Now Playing view) ---------- */

export function speedClick(target: Element): boolean {
  const preset = target.closest('[data-rpm]');
  if (preset) {
    setRpm(Number(preset.getAttribute('data-rpm')) || NOMINAL_RPM);
    return true;
  }
  if (target.closest('#ttRpmReset')) {
    setRpm(NOMINAL_RPM);
    return true;
  }
  return false;
}

/* ---------- the deck's pitch fader ---------- */

let faderDrag = -1;

function rpmAtFader(clientY: number, free: boolean): number {
  const track = document.getElementById('ttFader');
  if (!track) return rpmNow();
  const r = track.getBoundingClientRect();
  /* faster is up: the top of the track is 78, the bottom 16 */
  const f = 1 - (clientY - r.top) / Math.max(1, r.height);
  return snapRpm(MIN_RPM + Math.max(0, Math.min(1, f)) * (MAX_RPM - MIN_RPM), free);
}

function nextPreset(dir: 1 | -1): number {
  const rpm = rpmNow();
  const list = dir > 0 ? PRESETS : PRESETS.slice().reverse();
  for (const p of list) if (dir > 0 ? p > rpm + 0.05 : p < rpm - 0.05) return p;
  return dir > 0 ? MAX_RPM : MIN_RPM;
}

/* ---------- the player bar's speed control (beside the volume) ---------- */

const SPEED_ICON =
  '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.2 16.5a8.2 8.2 0 1115.6 0"/><path d="M12 15.6l4.1-5.1"/><circle cx="12" cy="15.8" r="1.3" fill="currentColor" stroke="none"/></svg>';

function mountBarControl(): void {
  if (document.getElementById('spdWrap')) return;
  const right = document.querySelector('#playerbar .pb-right');
  if (!right) return;
  const wrap = document.createElement('div');
  wrap.className = 'spdwrap';
  wrap.id = 'spdWrap';
  wrap.innerHTML =
    '<button class="pb-btn spd-btn" id="btnSpeed" type="button">' + SPEED_ICON + '<b></b></button>' +
    '<input id="spdRange" type="range" min="' + MIN_RPM + '" max="' + MAX_RPM + '" step="0.1" aria-label="Playback speed in RPM (33⅓ is normal)">';
  const vol = right.querySelector('.volwrap');
  right.insertBefore(wrap, vol);
  (wrap.querySelector('#btnSpeed') as HTMLButtonElement).addEventListener('click', () => {
    setRpm(isNominal() ? lastCustom : NOMINAL_RPM);
  });
  const range = wrap.querySelector('#spdRange') as HTMLInputElement;
  range.addEventListener('input', () => setRpm(snapRpm(Number(range.value))));
}

/* ---------- wiring ---------- */

export function wireSpeedInput(): void {
  if (!isNominal()) lastCustom = rpmNow();
  /* The saved speed is in force from the first track on. */
  pb.setRate(rateFor(rpmNow()));
  mountBarControl();
  syncSpeedUI();

  const view = document.getElementById('npview');
  if (!view) return;
  view.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.id === 'ttRpm') setRpm(snapRpm(Number(el.value)));
  });
  view.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.id === 'ttBrake') setBrake(el.checked);
  });

  /* the pitch fader: drag the knob (or press anywhere on the track) */
  view.addEventListener('pointerdown', (e) => {
    const f = (e.target as Element).closest('#ttFader');
    if (!f) return;
    e.preventDefault();
    faderDrag = e.pointerId;
    try {
      (f as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* capture is a nicety */
    }
    document.getElementById('ttWorld')?.classList.add('tt-fading');
    document.getElementById('ttFaderKnob')?.focus({ preventScroll: true });
    setRpm(rpmAtFader(e.clientY, e.altKey));
  });
  view.addEventListener('pointermove', (e) => {
    if (e.pointerId !== faderDrag) return;
    setRpm(rpmAtFader(e.clientY, e.altKey));
  });
  const endFader = (e: PointerEvent): void => {
    if (e.pointerId !== faderDrag) return;
    faderDrag = -1;
    document.getElementById('ttWorld')?.classList.remove('tt-fading');
  };
  view.addEventListener('pointerup', endFader);
  view.addEventListener('pointercancel', endFader);

  /* Keys on the focused fader knob: ↑/↓ ½ RPM (Shift: 5), PageUp/PageDown
     the next preset, Home/End the ends. Captured on window so the app-wide
     arrows-change-volume shortcut does not also fire. */
  window.addEventListener(
    'keydown',
    (e) => {
      if (!(e.target instanceof Element) || !e.target.closest('#ttFaderKnob')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const step = e.shiftKey ? 5 : 0.5;
      let handled = true;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') setRpm(rpmNow() + step);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') setRpm(rpmNow() - step);
      else if (e.key === 'PageUp') setRpm(nextPreset(1));
      else if (e.key === 'PageDown') setRpm(nextPreset(-1));
      else if (e.key === 'Home') setRpm(MIN_RPM);
      else if (e.key === 'End') setRpm(MAX_RPM);
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true
  );
}
