/* *** STUB DECODER — PLACEHOLDER, EMITS SILENCE ***

   This is NOT FFmpeg. It exists only so the engine's plumbing (WASM
   loading, Worker, Worklet, the playback facade) runs end to end in a
   session that could not install Emscripten. It exports exactly the ABI of
   ../shim.c and returns the correct number of silent frames per packet,
   read from the packet headers:
     ALAC   - the frame header's explicit sample count, else the cookie's
              frameLength
     AC-3   - 1536 per syncframe
     E-AC-3 - 256 x blocks of every independent substream-0 syncframe
   dec_is_stub() returns 1 so the app can say so loudly.

   The real decoder.wasm comes from build.sh (run by the build-decoder GitHub
   workflow) and simply replaces this file's output. Build this stub with
   build-stub.sh (clang + wasm-ld, no libc). */

typedef unsigned char u8;
typedef unsigned int u32;
typedef unsigned long size_t;

#define EXPORT(name) __attribute__((export_name(name)))
#define MAX_CH 32

/* ---------- a tiny first-fit allocator over linear memory ---------- */

extern unsigned char __heap_base;
static size_t heap_top = 0;

typedef struct Block {
  size_t size; /* payload bytes */
  struct Block *next;
} Block;
static Block *free_list = 0;

static size_t align16(size_t n) { return (n + 15) & ~(size_t)15; }

EXPORT("malloc") void *malloc(size_t n) {
  n = align16(n ? n : 1);
  Block **pp = &free_list;
  while (*pp) {
    if ((*pp)->size >= n) {
      Block *b = *pp;
      *pp = b->next;
      return (u8 *)b + sizeof(Block);
    }
    pp = &(*pp)->next;
  }
  if (!heap_top) heap_top = align16((size_t)&__heap_base);
  size_t need = heap_top + sizeof(Block) + n;
  size_t have = __builtin_wasm_memory_size(0) * 65536;
  if (need > have) {
    size_t pages = (need - have + 65535) / 65536;
    if (__builtin_wasm_memory_grow(0, pages) == (size_t)-1) return 0;
  }
  Block *b = (Block *)heap_top;
  b->size = n;
  b->next = 0;
  heap_top = need;
  return (u8 *)b + sizeof(Block);
}

EXPORT("free") void free(void *p) {
  if (!p) return;
  Block *b = (Block *)((u8 *)p - sizeof(Block));
  b->next = free_list;
  free_list = b;
}

static void zero(void *p, size_t n) {
  u8 *q = (u8 *)p;
  for (size_t i = 0; i < n; i++) q[i] = 0;
}

/* ---------- the decoder ABI ---------- */

typedef struct Dec {
  int codec;       /* 1 ALAC, 2 AC-3, 3 E-AC-3 */
  int channels;
  int rate;
  int frame_length; /* ALAC cookie frameLength */
  float *planes[MAX_CH];
  int cap;
  int frames;
} Dec;

static u32 be32(const u8 *b) { return ((u32)b[0] << 24) | ((u32)b[1] << 16) | ((u32)b[2] << 8) | b[3]; }

EXPORT("dec_is_stub") int dec_is_stub(void) { return 1; }

EXPORT("dec_version") const char *dec_version(void) {
  return "STUB decoder (silence) - run the build-decoder workflow for the real FFmpeg build";
}

EXPORT("dec_open") Dec *dec_open(int codec_id, const u8 *extra, int extra_len, int sample_rate, int channels) {
  if (codec_id < 1 || codec_id > 3) return 0;
  Dec *d = (Dec *)malloc(sizeof(Dec));
  if (!d) return 0;
  zero(d, sizeof(Dec));
  d->codec = codec_id;
  d->channels = channels > 0 && channels <= MAX_CH ? channels : 2;
  d->rate = sample_rate > 0 ? sample_rate : 48000;
  d->frame_length = 4096;
  /* ALAC: 'alac' atom = size(4) type(4) version/flags(4) then the cookie:
     frameLength(4) compatibleVersion(1) bitDepth(1) pb(1) mb(1) kb(1)
     numChannels(1) maxRun(2) maxFrameBytes(4) avgBitRate(4) sampleRate(4) */
  if (codec_id == 1 && extra && extra_len >= 36) {
    u32 fl = be32(extra + 12);
    if (fl > 0 && fl <= 65536) d->frame_length = (int)fl;
    if (extra[21] > 0) d->channels = extra[21];
    u32 sr = be32(extra + 32);
    if (sr > 0) d->rate = (int)sr;
  }
  return d;
}

static int alac_frames(Dec *d, const u8 *p, int len) {
  /* element tag(3) instance(4) unused(12) hasSize(1) shift(2) escape(1)
     [numSamples(32) when hasSize] */
  if (len < 3) return 0;
  int has_size = (p[2] >> 4) & 1;
  if (!has_size) return d->frame_length;
  if (len < 7) return 0;
  /* the 32-bit count starts at bit 23 */
  u32 v = 0;
  for (int bit = 23; bit < 55; bit++) v = (v << 1) | ((p[bit >> 3] >> (7 - (bit & 7))) & 1);
  return v > 0 && v <= 65536 ? (int)v : d->frame_length;
}

static int ac3_frames(const u8 *p, int len, int enhanced) {
  if (!enhanced) return len >= 2 && p[0] == 0x0b && p[1] == 0x77 ? 1536 : 0;
  int total = 0;
  int at = 0;
  static const int blocks[4] = {1, 2, 3, 6};
  while (at + 5 <= len && p[at] == 0x0b && p[at + 1] == 0x77) {
    int strmtyp = p[at + 2] >> 6;
    int substream = (p[at + 2] >> 3) & 7;
    int frmsiz = ((p[at + 2] & 7) << 8) | p[at + 3];
    int fscod = p[at + 4] >> 6;
    int nblk = fscod == 3 ? 6 : blocks[(p[at + 4] >> 4) & 3];
    if (strmtyp != 1 && substream == 0) total += nblk * 256;
    at += (frmsiz + 1) * 2;
  }
  return total;
}

EXPORT("dec_send") int dec_send(Dec *d, const u8 *data, int len) {
  if (!d || !data || len <= 0) return -22;
  int n = d->codec == 1 ? alac_frames(d, data, len) : ac3_frames(data, len, d->codec == 3);
  if (n <= 0) return -1094995529; /* AVERROR_INVALIDDATA */
  if (n > d->cap) {
    for (int c = 0; c < MAX_CH; c++) {
      if (d->planes[c]) free(d->planes[c]);
      d->planes[c] = 0;
    }
    d->cap = n;
  }
  for (int c = 0; c < d->channels; c++) {
    if (!d->planes[c]) d->planes[c] = (float *)malloc(sizeof(float) * (size_t)d->cap);
    if (!d->planes[c]) return -12;
    zero(d->planes[c], sizeof(float) * (size_t)n);
  }
  d->frames = n;
  return n;
}

EXPORT("dec_get_planar_f32") float *dec_get_planar_f32(Dec *d, int ch) {
  if (!d || ch < 0 || ch >= d->channels) return 0;
  return d->planes[ch];
}

EXPORT("dec_channels") int dec_channels(Dec *d) { return d ? d->channels : 0; }

EXPORT("dec_sample_rate") int dec_sample_rate(Dec *d) { return d ? d->rate : 0; }

EXPORT("dec_flush") void dec_flush(Dec *d) {
  if (d) d->frames = 0;
}

EXPORT("dec_close") void dec_close(Dec *d) {
  if (!d) return;
  for (int c = 0; c < MAX_CH; c++)
    if (d->planes[c]) free(d->planes[c]);
  free(d);
}
