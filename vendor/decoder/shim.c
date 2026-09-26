/* AMC software decoder: a thin C shim over FFmpeg's libavcodec, built to a
   standalone WebAssembly module by build.sh. Only the ALAC, AC-3 and E-AC-3
   decoders are compiled in (LGPL-2.1, no GPL or nonfree parts).

   Contract with vendor/decoder/decoder.js (the hand-written JS loader):
     dec_open(codec_id, extradata, extradata_len, sample_rate, channels)
         codec_id 1 = ALAC, 2 = AC-3, 3 = E-AC-3. ALAC wants the full 36-byte
         'alac' atom (size + type + version/flags + 24-byte cookie) as
         extradata; AC-3/E-AC-3 need none. Returns a handle, or 0.
     dec_send(handle, packet, len) -> frames decoded from that packet (>= 0),
         or a negative AVERROR. One MP4 sample = one packet.
     dec_get_planar_f32(handle, ch) -> float* to `frames` samples of channel
         `ch` from the last dec_send. Valid until the next call on the handle.
     dec_channels / dec_sample_rate -> shape of the last output.
     dec_flush(handle) -> drop decoder state (seek).
     dec_close(handle).
   Output is always planar float32. Integer formats are scaled exactly the
   way libswresample does it (s16 * 2^-15, s32 * 2^-31), so ALAC output is
   bit-identical to `ffmpeg -f f32le`.

   AC-3 / E-AC-3 open with dynamic range compression OFF (drc_scale 0,
   i.e. `ffmpeg -drc_scale 0`): AMC plays music, not a late-night film mix,
   and it matches Cavern's core, which the Atmos objects are derived from
   (docs/atmos/PLAN.md §7). */

#include <stdint.h>
#include <string.h>

#include <emscripten/emscripten.h>
#include <libavcodec/avcodec.h>
#include <libavutil/channel_layout.h>
#include <libavutil/dict.h>
#include <libavutil/log.h>
#include <libavutil/mem.h>

#ifndef AMC_FFMPEG_TAG
#define AMC_FFMPEG_TAG "unknown"
#endif

#define AMC_MAX_CH 32

enum { AMC_ALAC = 1, AMC_AC3 = 2, AMC_EAC3 = 3 };

typedef struct AmcDec {
  AVCodecContext *ctx;
  AVPacket *pkt;
  AVFrame *frame;
  float *planes[AMC_MAX_CH];
  int cap;      /* frames each allocated plane holds */
  int frames;   /* frames produced by the last dec_send */
  int channels; /* channels of the last output */
} AmcDec;

EMSCRIPTEN_KEEPALIVE int dec_is_stub(void) { return 0; }

EMSCRIPTEN_KEEPALIVE const char *dec_version(void) {
  return "FFmpeg " AMC_FFMPEG_TAG " / libavcodec " AV_STRINGIFY(LIBAVCODEC_VERSION) " (alac, ac3, eac3)";
}

EMSCRIPTEN_KEEPALIVE void dec_close(AmcDec *d) {
  if (!d) return;
  if (d->ctx) avcodec_free_context(&d->ctx);
  if (d->pkt) av_packet_free(&d->pkt);
  if (d->frame) av_frame_free(&d->frame);
  for (int c = 0; c < AMC_MAX_CH; c++) av_freep(&d->planes[c]);
  av_free(d);
}

EMSCRIPTEN_KEEPALIVE AmcDec *dec_open(int codec_id, const uint8_t *extradata, int extradata_len, int sample_rate, int channels) {
  enum AVCodecID id;
  switch (codec_id) {
    case AMC_ALAC: id = AV_CODEC_ID_ALAC; break;
    case AMC_AC3: id = AV_CODEC_ID_AC3; break;
    case AMC_EAC3: id = AV_CODEC_ID_EAC3; break;
    default: return NULL;
  }
  const AVCodec *codec = avcodec_find_decoder(id);
  if (!codec) return NULL;
  av_log_set_level(AV_LOG_ERROR);

  AmcDec *d = av_mallocz(sizeof(AmcDec));
  if (!d) return NULL;
  d->ctx = avcodec_alloc_context3(codec);
  d->pkt = av_packet_alloc();
  d->frame = av_frame_alloc();
  if (!d->ctx || !d->pkt || !d->frame) {
    dec_close(d);
    return NULL;
  }
  if (extradata && extradata_len > 0) {
    d->ctx->extradata = av_mallocz(extradata_len + AV_INPUT_BUFFER_PADDING_SIZE);
    if (!d->ctx->extradata) {
      dec_close(d);
      return NULL;
    }
    memcpy(d->ctx->extradata, extradata, extradata_len);
    d->ctx->extradata_size = extradata_len;
  }
  if (sample_rate > 0) d->ctx->sample_rate = sample_rate;
  if (channels > 0) av_channel_layout_default(&d->ctx->ch_layout, channels);
  d->ctx->thread_count = 1;
  /* The (E-)AC-3 decoders' private option: no dynamic range compression. */
  AVDictionary *opts = NULL;
  if (id == AV_CODEC_ID_AC3 || id == AV_CODEC_ID_EAC3) av_dict_set(&opts, "drc_scale", "0", 0);
  int err = avcodec_open2(d->ctx, codec, &opts);
  av_dict_free(&opts);
  if (err < 0) {
    dec_close(d);
    return NULL;
  }
  return d;
}

