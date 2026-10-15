/* Hand on the record: grab the vinyl (anywhere on it, label included) and
   turn it. The record follows the hand exactly, the tonearm with it, and
   the sound follows the speed — forwards, backwards, stopped — with the
   pitch moving like a real stylus in a groove.

   While the hand is down, the main playback (the `media` facade) is held
   quiet and nearly still, and the scratch voice (src/audio/scratch/) plays
   decoded windows of the record at the hand's speed. Letting go:
     • a running deck: the motor takes the record back up to the set speed,
       then the main playback is seeked to where the record is and
       crossfaded in;
     • a stopped deck: the record coasts to a stop and the playback is left
       paused there — cued, the way a DJ finds the beat.

   Files whose middle cannot be window-decoded here (Ogg, or ALAC/E-AC-3
   without a WebCodecs decoder) scratch by playback rate instead: forward
   turns play the main playback at the hand's speed, backward turns wind
   silently, and the playback lands where the record is on release.

   The playback is only ever reached through ./playback and the facade's
   volume, and the platter only through ./motion's overrides. */

import type { AnyTrack } from '../../types';
import { S, refOf } from '../../state';
import { media } from '../../audio/media';
import { getVoice, type ScratchVoice } from '../../audio/scratch/voice';
import * as pb from './playback';
import { C, DEG_PER_SEC, STAGE_W } from './geometry';
import {
  addFrameHook, armIsLocked, currentPlatterAngle, currentRecordAngle, isDragging, motionRunning, noteJump, overrideRecord, overrideSpin, seekFraction,
} from './motion';
import { brakingNow, rateFor, rpmNow } from './speed';

type Phase = 'none' | 'hold' | 'release';
/** wait — the voice is not ready yet (the playback carries on as it was);
    voice — the scratch voice plays; rate — the playback-rate fallback. */
type Mode = 'wait' | 'voice' | 'rate';

let phase: Phase = 'none';
let mode: Mode = 'wait';
/** Bumped by every grab, release and cancel: stale async steps check it. */
let gen = 0;
let pointerId = -1;
let lastDeg = 0;
/** Where the hand has put the record, in source seconds. */
let handPos = 0;
/** What the deck shows (the record, the tonearm), in source seconds. */
let shown = 0;
let moves: Array<{ t: number; pos: number }> = [];
/** The deck was running when the hand came down: the motor keeps the
    platter turning under the record, and takes it back on release. */
let wasPlaying = false;
let motorRate = 0;
let platter0 = 0;
let rec0 = 0;
let pos0 = 0;
let t0 = 0;
let hookOn = false;
let voice: ScratchVoice | null = null;

/** The main playback is held quiet (volume 0, slowest rate). */
let mainQuiet = false;
/** The rate fallback started a paused playback; it pauses it again. */
let startedMain = false;
let lastRate = 0;
let lastResync = 0;
/** Our own seek is moving playback (on a cue side, maybe to another
    track): that track change must not cancel the scratch. */
let ourSeek = false;
let volTimer: ReturnType<typeof setTimeout> | null = null;

export function scratching(): boolean {
  return phase !== 'none';
}

/** Test / diagnostics. */
export function scratchDebug(): { phase: Phase; mode: Mode; shown: number; handPos: number; voice: ScratchVoice | null } {
  return { phase, mode, shown, handPos, voice };
}

function keyOf(t: AnyTrack): string {
  return refOf(t.folderId, t.kind === 'virtual' ? t.sourcePath : t.path);
}

function userVolume(): number {
  return S.muted ? 0 : S.volume;
}

/** The pointer's angle around the spindle (degrees, clockwise from +x —
    the way the platter turns), or null right over the spindle. */
function deckAngleAt(clientX: number, clientY: number): number | null {
  const stage = document.querySelector('.tt-stage') as HTMLElement | null;
  if (!stage) return null;
  const r = stage.getBoundingClientRect();
  const u = r.width / STAGE_W;
  if (!(u > 0)) return null;
  const x = (clientX - r.left) / u - C.x;
  const y = (clientY - r.top) / u - C.y;
  if (Math.hypot(x, y) < 18) return null;
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/* ---------- the main playback ---------- */

function cancelVolRamp(): void {
  if (volTimer) clearTimeout(volTimer);
  volTimer = null;
}

function quietMain(): void {
  cancelVolRamp();
  mainQuiet = true;
  try {
    media.volume = 0;
  } catch {
    /* nothing loaded */
  }
  if (!pb.isPaused()) pb.setInstantRate(0.0625);
  lastRate = 0.0625;
}

/** Back to the set speed and the listener's volume (over `ms`). */
function restoreMain(ms: number): void {
  if (!mainQuiet) return;
  mainQuiet = false;
  pb.setRate(rateFor(rpmNow()));
  cancelVolRamp();
  const from = media.volume;
  const t = performance.now();
  const step = (): void => {
    const p = ms > 0 ? Math.min(1, (performance.now() - t) / ms) : 1;
    try {
      media.volume = from + (S.volume - from) * p;
    } catch {
      return;
    }
    volTimer = p < 1 ? setTimeout(step, 12) : null;
  };
  step();
}

/** Seeks the playback (on a cue side, to the track that holds `sec`) and
    resolves once it landed. */
function seekMain(sec: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const fin = (): void => {
      if (done) return;
      done = true;
      ourSeek = false;
      media.removeEventListener('seeked', fin);
      clearTimeout(timer);
      resolve();
    };
    media.addEventListener('seeked', fin);
    const timer = setTimeout(fin, 700);
    const d = pb.getDuration();
    ourSeek = true;
    if (d > 0) seekFraction(sec / d);
    else fin();
  });
}

