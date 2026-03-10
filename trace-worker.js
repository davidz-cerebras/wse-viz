// Coordinator worker: splits trace file across 8 segment workers for parallel
// parsing, merges results, and sends the final compacted trace data to the
// main thread. Falls back to single-threaded parsing for small files.
//
// Protocol:
//   Main → Worker: { file: File }
//   Worker → Main: { type: 'progress', pct: number }
//   Worker → Main: { type: 'merging', step: string, pct: number }
//   Worker → Main: { type: 'transferring' }
//   Worker → Main: { type: 'done', data: traceData }
//   Worker → Main: { type: 'error', message: string }

import { TraceParser } from "./trace-parser.js";

const NUM_WORKERS = 8;
const PARALLEL_THRESHOLD = 100 * 1024 * 1024; // 100MB — below this, use single-threaded

self.onmessage = async (e) => {
  const { file } = e.data;

  if (file.size < PARALLEL_THRESHOLD) {
    // Small file: single-threaded (avoids worker spawn overhead)
    try {
      const traceData = await TraceParser.index(file, (pct) => {
        self.postMessage({ type: "progress", pct });
      });
      postResult(traceData);
    } catch (err) {
      self.postMessage({ type: "error", message: err.message });
    }
    return;
  }

  // Large file: parallel segment parsing
  // Nested workers (workers spawned from a worker) are not supported in all
  // browsers (Safari, older Chrome). Test by spawning one worker first; if it
  // fails, fall back to single-threaded parsing.
  let nestedWorkersSupported = true;
  try {
    const probe = new Worker("trace-segment-worker.js", { type: "module" });
    probe.terminate();
  } catch (_) {
    nestedWorkersSupported = false;
  }

  if (!nestedWorkersSupported) {
    try {
      const traceData = await TraceParser.index(file, (pct) => {
        self.postMessage({ type: "progress", pct });
      });
      postResult(traceData);
    } catch (err) {
      self.postMessage({ type: "error", message: err.message });
    }
    return;
  }

  try {
    const segments = new Array(NUM_WORKERS).fill(null);
    const segProgress = new Array(NUM_WORKERS).fill(0);
    let completed = 0;
    let error = null;

    const workers = [];
    await new Promise((resolve, reject) => {
      for (let i = 0; i < NUM_WORKERS; i++) {
        const startByte = Math.floor(file.size * i / NUM_WORKERS);
        const endByte = Math.floor(file.size * (i + 1) / NUM_WORKERS);
        const worker = new Worker("trace-segment-worker.js", { type: "module" });
        workers.push(worker);

        worker.onerror = (err) => {
          workers.forEach(w => w.terminate());
          if (!error) { error = err.message || "segment worker failed"; reject(new Error(error)); }
        };

        worker.onmessage = (ev) => {
          const msg = ev.data;

          if (msg.type === "progress") {
            segProgress[msg.segmentIndex] = msg.pct;
            const overall = segProgress.reduce((a, b) => a + b, 0) / NUM_WORKERS;
            self.postMessage({ type: "progress", pct: overall });
            return;
          }

          if (msg.type === "error") {
            workers.forEach(w => w.terminate());
            if (!error) { error = msg.message; reject(new Error(msg.message)); }
            return;
          }

          if (msg.type === "done") {
            worker.terminate();
            segments[msg.segmentIndex] = msg.result;
            completed++;
            if (completed === NUM_WORKERS) resolve();
          }
        };

        worker.postMessage({ file, startByte, endByte, isFirst: i === 0, segmentIndex: i });
      }
    });

    // Merge all segments — this can take several seconds for large traces
    const traceData = TraceParser.mergeSegments(segments, (step, pct) => {
      self.postMessage({ type: "merging", step, pct });
    });
    self.postMessage({ type: "transferring" });
    postResult(traceData);
  } catch (err) {
    self.postMessage({ type: "error", message: err.message });
  }
};

function postResult(traceData) {
  // Collect typed array buffers for zero-copy transfer
  const transfer = [];
  if (traceData.landingIndex) {
    const li = traceData.landingIndex;
    transfer.push(li.cycles.buffer, li.offsets.buffer,
      li.xs.buffer, li.ys.buffer, li.colors.buffer, li.dirs.buffer);
  }
  for (const [, entry] of traceData.peStateIndex) {
    transfer.push(entry.cycles.buffer, entry.busy.buffer,
      entry.opIds.buffer, entry.predIds.buffer, entry.stall.buffer);
  }
  for (const [, entry] of traceData.waveletIndex) {
    const h = entry.hops;
    transfer.push(h.cycles.buffer, h.xs.buffer, h.ys.buffer,
      h.landings.buffer, h.departings.buffer, h.consumed.buffer);
  }

  const peStateEntries = [...traceData.peStateIndex.entries()];
  const waveletEntries = [...traceData.waveletIndex.entries()];

  self.postMessage({
    type: "done",
    data: {
      dimX: traceData.dimX,
      dimY: traceData.dimY,
      landingIndex: traceData.landingIndex,
      peStateEntries,
      opLookup: traceData.opLookup,
      predLookup: traceData.predLookup,
      waveletEntries,
      hasWaveletData: traceData.hasWaveletData,
      minCycle: traceData.minCycle,
      maxCycle: traceData.maxCycle,
    },
  }, transfer);
}
