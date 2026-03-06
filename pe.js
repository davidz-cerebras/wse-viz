import { PE_ON_DURATION, PE_BRIGHTEN_DURATION, PE_DIM_DURATION, PE_BRIGHTNESS_THRESHOLD } from "./constants.js";

const SYMBOLIC_OPS = {
  // FP32 arithmetic
  FADDS:  { symbol: "+", sub: "F32" },
  FADDE:  { symbol: "+", sub: "F32" },
  FMULS:  { symbol: "\u00d7", sub: "F32" },
  FSUBS:  { symbol: "\u2212", sub: "F32" },
  FMACS:  { symbol: "\u00d7+", sub: "F32" },
  FMSS:   { symbol: "\u00d7\u2212", sub: "F32" },
  FMSES:  { symbol: "\u00d7\u2212", sub: "F32" },
  FDPS:   { symbol: "\u22c5", sub: "F32" },
  FMOV32: { symbol: "MOV", sub: "F32" },
  FMOVS:  { symbol: "MOV", sub: "F32" },
  FSTDPAS:{ symbol: "ST", sub: "F32" },
  FSTDPAE:{ symbol: "ST", sub: "F32" },
  FSTDPAH:{ symbol: "ST", sub: "F16" },
  FABSS:  { symbol: "ABS", sub: "F32" },
  FNEGS:  { symbol: "\u2212", sub: "F32" },
  FMAXS:  { symbol: "MAX", sub: "F32" },
  FMINS:  { symbol: "MIN", sub: "F32" },
  FEQS:   { symbol: "=", sub: "F32" },
  FEQUS:  { symbol: "=", sub: "F32" },
  FLTS:   { symbol: "<", sub: "F32" },
  FLTUS:  { symbol: "<", sub: "F32" },
  FLTEQS: { symbol: "\u2264", sub: "F32" },
  FLTEQUS:{ symbol: "\u2264", sub: "F32" },
  FMULE:  { symbol: "\u00d7", sub: "F32" },
  FSUBE:  { symbol: "\u2212", sub: "F32" },
  FMACE:  { symbol: "\u00d7+", sub: "F32" },
  FMACES: { symbol: "\u00d7+", sub: "F32" },
  FMSE:   { symbol: "\u00d7\u2212", sub: "F32" },
  FDPE:   { symbol: "\u22c5", sub: "F32" },
  // FP16 arithmetic
  FADDH:  { symbol: "+", sub: "F16" },
  FMULH:  { symbol: "\u00d7", sub: "F16" },
  FSUBH:  { symbol: "\u2212", sub: "F16" },
  FMACH:  { symbol: "\u00d7+", sub: "F16" },
  FMACHS: { symbol: "\u00d7+", sub: "F16" },
  FMSH:   { symbol: "\u00d7\u2212", sub: "F16" },
  FMSHS:  { symbol: "\u00d7\u2212", sub: "F16" },
  FDPH:   { symbol: "\u22c5", sub: "F16" },
  FMOV16: { symbol: "MOV", sub: "F16" },
  FMOVH:  { symbol: "MOV", sub: "F16" },
  FABSH:  { symbol: "ABS", sub: "F16" },
  FNEGH:  { symbol: "\u2212", sub: "F16" },
  FMAXH:  { symbol: "MAX", sub: "F16" },
  FMINH:  { symbol: "MIN", sub: "F16" },
  FEQH:   { symbol: "=", sub: "F16" },
  FEQUH:  { symbol: "=", sub: "F16" },
  FLTH:   { symbol: "<", sub: "F16" },
  FLTUH:  { symbol: "<", sub: "F16" },
  FLTEQH: { symbol: "\u2264", sub: "F16" },
  FLTEQUH:{ symbol: "\u2264", sub: "F16" },
  // INT16 arithmetic
  ADD16:  { symbol: "+", sub: "I16" },
  SUB16:  { symbol: "\u2212", sub: "I16" },
  NEG16:  { symbol: "\u2212", sub: "I16" },
  IMUL16: { symbol: "\u00d7", sub: "I16" },
  SLL16:  { symbol: "\u00ab", sub: "I16" },
  SLR16:  { symbol: "\u00bb", sub: "I16" },
  SAR16:  { symbol: "\u00bb", sub: "I16" },
  AND16:  { symbol: "&", sub: "I16" },
  ANDN16: { symbol: "&~", sub: "I16" },
  OR16:   { symbol: "|", sub: "I16" },
  NOT16:  { symbol: "~", sub: "I16" },
  IMOV16: { symbol: "MOV", sub: "I16" },
  EQ16:   { symbol: "=", sub: "I16" },
  LT16:   { symbol: "<", sub: "I16" },
  LTE16:  { symbol: "\u2264", sub: "I16" },
  ADDC16: { symbol: "+", sub: "I16" },
  ADDSS16:{ symbol: "+", sub: "I16" },
  ADDSU16:{ symbol: "+", sub: "I16" },
  SUBC16: { symbol: "\u2212", sub: "I16" },
  SUBSS16:{ symbol: "\u2212", sub: "I16" },
  SUBSU16:{ symbol: "\u2212", sub: "I16" },
  LTU16:  { symbol: "<", sub: "I16" },
  LTEU16: { symbol: "\u2264", sub: "I16" },
  // INT32 arithmetic
  ADD32:  { symbol: "+", sub: "I32" },
  SUB32:  { symbol: "\u2212", sub: "I32" },
  NEG32:  { symbol: "\u2212", sub: "I32" },
  AND32:  { symbol: "&", sub: "I32" },
  ANDN32: { symbol: "&~", sub: "I32" },
  OR32:   { symbol: "|", sub: "I32" },
  NOT32:  { symbol: "~", sub: "I32" },
  IMOV32: { symbol: "MOV", sub: "I32" },
  EQ32:   { symbol: "=", sub: "I32" },
  LT32:   { symbol: "<", sub: "I32" },
  LTE32:  { symbol: "\u2264", sub: "I32" },
  ADDC32: { symbol: "+", sub: "I32" },
  SUBC32: { symbol: "\u2212", sub: "I32" },
  LTU32:  { symbol: "<", sub: "I32" },
  LTEU32: { symbol: "\u2264", sub: "I32" },
  // Bit counting
  CLZ:    { symbol: "CLZ" },
  CTZ:    { symbol: "CTZ" },
  // Move (untyped)
  MOV16:  { symbol: "MOV", sub: "16" },
  MOV32:  { symbol: "MOV", sub: "32" },
  JMP:    { symbol: "JMP" },
  LDCFG32:{ symbol: "LD", sub: "CFG" },
  LD16:   { symbol: "LD", sub: "16" },
  LD16RP: { symbol: "LD", sub: "32" },
  LD32:   { symbol: "LD", sub: "32" },
  LD16RQ: { symbol: "LD", sub: "64" },
  LDR16P: { symbol: "LD", sub: "32" },
  LDDDS:  { symbol: "DSR", sub: "LD D" },
  LDDWDS: { symbol: "DSR", sub: "LD D" },
  LDS0DS: { symbol: "DSR", sub: "LD S0" },
  LDS0WDS:{ symbol: "DSR", sub: "LD S0" },
  LDS1DS: { symbol: "DSR", sub: "LD S1" },
  LDS1WDS:{ symbol: "DSR", sub: "LD S1" },
  SETDDA: { symbol: "DSR", sub: "SET D.A" },
  SETDS0A:{ symbol: "DSR", sub: "SET S0.A" },
  SETDS1A:{ symbol: "DSR", sub: "SET S1.A" },
  SETDDL: { symbol: "DSR", sub: "SET D.L" },
  SETDS0L:{ symbol: "DSR", sub: "SET S0.L" },
  SETDS1L:{ symbol: "DSR", sub: "SET S1.L" },
  STDDS:  { symbol: "DSR", sub: "ST D" },
  STDWDS: { symbol: "DSR", sub: "ST D" },
  STS0DS: { symbol: "DSR", sub: "ST S0" },
  STS0WDS:{ symbol: "DSR", sub: "ST S0" },
  STS1DS: { symbol: "DSR", sub: "ST S1" },
  STS1WDS:{ symbol: "DSR", sub: "ST S1" },
  CPDDS:  { symbol: "DSR", sub: "CP D" },
  CPSDS:  { symbol: "DSR", sub: "CP S" },
  CPDDSA: { symbol: "DSR", sub: "CP D.A" },
  CPSDSA: { symbol: "DSR", sub: "CP S.A" },
  SETJT:  { symbol: "MOV", sub: "JT" },
  STCFG32:{ symbol: "ST", sub: "CFG" },
  ST16:   { symbol: "ST", sub: "16" },
  ST32:   { symbol: "ST", sub: "32" },
};

