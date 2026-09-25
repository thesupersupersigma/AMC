/* While the software engine plays, the real <audio> element loops a few
   seconds of generated digital silence. Chrome builds its media session
   (the ChromeOS media controls, the keyboard's media keys, the tab's audio
   indicator) from playing media ELEMENTS; Web Audio output alone gets none
   of that. The silence is generated here — no file, no network. */

let url = '';

/** 12 s of 8 kHz 8-bit mono silence as a WAV blob URL (made once). Longer
    than 5 s so Chrome treats it as content, not a one-shot sound. */
export function keepaliveUrl(): string {
  if (url) return url;
  const rate = 8000;
  const samples = rate * 12;
  const buf = new ArrayBuffer(44 + samples);
  const dv = new DataView(buf);
  const ascii = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) dv.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  dv.setUint32(4, 36 + samples, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); /* PCM */
  dv.setUint16(22, 1, true); /* mono */
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate, true); /* byte rate */
  dv.setUint16(32, 1, true); /* block align */
  dv.setUint16(34, 8, true); /* bits */
  ascii(36, 'data');
  dv.setUint32(40, samples, true);
  new Uint8Array(buf, 44).fill(128); /* unsigned 8-bit silence */
  url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  return url;
}
