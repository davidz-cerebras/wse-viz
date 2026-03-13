const landingRegex =
  /^@(\d+) P(\d+)\.(\d+) \(\w+\) landing C(\d+) from link ([WESNR]),/;
const opcodeRegex = /T\d+(?:\.\w+)?\s+(!?(?:CF|p)\d+(?::\d+)?\?)?\s*(\S+)/;
const waveletStallRegex =
  /^@(\d+) P(\d+)\.(\d+):.*Not enough wavelets \((?:\d+)\/(?:\d+)\) (?:for )?(?:SRC\d) with C(\d+), IN_Q\[(?:\d+)\], SIMD-(?:\d+)/;
const pipeStallRegex =
  /^@(\d+) P(\d+)\.(\d+):.*Pipe: (?:\d+), Msg: stall: (.+)/;
const waveletRegex =
  /^@(\d+) P(\d+)\.(\d+) \(\w+\) wavelet C(\d+) ctrl=(\d), idx=(?:[0-9a-fA-F]+), data=(?:[0-9a-fA-F]+) \([^)]*\([^)]*\)\), half=(?:\d), ident=([0-9a-fA-F]+) landing=([RENWSD-]) departing=\/(.{5})\//;

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

// IO tiles (e.g., "LW36 (iotile)") use a different identifier format than
// compute tiles ("P<x>.<y> (hwtile)"). We intentionally ignore IO tile events
// in the current implementation — they handle host I/O and are not part of the
// PE grid visualization. We may revisit this in the future.
const dimRegex = /^@\d+ dimX=(\d+), dimY=(\d+)/;
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
    dirEncoded: LANDING_ENCODE[m[5]],
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
  // Encode as bitmask immediately (bit0=E, bit1=N, bit2=W, bit3=S)
  // to avoid creating string arrays and calling encodeDeparting later.
  const depStr = m[8];
  let departingEncoded = 0;
  if (depStr[0] !== " ") departingEncoded |= 1;
  if (depStr[1] !== " ") departingEncoded |= 2;
  if (depStr[2] !== " ") departingEncoded |= 4;
  if (depStr[3] !== " ") departingEncoded |= 8;
  // depStr[4] is the R (CE ramp) direction — intentionally not tracked because
  // ramp delivery is local to the PE (no visual hop to another tile to draw).

  return {
    cycle: parseInt(m[1]),
    x: parseInt(m[2]),
    y: parseInt(m[3]),
    color: parseInt(m[4]),
    ctrl: m[5] === "1",
    ident: flatStr(m[6]),
    landingEncoded: LANDING_ENCODE[m[7]], // encode immediately to avoid JSC rope retention
    departingEncoded,
    lf: line.includes(", lf=1"),
    consumed: line.includes("to_ce_from_q") || line.includes("to_ce_from_router") ||
      (m[7] !== "-" && departingEncoded === 0 && !line.includes("no_ce")),
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
    color: parseInt(m[4]),
  };
}

function classifyPipeStall(msg) {
  // Accumulator dependency (Pipe 7): "dependent accum0"
  const accumMatch = msg.match(/^dependent accum(\d)/);
  if (accumMatch) return { label: `ACC ${accumMatch[1]}` };

  // Register interlock (Pipe 6): "R3 ilock"
  const regMatch = msg.match(/^(R\d+) ilock/);
  if (regMatch) return { label: flatStr(regMatch[1]) };

  // Memory interlock (Pipe 6): "MEM[005c] ilock"
  if (msg.includes("] ilock")) return { label: "MEM" };

  // Write-read hazard (Pipe 5): "write_pending/read conflict MEM[addr](bank)"
  if (msg.startsWith("write_pending/read conflict MEM"))
    return { label: "MEM RAW" };

  // Memory bank conflict (Pipe 5): "read conflict MEM[addr](bN)"
  const bankMatch = msg.match(/^read conflict MEM\[[0-9a-f]+\]\(b(\d)\)/);
  if (bankMatch) return { label: `BANK ${bankMatch[1]}` };

  // DSR dependency (Pipe 2): "dependent S0DS0", "dependent S1DS12", "dependent DDS0"
  const dsrMatch = msg.match(/^dependent ((?:S[01]|D)DS\d+)/);
  if (dsrMatch) return { label: flatStr(dsrMatch[1]) };

  return null;
}

