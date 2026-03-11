import {
  CELL_SIZE,
  PE_COLOR_IDLE, PE_COLOR_EXEC, PE_COLOR_FP_ARITH, PE_COLOR_INT_ARITH, PE_COLOR_CTRL, PE_COLOR_TASK, PE_COLOR_MEM_READ, PE_COLOR_MEM_WRITE,
  PE_STALL_TEXT_WAVELET, PE_STALL_TEXT_PIPE, PE_SELECT_COLOR,
  PE_TEXT_DEFAULT, PE_TEXT_DEFAULT_SUB, PE_TEXT_CTRL, PE_TEXT_CTRL_SUB, PE_TEXT_TASK, PE_TEXT_TASK_SUB,
  DEMO_PE_ON_DURATION, DEMO_PE_BRIGHTEN_DURATION, DEMO_PE_DIM_DURATION,
} from "./constants.js";

// Operation categories for PE color-coding:
//   "fp-arith"  = floating-point compute (green)
//   "int-arith" = integer/fixed-point compute (yellow-green)
//   "ctrl"      = control flow: comparisons, jumps (light yellow)
//   "task"      = task management: activate, block, yield (grey)
//   "mem-read"  = memory read: loads (steel blue)
//   "mem-write" = memory write: stores (warm orange)
//   undefined   = everything else: moves, conversions, bitwise, DSR config (blue)
const SYMBOLIC_OPS = {
  // FP32 arithmetic
  FADDS:  { symbol: "+", sub: "F32", cat: "fp-arith" },
  FADDE:  { symbol: "+", sub: "F32", cat: "fp-arith" },
  FMULS:  { symbol: "\u00d7", sub: "F32", cat: "fp-arith" },
  FSUBS:  { symbol: "\u2212", sub: "F32", cat: "fp-arith" },
  FMACS:  { symbol: "\u00d7+", sub: "F32", cat: "fp-arith" },
  FMSS:   { symbol: "\u00d7\u2212", sub: "F32", cat: "fp-arith" },
  FMSES:  { symbol: "\u00d7\u2212", sub: "F32", cat: "fp-arith" },
  FDPS:   { symbol: "\u22c5", sub: "F32", cat: "fp-arith" },
  FMOV32: { symbol: "MOV", sub: "F32" },
  FMOVS:  { symbol: "MOV", sub: "F32" },
  FSTDPAS:{ symbol: "ST", sub: "F32", cat: "mem-write" },
  FSTDPAE:{ symbol: "ST", sub: "F32", cat: "mem-write" },
  FSTDPAH:{ symbol: "ST", sub: "F16", cat: "mem-write" },
  FCPSS:  { symbol: "CPS", sub: "F32", cat: "fp-arith" },
  FCPXSS: { symbol: "\u2102", sub: "F32", cat: "fp-arith" },
  FABSS:  { symbol: "ABS", sub: "F32", cat: "fp-arith" },
  FNEGS:  { symbol: "\u2212", sub: "F32", cat: "fp-arith" },
  FMAXS:  { symbol: "MAX", sub: "F32", cat: "fp-arith" },
  FMINS:  { symbol: "MIN", sub: "F32", cat: "fp-arith" },
  FEQS:   { symbol: "=", sub: "F32", cat: "ctrl" },
  FEQUS:  { symbol: "=", sub: "F32", cat: "ctrl" },
  FLTS:   { symbol: "<", sub: "F32", cat: "ctrl" },
  FLTUS:  { symbol: "<", sub: "F32", cat: "ctrl" },
  FLTEQS: { symbol: "\u2264", sub: "F32", cat: "ctrl" },
  FLTEQUS:{ symbol: "\u2264", sub: "F32", cat: "ctrl" },
  FUNS:   { symbol: "NaN", sub: "F32", cat: "ctrl" },
  FMULE:  { symbol: "\u00d7", sub: "F32", cat: "fp-arith" },
  FSUBE:  { symbol: "\u2212", sub: "F32", cat: "fp-arith" },
  FMACE:  { symbol: "\u00d7+", sub: "F32", cat: "fp-arith" },
  FMACES: { symbol: "\u00d7+", sub: "F32", cat: "fp-arith" },
  FMSE:   { symbol: "\u00d7\u2212", sub: "F32", cat: "fp-arith" },
  FDPE:   { symbol: "\u22c5", sub: "F32", cat: "fp-arith" },
  FSQRS:  { symbol: "\u00d7", sub: "F32", cat: "fp-arith" },
  FSQRE:  { symbol: "\u00d7", sub: "F32", cat: "fp-arith" },
  FSSQRS: { symbol: "\u22c5", sub: "F32", cat: "fp-arith" },
  FSSQRE: { symbol: "\u22c5", sub: "F32", cat: "fp-arith" },
  FSCALES:{ symbol: "SCALE", sub: "F32", cat: "fp-arith" },
  FNORMS: { symbol: "NORM", sub: "F32", cat: "fp-arith" },
  FDIVSS: { symbol: "\u00f7", sub: "F32", cat: "fp-arith" },
  FADDHS: { symbol: "+", sub: "F16\u2192F32", cat: "fp-arith" },
  FADDSH: { symbol: "+", sub: "F32\u2192F16", cat: "fp-arith" },
  // FP16 arithmetic
  FADDH:  { symbol: "+", sub: "F16", cat: "fp-arith" },
  FMULH:  { symbol: "\u00d7", sub: "F16", cat: "fp-arith" },
  FSUBH:  { symbol: "\u2212", sub: "F16", cat: "fp-arith" },
  FMACH:  { symbol: "\u00d7+", sub: "F16", cat: "fp-arith" },
  FMACHS: { symbol: "\u00d7+", sub: "F16", cat: "fp-arith" },
  FMSH:   { symbol: "\u00d7\u2212", sub: "F16", cat: "fp-arith" },
  FMSHS:  { symbol: "\u00d7\u2212", sub: "F16", cat: "fp-arith" },
  FDPH:   { symbol: "\u22c5", sub: "F16", cat: "fp-arith" },
  FSQRH:  { symbol: "\u00d7", sub: "F16", cat: "fp-arith" },
  FSSQRH: { symbol: "\u22c5", sub: "F16", cat: "fp-arith" },
  FSCALEH:{ symbol: "SCALE", sub: "F16", cat: "fp-arith" },
  FNORMH: { symbol: "NORM", sub: "F16", cat: "fp-arith" },
  FDIVSH: { symbol: "\u00f7", sub: "F16", cat: "fp-arith" },
  FMOV16: { symbol: "MOV", sub: "F16" },
  FMOVH:  { symbol: "MOV", sub: "F16" },
  FCPSH:  { symbol: "CPS", sub: "F16", cat: "fp-arith" },
  FCPXSH: { symbol: "\u2102", sub: "F16", cat: "fp-arith" },
  FABSH:  { symbol: "ABS", sub: "F16", cat: "fp-arith" },
  FNEGH:  { symbol: "\u2212", sub: "F16", cat: "fp-arith" },
  FMAXH:  { symbol: "MAX", sub: "F16", cat: "fp-arith" },
  FMINH:  { symbol: "MIN", sub: "F16", cat: "fp-arith" },
  FEQH:   { symbol: "=", sub: "F16", cat: "ctrl" },
  FEQUH:  { symbol: "=", sub: "F16", cat: "ctrl" },
  FLTH:   { symbol: "<", sub: "F16", cat: "ctrl" },
  FLTUH:  { symbol: "<", sub: "F16", cat: "ctrl" },
  FLTEQH: { symbol: "\u2264", sub: "F16", cat: "ctrl" },
  FLTEQUH:{ symbol: "\u2264", sub: "F16", cat: "ctrl" },
  FUNH:   { symbol: "NaN", sub: "F16", cat: "ctrl" },
  // FP/int/fixed-point conversion
  FH2S:   { symbol: "CVT", sub: "F16\u2192F32" },
  FS2H:   { symbol: "CVT", sub: "F32\u2192F16" },
  XP162FH:{ symbol: "CVT", sub: "I16\u2192F16" },
  XP162FS:{ symbol: "CVT", sub: "I16\u2192F32" },
  XPX162FH:{ symbol: "CVT", sub: "X16\u2192F16" },
  XPX162FS:{ symbol: "CVT", sub: "X16\u2192F32" },
  FH2XP16:{ symbol: "CVT", sub: "F16\u2192I16" },
  FS2XP16:{ symbol: "CVT", sub: "F32\u2192I16" },
  FH2XPX16:{ symbol: "CVT", sub: "F16\u2192X16" },
  FS2XPX16:{ symbol: "CVT", sub: "F32\u2192X16" },
  XP322FS:{ symbol: "CVT", sub: "I32\u2192F32" },
  FS2XP32:{ symbol: "CVT", sub: "F32\u2192I32" },
  XP162XP8:{ symbol: "CVT", sub: "X16\u2192X8" },
  XP162XP8D:{ symbol: "CVT", sub: "X16\u2192X8" },
  // INT16 arithmetic
  ADD16:  { symbol: "+", sub: "I16", cat: "int-arith" },
  SUB16:  { symbol: "\u2212", sub: "I16", cat: "int-arith" },
  NEG16:  { symbol: "\u2212", sub: "I16", cat: "int-arith" },
  IMUL16: { symbol: "\u00d7", sub: "I16", cat: "int-arith" },
  IMUL11: { symbol: "\u00d7", sub: "I11", cat: "int-arith" },
  IMUL16UD:{ symbol: "\u00d7", sub: "I16\u2192I32", cat: "int-arith" },
  IMUL16SD:{ symbol: "\u00d7", sub: "I16\u2192I32", cat: "int-arith" },
  IADD16: { symbol: "+", sub: "I16\u2192I32", cat: "int-arith" },
  LDA:    { symbol: "+", sub: "I16", cat: "int-arith" },
  SLL16:  { symbol: "\u226a", sub: "I16" },
  SLR16:  { symbol: "\u226b", sub: "I16" },
  SAR16:  { symbol: "\u226b", sub: "I16" },
  XOR16:  { symbol: "XOR", sub: "I16" },
  AND16:  { symbol: "AND", sub: "I16" },
  ANDN16: { symbol: "ANDN", sub: "I16" },
  OR16:   { symbol: "OR", sub: "I16" },
  NOT16:  { symbol: "NOT", sub: "I16" },
  IMOV16: { symbol: "MOV", sub: "I16" },
  EQ16:   { symbol: "=", sub: "I16", cat: "ctrl" },
  LT16:   { symbol: "<", sub: "I16", cat: "ctrl" },
  LTE16:  { symbol: "\u2264", sub: "I16", cat: "ctrl" },
  ADDC16: { symbol: "+", sub: "I16", cat: "int-arith" },
  ADDSS16:{ symbol: "+", sub: "I16", cat: "int-arith" },
  ADDSU16:{ symbol: "+", sub: "I16", cat: "int-arith" },
  SUBC16: { symbol: "\u2212", sub: "I16", cat: "int-arith" },
  SUBSS16:{ symbol: "\u2212", sub: "I16", cat: "int-arith" },
  SUBSU16:{ symbol: "\u2212", sub: "I16", cat: "int-arith" },
  LTU16:  { symbol: "<", sub: "I16", cat: "ctrl" },
  LTEU16: { symbol: "\u2264", sub: "I16", cat: "ctrl" },
  // INT32 arithmetic
  ADD32:  { symbol: "+", sub: "I32", cat: "int-arith" },
  SUB32:  { symbol: "\u2212", sub: "I32", cat: "int-arith" },
  NEG32:  { symbol: "\u2212", sub: "I32", cat: "int-arith" },
  XOR32:  { symbol: "XOR", sub: "I32" },
  AND32:  { symbol: "AND", sub: "I32" },
  ANDN32: { symbol: "ANDN", sub: "I32" },
  OR32:   { symbol: "OR", sub: "I32" },
  NOT32:  { symbol: "NOT", sub: "I32" },
  IMOV32: { symbol: "MOV", sub: "I32" },
  EQ32:   { symbol: "=", sub: "I32", cat: "ctrl" },
  LT32:   { symbol: "<", sub: "I32", cat: "ctrl" },
  LTE32:  { symbol: "\u2264", sub: "I32", cat: "ctrl" },
  ADDC32: { symbol: "+", sub: "I32", cat: "int-arith" },
  SUBC32: { symbol: "\u2212", sub: "I32", cat: "int-arith" },
  LTU32:  { symbol: "<", sub: "I32", cat: "ctrl" },
  LTEU32: { symbol: "\u2264", sub: "I32", cat: "ctrl" },
  // 8-bit fixed-point arithmetic
  XADD8:  { symbol: "+", sub: "X8", cat: "int-arith" },
  XSUB8:  { symbol: "\u2212", sub: "X8", cat: "int-arith" },
  XMUL8:  { symbol: "\u00d7", sub: "X8", cat: "int-arith" },
  XDP8:   { symbol: "\u22c5", sub: "X8", cat: "int-arith" },
  XSQR8:  { symbol: "\u00d7", sub: "X8", cat: "int-arith" },
  XSSQR8: { symbol: "\u22c5", sub: "X8", cat: "int-arith" },
  XADD816:{ symbol: "+", sub: "X8\u2192X16", cat: "int-arith" },
  // Bit counting
  CLZ16:  { symbol: "CLZ", cat: "int-arith" },
  CTZ16:  { symbol: "CTZ", cat: "int-arith" },
  POPCNT16:{ symbol: "POPCNT", cat: "int-arith" },
  SXTD16: { symbol: "SXTD", sub: "I16\u2192I32" },
  // Move (untyped)
  MOV16:  { symbol: "MOV", sub: "16" },
  MOV32:  { symbol: "MOV", sub: "32" },
  MOVO16: { symbol: "MOV", sub: "16" },
  MOVO32: { symbol: "MOV", sub: "32" },
  UMOV16: { symbol: "MOV", sub: "16" },
  UMOV32: { symbol: "MOV", sub: "32" },
  JMP:    { symbol: "JMP", cat: "ctrl" },
  LDCFG32:{ symbol: "LD", sub: "CFG", cat: "mem-read" },
  LD16:   { symbol: "LD", sub: "16", cat: "mem-read" },
  LD16RP: { symbol: "LD", sub: "32", cat: "mem-read" },
  LD32:   { symbol: "LD", sub: "32", cat: "mem-read" },
  LD16RQ: { symbol: "LD", sub: "64", cat: "mem-read" },
  LD64:   { symbol: "LD", sub: "64", cat: "mem-read" },
  LDR16P: { symbol: "LD", sub: "32", cat: "mem-read" },
  LDDDS:  { symbol: "DSR", sub: "LD D", cat: "mem-read" },
  LDDWDS: { symbol: "DSR", sub: "LD D", cat: "mem-read" },
  LDS0DS: { symbol: "DSR", sub: "LD S0", cat: "mem-read" },
  LDS0WDS:{ symbol: "DSR", sub: "LD S0", cat: "mem-read" },
  LDS1DS: { symbol: "DSR", sub: "LD S1", cat: "mem-read" },
  LDS1WDS:{ symbol: "DSR", sub: "LD S1", cat: "mem-read" },
  LDSR:   { symbol: "LD", sub: "SR", cat: "mem-read" },
  LDXDS:  { symbol: "DSR", sub: "LD X", cat: "mem-read" },
  SETDDA: { symbol: "DSR", sub: "SET D.A" },
  SETDS0A:{ symbol: "DSR", sub: "SET S0.A" },
  SETDS1A:{ symbol: "DSR", sub: "SET S1.A" },
  SETDDL: { symbol: "DSR", sub: "SET D.L" },
  SETDS0L:{ symbol: "DSR", sub: "SET S0.L" },
  SETDS1L:{ symbol: "DSR", sub: "SET S1.L" },
  STDDS:  { symbol: "DSR", sub: "ST D", cat: "mem-write" },
  STDWDS: { symbol: "DSR", sub: "ST D", cat: "mem-write" },
  STS0DS: { symbol: "DSR", sub: "ST S0", cat: "mem-write" },
  STS0WDS:{ symbol: "DSR", sub: "ST S0", cat: "mem-write" },
  STS1DS: { symbol: "DSR", sub: "ST S1", cat: "mem-write" },
  STS1WDS:{ symbol: "DSR", sub: "ST S1", cat: "mem-write" },
  STXDS:  { symbol: "DSR", sub: "ST X", cat: "mem-write" },
  XP16STDPA:{ symbol: "ST", sub: "X16", cat: "mem-write" },
  CPDDS:  { symbol: "DSR", sub: "CP D" },
  CPSDS:  { symbol: "DSR", sub: "CP S" },
  CPDDSA: { symbol: "DSR", sub: "CP D.A" },
  CPSDSA: { symbol: "DSR", sub: "CP S.A" },
  SETJT:  { symbol: "MOV", sub: "JT" },
  STCFG32:{ symbol: "ST", sub: "CFG", cat: "mem-write" },
  ST16:   { symbol: "ST", sub: "16", cat: "mem-write" },
  ST32:   { symbol: "ST", sub: "32", cat: "mem-write" },
  // Task management
  ACTVT:  { symbol: "ACTVT", cat: "task" },
  BLK:    { symbol: "BLK", cat: "task" },
  UBLK:   { symbol: "UBLK", cat: "task" },
  YIELD:  { symbol: "YIELD", cat: "task" },
  YIELDH: { symbol: "YIELD", sub: "HIGH", cat: "task" },
  JMPT:   { symbol: "JMPT", cat: "task" },
  IQFLUSH:{ symbol: "IQ", sub: "FLUSH", cat: "task" },
  OQFLUSH:{ symbol: "OQ", sub: "FLUSH", cat: "task" },
  // Queue test/query
  QEMPTY: { symbol: "Q?", sub: "EMPTY", cat: "ctrl" },
  QFULL:  { symbol: "Q?", sub: "FULL", cat: "ctrl" },
  QDEPTH: { symbol: "Q#", sub: "DEPTH" },
  QAVAIL: { symbol: "Q#", sub: "AVAIL" },
  DFILT:  { symbol: "FILT" },
  DFLITEQ:{ symbol: "FILT", sub: "EQ", cat: "task" },
  DFILTNE:{ symbol: "FILT", sub: "NE", cat: "task" },
  // Data manipulation
  SELECT16:{ symbol: "SEL", sub: "I16" },
  SELECT32:{ symbol: "SEL", sub: "I32" },
  DEP16:  { symbol: "DEP", sub: "I16" },
  EXTR16: { symbol: "EXTR", sub: "I16" },
  MERGE:  { symbol: "MERGE", sub: "I16\u2192I32" },
  MERGEF: { symbol: "MERGE", sub: "I16\u2192I32" },
  MERGE64:{ symbol: "MERGE", sub: "I32\u2192I64" },
  MERGEF64:{ symbol: "MERGE", sub: "I32\u2192I64" },
  WPACK:  { symbol: "CVT", sub: "W\u219216" },
  WUNPACK:{ symbol: "CVT", sub: "16\u2192W" },
  // Integer misc
  ISCL11_32:{ symbol: "\u00d7", sub: "I11\u2192I32", cat: "int-arith" },
  MOVRI:  { symbol: "MOV", sub: "IMM" },
  ADDSP:  { symbol: "ADDSP" },
  // System/control
  BRK:    { symbol: "BRK", cat: "ctrl" },
  JV:     { symbol: "JV", cat: "ctrl" },
  PFCTL:  { symbol: "PF" },
  STPRNG: { symbol: "PRNG" },
};

