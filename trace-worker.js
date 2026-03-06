// Web Worker that runs TraceParser.index() off the main thread.
// Protocol:
//   Main → Worker: { file: File }
//   Worker → Main: { type: 'progress', pct: number }
//   Worker → Main: { type: 'done', data: traceData }
//   Worker → Main: { type: 'error', message: string }

import { TraceParser } from "./trace-parser.js";

self.onmessage = async (e) => {
  const { file } = e.data;
  try {
    const traceData = await TraceParser.index(file, (pct) => {
      self.postMessage({ type: "progress", pct });
    });

    // Collect all typed array buffers for zero-copy transfer
    const transfer = [];
    if (traceData.landingIndex) {
      const li = traceData.landingIndex;
      transfer.push(li.cycles.buffer, li.offsets.buffer,
        li.xs.buffer, li.ys.buffer, li.colors.buffer, li.dirs.buffer);
    }
    for (const [, entry] of traceData.peStateIndex) {
      transfer.push(entry.cycles.buffer, entry.busy.buffer, entry.stall.buffer);
    }
    for (const [, entry] of traceData.waveletIndex) {
      const h = entry.hops;
      transfer.push(h.cycles.buffer, h.xs.buffer, h.ys.buffer,
        h.landings.buffer, h.departings.buffer);
    }

    // Maps can't be transferred directly — convert to arrays of entries
    const peStateEntries = [...traceData.peStateIndex.entries()];
    const waveletEntries = [...traceData.waveletIndex.entries()];

    self.postMessage({
      type: "done",
      data: {
        dimX: traceData.dimX,
        dimY: traceData.dimY,
        landingIndex: traceData.landingIndex,
        peStateEntries,
        waveletEntries,
        hasWaveletData: traceData.hasWaveletData,
        minCycle: traceData.minCycle,
        maxCycle: traceData.maxCycle,
        totalEvents: traceData.totalEvents,
      },
    }, transfer);
  } catch (err) {
    self.postMessage({ type: "error", message: err.message });
  }
};
