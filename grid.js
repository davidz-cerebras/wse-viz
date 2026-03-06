import { PE } from "./pe.js";
import { DataPacket } from "./packet.js";
import { CELL_SIZE, RAMP_ARROW_DEPTH, RAMP_LATERAL, RAMP_ARROW_SIZE } from "./constants.js";

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
    this.viewport = null; // { minRow, maxRow, minCol, maxCol } or null for full grid
    this.zoomPreview = null; // { minRow, maxRow, minCol, maxCol } — highlight during drag
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

  setViewport(minRow, maxRow, minCol, maxCol) {
    this.viewport = {
      minRow: Math.max(0, minRow),
      maxRow: Math.min(this.rows - 1, maxRow),
      minCol: Math.max(0, minCol),
      maxCol: Math.min(this.cols - 1, maxCol),
    };
  }

  clearViewport() {
    this.viewport = null;
  }

  // Returns the natural (logical) pixel size of the current viewport region.
  getViewportNaturalSize() {
    const step = this.cellSize + this.gap;
    if (!this.viewport) {
      return { width: this.cols * step + this.gap, height: this.rows * step + this.gap };
    }
    const v = this.viewport;
    return {
      width: (v.maxCol - v.minCol + 1) * step + this.gap,
      height: (v.maxRow - v.minRow + 1) * step + this.gap,
    };
  }

  // Returns the logical pixel offset of the viewport origin.
  getViewportOffset() {
    if (!this.viewport) return { x: 0, y: 0 };
    const step = this.cellSize + this.gap;
    return { x: this.viewport.minCol * step, y: this.viewport.minRow * step };
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

  setPEBusy(row, col, busy, op, stall) {
    const pe = this.getPE(row, col);
    if (pe) pe.setBusy(busy, op, stall);
  }

  setPEStall(row, col, stall, reason) {
    const pe = this.getPE(row, col);
    if (pe) {
      pe.stall = stall || null;
      pe.stallReason = reason || null;
      if (stall) pe.brightness = Math.max(pe.brightness, 0.25);
    }
  }

  resetAllPEs() {
    for (const pe of this.pes) pe.setBusy(false, null, null);
  }

  selectPE(row, col) {
    this.deselectAllPEs();
    const pe = this.getPE(row, col);
    if (pe) pe.selected = true;
  }

  deselectAllPEs() {
    for (const pe of this.pes) pe.selected = false;
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
    const v = this.viewport;
    const minR = v ? v.minRow : 0, maxR = v ? v.maxRow : this.rows - 1;
    const minC = v ? v.minCol : 0, maxC = v ? v.maxCol : this.cols - 1;
    for (let row = minR; row <= maxR; row++) {
      for (let col = minC; col <= maxC; col++) {
        this.pes[row * this.cols + col].draw(ctx);
      }
    }
    this.drawRamps(ctx, minR, maxR, minC, maxC);
    // Packets: let canvas clipping handle off-viewport ones (few packets, negligible cost)
    for (const packet of this.packets) packet.draw(ctx, now, this);

    // Draw zoom preview: tint each selected PE during Shift+drag
    if (this.zoomPreview) {
      const zp = this.zoomPreview;
      ctx.fillStyle = "rgba(255, 152, 0, 0.3)";
      for (let row = zp.minRow; row <= zp.maxRow; row++) {
        for (let col = zp.minCol; col <= zp.maxCol; col++) {
          const pe = this.getPE(row, col);
          if (pe) ctx.fillRect(pe.x, pe.y, this.cellSize, this.cellSize);
        }
      }
    }
  }

  drawRamps(ctx, minR, maxR, minC, maxC) {
    const depth = RAMP_ARROW_DEPTH;
    const lat = RAMP_LATERAL;
    const arrowSize = RAMP_ARROW_SIZE;

    // Collect active ramps from TracedPackets
    const activeRamps = this._collectActiveRamps();

    for (let row = minR; row <= maxR; row++) {
      for (let col = minC; col <= maxC; col++) {
        const pe = this.getPE(row, col);
        if (!pe) continue;
        const cx = pe.x + CELL_SIZE / 2;
        const cy = pe.y + CELL_SIZE / 2;
        const key = row * this.cols + col;

        // Each direction has an on-ramp (arriving) and off-ramp (departing)
        // Off-ramp arrow points away from PE; on-ramp arrow points toward PE

        // E side (screen right)
        this._drawRamp(ctx, cx + depth, cy - lat, arrowSize, "E", false, activeRamps.has(`${key},E,off`));
        this._drawRamp(ctx, cx + depth, cy + lat, arrowSize, "E", true, activeRamps.has(`${key},E,on`));

        // W side (screen left)
        this._drawRamp(ctx, cx - depth, cy + lat, arrowSize, "W", false, activeRamps.has(`${key},W,off`));
        this._drawRamp(ctx, cx - depth, cy - lat, arrowSize, "W", true, activeRamps.has(`${key},W,on`));

        // N side (screen down — trace N = y-1 = lower on screen)
        this._drawRamp(ctx, cx - lat, cy + depth, arrowSize, "N", false, activeRamps.has(`${key},N,off`));
        this._drawRamp(ctx, cx + lat, cy + depth, arrowSize, "N", true, activeRamps.has(`${key},N,on`));

        // S side (screen up — trace S = y+1 = higher on screen)
        this._drawRamp(ctx, cx + lat, cy - depth, arrowSize, "S", false, activeRamps.has(`${key},S,off`));
        this._drawRamp(ctx, cx - lat, cy - depth, arrowSize, "S", true, activeRamps.has(`${key},S,on`));
      }
    }
  }

  _drawRamp(ctx, x, y, size, dir, isOnRamp, active) {
    // Arrow pointing toward PE (on-ramp) or away from PE (off-ramp)
    // Screen directions: E=right, W=left, N=down, S=up
    const alpha = active ? 0.9 : 0.15;
    ctx.fillStyle = isOnRamp
      ? `rgba(100, 181, 246, ${alpha})`   // blue for on-ramp
      : `rgba(255, 152, 0, ${alpha})`;     // orange for off-ramp

    // Arrow direction: on-ramp points inward (toward PE), off-ramp points outward
    let dx = 0, dy = 0;
    switch (dir) {
      case "E": dx = isOnRamp ? -1 : 1; break;
      case "W": dx = isOnRamp ? 1 : -1; break;
      case "N": dy = isOnRamp ? -1 : 1; break; // N = screen down, inward = up (-Y)
      case "S": dy = isOnRamp ? 1 : -1; break; // S = screen up, inward = down (+Y)
    }

    // Draw a small triangle pointing in (dx, dy) direction
    ctx.beginPath();
    if (dx !== 0) {
      // Horizontal arrow
      ctx.moveTo(x + dx * size, y);
      ctx.lineTo(x - dx * size, y - size);
      ctx.lineTo(x - dx * size, y + size);
    } else {
      // Vertical arrow
      ctx.moveTo(x, y + dy * size);
      ctx.lineTo(x - size, y - dy * size);
      ctx.lineTo(x + size, y - dy * size);
    }
    ctx.closePath();
    ctx.fill();
  }

  _collectActiveRamps() {
    // Returns a Set of "peKey,dir,on|off" strings for ramps currently in use
    const active = new Set();
    for (const pkt of this.packets) {
      if (!pkt.waypoints || !pkt.visible) continue;

      const wp = pkt.waypoints;
      const fc = pkt.fractionalCycle;
      // Find current waypoint
      let wpIdx = 0;
      for (let i = 1; i < wp.length; i++) {
        if (wp[i].cycle > fc) break;
        wpIdx = i;
      }

      const cur = wp[wpIdx];
      const depCycle = cur.depCycle;
      const row = pkt.dimY - 1 - cur.y;
      const col = cur.x;
      const inBounds = row >= 0 && row < this.rows && col >= 0 && col < this.cols;

      if (depCycle !== null && fc < depCycle) {
        if (inBounds) {
          const key = row * this.cols + col;
          if (cur.arriveDir && cur.arriveDir !== "R") active.add(`${key},${cur.arriveDir},on`);
          if (cur.departDir) active.add(`${key},${cur.departDir},off`);
        }
      } else if (depCycle !== null && wpIdx < wp.length - 1) {
        if (inBounds && cur.departDir) {
          active.add(`${row * this.cols + col},${cur.departDir},off`);
        }
        const next = wp[wpIdx + 1];
        const nextRow = pkt.dimY - 1 - next.y;
        const nextCol = next.x;
        if (nextRow >= 0 && nextRow < this.rows && nextCol >= 0 && nextCol < this.cols) {
          if (next.arriveDir && next.arriveDir !== "R") {
            active.add(`${nextRow * this.cols + nextCol},${next.arriveDir},on`);
          }
        }
      } else {
        if (inBounds && cur.arriveDir && cur.arriveDir !== "R") {
          active.add(`${row * this.cols + col},${cur.arriveDir},on`);
        }
      }
    }
    return active;
  }

  hasActivity() {
    if (this.zoomPreview) return true;
    if (this.packets.length > 0) return true;
    for (const pe of this.pes) {
      if (pe.active || pe.transitionDuration > 0) return true;
    }
    return false;
  }
}