// Category → PE tile fill color (pre-computed to avoid per-frame branching)
const CAT_FILL_COLOR = {
  "fp-arith": PE_COLOR_FP_ARITH,
  "int-arith": PE_COLOR_INT_ARITH,
  "ctrl": PE_COLOR_CTRL,
  "task": PE_COLOR_TASK,
  "mem-read": PE_COLOR_MEM_READ,
  "mem-write": PE_COLOR_MEM_WRITE,
};

// Set of disabled categories — entries with a disabled cat use PE_COLOR_EXEC.
const _disabledCats = new Set();

/** Update fill/text/sub colors on a single SYMBOLIC_OPS entry based on _disabledCats. */
function _updateEntryColors(entry) {
  const active = entry.cat && !_disabledCats.has(entry.cat);
  entry.fillColor = active ? (CAT_FILL_COLOR[entry.cat] || PE_COLOR_EXEC) : PE_COLOR_EXEC;
  if (active) {
    entry.textColor = entry.cat === "task" ? PE_TEXT_TASK
      : entry.cat === "ctrl" ? PE_TEXT_CTRL : PE_TEXT_DEFAULT;
    entry.subColor = entry.cat === "task" ? PE_TEXT_TASK_SUB
      : entry.cat === "ctrl" ? PE_TEXT_CTRL_SUB : PE_TEXT_DEFAULT_SUB;
  } else {
    entry.textColor = PE_TEXT_DEFAULT;
    entry.subColor = PE_TEXT_DEFAULT_SUB;
  }
}

