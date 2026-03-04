const landingRegex =
  /^@(\d+) P(\d+)\.(\d+) \(\w+\) landing C(\d+) from link ([WESNR]),/;
const exOpRegex = /^@(\d+) P(\d+)\.(\d+):.*\[EX OP\]/;
const opcodeRegex = /T\d+(?:\.\w+)?\s+(\S+)/;
const waveletStallRegex =
  /^@(\d+) P(\d+)\.(\d+):.*Not enough wavelets \((\d+)\/(\d+)\) (SRC\d) with C(\d+), IN_Q\[(\d+)\], SIMD-(\d+)/;
const waveletRegex =
  /^@(\d+) P(\d+)\.(\d+) \(\w+\) wavelet C(\d+) ctrl=(\d), idx=([0-9a-fA-F]+), data=([0-9a-fA-F]+) \([^)]*\([^)]*\)\), half=(\d), ident=([0-9a-fA-F]+) landing=([RENWSD-]) departing=\/(.{5})\//;

function parseLanding(line) {
  if (!line.includes(") landing C")) return null;
  const m = line.match(landingRegex);
  if (!m) {
    console.warn("Trace parse failure: landing line did not match regex:", line.substring(0, 120));
    return null;
  }
  return {
    cycle: parseInt(m[1]),
    x: parseInt(m[2]),
    y: parseInt(m[3]),
    color: parseInt(m[4]),
    dir: m[5],
  };
}

function parseExOp(line) {
  if (!line.includes("[EX OP]")) return null;
  const m = line.match(exOpRegex);
  if (!m) {
    console.warn("Trace parse failure: EX OP line did not match regex:", line.substring(0, 120));
    return null;
  }
  const busy = !line.includes("[EX OP] IDLE");
  let op = null;
  if (busy) {
    const afterExOp = line.split("[EX OP]")[1];
    const opcodeMatch = afterExOp.match(opcodeRegex);
    if (opcodeMatch) op = opcodeMatch[1];
  }
  return {
    cycle: parseInt(m[1]),
    x: parseInt(m[2]),
    y: parseInt(m[3]),
    busy,
    op,
  };
}

function parseWavelet(line) {
  if (!line.includes(") wavelet C")) return null;
  const m = line.match(waveletRegex);
  if (!m) {
    console.warn("Trace parse failure: wavelet line did not match regex:", line.substring(0, 120));
    return null;
  }

  // Parse departing directions from 5-slot field: E,N,W,S,_
  const depStr = m[11];
  const departing = [];
  if (depStr[0] !== " ") departing.push("E");
  if (depStr[1] !== " ") departing.push("N");
  if (depStr[2] !== " ") departing.push("W");
  if (depStr[3] !== " ") departing.push("S");
  // depStr[4] is unused/reserved

  return {
    cycle: parseInt(m[1]),
    x: parseInt(m[2]),
    y: parseInt(m[3]),
    color: parseInt(m[4]),
    ctrl: m[5] === "1",
    idx: m[6],
    data: m[7],
    half: m[8] === "1",
    ident: m[9],
    landing: m[10],
    departing,
    colorswap: line.includes("colorswap from C") ? parseInt(line.match(/colorswap from C(\d+)/)[1]) : null,
    lf: line.includes(", lf=1"),
    noCe: line.includes("no_ce"),
    toCe: line.includes("to_ce_from_q"),
  };
}

function parseWaveletStall(line) {
  if (!line.includes("Not enough wavelets")) return null;
  const m = line.match(waveletStallRegex);
  if (!m) {
    console.warn("Trace parse failure: wavelet stall line did not match regex:", line.substring(0, 120));
    return null;
  }
  return {
    cycle: parseInt(m[1]),
    x: parseInt(m[2]),
    y: parseInt(m[3]),
    have: parseInt(m[4]),
    need: parseInt(m[5]),
    src: m[6],
    color: parseInt(m[7]),
    queue: parseInt(m[8]),
    simd: parseInt(m[9]),
  };
}