export class PE {
  constructor(x, y, size) {
    this.x = x;
    this.y = y;
    this.size = size;
    this.brightness = 0;
    this.targetBrightness = 0;
    this.transitionStartTime = 0;
    this.transitionDuration = 0;
    this.startBrightness = 0;
    this.onDuration = PE_ON_DURATION;
    this.activationTime = 0;
    this.active = false;
    this.op = null;
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
  }

  setBusy(busy, op, stall) {
    const isNop = op === "NOP" || (op && op.startsWith("NOP."));
    this.brightness = (busy && !isNop) ? 1 : (stall ? 0.25 : 0);
    this.targetBrightness = this.brightness;
    this.transitionDuration = 0;
    this.active = false;
    this.op = isNop ? null : (op || null);
    this.stall = stall || null;
    this.stallReason = null;
  }

  activate(now) {
    if (now === undefined) now = performance.now();
    this.active = true;
    this.activationTime = now;
    this.startBrightness = this.brightness;
    this.targetBrightness = 1;
    this.transitionStartTime = now;
    this.transitionDuration = PE_BRIGHTEN_DURATION;
  }

  update(now) {
    if (this.active && now - this.activationTime > this.onDuration) {
      this.active = false;
      this.startBrightness = this.brightness;
      this.targetBrightness = 0;
      this.transitionStartTime = now;
      this.transitionDuration = PE_DIM_DURATION;
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
    }
  }

