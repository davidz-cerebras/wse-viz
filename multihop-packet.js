import { HOP_DELAY } from "./constants.js";
import { drawPacketDot } from "./draw-utils.js";

export function buildManhattanPath(fromRow, fromCol, toRow, toCol) {
  const path = [];
  let currentRow = fromRow;
  let currentCol = fromCol;
  const hDir = toCol > fromCol ? 1 : -1;
  const vDir = toRow > fromRow ? 1 : -1;
  for (let i = Math.abs(toCol - fromCol); i > 0; i--) {
    currentCol += hDir;
    path.push({ row: currentRow, col: currentCol });
  }
  for (let i = Math.abs(toRow - fromRow); i > 0; i--) {
    currentRow += vDir;
    path.push({ row: currentRow, col: currentCol });
  }
  return path;
}

export class MultiHopPacket {
  constructor(fromRow, fromCol, toRow, toCol, startTime) {
    this.fromRow = fromRow;
    this.fromCol = fromCol;
    this.toRow = toRow;
    this.toCol = toCol;
    this.startTime = startTime;
    this.path = buildManhattanPath(fromRow, fromCol, toRow, toCol);
    this.totalHops = this.path.length;
    this.totalDuration = this.totalHops * HOP_DELAY;
  }

  getCurrentPosition(currentTime, grid) {
    const elapsed = currentTime - this.startTime;
    if (elapsed <= 0 || this.totalHops === 0) {
      const pe = grid.getPE(this.fromRow, this.fromCol);
      if (pe) return { x: pe.x + grid.cellSize / 2, y: pe.y + grid.cellSize / 2 };
      return null;
    }
    if (elapsed >= this.totalDuration) {
      const pe = grid.getPE(this.toRow, this.toCol);
      if (pe) return { x: pe.x + grid.cellSize / 2, y: pe.y + grid.cellSize / 2 };
      return null;
    }

    const hopIndex = Math.floor(elapsed / HOP_DELAY);
    const hopProgress = (elapsed % HOP_DELAY) / HOP_DELAY;
    if (hopIndex >= this.path.length) return null;

    const prev = hopIndex === 0
      ? grid.getPE(this.fromRow, this.fromCol)
      : grid.getPE(this.path[hopIndex - 1].row, this.path[hopIndex - 1].col);
    const next = grid.getPE(this.path[hopIndex].row, this.path[hopIndex].col);
    if (!prev || !next) return null;

    const half = grid.cellSize / 2;
    return {
      x: prev.x + half + (next.x - prev.x) * hopProgress,
      y: prev.y + half + (next.y - prev.y) * hopProgress,
    };
  }

  isComplete(currentTime) {
    return currentTime - this.startTime >= this.totalDuration;
  }

  draw(ctx, currentTime, grid) {
    const pos = this.getCurrentPosition(currentTime, grid);
    if (!pos) return;
    drawPacketDot(ctx, pos.x, pos.y);
  }
}
