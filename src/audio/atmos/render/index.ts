/* SpatialRenderer for decoded Atmos objects: runs on the main thread.
   AMC-original; distributed under the Cavern licence as part of
   src/audio/atmos/ (see README.md there).

   This module must not touch AudioContext, window or document at import
   time: the engine imports register.ts in its Worker too. Everything below
   runs only inside createAtmosRenderer and the renderer's methods.

   Graph: engine Worklet → input (ChannelSplitter, one output per channel)
     → per-mode graph (graphs.ts) → fade gain → output → engine gain node.
   On a mode change the new graph fades in over 30 ms while the old one
   fades out; the old one is then disconnected. Positions drive AudioParam
   automation scheduled from the keyframe timeline (timeline.ts).

   Frames are SOURCE frames. At a playback rate r (setRate) they advance r
   times faster than the context clock, so every frame <-> time mapping
   below divides or multiplies by sampleRate * rate. */

import type { SpatialKeyframe, SpatialOutputMode, SpatialRenderer, SpatialRendererFactory } from '../../spatial/contract';
import { buildGraph, type Graph } from './graphs';
import { multichannelLayout } from './layouts';
import { KeyframeTimeline, TrackScheduler } from './timeline';

/** Seconds of automation kept scheduled ahead of the played position. */
const horizonSeconds = 0.5;
/** Re-anchor when the reported played frame and the prediction disagree by
    more than this (seconds): pause without suspend, seek, underrun. */
const driftSeconds = 0.02;
/** Mode-change crossfade length (seconds). */
const fadeSeconds = 0.03;

interface LiveGraph {
  graph: Graph;
  scheduler: TrackScheduler;
  /** Context time after which a faded-out graph can be torn down. */
  retireAt: number;
}

interface DestinationState {
  channelCount: number;
  channelCountMode: ChannelCountMode;
  channelInterpretation: ChannelInterpretation;
}

class AtmosRenderer implements SpatialRenderer {
  readonly input: AudioNode;
  readonly output: AudioNode;
  private readonly splitter: ChannelSplitterNode;
  private readonly out: GainNode;
  private readonly bed: string[];
  private readonly timeline: KeyframeTimeline;
  private readonly sampleRate: number;
  private active: LiveGraph | null = null;
  private retiring: LiveGraph[] = [];
  private anchor: { frame: number; time: number } | null = null;
  /** Source frames per output frame (the playback rate). */
  private rate = 1;
  private savedDestination: DestinationState | null = null;
  private disposed = false;
  private readonly frameToTime = (frame: number): number => {
    const a = this.anchor!;
    return a.time + (frame - a.frame) / (this.sampleRate * this.rate);
  };

  constructor(private readonly ctx: BaseAudioContext, bedLayout: readonly string[], private readonly objects: number) {
    const total = bedLayout.length + objects;
    this.sampleRate = ctx.sampleRate;
    this.bed = bedLayout.slice();
    this.timeline = new KeyframeTimeline(objects);
    this.splitter = ctx.createChannelSplitter(Math.max(1, total));
    this.input = this.splitter;
    this.out = ctx.createGain();
    this.out.channelCountMode = 'max';
    this.out.channelInterpretation = 'discrete';
    this.output = this.out;
    this.setMode('speakers');
  }

  get mode(): SpatialOutputMode | null {
    return this.active?.graph.mode ?? null;
  }

  setMode(requested: SpatialOutputMode): void {
    if (this.disposed) return;
    // Multichannel needs at least 6 destination channels; otherwise the
    // speakers graph is what plays (and asking again changes nothing).
    const mode: SpatialOutputMode =
      requested === 'multichannel' && !multichannelLayout(this.ctx.destination.maxChannelCount) ? 'speakers' : requested;
    if (this.active && this.active.graph.mode === mode) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this.retireFinished(now);

    const graph = buildGraph(mode, ctx, this.splitter, this.bed, this.objects);
    const scheduler = new TrackScheduler(graph.tracks, this.timeline, this.sampleRate);
    const live: LiveGraph = { graph, scheduler, retireAt: Infinity };
    this.startAutomation(scheduler, now);

    if (graph.mode === 'multichannel') this.useDestination(graph.channels);

    const old = this.active;
    graph.fade.connect(this.out);
    if (old) {
      graph.fade.gain.setValueAtTime(0, now);
      graph.fade.gain.linearRampToValueAtTime(1, now + fadeSeconds);
      old.graph.fade.gain.cancelScheduledValues(now);
      old.graph.fade.gain.setValueAtTime(old.graph.fade.gain.value, now);
      old.graph.fade.gain.linearRampToValueAtTime(0, now + fadeSeconds);
      old.retireAt = now + fadeSeconds + 0.02;
      this.retiring.push(old);
      if (typeof setTimeout === 'function') setTimeout(() => this.retireFinished(this.ctx.currentTime), (fadeSeconds + 0.1) * 1000);
    }
    this.active = live;
  }

