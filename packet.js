import { FADE_IN, FADE_OUT, HOP_DELAY, PACKET_RADIUS, PACKET_COLOR, PACKET_HALO_COLOR } from "./constants.js";

export class DataPacket {
  constructor(fromX, fromY, toX, toY, startTime) {
    this.fromX = fromX;
    this.fromY = fromY;
    this.toX = toX;
    this.toY = toY;
    this.startTime = startTime;
    this.duration = FADE_IN + HOP_DELAY + FADE_OUT;
    this.fadeInDuration = FADE_IN;
    this.fadeOutDuration = FADE_OUT;
  }

  getCurrentPosition(currentTime) {
    const elapsed = currentTime - this.startTime;
    const fadeOutStart = this.duration - this.fadeOutDuration;

    if (elapsed < this.fadeInDuration) {
      return { x: this.fromX, y: this.fromY };
    } else if (elapsed < fadeOutStart) {
      const moveProgress =
        (elapsed - this.fadeInDuration) / (fadeOutStart - this.fadeInDuration);
      return {
        x: this.fromX + (this.toX - this.fromX) * moveProgress,
        y: this.fromY + (this.toY - this.fromY) * moveProgress,
      };
    } else {
      return { x: this.toX, y: this.toY };
    }
  }

  isComplete(currentTime) {
    return currentTime - this.startTime >= this.duration;
  }

  draw(ctx, currentTime) {
    const { x, y } = this.getCurrentPosition(currentTime);

    ctx.beginPath();
    ctx.arc(x, y, PACKET_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = PACKET_COLOR;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, y, PACKET_RADIUS + 2, 0, Math.PI * 2);
    ctx.strokeStyle = PACKET_HALO_COLOR;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}
