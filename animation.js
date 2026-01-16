export class AnimationLoop {
  constructor(updateFn, drawFn) {
    this.updateFn = updateFn;
    this.drawFn = drawFn;
    this.running = false;
    this.lastTime = 0;
    this.fps = 60;
    this.frameInterval = 1000 / this.fps;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.loop();
  }

  stop() {
    this.running = false;
  }

  loop() {
    if (!this.running) return;

    const currentTime = performance.now();
    const deltaTime = currentTime - this.lastTime;

    if (deltaTime >= this.frameInterval) {
      this.lastTime = currentTime - (deltaTime % this.frameInterval);
      this.updateFn(deltaTime);
      this.drawFn();
    }

    requestAnimationFrame(() => this.loop());
  }
}