export class TraceParser {
  static async index(file) {
    let dimX = 0;
    let dimY = 0;
    let minCycle = Infinity;
    let maxCycle = -Infinity;
    let totalEvents = 0;

    const dimRegex = /^@\d+ dimX=(\d+), dimY=(\d+)/;
    const prevExState = new Map();   // per-PE EX OP dedup
    const prevStallState = new Map(); // per-PE stall dedup (separate from EX OP)
    const peStateIndex = new Map();
    const peStallIndex = new Map();   // key → [{startCycle, endCycle, color, src, queue}]
    const stallActive = new Map();    // key → {startCycle, color, src, queue, lastCycle}
    const waveletIndex = new Map();   // ident → { ident, color, ctrl, hops: [] }
    let hasWaveletData = false;

    const tmpCycles = [];
    const tmpStarts = [];
    const tmpEnds = [];
    let currentCycle = -1;
    let blockByteStart = 0;
    let hasEvents = false;

    const processLine = (line, lineByteStart) => {
      if (line.charCodeAt(0) === 64) {
        const spaceIdx = line.indexOf(" ", 1);
        if (spaceIdx > 1) {
          const cycle = parseInt(line.substring(1, spaceIdx));
          if (cycle !== currentCycle) {
            if (hasEvents && currentCycle >= 0) {
              tmpCycles.push(currentCycle);
              tmpStarts.push(blockByteStart);
              tmpEnds.push(lineByteStart);
            }
            currentCycle = cycle;
            blockByteStart = lineByteStart;
            hasEvents = false;
          }
        }
      }

      if (dimX === 0) {
        const dimMatch = line.match(dimRegex);
        if (dimMatch) {
          dimX = parseInt(dimMatch[1]);
          dimY = parseInt(dimMatch[2]);
          return;
        }
      }

      const landing = parseLanding(line);
      if (landing) {
        if (landing.cycle < minCycle) minCycle = landing.cycle;
        if (landing.cycle > maxCycle) maxCycle = landing.cycle;
        totalEvents++;
        hasEvents = true;
        return;
      }

      const wv = parseWavelet(line);
      if (wv) {
        hasWaveletData = true;
        hasEvents = true;
        totalEvents++;

        // Determine if this hop is consumed (delivered to compute element)
        wv.consumed = wv.toCe || (wv.landing !== "-" && wv.departing.length === 0 && !wv.noCe);

        let entry = waveletIndex.get(wv.ident);
        if (!entry) {
          entry = { ident: wv.ident, color: wv.color, ctrl: wv.ctrl, hops: [] };
          waveletIndex.set(wv.ident, entry);
        }
        entry.hops.push({
          cycle: wv.cycle, x: wv.x, y: wv.y,
          landing: wv.landing, departing: wv.departing,
          consumed: wv.consumed, noCe: wv.noCe, toCe: wv.toCe,
          colorswap: wv.colorswap, lf: wv.lf,
          idx: wv.idx, data: wv.data, half: wv.half,
        });

        if (wv.cycle < minCycle) minCycle = wv.cycle;
        if (wv.cycle > maxCycle) maxCycle = wv.cycle;
        return;
      }

      const stall = parseWaveletStall(line);
      if (stall) {
        const key = `${stall.x},${stall.y}`;
        // Track stall ranges: extend active stall or start a new one
        // A gap of >1 cycle between consecutive stall events means the stall ended and restarted
        const active = stallActive.get(key);
        if (active && stall.cycle <= active.lastCycle + 1) {
          active.lastCycle = stall.cycle;
        } else {
          // Close previous range if any
          if (active) {
            if (!peStallIndex.has(key)) peStallIndex.set(key, []);
            peStallIndex.get(key).push({
              startCycle: active.startCycle, endCycle: active.lastCycle,
              color: active.color, src: active.src, queue: active.queue,
            });
          }
          stallActive.set(key, {
            startCycle: stall.cycle, lastCycle: stall.cycle,
            color: stall.color, src: stall.src, queue: stall.queue,
          });
        }
        // Also record in peStateIndex for seek reconstruction (deduplicated)
        const state = `S:${stall.color}`;
        if (prevStallState.get(key) !== state) {
          prevStallState.set(key, state);
          if (!peStateIndex.has(key)) peStateIndex.set(key, []);
          peStateIndex.get(key).push({
            cycle: stall.cycle, busy: false, op: null,
            stall: "wavelet", stallColor: stall.color,
            stallHave: stall.have, stallNeed: stall.need,
            stallSrc: stall.src, stallQueue: stall.queue,
          });
          if (stall.cycle < minCycle) minCycle = stall.cycle;
          if (stall.cycle > maxCycle) maxCycle = stall.cycle;
        }
        hasEvents = true;
        return;
      }

      const ex = parseExOp(line);
      if (ex) {
        const key = `${ex.x},${ex.y}`;
        const state = ex.busy ? `1:${ex.op}` : "0";
        if (prevExState.get(key) !== state) {
          prevExState.set(key, state);
          if (!peStateIndex.has(key)) peStateIndex.set(key, []);
          peStateIndex.get(key).push({
            cycle: ex.cycle, busy: ex.busy, op: ex.op,
            stall: null, stallColor: null,
          });
          if (ex.cycle < minCycle) minCycle = ex.cycle;
          if (ex.cycle > maxCycle) maxCycle = ex.cycle;
        }
        hasEvents = true;
      }
    };

    const reader = file
      .stream()
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let partial = "";
    let byteOffset = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      partial += value;
      const lines = partial.split("\n");
      partial = lines.pop();

      for (const line of lines) {
        const lineByteStart = byteOffset;
        // Byte offset tracking assumes ASCII (1 byte per char). This is safe
        // because simfabric trace files are always pure ASCII.
        byteOffset += line.length + 1;
        processLine(line, lineByteStart);
      }
    }

