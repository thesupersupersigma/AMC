/* Can the software engine run here? Kept apart from the engine itself so
   state.ts can ask without importing the Worker and Worklet code. */

export function engineSupported(): boolean {
  return (
    typeof Worker !== 'undefined' &&
    typeof WebAssembly !== 'undefined' &&
    typeof AudioContext !== 'undefined' &&
    typeof AudioWorkletNode !== 'undefined' &&
    typeof MessageChannel !== 'undefined'
  );
}
