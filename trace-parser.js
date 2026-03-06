const landingRegex =
  /^@(\d+) P(\d+)\.(\d+) \(\w+\) landing C(\d+) from link ([WESNR]),/;
const exOpRegex = /^@(\d+) P(\d+)\.(\d+):.*\[EX OP\]/;
const opcodeRegex = /T\d+(?:\.\w+)?\s+(!?(?:CF|p)\d+(?::\d+)?\?)?\s*(\S+)/;
const waveletStallRegex =
  /^@(\d+) P(\d+)\.(\d+):.*Not enough wavelets \((\d+)\/(\d+)\) (?:for )?(SRC\d) with C(\d+), IN_Q\[(\d+)\], SIMD-(\d+)/;
const pipeStallRegex =
  /^@(\d+) P(\d+)\.(\d+):.*Pipe: (\d+), Msg: stall: (.+)/;
const waveletRegex =
  /^@(\d+) P(\d+)\.(\d+) \(\w+\) wavelet C(\d+) ctrl=(\d), idx=([0-9a-fA-F]+), data=([0-9a-fA-F]+) \([^)]*\([^)]*\)\), half=(\d), ident=([0-9a-fA-F]+) landing=([RENWSD-]) departing=\/(.{5})\//;

// In JSC (Safari), regex captures and String.substring() return "ropes" —
// lightweight references into the parent string. Storing a rope long-term
// prevents the entire parent from being GC'd. When parsing a 27GB file in
// 10MB chunks, each retained rope keeps its ~10MB chunk alive. This helper
// forces a flat copy by round-tripping through TextEncoder/TextDecoder,
// definitively breaking any rope reference. Only used for the few strings
// that are stored long-term (wavelet idents, opcode/pred intern keys,
// stall reason labels) — all are short (< 20 chars), so the cost is minimal.
const _enc = new TextEncoder();
const _dec = new TextDecoder();
function flatStr(s) {
  return s == null ? s : _dec.decode(_enc.encode(s));
}

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

// IO tiles (e.g., "LW36 (iotile)") use a different identifier format than
// compute tiles ("P<x>.<y> (hwtile)"). We intentionally ignore IO tile events
// in the current implementation — they handle host I/O and are not part of the
// PE grid visualization. We may revisit this in the future.
const iotileTest = /\(iotile\)/;