// Pre-compute derived properties on each SYMBOLIC_OPS entry at module init.
// _disabledCats is empty at this point, so _updateEntryColors produces the
// same active-path values as the original inline logic.
for (const entry of Object.values(SYMBOLIC_OPS)) {
  entry.isText = /^[A-Z\u2102]/.test(entry.symbol);
  _updateEntryColors(entry);
}

// Font constants derived from CELL_SIZE — identical for every PE, so computed
// once at module level instead of per-instance.
const FONT_SIZE_MAX_LABEL = CELL_SIZE * 0.25;
const FONT_SIZE_SCALE_LABEL = CELL_SIZE * 1.2;
const FONT_TEXT_MAX = CELL_SIZE * 0.32;   // max font size for text symbols
const FONT_TEXT_FIT = CELL_SIZE * 1.15;   // shrink factor: fontSize = FIT / length
const FONT_BOLD_MATH = `bold ${CELL_SIZE * 0.55}px sans-serif`;
const FONT_SUB = `${CELL_SIZE * 0.2}px sans-serif`;

// Pre-rendered op symbol bitmaps — eliminates per-PE font changes and fillText
// during draw(). Rendered at full device resolution (CELL_SIZE × scale) so text
// is crisp at the actual display size. Cache is invalidated when scale changes.
let _opBitmapCache = new Map();
let _opBitmapScale = 0;

