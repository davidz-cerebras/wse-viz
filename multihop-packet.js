export class MultiHopPacket {
  constructor(fromRow, fromCol, toRow, toCol, startTime, hopDelay = 300) {
    this.fromRow = fromRow;
    this.fromCol = fromCol;
    this.toRow = toRow;
    this.toCol = toCol;
    this.startTime = startTime;
    this.hopDelay = hopDelay;
    this.size = 4;
    this.fadeInDuration = 100;
    this.fadeOutDuration = 100;
    this.currentHop = 0;
    this.totalHops = 0;
    this.path = [];
    this.calculatePath();
  }

  calculatePath() {
    const horizontalSteps = Math.abs(this.toCol - this.fromCol);
    const verticalSteps = Math.abs(this.toRow - this.fromRow);
    this.totalHops = horizontalSteps + verticalSteps;

    let currentRow = this.fromRow;
    let currentCol = this.fromCol;

    const horizontalDirection = this.toCol > this.fromCol ? 1 : -1;
    const verticalDirection = this.toRow > this.fromRow ? 1 : -1;

    for (let i = 0; i < horizontalSteps; i++) {
      currentCol += horizontalDirection;
      this.path.push({ row: currentRow, col: currentCol });
    }

    for (let i = 0; i < verticalSteps; i++) {
      currentRow += verticalDirection;
      this.path.push({ row: currentRow, col: currentCol });
    }
  }

  getCurrentPosition(currentTime, grid) {
    const elapsed = currentTime - this.startTime;
    const totalDuration =
      this.totalHops * this.hopDelay +
      this.fadeInDuration +
      this.fadeOutDuration;

    if (elapsed < this.fadeInDuration) {
      const fromPE = grid.getPE(this.fromRow, this.fromCol);
      if (fromPE) {
        return {
          x: fromPE.x + grid.cellSize / 2,
          y: fromPE.y + grid.cellSize / 2,
          alpha: elapsed / this.fadeInDuration,
          isComplete: false,
        };
      }
    } else if (elapsed < totalDuration - this.fadeOutDuration) {
      const moveElapsed = elapsed - this.fadeInDuration;
      const hopIndex = Math.floor(moveElapsed / this.hopDelay);
      const hopProgress = (moveElapsed % this.hopDelay) / this.hopDelay;

      if (hopIndex < this.path.length) {
        const prevPos =
          hopIndex === 0
            ? grid.getPE(this.fromRow, this.fromCol)
            : grid.getPE(
                this.path[hopIndex - 1].row,
                this.path[hopIndex - 1].col,
              );
        const nextPos = grid.getPE(
          this.path[hopIndex].row,
          this.path[hopIndex].col,
        );

        if (prevPos && nextPos) {
          const x =
            prevPos.x +
            grid.cellSize / 2 +
            (nextPos.x - prevPos.x) * hopProgress;
          const y =
            prevPos.y +
            grid.cellSize / 2 +
            (nextPos.y - prevPos.y) * hopProgress;
          return { x, y, alpha: 1, isComplete: false };
        }
      }
    } else {
      const toPE = grid.getPE(this.toRow, this.toCol);
      if (toPE) {
        const fadeElapsed = elapsed - (totalDuration - this.fadeOutDuration);
        const alpha = 1 - fadeElapsed / this.fadeOutDuration;
        return {
          x: toPE.x + grid.cellSize / 2,
          y: toPE.y + grid.cellSize / 2,
          alpha: Math.max(0, alpha),
          isComplete: false,
        };
      }
    }

    return { x: 0, y: 0, alpha: 0, isComplete: true };
  }

  isComplete(currentTime) {
    const totalDuration =
      this.totalHops * this.hopDelay +
      this.fadeInDuration +
      this.fadeOutDuration;
    return currentTime - this.startTime >= totalDuration;
  }

  draw(ctx, currentTime, grid) {
    const { x, y, alpha, isComplete } = this.getCurrentPosition(
      currentTime,
      grid,
    );
    if (isComplete) return;

    ctx.shadowColor = `rgba(255, 193, 7, ${alpha})`;
    ctx.shadowBlur = alpha * 25;

    ctx.beginPath();
    ctx.arc(x, y, this.size, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 193, 7, ${alpha})`;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, y, this.size + 2, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255, 193, 7, ${alpha * 0.5})`;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
  }
}
