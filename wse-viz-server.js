#!/usr/bin/env node
// wse-viz server — indexes a trace file and serves the visualization + API.
// Usage: node wse-viz-server.js [trace-file] [--port=PORT]
//   trace-file defaults to bench-sim.log in the current directory.
//   PORT defaults to 8080.

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

import { hostname } from "node:os";
import { NodeFile } from "./node-file.js";
import { TraceParser } from "./trace-parser.js";
import { extractBranches } from "./wavelet.js";

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

process.stderr.write(`Indexing ${traceFile}...\n`);
const nodeFile = new NodeFile(traceFile);
const raw = await TraceParser.index(nodeFile, (pct) => {
  process.stderr.write(`\r  ${pct.toFixed(1)}%`);
});
nodeFile.close();
process.stderr.write("\r  done.     \n");

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
  waveletList = [...raw.waveletIndex.values()];
  for (const wv of waveletList) {
    wv.firstCycle = wv.hops.cycles[0];
    wv.lastCycle = wv.hops.cycles[wv.hops.cycles.length - 1];
  }
  waveletList.sort((a, b) => a.firstCycle - b.firstCycle);
  wavPrefMaxLastCycle = new Float64Array(waveletList.length);
  let runMax = -Infinity;
  for (let i = 0; i < waveletList.length; i++) {
    runMax = Math.max(runMax, waveletList[i].lastCycle);
    wavPrefMaxLastCycle[i] = runMax;
  }
}

// Build NOP lookup from opLookup (avoids importing pe.js which has browser deps)
const opNopLookup = new Uint8Array(raw.opLookup.length);
for (let i = 0; i < raw.opLookup.length; i++) {
  const op = raw.opLookup[i];
  if (op && (op === "NOP" || op.startsWith("NOP."))) opNopLookup[i] = 1;
}

const traceData = {
  dimX: raw.dimX,
  dimY: raw.dimY,
  peStateIndex,
  peStateList,
  opLookup: raw.opLookup,
  predLookup: raw.predLookup,
  opNopLookup,
  waveletList,
  wavPrefMaxLastCycle,
  hasWaveletData: raw.hasWaveletData,
  minCycle: raw.minCycle,
  maxCycle: raw.maxCycle,
};

if (traceData.dimX === 0 || traceData.dimY === 0 || traceData.minCycle > traceData.maxCycle) {
  process.stderr.write("Error: invalid trace data\n");
  process.exit(1);
}

process.stderr.write(`Grid: ${traceData.dimY} rows × ${traceData.dimX} cols, ` +
  `cycles ${traceData.minCycle}–${traceData.maxCycle}\n`);

// ---------------------------------------------------------------------------
// Wavelet branch cache
// ---------------------------------------------------------------------------

function getBranches(wv) {
  if (!wv._branches) wv._branches = extractBranches(wv);
  return wv._branches;
}

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

  // PE state reconstruction (mirrors reconstructStateAtCycle in replay-controller.js)
  for (const item of td.peStateList) {
    const entry = item.entry;
    const found = TraceParser.findCycleIndexLE(entry.cycles, entry.length, cycle);
    if (found < 0) continue;

    let exIdx = -1, stallIdx = -1;
    for (let i = found; i >= 0; i--) {
      if (!entry.stall[i]) { exIdx = i; break; }
      if (stallIdx < 0) stallIdx = i;
    }
    if (exIdx >= 0 && stallIdx < 0 && exIdx > 0 &&
        entry.stall[exIdx - 1] && entry.cycles[exIdx - 1] === entry.cycles[exIdx]) {
      stallIdx = exIdx - 1;
    }

    let busy = 0, opId = 0;
    if (exIdx >= 0) {
      opId = entry.opIds[exIdx];
      if (td.opNopLookup[opId]) { busy = 0; opId = 0; }
      else busy = entry.busy[exIdx];
    }

    let stallType = null, stallReason = null;
    if (stallIdx >= 0) {
      const reasons = entry.stallReasons[stallIdx];
      if (reasons && reasons.length > 0) {
        stallType = reasons[0].type;
        stallReason = reasons[0].reason;
      }
    }

    if (busy || opId || stallType) {
      pes.push([item.row, item.col, busy, opId, stallType, stallReason]);
    }
  }

  // Wavelet reconstruction
  const wavelets = [];
  if (td.waveletList) {
    const wvList = td.waveletList;
    const wvLen = wvList.length;
    const prefMax = td.wavPrefMaxLastCycle;

    // Upper bound: first index where firstCycle > cycle
    let lo = 0, hi = wvLen;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (wvList[mid].firstCycle <= cycle) lo = mid + 1;
      else hi = mid;
    }
    const upperBound = lo;

    // Lower bound: first index where prefMaxLastCycle >= cycle
    lo = 0; hi = upperBound;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (prefMax[mid] < cycle) lo = mid + 1;
      else hi = mid;
    }
    const lowerBound = lo;

    for (let wi = lowerBound; wi < upperBound; wi++) {
      const wv = wvList[wi];
      if (wv.lastCycle < cycle) continue;
      const branches = getBranches(wv);
      for (const waypoints of branches) {
        const branchEnd = waypoints[waypoints.length - 1].cycle;
        if (branchEnd < cycle) continue;
        // Serialize waypoints as compact tuples
        const wps = [];
        for (const wp of waypoints) {
          wps.push([wp.cycle, wp.x, wp.y, wp.arriveDir, wp.departDir, wp.depCycle]);
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

  // Send sparse entry data — client reconstructs flat arrays and computes opCounts
  return JSON.stringify({
    found: true,
    entry: {
      length: entry.length,
      cycles: Array.from(entry.cycles),
      busy: Array.from(entry.busy),
      opIds: Array.from(entry.opIds),
      predIds: Array.from(entry.predIds),
      stall: Array.from(entry.stall),
      stallReasons: entry.stallReasons,
    },
  });
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
    process.stderr.write(`Server ready — open http://${hostname()}:${tryPort}\n`);
  });
}

tryListen(0);
