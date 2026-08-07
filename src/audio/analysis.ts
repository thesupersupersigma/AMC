/* Phase 3 — silence detection for auto-split. Decodes into an
   OfflineAudioContext(1, length, 8000) — never a full-rate AudioContext,
   which would hold ~890 MB of PCM for a 42-minute side. Not part of Phase 1. */
export {};
