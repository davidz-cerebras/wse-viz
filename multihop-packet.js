import { FADE_IN, FADE_OUT, HOP_DELAY, PACKET_RADIUS, PACKET_COLOR, PACKET_HALO_COLOR } from "./constants.js";

export class MultiHopPacket {
  constructor(fromRow, fromCol, toRow, toCol, startTime) {
    this.fromRow = fromRow;
    this.fromCol = fromCol;
    this.toRow = toRow;
    this.toCol = toCol;
    this.startTime = startTime;
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
      this.totalHops * HOP_DELAY + FADE_IN + FADE_OUT;

    if (elapsed < FADE_IN) {
      const fromPE = grid.getPE(this.fromRow, this.fromCol);
      if (fromPE) {
        return {
          x: fromPE.x + grid.cellSize / 2,
          y: fromPE.y + grid.cellSize / 2,
          isComplete: false,
        };
      }
    } else if (elapsed < totalDuration - FADE_OUT) {
      const moveElapsed = elapsed - FADE_IN;
      const hopIndex = Math.floor(moveElapsed / HOP_DELAY);
      const hopProgress = (moveElapsed % HOP_DELAY) / HOP_DELAY;

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
          return { x, y, isComplete: false };
        }
      }
    } else {
      const toPE = grid.getPE(this.toRow, this.toCol);
      if (toPE) {
        return {
          x: toPE.x + grid.cellSize / 2,
          y: toPE.y + grid.cellSize / 2,
          isComplete: false,
        };
      }
    }

    return { x: 0, y: 0, isComplete: true };
  }

  isComplete(currentTime) {
    const totalDuration =
      this.totalHops * HOP_DELAY + FADE_IN + FADE_OUT;
    return currentTime - this.startTime >= totalDuration;
  }

  draw(ctx, currentTime, grid) {
    const { x, y, isComplete } = this.getCurrentPosition(
      currentTime,
      grid,
    );
    if (isComplete) return;

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