/** Called from app.js after resizeCanvas to update the rendering scale. */
export function setOpBitmapScale(scale) {
  if (scale === _opBitmapScale) return;
  _opBitmapScale = scale;
  _opBitmapCache.clear();
}

/** Toggle a category's coloring on/off. */
export function setCatEnabled(cat, enabled) {
  if (enabled) _disabledCats.delete(cat);
  else _disabledCats.add(cat);
  // Recompute fillColor and text colors on every entry
  for (const entry of Object.values(SYMBOLIC_OPS)) {
    _updateEntryColors(entry);
  }
  // Clear bitmap cache so text is re-rendered with updated colors
  _opBitmapCache.clear();
}

function _getOpBitmap(entry) {
  const cached = _opBitmapCache.get(entry);
  if (cached) return cached;

  // Render at device pixels: CELL_SIZE * scale, where scale = canvasScale * dpr.
  // draw() uses drawImage(bm, x, y, CELL_SIZE, CELL_SIZE) in logical coords,
  // and the canvas transform maps that to device pixels — so the bitmap must
  // contain CELL_SIZE * scale device pixels to be 1:1 at the final resolution.
  const s = _opBitmapScale || 1;
  const pxSize = Math.max(1, Math.round(CELL_SIZE * s));
  const c = new OffscreenCanvas(pxSize, pxSize);
  const cx = c.getContext("2d");
  cx.scale(s, s);

  const half = CELL_SIZE / 2;

  cx.fillStyle = entry.textColor;
  cx.textAlign = "center";
  cx.font = entry.isText
    ? `bold ${Math.min(FONT_TEXT_MAX, FONT_TEXT_FIT / entry.symbol.length)}px sans-serif`
    : FONT_BOLD_MATH;

  if (entry.sub) {
    cx.textBaseline = "alphabetic";
    cx.fillText(entry.symbol, half, half + CELL_SIZE * 0.05);
    cx.font = FONT_SUB;
    cx.fillStyle = entry.subColor;
    cx.textBaseline = "top";
    cx.fillText(entry.sub, half, half + CELL_SIZE * 0.1);
  } else {
    cx.textBaseline = "middle";
    cx.fillText(entry.symbol, half, half);
  }

  _opBitmapCache.set(entry, c);
  return c;
}

