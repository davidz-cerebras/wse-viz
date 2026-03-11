// Node.js segment worker for parallel trace parsing.
// Receives workerData: { filePath, startByte, endByte, isFirst, segmentIndex }

import { workerData, parentPort } from "node:worker_threads";
import { NodeFile } from "./node-file.js";
import { TraceParser } from "./trace-parser.js";

const { filePath, startByte, endByte, isFirst, segmentIndex } = workerData;
const nf = new NodeFile(filePath);
const result = await TraceParser.indexSegment(nf, startByte, endByte, isFirst, (pct) => {
  parentPort.postMessage({ type: "progress", segmentIndex, pct });
});
nf.close();
parentPort.postMessage({ type: "done", segmentIndex, result });
