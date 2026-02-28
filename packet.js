import { HOP_DELAY } from "./constants.js";
import { drawPacketDot } from "./draw-utils.js";

export class DataPacket {
  constructor(fromX, fromY, toX, toY, startTime, duration) {
    this.fromX = fromX;
    this.fromY = fromY;
    this.toX = toX;
    this.toY = toY;
    this.startTime = startTime !== undefined ? startTime : performance.now();
    this.duration = duration !== undefined ? duration : HOP_DELAY;
  }

  getCurrentPosition(currentTime) {
    if (this.startTime === Infinity) return { x: this.fromX, y: this.fromY };
    const progress = Math.min((currentTime - this.startTime) / this.duration, 1);
    if (progress <= 0) return { x: this.fromX, y: this.fromY };
    return {
      x: this.fromX + (this.toX - this.fromX) * progress,
      y: this.fromY + (this.toY - this.fromY) * progress,
    };
  }

  isComplete(currentTime) {
    if (this.startTime === Infinity) return false;
    return currentTime - this.startTime >= this.duration;
  }

  draw(ctx, currentTime, _grid) {
    const { x, y } = this.getCurrentPosition(currentTime);
    drawPacketDot(ctx, x, y);
  }
}
