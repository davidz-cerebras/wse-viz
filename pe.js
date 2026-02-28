import { PE_ON_DURATION, PE_BRIGHTEN_DURATION, PE_DIM_DURATION, PE_BRIGHTNESS_THRESHOLD } from "./constants.js";

const SYMBOLIC_OPS = {
  FADDS:  { symbol: "+", sub: "FP32" },
  FMULS:  { symbol: "\u00d7", sub: "FP32" },
  FSUBS:  { symbol: "\u2212", sub: "FP32" },
  FMACS:  { symbol: "\u00d7+", sub: "FP32" },
  FDPS:   { symbol: "\u22c5", sub: "FP32" },
  FMOV32: { symbol: "MOV", sub: "FP32" },
  FSTDPAS:{ symbol: "ST", sub: "FP32" },
  ADD16:  { symbol: "+", sub: "INT16" },
  IMUL16: { symbol: "\u00d7", sub: "INT16" },
  SLL16:  { symbol: "\u00ab", sub: "INT16" },
  IMOV16: { symbol: "MOV", sub: "INT16" },
  LD16:   { symbol: "LD", sub: "INT16" },
  ST16:   { symbol: "ST", sub: "INT16" },
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
  }

  setBusy(busy, op) {
    const isNop = op === "NOP";
    this.brightness = (busy && !isNop) ? 1 : 0;
    this.targetBrightness = this.brightness;
    this.transitionDuration = 0;
    this.active = false;
    this.op = isNop ? null : (op || null);
  }

  activate() {
    const now = performance.now();
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

    ctx.fillStyle = `rgba(${45 + b * 55}, ${58 + b * 123}, ${90 + b * 156}, ${baseAlpha})`;
    ctx.fillRect(this.x, this.y, this.size, this.size);

    if (b <= PE_BRIGHTNESS_THRESHOLD) return;

    ctx.strokeStyle = `rgba(144, 202, 249, ${b * 0.8})`;
    ctx.lineWidth = 2;
    ctx.strokeRect(this.x, this.y, this.size, this.size);

    if (!this.op) return;

    const cx = this.x + this.size / 2;
    const cy = this.y + this.size / 2;
    ctx.fillStyle = `rgba(255, 255, 255, ${b})`;
    ctx.textAlign = "center";

    const baseOp = this.op.split(".")[0];
    const entry = SYMBOLIC_OPS[baseOp];
    if (entry) {
      const isText = /^[A-Z]/.test(entry.symbol);
      const symbolSize = isText ? this.size * 0.32 : this.size * 0.55;
      ctx.font = `bold ${symbolSize}px sans-serif`;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(entry.symbol, cx, cy + this.size * 0.05);

      ctx.font = `${this.size * 0.2}px sans-serif`;
      ctx.fillStyle = `rgba(200, 200, 255, ${b * 0.8})`;
      ctx.textBaseline = "top";
      ctx.fillText(entry.sub, cx, cy + this.size * 0.1);
    } else {
      const fontSize = Math.min(this.size * 0.25, (this.size * 1.2) / this.op.length);
      ctx.font = `${fontSize}px sans-serif`;
      ctx.fillStyle = `rgba(200, 200, 255, ${b * 0.8})`;
      ctx.textBaseline = "middle";
      ctx.fillText(this.op, cx, cy);
    }
  }
}
