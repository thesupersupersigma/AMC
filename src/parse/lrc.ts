/* LRC parsing — standard line timing and Enhanced LRC word timing.

   Standard:  [mm:ss.xx]line text          (several tags may share one line)
   Enhanced:  [mm:ss.xx]<mm:ss.xx>word <mm:ss.xx>word …
   Metadata:  [ar:…] [ti:…] [al:…] [offset:±ms] — offset shifts every time.

   Untimed text parses too: every plain line becomes an untimed entry
   (timeSec −1), which the panel renders static — a paste of bare lyrics is
   the editor's starting point, not an error. */

import type { LrcLine, LrcWord } from '../types';

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;

function tagToSec(mm: string, ss: string, frac: string | undefined): number {
  const base = parseInt(mm, 10) * 60 + parseInt(ss, 10);
  if (!frac) return base;
  const f = parseInt(frac, 10);
  return base + f / (frac.length === 3 ? 1000 : frac.length === 1 ? 10 : 100);
}

/** Parses LRC (or plain) text. Returns [] only for genuinely empty input. */
export function parseLrc(text: string): LrcLine[] {
  const out: LrcLine[] = [];
  let offsetSec = 0;
  const lines = String(text).split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const meta = line.match(/^\[(ar|ti|al|au|by|re|ve|length):[^\]]*\]$/i);
    if (meta) continue;
    const off = line.match(/^\[offset:\s*([+-]?\d+)\s*\]$/i);
    if (off) {
      offsetSec = parseInt(off[1], 10) / 1000;
      continue;
    }

    /* Collect every leading line-time tag. */
    TIME_TAG.lastIndex = 0;
    const times: number[] = [];
    let m: RegExpExecArray | null;
    let bodyStart = 0;
    while ((m = TIME_TAG.exec(line)) !== null) {
      if (m.index !== bodyStart) break; /* tags must be a leading run */
      times.push(tagToSec(m[1], m[2], m[3]));
      bodyStart = TIME_TAG.lastIndex;
    }
    const body = line.slice(bodyStart).trim();

    if (!times.length) {
      /* Plain text line — untimed. */
      out.push({ timeSec: -1, text: body || line });
      continue;
    }

    /* Enhanced word tags inside the body. */
    let words: LrcWord[] | undefined;
    WORD_TAG.lastIndex = 0;
    if (WORD_TAG.test(body)) {
      words = [];
      WORD_TAG.lastIndex = 0;
      let prevEnd = 0;
      let prevTime = -1;
      let wm: RegExpExecArray | null;
      while ((wm = WORD_TAG.exec(body)) !== null) {
        const before = body.slice(prevEnd, wm.index).trim();
        if (before && prevTime >= 0) words.push({ timeSec: prevTime, text: before });
        else if (before && prevTime < 0 && words.length === 0) words.push({ timeSec: times[0], text: before });
        prevTime = tagToSec(wm[1], wm[2], wm[3]);
        prevEnd = WORD_TAG.lastIndex;
      }
      const last = body.slice(prevEnd).trim();
      if (last && prevTime >= 0) words.push({ timeSec: prevTime, text: last });
      words = words.filter((w) => w.text);
      if (!words.length) words = undefined;
    }

    const textOnly = body.replace(WORD_TAG, ' ').replace(/\s+/g, ' ').trim();
    for (const tSec of times) {
      out.push({
        timeSec: tSec + offsetSec,
        text: textOnly,
        words: words ? words.map((w) => ({ timeSec: w.timeSec + offsetSec, text: w.text })) : undefined,
      });
    }
  }

  /* Timed lines sort by time. A plain paste (nothing timed) keeps its
     original order; mixed content keeps the timed lines only. */
  const timed = out.filter((l) => l.timeSec >= 0).sort((a, b) => a.timeSec - b.timeSec);
  if (timed.length) return timed;
  return out;
}

export function isSynced(lines: LrcLine[]): boolean {
  return lines.length > 0 && lines[0].timeSec >= 0;
}

function fmtLrcTime(sec: number): string {
  const s = Math.max(0, sec);
  const mm = Math.floor(s / 60);
  const rest = s - mm * 60;
  let whole = Math.floor(rest);
  let cs = Math.round((rest - whole) * 100);
  if (cs === 100) {
    cs = 0;
    whole += 1;
  }
  return String(mm).padStart(2, '0') + ':' + String(whole).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
}

/** Serializes lines back to LRC — what the editor writes to the sidecar.
    Word timings survive a round-trip; untimed lines are written bare. */
export function buildLrcText(lines: LrcLine[]): string {
  const out: string[] = [];
  for (const l of lines) {
    if (l.timeSec < 0) {
      out.push(l.text);
      continue;
    }
    let body = l.text;
    if (l.words && l.words.length) {
      body = l.words.map((w) => '<' + fmtLrcTime(w.timeSec) + '>' + w.text).join(' ');
    }
    out.push('[' + fmtLrcTime(l.timeSec) + ']' + body);
  }
  return out.join('\n') + '\n';
}