  draw(ctx) {
    const b = this.brightness;
    const baseAlpha = 0.3 + b * 0.7;

    // Stall colors only render when nothing is executing (!this.op).
    // See the execution/stall model comment in the constructor.
    if (this.stall === "wavelet" && !this.op) {
      ctx.fillStyle = `rgba(${55 + b * 75}, ${20 + b * 20}, ${70 + b * 110}, ${baseAlpha})`;
    } else if (this.stall && !this.op) {
      ctx.fillStyle = `rgba(${70 + b * 100}, ${30 + b * 30}, ${20 + b * 20}, ${baseAlpha})`;
    } else {
      // Normal: executing (bright blue) or idle (dark blue)
      ctx.fillStyle = `rgba(${45 + b * 55}, ${58 + b * 123}, ${90 + b * 156}, ${baseAlpha})`;
    }
    ctx.fillRect(this.x, this.y, this.size, this.size);

    if (this.selected) {
      ctx.strokeStyle = "#ff9800";
      ctx.lineWidth = 2;
      ctx.strokeRect(this.x, this.y, this.size, this.size);
    }

    if (!this.op && this.stallReason) {
      const cx = this.x + this.size / 2;
      const cy = this.y + this.size / 2;
      const fontSize = Math.min(this.size * 0.25, (this.size * 1.2) / this.stallReason.length);
      ctx.font = `${fontSize}px monospace`;
      ctx.fillStyle = this.stall === "wavelet"
        ? "rgba(200, 180, 220, 0.7)"   // lavender for wavelet stalls
        : "rgba(230, 200, 150, 0.7)";  // light orange for pipeline stalls
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(this.stallReason, cx, cy);
      return;
    }

    if (b <= PE_BRIGHTNESS_THRESHOLD) return;

    if (!this.op) return;

    const cx = this.x + this.size / 2;
    const cy = this.y + this.size / 2;
    ctx.fillStyle = `rgba(255, 255, 255, ${b})`;
    ctx.textAlign = "center";

    const baseOp = this.op.split(".")[0];
    const entry = SYMBOLIC_OPS[baseOp];
    if (entry) {
      const isText = /^[A-Z]/.test(entry.symbol);
      if (entry.sub) {
        const symbolSize = isText ? this.size * 0.32 : this.size * 0.55;
        ctx.font = `bold ${symbolSize}px sans-serif`;
        ctx.textBaseline = "alphabetic";
        ctx.fillText(entry.symbol, cx, cy + this.size * 0.05);

        ctx.font = `${this.size * 0.2}px sans-serif`;
        ctx.fillStyle = `rgba(255, 255, 255, ${b * 0.85})`;
        ctx.textBaseline = "top";
        ctx.fillText(entry.sub, cx, cy + this.size * 0.1);
      } else {
        const symbolSize = isText ? this.size * 0.32 : this.size * 0.55;
        ctx.font = `bold ${symbolSize}px sans-serif`;
        ctx.textBaseline = "middle";
        ctx.fillText(entry.symbol, cx, cy);
      }
    } else {
      const fontSize = Math.min(this.size * 0.25, (this.size * 1.2) / this.op.length);
      ctx.font = `${fontSize}px sans-serif`;
      ctx.fillStyle = `rgba(255, 255, 255, ${b * 0.85})`;
      ctx.textBaseline = "middle";
      ctx.fillText(this.op, cx, cy);
    }
  }
}
