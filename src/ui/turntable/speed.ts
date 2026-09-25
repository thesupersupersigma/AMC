/* Speed: 33⅓ / 45 / 78 presets, a continuous 16–78 RPM slider, and the
   stop/start effect. Playback rate = rpm / 33⅓ with the pitch following
   the speed, like a real record. The chosen speed persists as a pref but
   only ever applies INSIDE turntable mode — leaving it puts playback back
   to 1× so Cover mode, the mini player and every other view play at
   normal speed.

   The stop/start effect: while turntable mode is open, pause ramps the
   rate down to ~0.1× over ~0.8 s (the platter, driven by playback time,
   slows with it) and only then pauses; play starts at ~0.1× and ramps up
   over ~0.4 s. It wraps the element's own pause()/play(), so the player
   bar, Space, PiP and the Media Session / media keys all get it. */

import { S, savePrefs } from '../../state';
import * as pb from './playback';
import { NOMINAL_RPM } from './geometry';

export const MIN_RPM = 16;
export const MAX_RPM = 78;
const BRAKE_MS = 800;
const SPINUP_MS = 400;
const FLOOR_RATE = 0.1;

let active = false;

export function rpmNow(): number {
  const v = S.ttRpm;
  return typeof v === 'number' && v >= MIN_RPM && v <= MAX_RPM ? v : NOMINAL_RPM;
}

export function rateFor(rpm: number): number {
  return rpm / NOMINAL_RPM;
}

function fmtRpm(rpm: number): string {
  if (Math.abs(rpm - NOMINAL_RPM) < 0.05) return '33⅓';
  return (Math.round(rpm * 10) / 10).toString();
}

/* ---------- UI ---------- */

export function syncSpeedUI(): void {
  const rpm = rpmNow();
  const read = document.getElementById('ttRpmRead');
  if (read) read.textContent = fmtRpm(rpm) + ' RPM · ' + rateFor(rpm).toFixed(2) + '×';
  const slider = document.getElementById('ttRpm') as HTMLInputElement | null;
  if (slider && document.activeElement !== slider) slider.value = String(Math.round(rpm * 10) / 10);
  if (slider) slider.style.setProperty('--p', (((rpm - MIN_RPM) / (MAX_RPM - MIN_RPM)) * 100).toFixed(2) + '%');
  document.querySelectorAll<HTMLElement>('[data-rpm]').forEach((b) => {
    const on = Math.abs(Number(b.getAttribute('data-rpm')) - rpm) < 0.05;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  const reset = document.getElementById('ttRpmReset') as HTMLButtonElement | null;
  if (reset) reset.disabled = Math.abs(rpm - NOMINAL_RPM) < 0.05;
  const brake = document.getElementById('ttBrake') as HTMLInputElement | null;
  if (brake) brake.checked = S.ttBrake !== false;
  /* the deck's pitch fader mirrors the speed */
  const world = document.getElementById('ttWorld');
  if (world) world.style.setProperty('--pitch-off', Math.max(-1, Math.min(1, (NOMINAL_RPM - rpm) / 30)).toFixed(3));
}

export function setRpm(rpm: number): void {
  const v = Math.max(MIN_RPM, Math.min(MAX_RPM, rpm));
  S.ttRpm = Math.abs(v - NOMINAL_RPM) < 0.05 ? NOMINAL_RPM : v;
  savePrefs();
  if (active && !braking) pb.setRate(rateFor(S.ttRpm));
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
  pb.setRate(rateFor(rpmNow()));
  interceptIfWanted();
  syncSpeedUI();
}

/** Back to 1× (33⅓): other views never play at turntable speed. A brake in
    progress completes at once — the pause was asked for. */
export function speedLeave(): void {
  active = false;
  pb.interceptTransport(null);
  if (rampTimer) {
    clearRamp();
    if (braking) pb.realPause();
  }
  braking = false;
  document.getElementById('npview')?.classList.remove('tt-braking');
  pb.setRate(1);
}

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

export function wireSpeedInput(): void {
  const view = document.getElementById('npview');
  if (!view) return;
  view.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.id === 'ttRpm') setRpm(Number(el.value));
  });
  view.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.id === 'ttBrake') setBrake(el.checked);
  });
}
