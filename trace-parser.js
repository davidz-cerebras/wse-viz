const landingRegex =
  /^@(\d+) P(\d+)\.(\d+) \(\w+\) landing C(\d+) from link ([WESNR]),/;
const exOpRegex = /^@(\d+) P(\d+)\.(\d+):.*\[EX OP\]/;
const opcodeRegex = /T\d+(?:\.\w+)?\s+(!?(?:CF|p)\d+(?::\d+)?\?)?\s*(\S+)/;
const waveletStallRegex =
  /^@(\d+) P(\d+)\.(\d+):.*Not enough wavelets \((\d+)\/(\d+)\) (SRC\d) with C(\d+), IN_Q\[(\d+)\], SIMD-(\d+)/;
const pipeStallRegex =
  /^@(\d+) P(\d+)\.(\d+):.*Pipe: (\d+), Msg: stall: (.+)/;
const waveletRegex =
  /^@(\d+) P(\d+)\.(\d+) \(\w+\) wavelet C(\d+) ctrl=(\d), idx=([0-9a-fA-F]+), data=([0-9a-fA-F]+) \([^)]*\([^)]*\)\), half=(\d), ident=([0-9a-fA-F]+) landing=([RENWSD-]) departing=\/(.{5})\//;

// Landing direction encoding for typed arrays
const LANDING_ENCODE = { R: 0, E: 1, N: 2, W: 3, S: 4, "-": 5, D: 6 };
export const LANDING_DECODE = ["R", "E", "N", "W", "S", "-", "D"];

export function decodeDeparting(mask) {
  const dirs = [];
  if (mask & 1) dirs.push("E");
  if (mask & 2) dirs.push("N");
  if (mask & 4) dirs.push("W");
  if (mask & 8) dirs.push("S");
  return dirs;
}

