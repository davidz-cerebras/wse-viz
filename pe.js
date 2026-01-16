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
    this.onDuration = 500;
    this.activationTime = 0;
    this.active = false;
  }

  activate() {
    this.active = true;
    this.activationTime = Date.now();
    this.startBrightness = this.brightness;
    this.targetBrightness = 1;
    this.transitionStartTime = Date.now();
    this.transitionDuration = 50;
  }

  update() {
    const now = Date.now();

    if (this.active && now - this.activationTime > this.onDuration) {
      this.active = false;
      this.startBrightness = this.brightness;
      this.targetBrightness = 0;
      this.transitionStartTime = now;
      this.transitionDuration = 600;
    }

    if (this.transitionDuration > 0) {
      const elapsed = now - this.transitionStartTime;
      const progress = Math.min(elapsed / this.transitionDuration, 1);
      this.brightness =
        this.startBrightness +
        (this.targetBrightness - this.startBrightness) * progress;
    }
  }

  draw(ctx) {
    const baseAlpha = 0.3 + this.brightness * 0.7;

    ctx.fillStyle = `rgba(${45 + this.brightness * 55}, ${58 + this.brightness * 123}, ${90 + this.brightness * 156}, ${baseAlpha})`;
    ctx.fillRect(this.x, this.y, this.size, this.size);

    if (this.brightness > 0.1) {
      ctx.strokeStyle = `rgba(144, 202, 249, ${this.brightness * 0.8})`;
      ctx.lineWidth = 2;
      ctx.strokeRect(this.x, this.y, this.size, this.size);
    }
  }
}
