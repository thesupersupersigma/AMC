/* Spatial add-on registration point. On this branch nothing is registered,
   so the engine plays the E-AC-3 5.1 core. The Atmos branch (feat/atmos)
   REPLACES this file with one that calls registerSpatial(...) from
   ./contract. It is imported for side effects by both the decode Worker
   entry and the main-thread engine module, because the registry lives per
   realm (a Worker has its own copy of every module). */

export {};