    // Handle remaining partial line (file may not end with \n)
    if (partial.length > 0) {
      processLine(partial, byteOffset);
      byteOffset += partial.length;
    }

    // Flush last cycle block
    if (hasEvents && currentCycle >= 0) {
      tmpCycles.push(currentCycle);
      tmpStarts.push(blockByteStart);
      tmpEnds.push(byteOffset);
    }

    const len = tmpCycles.length;
    const cycleIndex = {
      cycles: new Float64Array(tmpCycles),
      starts: new Float64Array(tmpStarts),
      ends: new Float64Array(tmpEnds),
      length: len,
    };

    // Close any stall ranges still active at end of trace
    for (const [key, active] of stallActive) {
      if (!peStallIndex.has(key)) peStallIndex.set(key, []);
      peStallIndex.get(key).push({
        startCycle: active.startCycle, endCycle: active.lastCycle,
        color: active.color, src: active.src, queue: active.queue,
      });
    }

    // Pre-compute per-PE cycle arrays for binary search during seek
    for (const [, events] of peStateIndex) {
      events.cycleArray = new Float64Array(events.map(e => e.cycle));
    }

    return {
      file,
      dimX,
      dimY,
      cycleIndex,
      peStateIndex,
      peStallIndex,
      waveletIndex,
      hasWaveletData,
      minCycle,
      maxCycle,
      totalEvents,
    };
  }

  static findCycleIndex(cycleIndex, cycle) {
    const { cycles, length } = cycleIndex;
    let lo = 0;
    let hi = length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cycles[mid] === cycle) return mid;
      if (cycles[mid] < cycle) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  static findCycleIndexGE(cycleIndex, cycle) {
    const { cycles, length } = cycleIndex;
    let lo = 0;
    let hi = length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cycles[mid] < cycle) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  static findCycleIndexLE(cycleIndex, cycle) {
    const { cycles, length } = cycleIndex;
    let lo = 0;
    let hi = length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cycles[mid] <= cycle) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  static async loadCycleRange(traceData, fromIdx, toIdx) {
    const { file, cycleIndex } = traceData;
    if (fromIdx < 0 || toIdx >= cycleIndex.length || fromIdx > toIdx) {
      return new Map();
    }

    const { starts, ends } = cycleIndex;
    const blob = file.slice(starts[fromIdx], ends[toIdx]);
    const text = await blob.text();

    const result = new Map();
    const prevExState = new Map();
    const prevStallState = new Map();

    function getOrCreateCycle(cycle) {
      let entry = result.get(cycle);
      if (!entry) {
        entry = { landings: [], execChanges: [] };
        result.set(cycle, entry);
      }
      return entry;
    }

    for (const line of text.split("\n")) {
      const landing = parseLanding(line);
      if (landing) {
        getOrCreateCycle(landing.cycle).landings.push(landing);
        continue;
      }
      const stall = parseWaveletStall(line);
      if (stall) {
        const key = `${stall.x},${stall.y}`;
        const state = `S:${stall.color}`;
        if (prevStallState.get(key) !== state) {
          prevStallState.set(key, state);
          getOrCreateCycle(stall.cycle).execChanges.push({
            cycle: stall.cycle, x: stall.x, y: stall.y,
            busy: false, op: null,
            stall: "wavelet", stallColor: stall.color,
          });
        }
        continue;
      }
      const ex = parseExOp(line);
      if (ex) {
        const key = `${ex.x},${ex.y}`;
        const state = ex.busy ? `1:${ex.op}` : "0";
        if (prevExState.get(key) !== state) {
          prevExState.set(key, state);
          getOrCreateCycle(ex.cycle).execChanges.push({
            ...ex, stall: null, stallColor: null,
          });
        }
      }
    }

    return result;
  }

  // Returns the source PE coordinates for a landing event. The direction
  // indicates which link the wavelet arrived on, NOT which compass direction
  // the source is in. "from link N" means the wavelet used the north-facing
  // link of the neighbor at y-1 (the tile to the south in trace coordinates).
  // This mapping is intentional and matches the simfabric trace format.
  static sourceCoords(x, y, dir) {
    switch (dir) {
      case "W":
        return { x: x - 1, y };
      case "E":
        return { x: x + 1, y };
      case "N":
        return { x, y: y - 1 };
      case "S":
        return { x, y: y + 1 };
      default:
        return null;
    }
  }

  static toGridCoords(x, y, dimY) {
    return { row: dimY - 1 - y, col: x };
  }
}
