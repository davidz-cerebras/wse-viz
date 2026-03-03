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
    this.cancelled = false;
    this.pendingTimers = new Set();
    this.centerCol1 = Math.floor((cols - 1) / 2);
    this.centerCol2 = cols % 2 === 0 ? this.centerCol1 + 1 : this.centerCol1;
    this.centerRow1 = Math.floor((rows - 1) / 2);
    this.centerRow2 = rows % 2 === 0 ? this.centerRow1 + 1 : this.centerRow1;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = col * (cellSize + gap) + gap;
        const y = row * (cellSize + gap) + gap;
        this.pes.push(new PE(x, y, cellSize));
      }
    }
  }

  cancel() {
    this.cancelled = true;
    for (const id of this.pendingTimers) clearTimeout(id);
    this.pendingTimers.clear();
  }

  resetTimers() {
    this.cancel();
    this.cancelled = false;
  }

  _setTimeout(fn, delay) {
    const id = setTimeout(() => {
      this.pendingTimers.delete(id);
      if (this.cancelled) return;
      fn();
    }, delay);
    this.pendingTimers.add(id);
    return id;
  }

  getPE(row, col) {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return null;
    return this.pes[row * this.cols + col];
  }

  activatePE(row, col) {
    const pe = this.getPE(row, col);
    if (pe) pe.activate();
  }

  activateAllPEs() {
    for (const pe of this.pes) pe.activate();
  }

  setPEBusy(row, col, busy, op) {
    const pe = this.getPE(row, col);
    if (pe) pe.setBusy(busy, op);
  }

  resetAllPEs() {
    for (const pe of this.pes) pe.setBusy(false, null);
  }

  clearPackets() {
    this.packets.length = 0;
  }

  sendPacket(fromRow, fromCol, toRow, toCol, duration, startTime) {
    const fromPE = this.getPE(fromRow, fromCol);
    const toPE = this.getPE(toRow, toCol);
    if (!fromPE || !toPE) return;

    const half = this.cellSize / 2;
    this.packets.push(
      new DataPacket(
        fromPE.x + half, fromPE.y + half,
        toPE.x + half, toPE.y + half,
        startTime, duration,
      ),
    );
  }

  update(now) {
    for (const pe of this.pes) pe.update(now);
    let writeIdx = 0;
    for (let i = 0; i < this.packets.length; i++) {
      if (!this.packets[i].isComplete(now)) {
        this.packets[writeIdx++] = this.packets[i];
      }
    }
    this.packets.length = writeIdx;
  }

  draw(ctx, now) {
    for (const pe of this.pes) pe.draw(ctx);
    for (const packet of this.packets) packet.draw(ctx, now, this);
  }

  hasActivity() {
    if (this.packets.length > 0) return true;
    for (const pe of this.pes) {
      if (pe.active || pe.transitionDuration > 0) return true;
    }
    return false;
  }
}
