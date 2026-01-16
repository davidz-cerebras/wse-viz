import { PE } from "./pe.js";
import { DataPacket } from "./packet.js";

export class Grid {
  constructor(rows, cols, cellSize, gap) {
    this.rows = rows;
    this.cols = cols;
    this.cellSize = cellSize;
    this.gap = gap;
    this.pes = [];
    this.packets = [];
    this.init();
  }

  init() {
    this.pes = [];
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const x = col * (this.cellSize + this.gap) + this.gap;
        const y = row * (this.cellSize + this.gap) + this.gap;
        this.pes.push(new PE(x, y, this.cellSize));
      }
    }
  }

  getPE(row, col) {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) {
      return null;
    }
    return this.pes[row * this.cols + col];
  }

  activatePE(row, col) {
    const pe = this.getPE(row, col);
    if (pe) {
      pe.activate();
    }
  }

  sendPacket(fromRow, fromCol, toRow, toCol, duration = 600) {
    const fromPE = this.getPE(fromRow, fromCol);
    const toPE = this.getPE(toRow, toCol);

    if (!fromPE || !toPE) {
      return;
    }

    const fromX = fromPE.x + this.cellSize / 2;
    const fromY = fromPE.y + this.cellSize / 2;
    const toX = toPE.x + this.cellSize / 2;
    const toY = toPE.y + this.cellSize / 2;

    this.packets.push(
      new DataPacket(fromX, fromY, toX, toY, Date.now(), duration),
    );
  }

  update() {
    this.pes.forEach((pe) => pe.update());
    this.packets = this.packets.filter(
      (packet) => !packet.isComplete(Date.now()),
    );
  }

  draw(ctx) {
    this.pes.forEach((pe) => pe.draw(ctx));
    this.packets.forEach((packet) => packet.draw(ctx, Date.now()));
  }

  getActivePECount() {
    return this.pes.filter((pe) => pe.active).length;
  }

  getPacketCount() {
    return this.packets.length;
  }
}