  pushKeyframes(blockStartFrame: number, keyframes: SpatialKeyframe[]): void {
    if (this.disposed || keyframes.length === 0) return;
    const changedFrom = this.timeline.push(blockStartFrame, keyframes);
    const now = this.ctx.currentTime;
    this.retireFinished(now);
    for (const g of this.liveGraphs()) {
      if (!this.anchor) {
        // Not playing yet: place everything at the first keyframe now;
        // ramps start once setPlayedFrame anchors the timeline.
        g.scheduler.rescheduleFrom(this.timeline.keyframes[0].frame, now);
        continue;
      }
      const current = this.currentFrame(now);
      if (changedFrom <= g.scheduler.lastScheduledFrame) {
        g.scheduler.rescheduleFrom(current, now);
      }
      g.scheduler.extend(current + this.horizonFrames(), this.frameToTime);
    }
  }

  setPlayedFrame(frame: number): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    this.retireFinished(now);
    const predicted = this.anchor ? this.currentFrame(now) : NaN;
    const reanchor = !this.anchor || !(Math.abs(predicted - frame) <= driftSeconds * this.sampleRate * Math.max(1, this.rate));
    if (reanchor) this.anchor = { frame, time: now };
    const current = reanchor ? frame : predicted;
    this.timeline.prune(Math.min(frame, current));
    for (const g of this.liveGraphs()) {
      if (reanchor) g.scheduler.rescheduleFrom(current, now);
      g.scheduler.extend(current + this.horizonFrames(), this.frameToTime);
    }
  }

  setRate(rate: number): void {
    if (this.disposed) return;
    const r = rate > 0 && isFinite(rate) ? rate : 1;
    if (Math.abs(r - this.rate) < 1e-6) return;
    const now = this.ctx.currentTime;
    if (!this.anchor) {
      this.rate = r;
      return;
    }
    // Re-anchor where the old rate says playback is now, then schedule on
    // at the new rate; the next setPlayedFrame corrects any residue.
    const current = this.currentFrame(now);
    this.anchor = { frame: current, time: now };
    this.rate = r;
    this.retireFinished(now);
    for (const g of this.liveGraphs()) {
      g.scheduler.rescheduleFrom(current, now);
      g.scheduler.extend(current + this.horizonFrames(), this.frameToTime);
    }
  }

  reset(): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    this.timeline.clear();
    this.anchor = null;
    // Hold every param where it is; the next keyframes place the objects.
    for (const g of this.liveGraphs()) {
      for (const t of g.graph.tracks) {
        for (const p of t.params) {
          const v = p.value;
          p.cancelScheduledValues(now);
          p.setValueAtTime(v, now);
        }
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const g of this.liveGraphs()) this.teardown(g);
    this.active = null;
    this.retiring = [];
    try {
      this.splitter.disconnect();
      this.out.disconnect();
    } catch {
      /* already disconnected */
    }
    this.restoreDestination();
  }

  private liveGraphs(): LiveGraph[] {
    return this.active ? [this.active, ...this.retiring] : this.retiring;
  }

  private currentFrame(now: number): number {
    const a = this.anchor!;
    return a.frame + (now - a.time) * this.sampleRate * this.rate;
  }

  /** The automation horizon in source frames: horizonSeconds of context time. */
  private horizonFrames(): number {
    return horizonSeconds * this.sampleRate * this.rate;
  }

  private startAutomation(scheduler: TrackScheduler, now: number): void {
    if (this.anchor) {
      const current = this.currentFrame(now);
      scheduler.rescheduleFrom(current, now);
      scheduler.extend(current + this.horizonFrames(), this.frameToTime);
    } else if (this.timeline.keyframes.length) {
      scheduler.rescheduleFrom(this.timeline.keyframes[0].frame, now);
    } else {
      scheduler.setInitial(now);
    }
  }

  private retireFinished(now: number): void {
    if (this.retiring.length === 0) return;
    const keep: LiveGraph[] = [];
    for (const g of this.retiring) {
      if (now >= g.retireAt) this.teardown(g);
      else keep.push(g);
    }
    this.retiring = keep;
    if (keep.length === 0 && this.active && this.active.graph.mode !== 'multichannel') this.restoreDestination();
  }

  private teardown(g: LiveGraph): void {
    for (const node of g.graph.nodes) {
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    // The splitter still feeds the torn-down graph's first nodes; drop
    // those links too by disconnecting it from each of them.
    for (const node of g.graph.nodes) {
      try {
        this.splitter.disconnect(node);
      } catch {
        /* was not connected to the splitter */
      }
    }
  }

  /** Multichannel output needs the destination opened to the layout's
      channel count, channels passed through as-is. */
  private useDestination(channels: number): void {
    const d = this.ctx.destination;
    if (!this.savedDestination) {
      this.savedDestination = {
        channelCount: d.channelCount,
        channelCountMode: d.channelCountMode,
        channelInterpretation: d.channelInterpretation,
      };
    }
    try {
      d.channelCount = Math.min(channels, d.maxChannelCount);
      d.channelCountMode = 'explicit';
      d.channelInterpretation = 'discrete';
    } catch {
      /* some destinations reject changes; the graph still plays */
    }
  }

  private restoreDestination(): void {
    const s = this.savedDestination;
    if (!s) return;
    this.savedDestination = null;
    const d = this.ctx.destination;
    try {
      d.channelCount = s.channelCount;
      d.channelCountMode = s.channelCountMode;
      d.channelInterpretation = s.channelInterpretation;
    } catch {
      /* ignore */
    }
  }
}

export type { AtmosRenderer };

export const createAtmosRenderer: SpatialRendererFactory = (ctx, bedLayout, objectChannels) =>
  new AtmosRenderer(ctx, bedLayout, objectChannels);