function parsePipeStall(line) {
  if (!line.includes("Msg: stall:")) return null;
  const m = line.match(pipeStallRegex);
  if (!m) return null;
  const info = classifyPipeStall(m[4]);
  if (!info) return null;
  return {
    cycle: parseInt(m[1]),
    x: parseInt(m[2]),
    y: parseInt(m[3]),
    ...info,
  };
}

// Extract a named field value from an IS OP line, e.g., "Dest:R5,R4" → "r5,r4"
function _isField(text, name) {
  const idx = text.indexOf(name + ":");
  if (idx < 0) return null;
  const start = idx + name.length + 1;
  let end = start;
  while (end < text.length && text.charCodeAt(end) !== 32 && text.charCodeAt(end) !== 9) end++;
  return flatStr(text.substring(start, end));
}

// Format an operand value for CASM display: lowercase, handle addr/imm notation
function _fmtOperand(val) {
  if (!val) return null;
  // addr16(XXXX) / addr32(XXX) → [XXXX] (memory address)
  const addrMatch = val.match(/^addr\d+\(([0-9a-fA-F]+)\)$/);
  if (addrMatch) return `[0x${addrMatch[1]}]`;
  // imm(XXXX) → 0xXXXX (immediate value)
  const immMatch = val.match(/^imm\(([0-9a-fA-F]+)\)$/);
  if (immMatch) return `0x${immMatch[1]}`;
  // Register names and DSR references — lowercase
  return val.toLowerCase();
}

// Build CASM-style operand string from an [IS OP] line.
// E.g., "Dest:R1,R0  Src0:R1,R0  Src1:[S1DS4]" → "r1,r0 = r1,r0, [s1ds4]"
function _buildCASMOperands(isAfter) {
  const dest = _isField(isAfter, "Dest");
  const src0 = _isField(isAfter, "Src0");
  const src1 = _isField(isAfter, "Src1");

  const fDest = _fmtOperand(dest);
  const fSrc0 = _fmtOperand(src0);
  const fSrc1 = _fmtOperand(src1);

  // JMP: destination is IP, show only the target
  if (dest === "IP" && fSrc1) return fSrc1;

  // Build source list
  const srcs = [];
  if (fSrc0) srcs.push(fSrc0);
  if (fSrc1) srcs.push(fSrc1);
  const srcStr = srcs.join(", ");

  // No destination (comparisons): just sources
  if (!fDest && srcStr) return srcStr;

  // Destination + sources: dst = src0, src1
  if (fDest && srcStr) return `${fDest} = ${srcStr}`;

  // Destination only (rare)
  if (fDest) return fDest;

  return null;
}

export class TraceParser {
  // Single-threaded parse: delegates to indexSegment for the full file, then compacts.
  static async index(file, onProgress) {
    const seg = await TraceParser.indexSegment(file, 0, file.size, true, onProgress);
    const { peStateIndex, stallLookup } = TraceParser._compactPEState(seg.peStateTemp);
    const waveletIndex = TraceParser._compactWavelets(seg.waveletTemp);
    const landingIndex = TraceParser._compactLandings(
      seg.tmpLandCycles, seg.tmpLandXs, seg.tmpLandYs, seg.tmpLandColors, seg.tmpLandDirs);
    const pcIndex = TraceParser._rebuildPCMaps(seg.pcMaps);
    return {
      dimX: seg.dimX, dimY: seg.dimY, landingIndex, peStateIndex, stallLookup,
      opLookup: seg.opLookup, predLookup: seg.predLookup,
      waveletIndex, hasWaveletData: seg.hasWaveletData,
      minCycle: seg.minCycle, maxCycle: seg.maxCycle,
      pcIndex,
    };
  }

