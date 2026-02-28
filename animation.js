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
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  loop(timestamp) {
    if (!this.running) return;
    this.updateFn(timestamp);
    this.drawFn(timestamp);
    this.rafId = requestAnimationFrame(this.boundLoop);
  }
}
