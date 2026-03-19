#!/usr/bin/env node
// wse-viz server — indexes a trace file and serves the visualization + API.
// Usage: node wse-viz-server.js [trace-file] [--port=PORT]
//   trace-file defaults to bench-sim.log in the current directory.
//   PORT defaults to 8080.

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

import { hostname, cpus, networkInterfaces } from "node:os";
import { Worker } from "node:worker_threads";
import { NodeFile } from "./node-file.js";
import { TraceParser } from "./trace-parser.js";
import { getBranches } from "./wavelet.js";

const PARALLEL_THRESHOLD = 64 * 1024 * 1024; // 64MB

// Clear the current terminal line and write a message.
function statusLine(msg, newline = false) {
  process.stderr.write(`\r\x1b[K  ${msg}${newline ? "\n" : ""}`);
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let traceFile = "bench-sim.log";
let port = 8080;

for (const arg of args) {
  if (arg.startsWith("--port=")) {
    port = parseInt(arg.slice(7), 10);
  } else if (!arg.startsWith("-")) {
    traceFile = arg;
  }
}

if (!existsSync(traceFile)) {
  process.stderr.write(`Error: trace file not found: ${traceFile}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Index the trace file
// ---------------------------------------------------------------------------

const installDir = join(fileURLToPath(import.meta.url), "..");

const nodeFile = new NodeFile(traceFile);
let raw;

if (nodeFile.size < PARALLEL_THRESHOLD) {
  process.stderr.write(`Indexing ${traceFile} (single-threaded)...\n`);
  raw = await TraceParser.index(nodeFile, (pct) => {
    statusLine(`${pct.toFixed(1)}%`);
  });
  statusLine("done.", true);
} else {
  const numWorkers = cpus().length;
  process.stderr.write(`Indexing ${traceFile} (${numWorkers} threads)...\n`);
  const segWorkerPath = join(installDir, "node-segment-worker.js");
  const segProgress = new Array(numWorkers).fill(0);

  const segments = await new Promise((resolve, reject) => {
    const results = new Array(numWorkers).fill(null);
    const workers = [];
    let completed = 0;
    let error = null;

    function fail(err) {
      if (error) return;
      error = err;
      for (const w of workers) w.terminate();
      reject(err);
    }

    for (let i = 0; i < numWorkers; i++) {
      const startByte = Math.floor(nodeFile.size * i / numWorkers);
      const endByte = Math.floor(nodeFile.size * (i + 1) / numWorkers);
      const w = new Worker(segWorkerPath, {
        workerData: { filePath: traceFile, startByte, endByte, isFirst: i === 0, segmentIndex: i },
      });
      workers.push(w);

      w.on("error", (err) => fail(err));

      w.on("exit", (code) => {
        if (code !== 0 && !error) fail(new Error(`Segment worker exited with code ${code}`));
      });

      w.on("message", (msg) => {
        if (msg.type === "progress") {
          segProgress[msg.segmentIndex] = msg.pct;
          const overall = segProgress.reduce((a, b) => a + b, 0) / numWorkers;
          statusLine(`${overall.toFixed(1)}%`);
        } else if (msg.type === "error") {
          fail(new Error(msg.message || "segment parse error"));
        } else if (msg.type === "done") {
          results[msg.segmentIndex] = msg.result;
          completed++;
          if (completed === numWorkers) resolve(results);
        }
      });
    }
  });

  statusLine("merging...", true);
  raw = TraceParser.mergeSegments(segments, (step, pct) => {
    statusLine(`${step} ${pct.toFixed(1)}%`);
  });
  statusLine("done.", true);
}

nodeFile.close();

// Post-process into traceData (mirrors trace-worker.js postResult + replay-controller.js "done" handler)
const peStateIndex = raw.peStateIndex;
const peStateList = [];
for (const [key, entry] of peStateIndex) {
  const [x, y] = key.split(",").map(Number);
  const { row, col } = TraceParser.toGridCoords(x, y, raw.dimY);
  peStateList.push({ key, entry, row, col, x, y });
}

let waveletList = null;
let wavPrefMaxLastCycle = null;
if (raw.hasWaveletData) {
  ({ waveletList, wavPrefMaxLastCycle } =
    TraceParser.prepareWaveletList([...raw.waveletIndex.values()]));
}

const opNopLookup = TraceParser.buildNopLookup(raw.opLookup);

const traceData = {
  dimX: raw.dimX,
  dimY: raw.dimY,
  peStateIndex,
  peStateList,
  opLookup: raw.opLookup,
  predLookup: raw.predLookup,
  opNopLookup,
  stallLookup: raw.stallLookup,
  waveletList,
  wavPrefMaxLastCycle,
  hasWaveletData: raw.hasWaveletData,
  minCycle: raw.minCycle,
  maxCycle: raw.maxCycle,
  pcIndex: raw.pcIndex,
};

if (traceData.dimX === 0 || traceData.dimY === 0 || traceData.minCycle > traceData.maxCycle) {
  process.stderr.write("Error: invalid trace data\n");
  process.exit(1);
}

process.stderr.write(`Grid: ${traceData.dimY} rows × ${traceData.dimX} cols, ` +
  `cycles ${traceData.minCycle}–${traceData.maxCycle}\n`);

// ---------------------------------------------------------------------------
// API: /api/meta
// ---------------------------------------------------------------------------

function handleMeta() {
  return JSON.stringify({
    dimX: traceData.dimX,
    dimY: traceData.dimY,
    minCycle: traceData.minCycle,
    maxCycle: traceData.maxCycle,
    opLookup: traceData.opLookup,
    predLookup: traceData.predLookup,
    hasWaveletData: traceData.hasWaveletData,
  });
}

// ---------------------------------------------------------------------------
// API: /api/state?cycle=N
// ---------------------------------------------------------------------------

function handleState(cycle) {
  const td = traceData;
  const pes = [];

  for (const item of td.peStateList) {
    const rec = TraceParser.reconstructPEAtCycle(item.entry, td.opNopLookup, td.stallLookup, cycle);
    if (rec && (rec.busy || rec.opId || rec.stallType)) {
      pes.push([item.row, item.col, rec.busy, rec.opId, rec.stallType, rec.stallReason]);
    }
  }

  // Wavelet reconstruction
  const wavelets = [];
  const wvRange = TraceParser.findLiveWaveletRange(td.waveletList, td.wavPrefMaxLastCycle, cycle, cycle - 1);
  if (wvRange) {
    const wvList = td.waveletList;
    for (let wi = wvRange.lowerBound; wi < wvRange.upperBound; wi++) {
      const wv = wvList[wi];
      if (wv.lastCycle + 1 < cycle) continue;
      const branches = getBranches(wv);
      for (const waypoints of branches) {
        const lastWp = waypoints[waypoints.length - 1];
        if ((lastWp.lingerUntil || lastWp.cycle) < cycle) continue;
        // Serialize waypoints as compact tuples
        const wps = [];
        for (const wp of waypoints) {
          wps.push([wp.cycle, wp.x, wp.y, wp.arriveDir, wp.departDir, wp.depCycle, wp.consumed || false, wp.lingerUntil || 0]);
        }
        wavelets.push([wv.color, wv.ctrl, wv.lf, wps]);
      }
    }
  }

  return JSON.stringify({ cycle, pes, wavelets });
}

// ---------------------------------------------------------------------------
// API: /api/pe-trace?x=X&y=Y
// ---------------------------------------------------------------------------

function handlePETrace(x, y) {
  const td = traceData;
  const key = `${x},${y}`;
  const entry = td.peStateIndex.get(key);

  if (!entry) return JSON.stringify({ found: false });

  // Build a minimal stallLookup containing only IDs this PE references
  const stallArr = Array.from(entry.stall);
  const usedIds = new Set(stallArr.filter(id => id !== 0));
  const minStallLookup = new Array(Math.max(0, ...usedIds) + 1).fill(null);
  for (const id of usedIds) minStallLookup[id] = td.stallLookup[id];

  return JSON.stringify({
    found: true,
    entry: {
      length: entry.length,
      cycles: Array.from(entry.cycles),
      busy: Array.from(entry.busy),
      opIds: Array.from(entry.opIds),
      predIds: Array.from(entry.predIds),
      pcs: Array.from(entry.pcs),
      stall: stallArr,
    },
    stallLookup: minStallLookup,
  });
}

// ---------------------------------------------------------------------------
// API: /api/pe-memory?x=X&y=Y
// ---------------------------------------------------------------------------

function handlePEMemory(x, y) {
  const key = `${x},${y}`;
  const m = traceData.pcIndex ? traceData.pcIndex.get(key) : null;
  if (!m) return JSON.stringify({ found: false });

  // Sort by PC address and serialize
  const instructions = [...m.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pc, rec]) => [pc, rec.op, rec.pred, rec.count, rec.firstCycle, rec.lastCycle, rec.operands || null]);

  return JSON.stringify({ found: true, instructions });
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function serveStatic(res, urlPath) {
  const safePath = urlPath === "/" ? "/index.html" : urlPath;
  if (safePath.includes("..")) { res.writeHead(403); res.end(); return; }
  const filePath = join(installDir, safePath);
  const mime = MIME[extname(filePath).toLowerCase()];
  if (!mime) { res.writeHead(404); res.end("Not found"); return; }
  try {
    const data = readFileSync(filePath);
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // CORS headers for development
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (path === "/api/meta") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(handleMeta());
    return;
  }

  if (path === "/api/state") {
    const cycle = parseInt(url.searchParams.get("cycle"), 10);
    if (!Number.isFinite(cycle)) { res.writeHead(400); res.end("Bad cycle"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(handleState(cycle));
    return;
  }

  if (path === "/api/pe-trace") {
    const x = parseInt(url.searchParams.get("x"), 10);
    const y = parseInt(url.searchParams.get("y"), 10);
    if (!Number.isFinite(x) || !Number.isFinite(y)) { res.writeHead(400); res.end("Bad coords"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(handlePETrace(x, y));
    return;
  }

  if (path === "/api/pe-memory") {
    const x = parseInt(url.searchParams.get("x"), 10);
    const y = parseInt(url.searchParams.get("y"), 10);
    if (!Number.isFinite(x) || !Number.isFinite(y)) { res.writeHead(400); res.end("Bad coords"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(handlePEMemory(x, y));
    return;
  }

  serveStatic(res, path);
});

const MAX_PORT_ATTEMPTS = 20;

function tryListen(attempt) {
  const tryPort = port + attempt;
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && attempt < MAX_PORT_ATTEMPTS - 1) {
      process.stderr.write(`Port ${tryPort} in use, trying ${tryPort + 1}...\n`);
      tryListen(attempt + 1);
    } else {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(1);
    }
  });
  server.listen(tryPort, () => {
    let host = hostname();
    // AWS-style hostnames (ip-w-x-y-z) aren't resolvable externally; use the IP instead
    if (/^ip-\d+-\d+-\d+-\d+/.test(host)) {
      for (const ifaces of Object.values(networkInterfaces())) {
        for (const iface of ifaces) {
          if (iface.family === "IPv4" && !iface.internal) { host = iface.address; break; }
        }
        if (host !== hostname()) break;
      }
    }
    process.stderr.write(`Server ready — open http://${host}:${tryPort}\n`);
  });
}

tryListen(0);