  // Parse a byte range of the file, returning uncompacted partial results.
  // Used by parallel segment workers. Each segment runs independently with
  // its own dedup state; the coordinator merges results afterward.
  static async indexSegment(file, startByte, endByte, isFirst, onProgress) {
    let dimX = 0, dimY = 0;
    let minCycle = Infinity, maxCycle = -Infinity;

    const prevExState = new Map();
    const peStateTemp = new Map();
    const waveletTemp = new Map();
    const tmpLandCycles = [], tmpLandXs = [], tmpLandYs = [], tmpLandColors = [], tmpLandDirs = [];
    let hasWaveletData = false;

    const opIntern = new Map(); opIntern.set(null, 0); opIntern.set("???", 1);
    const predIntern = new Map(); predIntern.set(null, 0); predIntern.set("???", 1);
    let nextOpId = 2, nextPredId = 2;

    const pcMapTemp = new Map(); // key → Map<pc, { op, count, firstCycle, lastCycle, tasks }>

    function getPEEntry(key) {
      let e = peStateTemp.get(key);
      if (!e) { e = { cycles: [], busy: [], opIds: [], predIds: [], stall: [], stallReasons: [], pcs: [] }; peStateTemp.set(key, e); }
      return e;
    }
    function getPCMap(key) {
      let m = pcMapTemp.get(key);
      if (!m) { m = new Map(); pcMapTemp.set(key, m); }
      return m;
    }
    function internOp(op) {
      let id = opIntern.get(op);
      if (id === undefined) {
        if (nextOpId > 255) return 1; // overflow → "???" sentinel at id 1
        id = nextOpId++; opIntern.set(flatStr(op), id);
      }
      return id;
    }
    function internPred(pred) {
      let id = predIntern.get(pred);
      if (id === undefined) {
        if (nextPredId > 255) return 1; // overflow → "???" sentinel at id 1
        id = nextPredId++; predIntern.set(flatStr(pred), id);
      }
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
      pe.cycles.push(cycle); pe.busy.push(0); pe.opIds.push(0); pe.predIds.push(0); pe.pcs.push(0xFFFF);
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

      // Capture operand text from [IS OP] lines for the code view.
      // Transform into CASM-style assembly syntax.
      const isIdx = line.indexOf("[IS OP]");
      if (isIdx !== -1) {
        const isIdle = line.charCodeAt(isIdx + 8) === 73; // 'I' for IDLE
        if (!isIdle) {
          const isSp1 = line.indexOf(" ", 1);
          const isPIdx = isSp1 + 2;
          const isDotIdx = line.indexOf(".", isPIdx);
          const isColIdx = line.indexOf(":", isDotIdx);
          if (isDotIdx >= 0 && isColIdx >= 0) {
            const isX = +line.substring(isPIdx, isDotIdx);
            const isY = +line.substring(isDotIdx + 1, isColIdx);
            const isKey = `${isX},${isY}`;
            const isAfter = line.substring(isIdx + 8);
            const isPcEnd = isAfter.indexOf(":", 2);
            if (isPcEnd > 4) {
              const isPc = parseInt(isAfter.substring(4, isPcEnd), 16);
              const m = getPCMap(isKey);
              const existing = m.get(isPc);
              if (existing && existing.operands) { /* already captured */ }
              else {
                const operands = _buildCASMOperands(isAfter);
                if (operands) {
                  const flatOps = flatStr(operands);
                  if (existing) { existing.operands = flatOps; }
                  else { m.set(isPc, { op: null, pred: null, count: 0, firstCycle: Infinity, lastCycle: -Infinity, operands: flatOps }); }
                }
              }
            }
          }
        }
        return;
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
            pe.opIds.push(0); pe.predIds.push(0); pe.pcs.push(0xFFFF);
            pe.stall.push(0); pe.stallReasons.push(null);
          }
        } else {
          const after = line.substring(exIdx + 8);
          const om = after.match(opcodeRegex);
          const pred = om ? (om[1] || null) : null;
          const op = om ? om[2] : null;
          // Extract PC from "^ 0xHHHH: Tnn ..."
          const pcEnd = after.indexOf(":", 2);
          const pc = pcEnd > 4 ? parseInt(after.substring(4, pcEnd), 16) : 0;
          const exState = `1:${pc}:${pred || ""}:${op || ""}`;
          if (prevExState.get(key) !== exState) {
            prevExState.set(key, exState);
            const pe = getPEEntry(key);
            pe.cycles.push(+line.substring(1, sp1)); pe.busy.push(1);
            pe.opIds.push(internOp(op)); pe.predIds.push(internPred(pred)); pe.pcs.push(pc);
            pe.stall.push(0); pe.stallReasons.push(null);
          }
          // Accumulate PC stats for memory-ordered view.
          if (pcEnd > 4) {
            const cycle = +line.substring(1, sp1);
            const m = getPCMap(key);
            let rec = m.get(pc);
            if (!rec) {
              rec = { op: flatStr(op || "?"), pred: pred ? flatStr(pred) : null, count: 0, firstCycle: cycle, lastCycle: cycle, operands: null };
              m.set(pc, rec);
            } else if (!rec.op) {
              // IS OP created a placeholder — fill in op/pred from EX OP
              rec.op = flatStr(op || "?");
              rec.pred = pred ? flatStr(pred) : null;
            } else if (rec.op !== "????????" && op && rec.op !== flatStr(op)) {
              // Self-modifying code: different instruction at same address
              rec.op = "????????";
              rec.pred = null;
              rec.operands = "SELF-MODIFYING CODE";
            }
            rec.count++;
            if (cycle < rec.firstCycle) rec.firstCycle = cycle;
            rec.lastCycle = cycle;
          }
        }
        return;
      }