// Build a pre-computed lookup table from interned opcode IDs to SYMBOLIC_OPS entries.
// Called once at load time so that setBusy/draw never need to split strings or
// hash-lookup SYMBOLIC_OPS.
export function buildOpEntryLookup(opLookup) {
  const entries = new Array(opLookup.length);
  const nops = new Uint8Array(opLookup.length);
  for (let i = 0; i < opLookup.length; i++) {
    const op = opLookup[i];
    if (op) {
      if (op === "NOP" || op.startsWith("NOP.")) {
        entries[i] = null;
        nops[i] = 1;
      } else {
        const dotIdx = op.indexOf(".");
        const baseOp = dotIdx >= 0 ? op.substring(0, dotIdx) : op;
        entries[i] = SYMBOLIC_OPS[baseOp] || null;
      }
    } else {
      entries[i] = null;
    }
  }
  return { entries, nops };
}

export class PE {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    // Pre-computed layout constants (never change after construction)
    this.cx = x + CELL_SIZE / 2;
    this.cy = y + CELL_SIZE / 2;
    this.brightness = 0;
    this.targetBrightness = 0;
    this.transitionStartTime = 0;
    this.transitionDuration = 0;
    this.startBrightness = 0;
    this.activationTime = 0;
    this.active = false;
    this.op = null;
    this.opEntry = null;
    this.selected = false;
    // Execution/stall model:
    // The Schrodinger pipeline has 11 stages. A stall at one stage (e.g.,
    // issue waiting for a DSR) does NOT prevent a different instruction from
    // executing at the EX stage simultaneously. So a PE can have both `op`
    // (from the EX stage) and `stall` (from an earlier stage) set at the
    // same cycle. When both are set, the executing op takes visual priority:
    // draw() renders the op symbol in blue. Stall coloring and stall reason
    // labels only appear when the PE is stalled with nothing executing
    // (`!this.op`), which is the more performance-critical case to highlight.
    this.stall = null; // null, "wavelet", or "pipeline"
    this.stallReason = null; // compact label: "C6", "A0", "R3", "MEM", "S1DS0"
    this.fillColor = PE_COLOR_IDLE;
  }

  setBusy(busy, op, opEntry) {
    this.op = op || null;
    this.opEntry = opEntry || null;
    this.stall = null;
    this.stallReason = null;
    this.fillColor = this.opEntry ? this.opEntry.fillColor
      : (busy ? PE_COLOR_EXEC : PE_COLOR_IDLE);
  }

  activate(now) {
    if (now === undefined) now = performance.now();
    this.active = true;
    this.activationTime = now;
    this.startBrightness = this.brightness;
    this.targetBrightness = 1;
    this.transitionStartTime = now;
    this.transitionDuration = DEMO_PE_BRIGHTEN_DURATION;
  }

  update(now) {
    if (this.active && now - this.activationTime > DEMO_PE_ON_DURATION) {
      this.active = false;
      this.startBrightness = this.brightness;
      this.targetBrightness = 0;
      this.transitionStartTime = now;
      this.transitionDuration = DEMO_PE_DIM_DURATION;
    }

    if (this.transitionDuration > 0) {
      const elapsed = now - this.transitionStartTime;
      const progress = Math.min(elapsed / this.transitionDuration, 1);
      this.brightness =
        this.startBrightness +
        (this.targetBrightness - this.startBrightness) * progress;
      if (progress >= 1) {
        this.brightness = this.targetBrightness;
        this.transitionDuration = 0;
      }
      // Update fill color to reflect brightness change (demo animation)
      if (!this.opEntry && !this.stall) this.fillColor = this.brightness > 0.5 ? PE_COLOR_EXEC : PE_COLOR_IDLE;
    }
  }

  draw(ctx) {
    ctx.fillStyle = this.fillColor;
    ctx.fillRect(this.x, this.y, CELL_SIZE, CELL_SIZE);

    if (this.selected) {
      ctx.strokeStyle = PE_SELECT_COLOR;
      ctx.lineWidth = 2;
      ctx.strokeRect(this.x, this.y, CELL_SIZE, CELL_SIZE);
    }

    if (!this.op && this.stallReason) {
      const fontSize = Math.min(FONT_SIZE_MAX_LABEL, FONT_SIZE_SCALE_LABEL / Math.max(1, this.stallReason.length));
      ctx.font = `${fontSize}px monospace`;
      ctx.fillStyle = this.stall === "wavelet" ? PE_STALL_TEXT_WAVELET : PE_STALL_TEXT_PIPE;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(this.stallReason, this.cx, this.cy);
      return;
    }

    if (!this.op) return;

    const entry = this.opEntry;
    if (entry) {
      ctx.drawImage(_getOpBitmap(entry), this.x, this.y, CELL_SIZE, CELL_SIZE);
    } else {
      const fontSize = Math.min(FONT_SIZE_MAX_LABEL, FONT_SIZE_SCALE_LABEL / Math.max(1, this.op.length));
      ctx.font = `${fontSize}px sans-serif`;
      ctx.fillStyle = PE_TEXT_DEFAULT_SUB;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(this.op, this.cx, this.cy);
    }
  }
}