/* ---------- the rate fallback ---------- */

function rateDrive(vel: number): void {
  if (!mainQuiet) quietMain();
  if (vel > 0.06) {
    if (pb.isPaused()) {
      startedMain = true;
      void pb.realPlay().catch(() => {});
    }
    const r = Math.max(0.0625, Math.min(4, vel));
    if (Math.abs(r - lastRate) / r > 0.03) {
      pb.setInstantRate(r);
      lastRate = r;
    }
    media.volume = S.volume;
    /* keep the playback near the record (it cannot follow exactly) */
    const now = performance.now();
    if (now - lastResync > 400 && Math.abs(pb.getTime() - handPos) > 0.5) {
      lastResync = now;
      pb.seek(handPos);
    }
  } else {
    media.volume = 0;
    if (lastRate !== 0.0625) {
      pb.setInstantRate(0.0625);
      lastRate = 0.0625;
    }
  }
}

/* ---------- per frame ---------- */

function handVelocity(now: number): number {
  while (moves.length > 2 && now - moves[0].t > 60) moves.shift();
  const last = moves[moves.length - 1];
  if (!last || moves.length < 2 || now - last.t > 50) return 0;
  const first = moves[0];
  const dt = (last.t - first.t) / 1000;
  return dt > 0 ? (last.pos - first.pos) / dt : 0;
}

function tick(): boolean {
  if (phase === 'none') {
    hookOn = false;
    return false;
  }
  const v = voice;
  if (phase === 'hold') {
    const vel = handVelocity(performance.now());
    shown = handPos;
    if (mode === 'wait' && v) {
      const k = v.kind();
      if (k === 'none') mode = 'rate';
      else if (k && v.covers(handPos)) {
        mode = 'voice';
        quietMain();
        v.setVolume(userVolume());
        v.grab(handPos);
      }
    }
    if (mode === 'voice' && v) {
      v.setVolume(userVolume());
      v.hand(handPos, vel);
    } else if (mode === 'rate') {
      rateDrive(vel);
    }
    if (v && mode !== 'rate') v.ensure(handPos);
  } else if (mode === 'voice' && v) {
    shown = v.posNow();
  }
  return true;
}

/* ---------- grab ---------- */

async function startVoice(t: AnyTrack, dur: number, g: number): Promise<void> {
  const v = await getVoice();
  if (g !== gen || phase !== 'hold') return;
  if (!v) {
    if (mode === 'wait') mode = 'rate';
    return;
  }
  voice = v;
  await v.wake();
  if (g !== gen || phase !== 'hold' || !t.file) return;
  v.prepare(keyOf(t), t.file, dur);
  v.ensure(handPos);
}

function grab(e: PointerEvent): void {
  const t = pb.currentTrack();
  const dur = pb.getDuration();
  if (!t || !t.file || !(dur > 0)) return;
  const deg = deckAngleAt(e.clientX, e.clientY);
  e.preventDefault();
  try {
    (e.target as Element).setPointerCapture(e.pointerId);
  } catch {
    /* capture is a nicety */
  }
  const g = ++gen;
  pointerId = e.pointerId;
  lastDeg = deg === null ? 0 : deg;
  if (phase === 'none') {
    wasPlaying = !pb.isPaused();
    handPos = pb.getTime();
    mode = 'wait';
    startedMain = false;
    /* the hand takes the record; the platter keeps turning under it while
       the motor runs */
    pos0 = handPos;
    rec0 = currentRecordAngle();
    platter0 = currentPlatterAngle();
    t0 = performance.now();
    motorRate = wasPlaying ? pb.getRate() : 0;
    overrideSpin((now) => platter0 + (DEG_PER_SEC * motorRate * (now - t0)) / 1000);
    overrideRecord(() => rec0 + (shown - pos0) * DEG_PER_SEC, () => shown);
  } else {
    /* caught again on its way back to speed: carry on from where it is */
    handPos = shown;
    if (mainQuiet) quietMain();
  }
  shown = handPos;
  phase = 'hold';
  moves = [{ t: performance.now(), pos: handPos }];
  document.getElementById('npview')?.classList.add('tt-scratching');
  if (!hookOn) {
    hookOn = true;
    addFrameHook(tick);
  }
  void startVoice(t, dur, g);
}

