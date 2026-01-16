export class DataPacket {
  constructor(fromX, fromY, toX, toY, startTime, duration) {
    this.fromX = fromX;
    this.fromY = fromY;
    this.toX = toX;
    this.toY = toY;
    this.startTime = startTime;
    this.duration = duration;
    this.size = 4;
    this.fadeInDuration = 150;
    this.fadeOutDuration = 150;
  }

  getCurrentPosition(currentTime) {
    const elapsed = currentTime - this.startTime;
    const fadeOutStart = this.duration - this.fadeOutDuration;

    let x, y, alpha;

    if (elapsed < this.fadeInDuration) {
      x = this.fromX;
      y = this.fromY;
      alpha = elapsed / this.fadeInDuration;
    } else if (elapsed < fadeOutStart) {
      const moveProgress =
        (elapsed - this.fadeInDuration) / (fadeOutStart - this.fadeInDuration);
      x = this.fromX + (this.toX - this.fromX) * moveProgress;
      y = this.fromY + (this.toY - this.fromY) * moveProgress;
      alpha = 1;
    } else {
      x = this.toX;
      y = this.toY;
      alpha = 1 - (elapsed - fadeOutStart) / this.fadeOutDuration;
    }

    return { x, y, alpha: Math.max(0, Math.min(1, alpha)) };
  }

  isComplete(currentTime) {
    return currentTime - this.startTime >= this.duration;
  }

  draw(ctx, currentTime) {
    const { x, y, alpha } = this.getCurrentPosition(currentTime);

    ctx.beginPath();
    ctx.arc(x, y, this.size, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 193, 7, ${alpha})`;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, y, this.size + 2, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255, 193, 7, ${alpha * 0.5})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}
