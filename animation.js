export class AnimationLoop {
  constructor(updateFn, drawFn) {
    this.updateFn = updateFn;
    this.drawFn = drawFn;
    this.running = false;
    this.rafId = 0;
    this.boundLoop = (ts) => this.loop(ts);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.rafId = requestAnimationFrame(this.boundLoop);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  loop(timestamp) {
    if (!this.running) return;
    try {
      this.updateFn(timestamp);
      if (!this.running) return;
      this.drawFn(timestamp);
    } catch (e) {
      this.running = false;
      throw e;
    }
    if (this.running) {
      this.rafId = requestAnimationFrame(this.boundLoop);
    }
  }
}