function move(e: PointerEvent): void {
  if (phase !== 'hold' || e.pointerId !== pointerId) return;
  const deg = deckAngleAt(e.clientX, e.clientY);
  if (deg === null) return;
  let d = deg - lastDeg;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  lastDeg = deg;
  const dur = pb.getDuration();
  handPos = Math.max(0, Math.min(Math.max(0, dur - 0.1), handPos + d / DEG_PER_SEC));
  moves.push({ t: performance.now(), pos: handPos });
}

/* ---------- release ---------- */

/** Clears the hand's hold on the deck: the record re-seats on the
    platter where it is, and time comes from the playback again. */
function end(): void {
  phase = 'none';
  mode = 'wait';
  startedMain = false;
  overrideRecord(null, null);
  overrideSpin(null);
  noteJump();
  if (voice) voice.idleSoon();
}

function waitFor(cond: () => boolean, maxMs: number, then: () => void): void {
  const t = performance.now();
  const check = (): void => {
    if (cond() || performance.now() - t > maxMs) then();
    else setTimeout(check, 20);
  };
  check();
}

/** Running deck: once the motor has the record back at speed, the
    playback takes over from where it is. */
async function handBackRunning(g: number): Promise<void> {
  const v = voice;
  if (!v) return;
  const rate = rateFor(rpmNow());
  pb.setInstantRate(rate);
  await seekMain(v.posNow() + rate * 0.08);
  if (g !== gen) return;
  /* line the voice up with the playback, then crossfade across */
  v.jump(pb.getTime());
  v.fade(90);
  restoreMain(90);
  end();
}

/** Stopped deck: the record has coasted to rest; the playback is cued
    there and stays paused. */
async function handBackStopped(g: number): Promise<void> {
  const v = voice;
  const at = v ? v.posNow() : handPos;
  shown = at;
  if (v) v.fade(30);
  await seekMain(at);
  if (g !== gen) return;
  restoreMain(0);
  end();
}

/** No voice audio was playing (not ready yet, or the rate fallback): the
    playback simply lands where the record is. */
async function landAt(pos: number, g: number): Promise<void> {
  if (startedMain && !wasPlaying) pb.realPause();
  await seekMain(pos);
  if (g !== gen) return;
  restoreMain(mode === 'rate' ? 60 : 0);
  end();
}

function release(e: PointerEvent): void {
  if (phase !== 'hold' || e.pointerId !== pointerId) return;
  pointerId = -1;
  document.getElementById('npview')?.classList.remove('tt-scratching');
  const g = ++gen;
  phase = 'release';
  const v = voice;
  if (mode === 'voice' && v) {
    if (wasPlaying) {
      v.motor(rateFor(rpmNow()));
      setTimeout(() => {
        if (g === gen) void handBackRunning(g);
      }, 320);
    } else {
      v.coast();
      waitFor(
        () => Math.abs(v.velNow()) < 0.02,
        900,
        () => {
          if (g === gen) void handBackStopped(g);
        }
      );
    }
    return;
  }
  shown = handPos;
  void landAt(handPos, g);
}

/** Drops the scratch at once (turntable mode closing, the track changing
    under the hand): the playback is restored where it is. */
export function scratchCancel(): void {
  if (phase === 'none') return;
  gen++;
  pointerId = -1;
  document.getElementById('npview')?.classList.remove('tt-scratching');
  if (voice) voice.fade(20);
  if (startedMain && !wasPlaying) pb.realPause();
  restoreMain(0);
  end();
}

/* ---------- warming up on hover ---------- */

let lastPrefetch = 0;
function prefetch(): void {
  const now = performance.now();
  if (phase !== 'none' || now - lastPrefetch < 1000) return;
  lastPrefetch = now;
  const t = pb.currentTrack();
  const dur = pb.getDuration();
  if (!t || !t.file || !(dur > 0)) return;
  const file = t.file;
  void getVoice().then((v) => {
    if (!v || phase !== 'none' || pb.currentTrack() !== t) return;
    voice = v;
    v.prepare(keyOf(t), file, dur);
    v.ensure(pb.getTime() + (pb.isPaused() ? 0 : 0.5));
  });
}

/* ---------- wiring ---------- */

function onRecord(target: EventTarget | null): boolean {
  const el = target as Element | null;
  return !!el && !!el.closest && !!el.closest('#ttRec, .tt-spindle') && !el.closest('#ttHead');
}

export function wireScratchInput(): void {
  const view = document.getElementById('npview');
  if (!view) return;
  view.addEventListener('pointerdown', (e) => {
    if (!onRecord(e.target)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (phase === 'hold' || !motionRunning() || armIsLocked() || isDragging() || brakingNow()) return;
    grab(e);
  });
  view.addEventListener('pointermove', move);
  view.addEventListener('pointerup', release);
  view.addEventListener('pointercancel', release);
  view.addEventListener('pointerover', (e) => {
    if (onRecord(e.target) && motionRunning()) prefetch();
  });
  pb.onTrackChange(() => {
    if (phase !== 'none' && !ourSeek) scratchCancel();
  });
}