      const landing = parseLanding(line);
      if (landing) {
        tmpLandCycles.push(landing.cycle); tmpLandXs.push(landing.x);
        tmpLandYs.push(landing.y); tmpLandColors.push(landing.color);
        tmpLandDirs.push(landing.dirEncoded);
        return;
      }

      const wv = parseWavelet(line);
      if (wv) {
        hasWaveletData = true;
        let entry = waveletTemp.get(wv.ident);
        if (!entry) {
          entry = { ident: wv.ident, color: wv.color, ctrl: wv.ctrl, lf: wv.lf,
                    cycles: [], xs: [], ys: [], landings: [], departings: [], consumed: [] };
          waveletTemp.set(wv.ident, entry);
        }
        entry.cycles.push(wv.cycle); entry.xs.push(wv.x); entry.ys.push(wv.y);
        entry.landings.push(wv.landingEncoded); entry.departings.push(wv.departingEncoded);
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
    // Non-first segments skip their first line (it's a partial line that the
    // previous segment handles by reading past its endByte). BUT if the byte
    // just before startByte is '\n', the boundary fell on a line edge and the
    // first line is actually complete — don't skip it.
    let skipFirstLine = false;
    if (!isFirst) {
      const peek = new Uint8Array(await file.slice(startByte - 1, startByte).arrayBuffer());
      skipFirstLine = peek[0] !== 10; // 10 = '\n'
    }

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

      if (lastNL < 0) { carryover = bytes; continue; }

      const text = decoder.decode(bytes.subarray(0, lastNL + 1));
      carryover = lastNL + 1 < bytes.length ? bytes.slice(lastNL + 1) : new Uint8Array(0);

      const lines = text.split("\n");
      let startI = 0;
      if (skipFirstLine) { startI = 1; skipFirstLine = false; } // skip partial first line
      for (let i = startI; i < lines.length - 1; i++) processLine(lines[i]);

      if (onProgress) {
        onProgress((end - startByte) / segmentSize * 100);
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

    // Convert pcMap Sets to arrays for serialization (worker transfer)
    const pcMaps = [];
    for (const [key, m] of pcMapTemp) {
      const entries = [];
      for (const [pc, rec] of m) {
        entries.push([pc, rec.op, rec.pred, rec.count, rec.firstCycle, rec.lastCycle, rec.operands || null]);
      }
      pcMaps.push([key, entries]);
    }

    return {
      dimX, dimY, minCycle, maxCycle, hasWaveletData,
      peStateTemp: [...peStateTemp.entries()],
      waveletTemp: [...waveletTemp.entries()],
      tmpLandCycles, tmpLandXs, tmpLandYs, tmpLandColors, tmpLandDirs,
      opLookup, predLookup,
      pcMaps,
    };
  }

  // Merge partial results from N parallel segments into final compacted trace data.
  static mergeSegments(segments, onMergeProgress) {
    let dimX = 0, dimY = 0, minCycle = Infinity, maxCycle = -Infinity;
    let hasWaveletData = false;

    // 1. Scalars: take from first segment that has dims; merge cycle range
    for (const seg of segments) {
      if (seg.dimX > 0 && dimX === 0) { dimX = seg.dimX; dimY = seg.dimY; }
      if (seg.minCycle < minCycle) minCycle = seg.minCycle;
      if (seg.maxCycle > maxCycle) maxCycle = seg.maxCycle;
      if (seg.hasWaveletData) hasWaveletData = true;
    }

    // Phase weights calibrated from 27GB trace profiling:
    //   Merge PE: 0-25%, Compact PE: 25-35%, Merge wav: 35-50%,
    //   Compact wav: 50-85%, Merge+sort+compact landings: 85-100%
    const mp = onMergeProgress || (() => {});

    mp("Remapping opcodes\u2026", 0);
    // 2. Build global op/pred intern tables from all segments
    const globalOpIntern = new Map(); globalOpIntern.set(null, 0); globalOpIntern.set("???", 1);
    const globalPredIntern = new Map(); globalPredIntern.set(null, 0); globalPredIntern.set("???", 1);
    let gNextOp = 2, gNextPred = 2;
    // segOpRemap[segIdx][localId] = globalId
    const segOpRemap = [];
    const segPredRemap = [];
    for (const seg of segments) {
      const opMap = new Array(seg.opLookup.length);
      for (let id = 0; id < seg.opLookup.length; id++) {
        const s = seg.opLookup[id];
        let gid = globalOpIntern.get(s);
        if (gid === undefined) { gid = gNextOp > 255 ? 1 : gNextOp++; globalOpIntern.set(s, gid); }
        opMap[id] = gid;
      }
      segOpRemap.push(opMap);

      const predMap = new Array(seg.predLookup.length);
      for (let id = 0; id < seg.predLookup.length; id++) {
        const s = seg.predLookup[id];
        let gid = globalPredIntern.get(s);
        if (gid === undefined) { gid = gNextPred > 255 ? 1 : gNextPred++; globalPredIntern.set(s, gid); }
        predMap[id] = gid;
      }
      segPredRemap.push(predMap);
    }
    const opLookup = new Array(gNextOp);
    for (const [str, id] of globalOpIntern) opLookup[id] = str;
    const predLookup = new Array(gNextPred);
    for (const [str, id] of globalPredIntern) predLookup[id] = str;

    mp("Merging PE state\u2026", 0);
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

    const nSeg = segments.length;
    for (let si = 0; si < nSeg; si++) {
      mp("Merging PE state\u2026", (si / nSeg) * 25);
      const seg = segments[si];
      const opRemap = segOpRemap[si];
      const predRemap = segPredRemap[si];

      for (const [key, pe] of seg.peStateTemp) {
        if (!mergedPE.has(key)) {
          mergedPE.set(key, { cycles: [], busy: [], opIds: [], predIds: [], pcs: [], stall: [], stallReasons: [] });
        }
        const dst = mergedPE.get(key);

        for (let i = 0; i < pe.cycles.length; i++) {
          const gOpId = opRemap[pe.opIds[i]];
          const gPredId = predRemap[pe.predIds[i]];

          if (!pe.stall[i]) {
            // Non-stall event: dedup against globalPrevExState (same logic as single-threaded)
            const pcVal = pe.pcs ? pe.pcs[i] : 0xFFFF;
            const newState = pe.busy[i] ? `1:${pcVal}:${predLookup[gPredId] || ""}:${opLookup[gOpId] || ""}` : "0";
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
          dst.pcs.push(pe.pcs ? pe.pcs[i] : 0xFFFF);
          dst.stall.push(pe.stall[i]);
          dst.stallReasons.push(pe.stallReasons[i]);
        }
      }

      // Note: globalPrevExState is already correct from the event processing
      // loop above — it updates for every non-stall event that passes dedup.
      // The merge dedup maintains its own consistent state.
    }

    // Sort merged PE events by cycle. Segments are individually cycle-ordered,
    // but straddling-line handling can produce out-of-order events at boundaries.
    for (const [, dst] of mergedPE) {
      TraceParser._sortParallelByCycle(dst.cycles,
        dst.busy, dst.opIds, dst.predIds, dst.pcs, dst.stall, dst.stallReasons);
    }

    mp("Compacting PE state\u2026", 25);
    const { peStateIndex, stallLookup } = TraceParser._compactPEState(mergedPE, (f) => mp("Compacting PE state\u2026", 25 + f * 10));

    mp("Merging wavelets\u2026", 35);
    // 4. Merge wavelet hops: concatenate per-ident arrays across segments
    const mergedWav = new Map();
    for (let si = 0; si < nSeg; si++) {
      mp("Merging wavelets\u2026", 35 + (si / nSeg) * 15);
      const seg = segments[si];
      // Free PE state data from this segment to reduce peak memory
      seg.peStateTemp = null;
      for (const [ident, entry] of seg.waveletTemp) {
        if (!mergedWav.has(ident)) {
          mergedWav.set(ident, { ident: entry.ident, color: entry.color, ctrl: entry.ctrl, lf: entry.lf,
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

    // Sort merged wavelet hops by cycle (same boundary concern as PE state)
    for (const [, dst] of mergedWav) {
      TraceParser._sortParallelByCycle(dst.cycles,
        dst.xs, dst.ys, dst.landings, dst.departings, dst.consumed);
    }

    mp("Compacting wavelets\u2026", 50);
    const waveletIndex = TraceParser._compactWavelets(mergedWav, (f) => mp("Compacting wavelets\u2026", 50 + f * 35));

    mp("Merging landings\u2026", 85);
    // 5. Merge and compact landings
    const allLandCycles = [], allLandXs = [], allLandYs = [], allLandColors = [], allLandDirs = [];
    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si];
      seg.waveletTemp = null; // free wavelet data for earlier GC
      for (let i = 0; i < seg.tmpLandCycles.length; i++) {
        allLandCycles.push(seg.tmpLandCycles[i]);
        allLandXs.push(seg.tmpLandXs[i]);
        allLandYs.push(seg.tmpLandYs[i]);
        allLandColors.push(seg.tmpLandColors[i]);
        allLandDirs.push(seg.tmpLandDirs[i]);
      }
    }

    mp("Sorting landings\u2026", 88);
    const landingIndex = TraceParser._compactLandings(allLandCycles, allLandXs, allLandYs, allLandColors, allLandDirs);

    const pcIndex = TraceParser._mergePCMaps(segments);

    mp("Done", 100);

    return { dimX, dimY, landingIndex, peStateIndex, stallLookup, opLookup, predLookup,
             waveletIndex, hasWaveletData, minCycle, maxCycle, pcIndex };
  }

  // Sort parallel arrays by the cycles array. No-op if already sorted.
  static _sortParallelByCycle(cycles, ...arrays) {
    const n = cycles.length;
    if (n < 2) return;
    let sorted = true;
    for (let i = 1; i < n; i++) {
      if (cycles[i] < cycles[i - 1]) { sorted = false; break; }
    }
    if (sorted) return;
    const order = Array.from({ length: n }, (_, i) => i);
    order.sort((a, b) => cycles[a] - cycles[b]);
    // In-place cyclic permutation — O(1) extra space per array instead of O(n).
    const visited = new Uint8Array(n);
    const reorder = (arr) => {
      for (let i = 0; i < n; i++) {
        if (visited[i] || order[i] === i) continue;
        let j = i;
        let tmp = arr[i];
        while (order[j] !== i) {
          arr[j] = arr[order[j]];
          visited[j] = 1;
          j = order[j];
        }
        arr[j] = tmp;
        visited[j] = 1;
      }
      visited.fill(0);
    };
    reorder(cycles);
    for (const arr of arrays) reorder(arr);
  }

  // Rebuild pcMaps from serialized segment format back to Map<key, Map<pc, record>>
  static _rebuildPCMaps(pcMaps) {
    const index = new Map();
    for (const [key, entries] of pcMaps) {
      const m = new Map();
      for (const [pc, op, pred, count, firstCycle, lastCycle, operands] of entries) {
        m.set(pc, { op, pred, count, firstCycle, lastCycle, operands });
      }
      index.set(key, m);
    }
    return index;
  }

  // Merge pcMaps from multiple segments
  static _mergePCMaps(segments) {
    const merged = new Map();
    for (const seg of segments) {
      if (!seg.pcMaps) continue;
      for (const [key, entries] of seg.pcMaps) {
        let m = merged.get(key);
        if (!m) { m = new Map(); merged.set(key, m); }
        for (const [pc, op, pred, count, firstCycle, lastCycle, operands] of entries) {
          let rec = m.get(pc);
          if (!rec) {
            rec = { op, pred, count: 0, firstCycle: Infinity, lastCycle: -Infinity, operands };
            m.set(pc, rec);
          }
          if (!rec.op && op) { rec.op = op; rec.pred = pred; }
          if (!rec.operands && operands) rec.operands = operands;
          rec.count += count;
          if (firstCycle < rec.firstCycle) rec.firstCycle = firstCycle;
          if (lastCycle > rec.lastCycle) rec.lastCycle = lastCycle;
        }
      }
    }
    return merged;
  }

  // --- Shared compaction helpers (used by both index and mergeSegments) ---

  static _compactPEState(peStateMap, onProgress) {
    const peStateIndex = new Map();
    // Intern unique stall reason combinations into a shared lookup table.
    // ID 0 = no stall; IDs 1+ map to reason arrays.
    const stallIntern = new Map(); // canonicalKey → id
    const stallLookup = [null]; // id → [{reason, type}, ...]
    let nextStallId = 1;

    function internStallReasons(reasons) {
      if (!reasons) return 0;
      // Build a canonical key from sorted reason strings
      const key = reasons.map(r => `${r.type}:${r.reason}`).sort().join("|");
      let id = stallIntern.get(key);
      if (id !== undefined) return id;
      if (nextStallId > 65535) return 1; // overflow → first entry
      id = nextStallId++;
      stallIntern.set(key, id);
      stallLookup.push(reasons);
      return id;
    }

    const total = peStateMap.size ?? peStateMap.length;
    let idx = 0;
    for (const [key, pe] of peStateMap) {
      if (onProgress && idx % 200 === 0) onProgress(idx / total);
      idx++;
      const len = pe.cycles.length;
      // Replace stall (0/1 flag) with interned stall reason IDs in a Uint16Array
      const stallIds = new Uint16Array(len);
      for (let i = 0; i < len; i++) {
        if (pe.stall[i]) stallIds[i] = internStallReasons(pe.stallReasons[i]);
      }
      peStateIndex.set(key, {
        cycles: new Float64Array(pe.cycles),
        busy: new Uint8Array(pe.busy),
        opIds: new Uint8Array(pe.opIds),
        predIds: new Uint8Array(pe.predIds),
        pcs: new Uint16Array(pe.pcs),
        stall: stallIds,
        length: len,
      });
    }
    return { peStateIndex, stallLookup };
  }

  static _compactWavelets(waveletMap, onProgress) {
    const waveletIndex = new Map();
    const total = waveletMap.size ?? waveletMap.length;
    let idx = 0;
    for (const [ident, entry] of waveletMap) {
      if (onProgress && idx % 500 === 0) onProgress(idx / total);
      idx++;
      const len = entry.cycles.length;
      waveletIndex.set(ident, {
        ident: entry.ident, color: entry.color, ctrl: entry.ctrl, lf: entry.lf,
        hops: {
          cycles: new Float64Array(entry.cycles),
          xs: new Uint16Array(entry.xs),
          ys: new Uint16Array(entry.ys),
          landings: new Uint8Array(entry.landings),
          departings: new Uint8Array(entry.departings),
          consumed: new Uint8Array(entry.consumed),
          length: len,
        },
      });
    }
    return waveletIndex;
  }

  static _compactLandings(tmpCycles, tmpXs, tmpYs, tmpColors, tmpDirs) {
    const totalLandings = tmpCycles.length;
    if (totalLandings === 0) return null;

    const order = new Uint32Array(totalLandings);
    for (let i = 0; i < totalLandings; i++) order[i] = i;
    order.sort((a, b) => tmpCycles[a] - tmpCycles[b]);

    const lXs = new Uint16Array(totalLandings);
    const lYs = new Uint16Array(totalLandings);
    const lColors = new Uint8Array(totalLandings);
    const lDirs = new Uint8Array(totalLandings);
    const lCyclesFlat = new Float64Array(totalLandings);
    for (let i = 0; i < totalLandings; i++) {
      const j = order[i];
      lCyclesFlat[i] = tmpCycles[j];
      lXs[i] = tmpXs[j];
      lYs[i] = tmpYs[j];
      lColors[i] = tmpColors[j];
      lDirs[i] = tmpDirs[j];
    }

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
    offsets.push(totalLandings);

    return {
      cycles: new Float64Array(uniqueCycles),
      offsets: new Uint32Array(offsets),
      xs: lXs, ys: lYs, colors: lColors, dirs: lDirs,
      length: uniqueCycles.length, totalLandings,
    };
  }

  static findCycleIndexLE(cycles, length, cycle) {
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

  /**
   * Find the range of potentially-live wavelets at a given cycle.
   * Returns { lowerBound, upperBound } indices into waveletList, or null.
   * Uses two binary searches: upper bound on firstCycle, lower bound on prefMaxLastCycle.
   * The range may include some dead wavelets (filtered by the caller via lastCycle check).
   */
  /**
   * Sort a wavelet list by firstCycle and compute the prefix-max of lastCycle
   * for binary-search-based live-range queries. Returns { waveletList, wavPrefMaxLastCycle }.
   */
  /** Build a Uint8Array marking which opcode IDs are NOPs. */
  static buildNopLookup(opLookup) {
    const nops = new Uint8Array(opLookup.length);
    for (let i = 0; i < opLookup.length; i++) {
      const op = opLookup[i];
      if (op && (op === "NOP" || op.startsWith("NOP."))) nops[i] = 1;
    }
    return nops;
  }

  static prepareWaveletList(wavelets) {
    for (const wv of wavelets) {
      wv.firstCycle = wv.hops.cycles[0];
      wv.lastCycle = wv.hops.cycles[wv.hops.cycles.length - 1];
    }
    wavelets.sort((a, b) => a.firstCycle - b.firstCycle);
    const prefMax = new Float64Array(wavelets.length);
    let runMax = -Infinity;
    for (let i = 0; i < wavelets.length; i++) {
      runMax = Math.max(runMax, wavelets[i].lastCycle);
      prefMax[i] = runMax;
    }
    return { waveletList: wavelets, wavPrefMaxLastCycle: prefMax };
  }

  static findLiveWaveletRange(waveletList, prefMaxLastCycle, cycle) {
    if (!waveletList) return null;
    const wvLen = waveletList.length;

    // Upper bound: first index where firstCycle > cycle
    let lo = 0, hi = wvLen;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (waveletList[mid].firstCycle <= cycle) lo = mid + 1;
      else hi = mid;
    }
    const upperBound = lo;
    if (upperBound === 0) return null;

    // Lower bound: first index where prefMaxLastCycle >= cycle
    lo = 0; hi = upperBound;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (prefMaxLastCycle[mid] < cycle) lo = mid + 1;
      else hi = mid;
    }
    return { lowerBound: lo, upperBound };
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

  /**
   * Reconstruct a single PE's execution and stall state at a given cycle.
   * Returns { busy, opId, stallType, stallReason } or null if no events found.
   * The backward scan finds the most recent EX event and the most recent stall,
   * including same-cycle stall+exec coexistence.
   */
  static reconstructPEAtCycle(entry, opNopLookup, stallLookup, targetCycle) {
    const found = TraceParser.findCycleIndexLE(entry.cycles, entry.length, targetCycle);
    if (found < 0) return null;

    let exIdx = -1, stallIdx = -1;
    for (let i = found; i >= 0; i--) {
      if (!entry.stall[i]) { exIdx = i; break; }
      if (stallIdx < 0) stallIdx = i;
    }
    if (exIdx >= 0 && stallIdx < 0 && exIdx > 0 &&
        entry.stall[exIdx - 1] && entry.cycles[exIdx - 1] === entry.cycles[exIdx]) {
      stallIdx = exIdx - 1;
    }

    let busy = 0, opId = 0, isNop = false;
    if (exIdx >= 0) {
      opId = entry.opIds[exIdx];
      if (opNopLookup[opId]) { busy = 0; opId = 0; isNop = true; }
      else busy = entry.busy[exIdx];
    }

    let stallType = null, stallReason = null;
    // NOP takes first precedence as stall reason
    if (isNop) {
      stallType = "nop";
      stallReason = "NOP";
    } else if (stallIdx >= 0) {
      const reasons = stallLookup[entry.stall[stallIdx]];
      if (reasons && reasons.length > 0) {
        stallType = reasons[0].type;
        stallReason = reasons.length > 1
          ? reasons[0].reason + "\u2026"
          : reasons[0].reason;
      }
    }

    return { busy, opId, stallType, stallReason };
  }
}