function parseLanding(line) {
  if (!line.includes(") landing C")) return null;
  if (iotileTest.test(line)) return null;
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

// parseExOp is intentionally NOT used for the hot path in processLine.
// EX OP lines are ~68% of all lines and ~98% are IDLE, so processLine
// uses manual string extraction (indexOf + substring) instead of regex
// for a ~1.6x speedup on large traces. This function is kept for
// clarity and potential use outside the hot loop.
function parseExOp(line) {
  if (!line.includes("[EX OP]")) return null;
  const m = line.match(exOpRegex);
  if (!m) return null;
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
  if (iotileTest.test(line)) return null; // ignore IO tile wavelets (see comment above parseLanding)
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
  // depStr[4] is the R (CE ramp) direction — intentionally not tracked because
  // ramp delivery is local to the PE (no visual hop to another tile to draw).

  const csMatch = line.match(/colorswap from C(\d+)/);
  return {
    cycle: parseInt(m[1]),
    x: parseInt(m[2]),
    y: parseInt(m[3]),
    color: parseInt(m[4]),
    ctrl: m[5] === "1",
    ident: flatStr(m[9]),
    landingEncoded: LANDING_ENCODE[m[10]] ?? 5, // encode immediately to avoid JSC rope retention
    departing,
    colorswap: csMatch ? parseInt(csMatch[1]) : null,
    lf: line.includes(", lf=1"),
    // A hop is "consumed" if the wavelet is delivered to the compute element.
    // This is used to visualize multicast-and-consume: when a wavelet is both
    // forwarded (departing.length > 0) and consumed, we fork the animation
    // so one dot continues onward and another terminates at the PE center.
    consumed: line.includes("to_ce_from_q") || line.includes("to_ce_from_router") ||
      (m[10] !== "-" && departing.length === 0 && !line.includes("no_ce")),
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
  if (regMatch) return { label: flatStr(regMatch[1]) };

  if (msg.startsWith("write_pending/read conflict MEM"))
    return { label: "MEM" };

  const dsrMatch = msg.match(/^dependent (S\dDS\d)/);
  if (dsrMatch) return { label: flatStr(dsrMatch[1]) };

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
    // peStateTemp stores flat parallel arrays per PE to avoid millions of
    // {cycle, busy, op, pred, stall, stallReasons} JS objects during parsing.
    // Opcodes and predicates are interned as uint8 IDs via small lookup tables.
    const peStateTemp = new Map();   // key → { cycles:[], busy:[], opIds:[], predIds:[], stall:[], stallReasons:[] }
    const opIntern = new Map();      // opcode string → uint8 id
    const predIntern = new Map();    // pred string → uint8 id
    opIntern.set(null, 0);          // id 0 = null (no op)
    predIntern.set(null, 0);        // id 0 = null (no pred)
    let nextOpId = 1;
    let nextPredId = 1;
    // Wavelet hops stored as flat parallel arrays per ident to avoid
    // millions of {cycle, x, y, landing, departing} JS objects (~1.5GB → ~266MB).
    const waveletTemp = new Map();   // ident → { ident, color, ctrl, cycles:[], xs:[], ys:[], landings:[], departings:[] }
    // Landings accumulated in flat temporary arrays, compacted to typed arrays
    // at the end. This avoids millions of {x, y, color, dir} JS objects.
    const tmpLandCycles = [];
    const tmpLandXs = [];
    const tmpLandYs = [];
    const tmpLandColors = [];
    const tmpLandDirs = [];
    let hasWaveletData = false;

    function getPEEntry(key) {
      let e = peStateTemp.get(key);
      if (!e) {
        e = { cycles: [], busy: [], opIds: [], predIds: [], stall: [], stallReasons: [] };
        peStateTemp.set(key, e);
      }
      return e;
    }

    function internOp(op) {
      let id = opIntern.get(op);
      if (id === undefined) { id = nextOpId++; opIntern.set(flatStr(op), id); }
      return id;
    }

    function internPred(pred) {
      let id = predIntern.get(pred);
      if (id === undefined) { id = nextPredId++; predIntern.set(flatStr(pred), id); }
      return id;
    }

    // Accumulate stall reasons: if the last event for this PE is a stall
    // at the same cycle, append to it; otherwise create a new stall event.
    const addStall = (key, cycle, reason, type) => {
      const pe = getPEEntry(key);
      const len = pe.cycles.length;
      if (len > 0 && pe.stall[len - 1] && pe.cycles[len - 1] === cycle) {
        // Same PE, same cycle: accumulate if not already present
        const existing = pe.stallReasons[len - 1];
        if (!existing.some(r => r.reason === reason))
          existing.push({ reason, type });
        return;
      }
      pe.cycles.push(cycle);
      pe.busy.push(0);
      pe.opIds.push(0);
      pe.predIds.push(0);
      pe.stall.push(1);
      pe.stallReasons.push([{ reason, type }]);
    };

    const processLine = (line) => {
      // Track the overall cycle range from the @<cycle> prefix of every line,
      // not just from events that pass dedup. Without this, traces where PEs
      // go idle early would have maxCycle stuck at the last state change.
      if (line.charCodeAt(0) === 64) { // '@'
        const spaceIdx = line.indexOf(" ", 1);
        if (spaceIdx > 1) {
          const cycle = parseInt(line.substring(1, spaceIdx));
          if (cycle > maxCycle) maxCycle = cycle;
          if (cycle < minCycle) minCycle = cycle;
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

      // EX OP hot path: manual string extraction instead of exOpRegex.
      // EX OP is ~68% of all lines, and ~98% of those are IDLE. We avoid
      // the expensive regex by using indexOf + substring + charCodeAt.
      const exIdx = line.indexOf("[EX OP]");
      if (exIdx !== -1) {
        // Extract PE key "x.y" from "@<cycle> P<x>.<y>:" prefix
        const sp1 = line.indexOf(" ", 1);
        const pIdx = sp1 + 2; // skip " P"
        const dotIdx = line.indexOf(".", pIdx);
        const colIdx = line.indexOf(":", dotIdx);
        if (dotIdx < 0 || colIdx < 0) return; // malformed
        // Parse as numbers then stringify to match addStall's key format
        // (guards against hypothetical leading-zero coordinates like P01.02)
        const x = +line.substring(pIdx, dotIdx);
        const y = +line.substring(dotIdx + 1, colIdx);
        const key = `${x},${y}`;

        // Fast IDLE check: char after "[EX OP] " is 'I' for IDLE
        const isIdle = line.charCodeAt(exIdx + 8) === 73;
        if (isIdle) {
          if (prevExState.get(key) !== "0") {
            prevExState.set(key, "0");
            const pe = getPEEntry(key);
            pe.cycles.push(+line.substring(1, sp1));
            pe.busy.push(0);
            pe.opIds.push(0);
            pe.predIds.push(0);
            pe.stall.push(0);
            pe.stallReasons.push(null);
          }
        } else {
          // Non-IDLE: extract opcode via regex (only ~2% of EX OP lines)
          const after = line.substring(exIdx + 8);
          const om = after.match(opcodeRegex);
          const pred = om ? (om[1] || null) : null;
          const op = om ? om[2] : null;
          const state = `1:${pred || ""}:${op || ""}`;
          if (prevExState.get(key) !== state) {
            prevExState.set(key, state);
            const pe = getPEEntry(key);
            pe.cycles.push(+line.substring(1, sp1));
            pe.busy.push(1);
            pe.opIds.push(internOp(op));
            pe.predIds.push(internPred(pred));
            pe.stall.push(0);
            pe.stallReasons.push(null);
          }
        }
        return;
      }

      const landing = parseLanding(line);
      if (landing) {
        totalEvents++;
        tmpLandCycles.push(landing.cycle);
        tmpLandXs.push(landing.x);
        tmpLandYs.push(landing.y);
        tmpLandColors.push(landing.color);
        tmpLandDirs.push(LANDING_ENCODE[landing.dir] ?? 0);
        return;
      }

      const wv = parseWavelet(line);
      if (wv) {
        hasWaveletData = true;
        totalEvents++;
        let entry = waveletTemp.get(wv.ident);
        if (!entry) {
          entry = { ident: wv.ident, color: wv.color, ctrl: wv.ctrl,
                    cycles: [], xs: [], ys: [], landings: [], departings: [], consumed: [] };
          waveletTemp.set(wv.ident, entry);
        }
        entry.cycles.push(wv.cycle);
        entry.xs.push(wv.x);
        entry.ys.push(wv.y);
        entry.landings.push(wv.landingEncoded);
        entry.departings.push(wv.departing);
        entry.consumed.push(wv.consumed ? 1 : 0);
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
      }
    };

    // Read the file in explicit slices with byte-level carryover to prevent
    // Safari/JSC from retaining all decoded text via substring ropes.
    // If we used string-based `partial += text`, JSC's rope optimization
    // would chain every chunk's decoded text across iterations, causing
    // the entire file (~27GB) to be held in memory simultaneously.
    // Instead, leftover bytes after the last newline are kept as a raw
    // Uint8Array, breaking the reference chain between iterations.
    const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB
    const decoder = new TextDecoder();
    const totalBytes = file.size;
    let carryover = new Uint8Array(0);
    let lastPct = -1;

    for (let offset = 0; offset < totalBytes; offset += CHUNK_SIZE) {
      const end = Math.min(offset + CHUNK_SIZE, totalBytes);
      const blob = file.slice(offset, end);
      const raw = new Uint8Array(await blob.arrayBuffer());

      // Prepend carryover bytes from the previous chunk
      let bytes;
      if (carryover.length > 0) {
        bytes = new Uint8Array(carryover.length + raw.length);
        bytes.set(carryover);
        bytes.set(raw, carryover.length);
      } else {
        bytes = raw;
      }

      // Find the last newline to split on a line boundary
      let lastNL = bytes.length - 1;
      while (lastNL >= 0 && bytes[lastNL] !== 10) lastNL--; // 10 = '\n'

      if (lastNL < 0) {
        // No newline in entire buffer — all carryover for next chunk
        carryover = bytes.slice(0);
        continue;
      }

      // Decode up to the last newline; keep remaining bytes as carryover
      const text = decoder.decode(bytes.subarray(0, lastNL + 1));
      carryover = lastNL + 1 < bytes.length ? bytes.slice(lastNL + 1) : new Uint8Array(0);

      const lines = text.split("\n");
      for (let i = 0; i < lines.length - 1; i++) {
        processLine(lines[i]);
      }

      if (onProgress) {
        const pct = Math.round((end / totalBytes) * 100);
        if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
      }
    }

    // Handle final carryover (file may not end with \n)
    if (carryover.length > 0) {
      processLine(decoder.decode(carryover));
    }
    if (onProgress && lastPct < 100) onProgress(100);

    // Build reverse lookup tables for interned opcodes and predicates
    const opLookup = new Array(nextOpId);
    for (const [str, id] of opIntern) opLookup[id] = str;
    const predLookup = new Array(nextPredId);
    for (const [str, id] of predIntern) predLookup[id] = str;

    // Compact peStateIndex: copy flat parallel arrays to typed arrays.
    // Ops and preds are stored as Uint8Array IDs with lookup tables,
    // reducing ~154MB of JS string arrays to ~10MB of typed arrays.
    const peStateIndex = new Map();
    for (const [key, pe] of peStateTemp) {
      const len = pe.cycles.length;
      peStateIndex.set(key, {
        cycles: new Float64Array(pe.cycles),
        busy: new Uint8Array(pe.busy),
        opIds: new Uint8Array(pe.opIds),
        predIds: new Uint8Array(pe.predIds),
        stall: new Uint8Array(pe.stall),
        stallReasons: pe.stallReasons, // kept as JS array (sparse, mostly null)
        length: len,
      });
    }

    // Compact wavelet hops into typed arrays. The temp data is already in
    // flat parallel arrays, so we just copy to typed arrays.
    const waveletIndex = new Map();
    for (const [ident, entry] of waveletTemp) {
      const len = entry.cycles.length;
      const cycles = new Float64Array(len);
      const xs = new Uint16Array(len);
      const ys = new Uint16Array(len);
      const landings = new Uint8Array(len);
      const departings = new Uint8Array(len);
      const consumed = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        cycles[i] = entry.cycles[i];
        xs[i] = entry.xs[i];
        ys[i] = entry.ys[i];
        landings[i] = entry.landings[i];
        departings[i] = encodeDeparting(entry.departings[i]);
        consumed[i] = entry.consumed[i];
      }
      waveletIndex.set(ident, {
        ident: entry.ident,
        color: entry.color,
        ctrl: entry.ctrl,
        hops: { cycles, xs, ys, landings, departings, consumed, length: len },
      });
    }

    // Compact landing events into sorted typed arrays with an offset index.
    // This replaces the Map<cycle, Array<{x,y,color,dir}>> with flat typed
    // arrays, reducing memory from ~80 bytes/landing to ~7 bytes/landing.
    const totalLandings = tmpLandCycles.length;
    let landingIndex = null;
    if (totalLandings > 0) {
      // Build sort order by cycle (stable: preserves insertion order within a cycle)
      const order = new Uint32Array(totalLandings);
      for (let i = 0; i < totalLandings; i++) order[i] = i;
      order.sort((a, b) => tmpLandCycles[a] - tmpLandCycles[b]);

      // Write sorted flat arrays
      const lXs = new Uint16Array(totalLandings);
      const lYs = new Uint16Array(totalLandings);
      const lColors = new Uint16Array(totalLandings);
      const lDirs = new Uint8Array(totalLandings);
      const lCyclesFlat = new Float64Array(totalLandings);
      for (let i = 0; i < totalLandings; i++) {
        const j = order[i];
        lCyclesFlat[i] = tmpLandCycles[j];
        lXs[i] = tmpLandXs[j];
        lYs[i] = tmpLandYs[j];
        lColors[i] = tmpLandColors[j];
        lDirs[i] = tmpLandDirs[j];
      }

      // Build unique-cycle offset index
      const uniqueCycles = [];
      const offsets = [0];
      let prevCycle = lCyclesFlat[0];
      uniqueCycles.push(prevCycle);
      for (let i = 1; i < totalLandings; i++) {
        if (lCyclesFlat[i] !== prevCycle) {
          prevCycle = lCyclesFlat[i];
          uniqueCycles.push(prevCycle);
          offsets.push(i);
        }
      }
      offsets.push(totalLandings); // sentinel

      landingIndex = {
        cycles: new Float64Array(uniqueCycles),
        offsets: new Uint32Array(offsets),
        xs: lXs,
        ys: lYs,
        colors: lColors,
        dirs: lDirs,
        length: uniqueCycles.length,
        totalLandings,
      };
    }

    return {
      dimX,
      dimY,
      landingIndex,
      peStateIndex,
      opLookup,     // uint8 id → opcode string (or null for id 0)
      predLookup,   // uint8 id → pred string (or null for id 0)
      waveletIndex,
      hasWaveletData,
      minCycle,
      maxCycle,
      totalEvents,
    };
  }

  // Parse a byte range of the file, returning uncompacted partial results.
  // Used by parallel segment workers. Each segment runs independently with
  // its own dedup state; the coordinator merges results afterward.
  static async indexSegment(file, startByte, endByte, isFirst, onProgress) {
    let dimX = 0, dimY = 0;
    let minCycle = Infinity, maxCycle = -Infinity;
    let totalEvents = 0;

    const dimRegex = /^@\d+ dimX=(\d+), dimY=(\d+)/;
    const prevExState = new Map();
    const peStateTemp = new Map();
    const waveletTemp = new Map();
    const tmpLandCycles = [], tmpLandXs = [], tmpLandYs = [], tmpLandColors = [], tmpLandDirs = [];
    let hasWaveletData = false;

    const opIntern = new Map(); opIntern.set(null, 0);
    const predIntern = new Map(); predIntern.set(null, 0);
    let nextOpId = 1, nextPredId = 1;

    function getPEEntry(key) {
      let e = peStateTemp.get(key);
      if (!e) { e = { cycles: [], busy: [], opIds: [], predIds: [], stall: [], stallReasons: [] }; peStateTemp.set(key, e); }
      return e;
    }
    function internOp(op) {
      let id = opIntern.get(op);
      if (id === undefined) { id = nextOpId++; opIntern.set(flatStr(op), id); }
      return id;
    }
    function internPred(pred) {
      let id = predIntern.get(pred);
      if (id === undefined) { id = nextPredId++; predIntern.set(flatStr(pred), id); }
      return id;
    }
    const addStall = (key, cycle, reason, type) => {
      const pe = getPEEntry(key);
      const len = pe.cycles.length;
      if (len > 0 && pe.stall[len - 1] && pe.cycles[len - 1] === cycle) {
        const existing = pe.stallReasons[len - 1];
        if (!existing.some(r => r.reason === reason)) existing.push({ reason, type });
        return;
      }
      pe.cycles.push(cycle); pe.busy.push(0); pe.opIds.push(0); pe.predIds.push(0);
      pe.stall.push(1); pe.stallReasons.push([{ reason, type }]);
    };

    const processLine = (line) => {
      if (line.charCodeAt(0) === 64) {
        const spaceIdx = line.indexOf(" ", 1);
        if (spaceIdx > 1) {
          const cycle = parseInt(line.substring(1, spaceIdx));
          if (cycle > maxCycle) maxCycle = cycle;
          if (cycle < minCycle) minCycle = cycle;
        }
      }
      if (isFirst && dimX === 0) {
        const dimMatch = line.match(dimRegex);
        if (dimMatch) { dimX = parseInt(dimMatch[1]); dimY = parseInt(dimMatch[2]); return; }
      }

      const exIdx = line.indexOf("[EX OP]");
      if (exIdx !== -1) {
        const sp1 = line.indexOf(" ", 1);
        const pIdx = sp1 + 2;
        const dotIdx = line.indexOf(".", pIdx);
        const colIdx = line.indexOf(":", dotIdx);
        if (dotIdx < 0 || colIdx < 0) return;
        const x = +line.substring(pIdx, dotIdx);
        const y = +line.substring(dotIdx + 1, colIdx);
        const key = `${x},${y}`;
        const isIdle = line.charCodeAt(exIdx + 8) === 73;
        if (isIdle) {
          if (prevExState.get(key) !== "0") {
            prevExState.set(key, "0");
            const pe = getPEEntry(key);
            pe.cycles.push(+line.substring(1, sp1)); pe.busy.push(0);
            pe.opIds.push(0); pe.predIds.push(0); pe.stall.push(0); pe.stallReasons.push(null);
          }
        } else {
          const after = line.substring(exIdx + 8);
          const om = after.match(opcodeRegex);
          const pred = om ? (om[1] || null) : null;
          const op = om ? om[2] : null;
          const state = `1:${pred || ""}:${op || ""}`;
          if (prevExState.get(key) !== state) {
            prevExState.set(key, state);
            const pe = getPEEntry(key);
            pe.cycles.push(+line.substring(1, sp1)); pe.busy.push(1);
            pe.opIds.push(internOp(op)); pe.predIds.push(internPred(pred));
            pe.stall.push(0); pe.stallReasons.push(null);
          }
        }
        return;
      }

      const landing = parseLanding(line);
      if (landing) {
        totalEvents++;
        tmpLandCycles.push(landing.cycle); tmpLandXs.push(landing.x);
        tmpLandYs.push(landing.y); tmpLandColors.push(landing.color);
        tmpLandDirs.push(LANDING_ENCODE[landing.dir] ?? 0);
        return;
      }

      const wv = parseWavelet(line);
      if (wv) {
        hasWaveletData = true; totalEvents++;
        let entry = waveletTemp.get(wv.ident);
        if (!entry) {
          entry = { ident: wv.ident, color: wv.color, ctrl: wv.ctrl,
                    cycles: [], xs: [], ys: [], landings: [], departings: [], consumed: [] };
          waveletTemp.set(wv.ident, entry);
        }
        entry.cycles.push(wv.cycle); entry.xs.push(wv.x); entry.ys.push(wv.y);
        entry.landings.push(wv.landingEncoded); entry.departings.push(wv.departing);
        entry.consumed.push(wv.consumed ? 1 : 0);
        return;
      }

      const stall = parseWaveletStall(line);
      if (stall) { addStall(`${stall.x},${stall.y}`, stall.cycle, `C${stall.color}`, "wavelet"); return; }

      const pipeStall = parsePipeStall(line);
      if (pipeStall) { addStall(`${pipeStall.x},${pipeStall.y}`, pipeStall.cycle, pipeStall.label, "pipeline"); }
    };

    // Chunked reading with byte-level carryover (see index() for explanation)
    const CHUNK_SIZE = 10 * 1024 * 1024;
    const decoder = new TextDecoder();
    const segmentSize = endByte - startByte;
    let carryover = new Uint8Array(0);
    let lastPct = -1;
    let skipFirstLine = !isFirst; // non-first segments skip partial first line

    for (let offset = startByte; offset < endByte; offset += CHUNK_SIZE) {
      const end = Math.min(offset + CHUNK_SIZE, endByte);
      const blob = file.slice(offset, end);
      const raw = new Uint8Array(await blob.arrayBuffer());

      let bytes;
      if (carryover.length > 0) {
        bytes = new Uint8Array(carryover.length + raw.length);
        bytes.set(carryover); bytes.set(raw, carryover.length);
      } else {
        bytes = raw;
      }

      let lastNL = bytes.length - 1;
      while (lastNL >= 0 && bytes[lastNL] !== 10) lastNL--;

      if (lastNL < 0) { carryover = bytes.slice(0); continue; }

      const text = decoder.decode(bytes.subarray(0, lastNL + 1));
      carryover = lastNL + 1 < bytes.length ? bytes.slice(lastNL + 1) : new Uint8Array(0);

      const lines = text.split("\n");
      let startI = 0;
      if (skipFirstLine) { startI = 1; skipFirstLine = false; } // skip partial first line
      for (let i = startI; i < lines.length - 1; i++) processLine(lines[i]);

      if (onProgress) {
        const pct = Math.round(((end - startByte) / segmentSize) * 100);
        if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
      }
    }

    // Handle final carryover — for the last segment, process it;
    // for non-last segments, read past endByte to finish the straddling line
    if (carryover.length > 0) {
      // Read one more small chunk to find the end of the straddling line
      if (endByte < file.size) {
        const extra = new Uint8Array(await file.slice(endByte, Math.min(endByte + 10000, file.size)).arrayBuffer());
        const combined = new Uint8Array(carryover.length + extra.length);
        combined.set(carryover); combined.set(extra, carryover.length);
        const nlIdx = combined.indexOf(10);
        if (nlIdx >= 0) {
          processLine(decoder.decode(combined.subarray(0, nlIdx)));
        } else {
          processLine(decoder.decode(combined));
        }
      } else {
        processLine(decoder.decode(carryover));
      }
    }

    // Build op/pred lookup tables for this segment
    const opLookup = new Array(nextOpId);
    for (const [str, id] of opIntern) opLookup[id] = str;
    const predLookup = new Array(nextPredId);
    for (const [str, id] of predIntern) predLookup[id] = str;

    return {
      dimX, dimY, minCycle, maxCycle, totalEvents, hasWaveletData,
      peStateTemp: [...peStateTemp.entries()],
      prevExState: [...prevExState.entries()],
      waveletTemp: [...waveletTemp.entries()],
      tmpLandCycles, tmpLandXs, tmpLandYs, tmpLandColors, tmpLandDirs,
      opLookup, predLookup,
    };
  }

  // Merge partial results from N parallel segments into final compacted trace data.
  static mergeSegments(segments) {
    let dimX = 0, dimY = 0, minCycle = Infinity, maxCycle = -Infinity;
    let totalEvents = 0, hasWaveletData = false;

    // 1. Scalars: take from first segment that has dims; merge cycle range
    for (const seg of segments) {
      if (seg.dimX > 0 && dimX === 0) { dimX = seg.dimX; dimY = seg.dimY; }
      if (seg.minCycle < minCycle) minCycle = seg.minCycle;
      if (seg.maxCycle > maxCycle) maxCycle = seg.maxCycle;
      totalEvents += seg.totalEvents;
      if (seg.hasWaveletData) hasWaveletData = true;
    }

    // 2. Build global op/pred intern tables from all segments
    const globalOpIntern = new Map(); globalOpIntern.set(null, 0);
    const globalPredIntern = new Map(); globalPredIntern.set(null, 0);
    let gNextOp = 1, gNextPred = 1;
    // segOpRemap[segIdx][localId] = globalId
    const segOpRemap = [];
    const segPredRemap = [];
    for (const seg of segments) {
      const opMap = new Array(seg.opLookup.length);
      for (let id = 0; id < seg.opLookup.length; id++) {
        const s = seg.opLookup[id];
        let gid = globalOpIntern.get(s);
        if (gid === undefined) { gid = gNextOp++; globalOpIntern.set(s, gid); }
        opMap[id] = gid;
      }
      segOpRemap.push(opMap);

      const predMap = new Array(seg.predLookup.length);
      for (let id = 0; id < seg.predLookup.length; id++) {
        const s = seg.predLookup[id];
        let gid = globalPredIntern.get(s);
        if (gid === undefined) { gid = gNextPred++; globalPredIntern.set(s, gid); }
        predMap[id] = gid;
      }
      segPredRemap.push(predMap);
    }
    const opLookup = new Array(gNextOp);
    for (const [str, id] of globalOpIntern) opLookup[id] = str;
    const predLookup = new Array(gNextPred);
    for (const [str, id] of globalPredIntern) predLookup[id] = str;

    // 3. Merge PE state across segments with cross-segment dedup.
    //
    // The single-threaded parser uses prevExState per PE to dedup EX OP events.
    // Stall events don't change prevExState. Each segment starts with a fresh
    // prevExState, so its first EX OP for each PE is always recorded — even if
    // it matches the state at the end of the previous segment.
    //
    // To fix this, we accumulate prevExState across segments and re-apply
    // dedup to non-stall events. For stalls, we merge same-cycle stall reasons.
    const mergedPE = new Map();
    const globalPrevExState = new Map(); // accumulated across all segments

    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si];
      const opRemap = segOpRemap[si];
      const predRemap = segPredRemap[si];

      for (const [key, pe] of seg.peStateTemp) {
        if (!mergedPE.has(key)) {
          mergedPE.set(key, { cycles: [], busy: [], opIds: [], predIds: [], stall: [], stallReasons: [] });
        }
        const dst = mergedPE.get(key);

        for (let i = 0; i < pe.cycles.length; i++) {
          const gOpId = opRemap[pe.opIds[i]];
          const gPredId = predRemap[pe.predIds[i]];

          if (!pe.stall[i]) {
            // Non-stall event: dedup against globalPrevExState (same logic as single-threaded)
            const newState = pe.busy[i] ? `1:${predLookup[gPredId] || ""}:${opLookup[gOpId] || ""}` : "0";
            if (globalPrevExState.get(key) === newState) continue;
            globalPrevExState.set(key, newState);
          } else {
            // Stall event: merge reasons if same PE + same cycle as last merged event
            const dstLen = dst.cycles.length;
            if (dstLen > 0 && dst.stall[dstLen - 1] && dst.cycles[dstLen - 1] === pe.cycles[i]) {
              const existing = dst.stallReasons[dstLen - 1];
              for (const r of pe.stallReasons[i]) {
                if (!existing.some(e => e.reason === r.reason)) existing.push(r);
              }
              continue;
            }
          }

          dst.cycles.push(pe.cycles[i]);
          dst.busy.push(pe.busy[i]);
          dst.opIds.push(gOpId);
          dst.predIds.push(gPredId);
          dst.stall.push(pe.stall[i]);
          dst.stallReasons.push(pe.stallReasons[i]);
        }
      }

      // Note: globalPrevExState is already correct from the event processing
      // loop above (line 821 updates it for every non-stall event that passes
      // dedup). We do NOT overwrite from seg.prevExState because the merge
      // dedup maintains its own consistent state.
    }

    // Compact merged PE state to typed arrays
    const peStateIndex = new Map();
    for (const [key, pe] of mergedPE) {
      const len = pe.cycles.length;
      peStateIndex.set(key, {
        cycles: new Float64Array(pe.cycles),
        busy: new Uint8Array(pe.busy),
        opIds: new Uint8Array(pe.opIds),
        predIds: new Uint8Array(pe.predIds),
        stall: new Uint8Array(pe.stall),
        stallReasons: pe.stallReasons,
        length: len,
      });
    }

    // 4. Merge wavelet hops: concatenate per-ident arrays across segments
    const mergedWav = new Map();
    for (const seg of segments) {
      for (const [ident, entry] of seg.waveletTemp) {
        if (!mergedWav.has(ident)) {
          mergedWav.set(ident, { ident: entry.ident, color: entry.color, ctrl: entry.ctrl,
                                  cycles: [], xs: [], ys: [], landings: [], departings: [], consumed: [] });
        }
        const dst = mergedWav.get(ident);
        for (let i = 0; i < entry.cycles.length; i++) {
          dst.cycles.push(entry.cycles[i]);
          dst.xs.push(entry.xs[i]);
          dst.ys.push(entry.ys[i]);
          dst.landings.push(entry.landings[i]);
          dst.departings.push(entry.departings[i]);
          dst.consumed.push(entry.consumed[i]);
        }
      }
    }

    // Compact wavelet hops to typed arrays
    const waveletIndex = new Map();
    for (const [ident, entry] of mergedWav) {
      const len = entry.cycles.length;
      const cycles = new Float64Array(len);
      const xs = new Uint16Array(len);
      const ys = new Uint16Array(len);
      const landings = new Uint8Array(len);
      const departings = new Uint8Array(len);
      const consumed = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        cycles[i] = entry.cycles[i];
        xs[i] = entry.xs[i];
        ys[i] = entry.ys[i];
        landings[i] = entry.landings[i]; // already encoded
        departings[i] = encodeDeparting(entry.departings[i]);
        consumed[i] = entry.consumed[i];
      }
      waveletIndex.set(ident, { ident: entry.ident, color: entry.color, ctrl: entry.ctrl,
                                 hops: { cycles, xs, ys, landings, departings, consumed, length: len } });
    }

    // 5. Merge and compact landings
    const allLandCycles = [], allLandXs = [], allLandYs = [], allLandColors = [], allLandDirs = [];
    for (const seg of segments) {
      for (let i = 0; i < seg.tmpLandCycles.length; i++) {
        allLandCycles.push(seg.tmpLandCycles[i]);
        allLandXs.push(seg.tmpLandXs[i]);
        allLandYs.push(seg.tmpLandYs[i]);
        allLandColors.push(seg.tmpLandColors[i]);
        allLandDirs.push(seg.tmpLandDirs[i]);
      }
    }
    let landingIndex = null;
    const totalLandings = allLandCycles.length;
    if (totalLandings > 0) {
      const order = new Uint32Array(totalLandings);
      for (let i = 0; i < totalLandings; i++) order[i] = i;
      order.sort((a, b) => allLandCycles[a] - allLandCycles[b]);
      const lXs = new Uint16Array(totalLandings), lYs = new Uint16Array(totalLandings);
      const lColors = new Uint16Array(totalLandings), lDirs = new Uint8Array(totalLandings);
      const lCyclesFlat = new Float64Array(totalLandings);
      for (let i = 0; i < totalLandings; i++) {
        const j = order[i];
        lCyclesFlat[i] = allLandCycles[j]; lXs[i] = allLandXs[j];
        lYs[i] = allLandYs[j]; lColors[i] = allLandColors[j]; lDirs[i] = allLandDirs[j];
      }
      const uniqueCycles = [], offsets = [0];
      let prevCycle = lCyclesFlat[0]; uniqueCycles.push(prevCycle);
      for (let i = 1; i < totalLandings; i++) {
        if (lCyclesFlat[i] !== prevCycle) { prevCycle = lCyclesFlat[i]; uniqueCycles.push(prevCycle); offsets.push(i); }
      }
      offsets.push(totalLandings);
      landingIndex = { cycles: new Float64Array(uniqueCycles), offsets: new Uint32Array(offsets),
                       xs: lXs, ys: lYs, colors: lColors, dirs: lDirs,
                       length: uniqueCycles.length, totalLandings };
    }

    return { dimX, dimY, landingIndex, peStateIndex, opLookup, predLookup,
             waveletIndex, hasWaveletData, minCycle, maxCycle, totalEvents };
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

  // Look up landings for a given cycle in the compact landingIndex.
  // Returns {start, end} indices into the flat arrays, or null if no landings.
  static getLandingRange(landingIndex, cycle) {
    if (!landingIndex) return null;
    const { cycles, offsets, length } = landingIndex;
    // Binary search for exact cycle match
    let lo = 0, hi = length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cycles[mid] === cycle) {
        return { start: offsets[mid], end: offsets[mid + 1] };
      }
      if (cycles[mid] < cycle) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
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
