// Segment worker: parses a byte range of the trace file independently.
// Receives: { file, startByte, endByte, isFirst, segmentIndex }
// Posts: { type: 'progress', segmentIndex, pct }
//        { type: 'done', segmentIndex, result }
//        { type: 'error', segmentIndex, message }

import { TraceParser } from "./trace-parser.js";

self.onmessage = async (e) => {
  const { file, startByte, endByte, isFirst, segmentIndex } = e.data;
  try {
    const result = await TraceParser.indexSegment(file, startByte, endByte, isFirst, (pct) => {
      self.postMessage({ type: "progress", segmentIndex, pct });
    });
    self.postMessage({ type: "done", segmentIndex, result });
  } catch (err) {
    self.postMessage({ type: "error", segmentIndex, message: err.message });
  }
};