static int ensure_cap(AmcDec *d, int channels, int frames) {
  if (frames <= d->cap) {
    for (int c = 0; c < channels; c++)
      if (!d->planes[c]) {
        d->planes[c] = av_malloc(sizeof(float) * (size_t)d->cap);
        if (!d->planes[c]) return AVERROR(ENOMEM);
      }
    return 0;
  }
  int cap = d->cap ? d->cap : 4096;
  while (cap < frames) cap *= 2;
  for (int c = 0; c < AMC_MAX_CH; c++) {
    if (!d->planes[c] && c >= channels) continue;
    float *p = av_realloc(d->planes[c], sizeof(float) * (size_t)cap);
    if (!p) return AVERROR(ENOMEM);
    d->planes[c] = p;
  }
  d->cap = cap;
  return 0;
}

static int append_frame(AmcDec *d, const AVFrame *f) {
  int ch = f->ch_layout.nb_channels;
  int n = f->nb_samples;
  if (ch <= 0 || n <= 0) return 0;
  if (ch > AMC_MAX_CH) ch = AMC_MAX_CH;
  /* A layout change inside one packet: keep only the newest shape. */
  if (d->frames > 0 && ch != d->channels) d->frames = 0;
  d->channels = ch;
  int err = ensure_cap(d, ch, d->frames + n);
  if (err < 0) return err;
  const int at = d->frames;
  const int stride = f->ch_layout.nb_channels;
  switch (f->format) {
    case AV_SAMPLE_FMT_FLTP:
      for (int c = 0; c < ch; c++) memcpy(d->planes[c] + at, f->extended_data[c], sizeof(float) * (size_t)n);
      break;
    case AV_SAMPLE_FMT_FLT: {
      const float *src = (const float *)f->extended_data[0];
      for (int i = 0; i < n; i++)
        for (int c = 0; c < ch; c++) d->planes[c][at + i] = src[i * stride + c];
      break;
    }
    case AV_SAMPLE_FMT_S16P:
      for (int c = 0; c < ch; c++) {
        const int16_t *src = (const int16_t *)f->extended_data[c];
        for (int i = 0; i < n; i++) d->planes[c][at + i] = src[i] * (1.0f / (1 << 15));
      }
      break;
    case AV_SAMPLE_FMT_S16: {
      const int16_t *src = (const int16_t *)f->extended_data[0];
      for (int i = 0; i < n; i++)
        for (int c = 0; c < ch; c++) d->planes[c][at + i] = src[i * stride + c] * (1.0f / (1 << 15));
      break;
    }
    case AV_SAMPLE_FMT_S32P:
      for (int c = 0; c < ch; c++) {
        const int32_t *src = (const int32_t *)f->extended_data[c];
        for (int i = 0; i < n; i++) d->planes[c][at + i] = src[i] * (1.0f / (1U << 31));
      }
      break;
    case AV_SAMPLE_FMT_S32: {
      const int32_t *src = (const int32_t *)f->extended_data[0];
      for (int i = 0; i < n; i++)
        for (int c = 0; c < ch; c++) d->planes[c][at + i] = src[i * stride + c] * (1.0f / (1U << 31));
      break;
    }
    default:
      return AVERROR(EINVAL);
  }
  d->frames = at + n;
  return 0;
}

EMSCRIPTEN_KEEPALIVE int dec_send(AmcDec *d, const uint8_t *data, int len) {
  if (!d) return AVERROR(EINVAL);
  d->frames = 0;
  /* A non-refcounted packet: avcodec_send_packet copies it (with padding). */
  d->pkt->data = (uint8_t *)data;
  d->pkt->size = len;
  int ret = avcodec_send_packet(d->ctx, d->pkt);
  d->pkt->data = NULL;
  d->pkt->size = 0;
  if (ret < 0 && ret != AVERROR(EAGAIN)) return ret;
  for (;;) {
    ret = avcodec_receive_frame(d->ctx, d->frame);
    if (ret < 0) break;
    int err = append_frame(d, d->frame);
    av_frame_unref(d->frame);
    if (err < 0) return err;
  }
  if (ret != AVERROR(EAGAIN) && ret != AVERROR_EOF) return ret;
  return d->frames;
}

EMSCRIPTEN_KEEPALIVE float *dec_get_planar_f32(AmcDec *d, int ch) {
  if (!d || ch < 0 || ch >= d->channels) return NULL;
  return d->planes[ch];
}

EMSCRIPTEN_KEEPALIVE int dec_channels(AmcDec *d) { return d ? d->channels : 0; }

EMSCRIPTEN_KEEPALIVE int dec_sample_rate(AmcDec *d) { return d && d->ctx ? d->ctx->sample_rate : 0; }

EMSCRIPTEN_KEEPALIVE void dec_flush(AmcDec *d) {
  if (!d || !d->ctx) return;
  avcodec_flush_buffers(d->ctx);
  d->frames = 0;
}