function encodeDeparting(dirs) {
  let mask = 0;
  for (const d of dirs) {
    if (d === "E") mask |= 1;
    else if (d === "N") mask |= 2;
    else if (d === "W") mask |= 4;
    else if (d === "S") mask |= 8;
  }
  return mask;
}

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
  let pred = null;
  if (busy) {
    const afterExOp = line.split("[EX OP]")[1];
    const opcodeMatch = afterExOp.match(opcodeRegex);
    if (opcodeMatch) {
      pred = opcodeMatch[1] || null;
      op = opcodeMatch[2];
    }
  }
  return {
    cycle: parseInt(m[1]),
    x: parseInt(m[2]),
    y: parseInt(m[3]),
    busy,
    op,
    pred,
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

function classifyPipeStall(msg) {
  const accumMatch = msg.match(/^dependent accum(\d)/);
  if (accumMatch) return { label: `A${accumMatch[1]}` };

  const regMatch = msg.match(/^(R\d+) ilock/);
  if (regMatch) return { label: regMatch[1] };

  if (msg.startsWith("write_pending/read conflict MEM"))
    return { label: "MEM" };

  const dsrMatch = msg.match(/^dependent (S\dDS\d)/);
  if (dsrMatch) return { label: dsrMatch[1] };

  return null;
}

function parsePipeStall(line) {
  if (!line.includes("Msg: stall:")) return null;
  const m = line.match(pipeStallRegex);
  if (!m) return null;
  const info = classifyPipeStall(m[5]);
  if (!info) return null;
  return {
    cycle: parseInt(m[1]),
    x: parseInt(m[2]),
    y: parseInt(m[3]),
    pipe: parseInt(m[4]),
    ...info,
  };
}

export class TraceParser {
  static async index(file, onProgress) {
    let dimX = 0;
    let dimY = 0;
    let minCycle = Infinity;
    let maxCycle = -Infinity;
    let totalEvents = 0;

    const dimRegex = /^@\d+ dimX=(\d+), dimY=(\d+)/;
    const prevExState = new Map();
    const peStateTemp = new Map();   // temporary: arrays of objects
    const waveletTemp = new Map();   // ident → { ident, color, ctrl, hops: [] }
    const landingsByCycle = new Map();
    let hasWaveletData = false;

    // Accumulate stall reasons: if the last event for this PE is a stall
    // at the same cycle, append to it; otherwise create a new stall event.
    const addStall = (key, cycle, reason, type) => {
      if (!peStateTemp.has(key)) peStateTemp.set(key, []);
      const events = peStateTemp.get(key);
      const last = events.length > 0 ? events[events.length - 1] : null;
      if (last && last.stall && last.cycle === cycle) {
        // Same PE, same cycle: accumulate if not already present
        if (!last.stallReasons.some(r => r.reason === reason))
          last.stallReasons.push({ reason, type });
        return;
      }
      events.push({
        cycle, busy: false, op: null, pred: null,
        stall: true, stallReasons: [{ reason, type }],
      });
      if (cycle < minCycle) minCycle = cycle;
      if (cycle > maxCycle) maxCycle = cycle;
    };

    const processLine = (line) => {
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
        let arr = landingsByCycle.get(landing.cycle);
        if (!arr) { arr = []; landingsByCycle.set(landing.cycle, arr); }
        arr.push({ x: landing.x, y: landing.y, color: landing.color, dir: landing.dir });
        return;
      }

      const wv = parseWavelet(line);
      if (wv) {
        hasWaveletData = true;
        totalEvents++;
        let entry = waveletTemp.get(wv.ident);
        if (!entry) {
          entry = { ident: wv.ident, color: wv.color, ctrl: wv.ctrl, hops: [] };
          waveletTemp.set(wv.ident, entry);
        }
        entry.hops.push({
          cycle: wv.cycle, x: wv.x, y: wv.y,
          landing: wv.landing, departing: wv.departing,
        });

        if (wv.cycle < minCycle) minCycle = wv.cycle;
        if (wv.cycle > maxCycle) maxCycle = wv.cycle;
        return;
      }

      const stall = parseWaveletStall(line);
      if (stall) {
        addStall(`${stall.x},${stall.y}`, stall.cycle,
          `C${stall.color}`, "wavelet");
        return;
      }

      const pipeStall = parsePipeStall(line);
      if (pipeStall) {
        addStall(`${pipeStall.x},${pipeStall.y}`, pipeStall.cycle,
          pipeStall.label, "pipeline");
        return;
      }

      const ex = parseExOp(line);
      if (ex) {
        const key = `${ex.x},${ex.y}`;
        const state = ex.busy ? `1:${ex.pred || ""}:${ex.op}` : "0";
        if (prevExState.get(key) !== state) {
          prevExState.set(key, state);
          if (!peStateTemp.has(key)) peStateTemp.set(key, []);
          peStateTemp.get(key).push({
            cycle: ex.cycle, busy: ex.busy, op: ex.op, pred: ex.pred,
            stall: false, stallReasons: null,
          });
          if (ex.cycle < minCycle) minCycle = ex.cycle;
          if (ex.cycle > maxCycle) maxCycle = ex.cycle;
        }
      }
    };

    const reader = file
      .stream()
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let partial = "";

    // Progress tracking: yield to the event loop periodically so the
    // browser can repaint the progress indicator. Byte count is tracked
    // from decoded text length (trace files are pure ASCII).
    const totalBytes = file.size;
    let bytesRead = 0;
    let lastPct = -1;
    let linesSinceYield = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      partial += value;
      const lines = partial.split("\n");
      partial = lines.pop();

      for (const line of lines) {
        processLine(line);
        if (onProgress) {
          bytesRead += line.length + 1;
          if (++linesSinceYield >= 1000) {
            linesSinceYield = 0;
            const pct = Math.round((bytesRead / totalBytes) * 100);
            if (pct !== lastPct) {
              lastPct = pct;
              onProgress(pct);
              await new Promise(resolve => setTimeout(resolve, 0));
            }
          }
        }
      }
    }

    if (partial.length > 0) {
      processLine(partial);
    }
    if (onProgress && lastPct < 100) onProgress(100);

    // Compact peStateIndex into typed arrays
    const peStateIndex = new Map();
    for (const [key, events] of peStateTemp) {
      const len = events.length;
      const cycles = new Float64Array(len);
      const busy = new Uint8Array(len);
      const ops = new Array(len);
      const preds = new Array(len);
      const stall = new Uint8Array(len);
      const stallReasons = new Array(len);
      for (let i = 0; i < len; i++) {
        const e = events[i];
        cycles[i] = e.cycle;
        busy[i] = e.busy ? 1 : 0;
        ops[i] = e.op;
        preds[i] = e.pred;
        stall[i] = e.stall ? 1 : 0;
        stallReasons[i] = e.stallReasons; // array of {reason, type} or null
      }
      peStateIndex.set(key, { cycles, busy, ops, preds, stall, stallReasons, length: len });
    }

    // Compact wavelet hops into typed arrays
    const waveletIndex = new Map();
    for (const [ident, entry] of waveletTemp) {
      const hops = entry.hops;
      const len = hops.length;
      const cycles = new Float64Array(len);
      const xs = new Uint16Array(len);
      const ys = new Uint16Array(len);
      const landings = new Uint8Array(len);
      const departings = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        const h = hops[i];
        cycles[i] = h.cycle;
        xs[i] = h.x;
        ys[i] = h.y;
        landings[i] = LANDING_ENCODE[h.landing] ?? 5;
        departings[i] = encodeDeparting(h.departing);
      }
      waveletIndex.set(ident, {
        ident: entry.ident,
        color: entry.color,
        ctrl: entry.ctrl,
        hops: { cycles, xs, ys, landings, departings, length: len },
      });
    }

    return {
      dimX,
      dimY,
      landingsByCycle,
      peStateIndex,
      waveletIndex,
      hasWaveletData,
      minCycle,
      maxCycle,
      totalEvents,
    };
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
