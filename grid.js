import { PE } from "./pe.js";
import { DataPacket } from "./packet.js";
import {
  CELL_SIZE, GAP_SIZE, ARROW_DEPTH, RAMP_LATERAL, ARROW_SIZE,
  ZOOM_PREVIEW_COLOR, CORNER_LABEL_COLOR,
  RAMP_ON_ACTIVE, RAMP_ON_INACTIVE, RAMP_OFF_ACTIVE, RAMP_OFF_INACTIVE,
} from "./constants.js";

export class Grid {
  constructor(rows, cols) {
    this.rows = rows;
    this.cols = cols;
    this.pes = [];
    this.packets = [];
    this.cancelled = false;
    this.pendingTimers = new Set();
    this.viewport = null; // { minRow, maxRow, minCol, maxCol } or null for full grid
    this.zoomPreview = null; // { minRow, maxRow, minCol, maxCol } — highlight during drag
    this._activeRamps = null; // cached Uint8Array for _collectActiveRamps
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = col * (CELL_SIZE + GAP_SIZE) + GAP_SIZE;
        const y = row * (CELL_SIZE + GAP_SIZE) + GAP_SIZE;
        this.pes.push(new PE(x, y));
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
    const step = CELL_SIZE + GAP_SIZE;
    if (!this.viewport) {
      return { width: this.cols * step + GAP_SIZE, height: this.rows * step + GAP_SIZE };
    }
    const v = this.viewport;
    return {
      width: (v.maxCol - v.minCol + 1) * step + GAP_SIZE,
      height: (v.maxRow - v.minRow + 1) * step + GAP_SIZE,
    };
  }

  // Returns the logical pixel offset of the viewport origin.
  getViewportOffset() {
    if (!this.viewport) return { x: 0, y: 0 };
    const step = CELL_SIZE + GAP_SIZE;
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

  setPEBusy(row, col, busy, op, opEntry) {
    const pe = this.getPE(row, col);
    if (pe) pe.setBusy(busy, op, opEntry);
  }

  setPEStall(row, col, stall, reason) {
    const pe = this.getPE(row, col);
    if (pe) {
      pe.stall = stall || null;
      pe.stallReason = reason || null;
      if (stall) pe.brightness = Math.max(pe.brightness, 0.25);
    }
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

    const half = CELL_SIZE / 2;
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

    // Corner PE labels (e.g., "P0.0") — helps orient when zoomed in
    this._drawCornerLabels(ctx, minR, maxR, minC, maxC);

    // Draw zoom preview: tint each selected PE during Shift+drag
    if (this.zoomPreview) {
      const zp = this.zoomPreview;
      ctx.fillStyle = ZOOM_PREVIEW_COLOR;
      for (let row = zp.minRow; row <= zp.maxRow; row++) {
        for (let col = zp.minCol; col <= zp.maxCol; col++) {
          const pe = this.getPE(row, col);
          if (pe) ctx.fillRect(pe.x, pe.y, CELL_SIZE, CELL_SIZE);
        }
      }
    }
  }

  drawRamps(ctx, minR, maxR, minC, maxC) {
    // Collect active ramps from TracedPackets
    const activeRamps = this._collectActiveRamps();

    // activeRamps is a Uint8Array indexed by peIndex*8 + dirIdx*2 + isOn
    // dirIdx: E=0, N=1, W=2, S=3; isOn: 0=off, 1=on
    for (let row = minR; row <= maxR; row++) {
      for (let col = minC; col <= maxC; col++) {
        const pe = this.getPE(row, col);
        if (!pe) continue;
        const { cx, cy } = pe;
        const base = (row * this.cols + col) * 8;

        // E side (screen right): dirIdx=0
        this._drawRamp(ctx, cx + ARROW_DEPTH, cy - RAMP_LATERAL, "E", false, activeRamps[base]);
        this._drawRamp(ctx, cx + ARROW_DEPTH, cy + RAMP_LATERAL, "E", true, activeRamps[base + 1]);

        // N side (screen down): dirIdx=1
        this._drawRamp(ctx, cx - RAMP_LATERAL, cy + ARROW_DEPTH, "N", false, activeRamps[base + 2]);
        this._drawRamp(ctx, cx + RAMP_LATERAL, cy + ARROW_DEPTH, "N", true, activeRamps[base + 3]);

        // W side (screen left): dirIdx=2
        this._drawRamp(ctx, cx - ARROW_DEPTH, cy + RAMP_LATERAL, "W", false, activeRamps[base + 4]);
        this._drawRamp(ctx, cx - ARROW_DEPTH, cy - RAMP_LATERAL, "W", true, activeRamps[base + 5]);

        // S side (screen up): dirIdx=3
        this._drawRamp(ctx, cx + RAMP_LATERAL, cy - ARROW_DEPTH, "S", false, activeRamps[base + 6]);
        this._drawRamp(ctx, cx - RAMP_LATERAL, cy - ARROW_DEPTH, "S", true, activeRamps[base + 7]);
      }
    }
  }

  _drawRamp(ctx, x, y, dir, isOnRamp, active) {
    ctx.fillStyle = isOnRamp
      ? (active ? RAMP_ON_ACTIVE : RAMP_ON_INACTIVE)
      : (active ? RAMP_OFF_ACTIVE : RAMP_OFF_INACTIVE);

    let dx = 0, dy = 0;
    switch (dir) {
      case "E": dx = isOnRamp ? -1 : 1; break;
      case "W": dx = isOnRamp ? 1 : -1; break;
      case "N": dy = isOnRamp ? -1 : 1; break;
      case "S": dy = isOnRamp ? 1 : -1; break;
    }

    ctx.beginPath();
    if (dx !== 0) {
      ctx.moveTo(x + dx * ARROW_SIZE, y);
      ctx.lineTo(x - dx * ARROW_SIZE, y - ARROW_SIZE);
      ctx.lineTo(x - dx * ARROW_SIZE, y + ARROW_SIZE);
    } else {
      ctx.moveTo(x, y + dy * ARROW_SIZE);
      ctx.lineTo(x - ARROW_SIZE, y - dy * ARROW_SIZE);
      ctx.lineTo(x + ARROW_SIZE, y - dy * ARROW_SIZE);
    }
    ctx.closePath();
    ctx.fill();
  }

  // Ramp direction encoding for the active ramps Uint8Array.
  // Each PE has 8 slots: 4 directions × (off-ramp, on-ramp).
  // Index = peIndex * 8 + dirIdx * 2 + isOn
  static _dirIdx = { E: 0, N: 1, W: 2, S: 3 };

  _collectActiveRamps() {
    // Returns a Uint8Array where a nonzero value means the ramp is active.
    // Indexed by (row*cols + col) * 8 + dirIdx * 2 + isOn.
    const size = this.rows * this.cols * 8;
    if (!this._activeRamps || this._activeRamps.length !== size) {
      this._activeRamps = new Uint8Array(size);
    }
    const active = this._activeRamps;
    active.fill(0);
    const dirIdx = Grid._dirIdx;
    for (const pkt of this.packets) {
      if (!pkt.waypoints || !pkt.visible) continue;

      const wp = pkt.waypoints;
      const fc = pkt.fractionalCycle;
      let wpI = 0;
      for (let i = 1; i < wp.length; i++) {
        if (wp[i].cycle > fc) break;
        wpI = i;
      }

      const cur = wp[wpI];
      const depCycle = cur.depCycle;
      const row = pkt.dimY - 1 - cur.y;
      const col = cur.x;
      const inBounds = row >= 0 && row < this.rows && col >= 0 && col < this.cols;

      if (depCycle !== null && fc < depCycle) {
        if (inBounds) {
          const base = (row * this.cols + col) * 8;
          if (cur.arriveDir && cur.arriveDir !== "R") active[base + dirIdx[cur.arriveDir] * 2 + 1] = 1;
          if (cur.departDir) active[base + dirIdx[cur.departDir] * 2] = 1;
        }
      } else if (depCycle !== null && wpI < wp.length - 1) {
        if (inBounds && cur.departDir) {
          active[(row * this.cols + col) * 8 + dirIdx[cur.departDir] * 2] = 1;
        }
        const next = wp[wpI + 1];
        const nRow = pkt.dimY - 1 - next.y;
        const nCol = next.x;
        if (nRow >= 0 && nRow < this.rows && nCol >= 0 && nCol < this.cols) {
          if (next.arriveDir && next.arriveDir !== "R") {
            active[(nRow * this.cols + nCol) * 8 + dirIdx[next.arriveDir] * 2 + 1] = 1;
          }
        }
      } else {
        if (inBounds && cur.arriveDir && cur.arriveDir !== "R") {
          active[(row * this.cols + col) * 8 + dirIdx[cur.arriveDir] * 2 + 1] = 1;
        }
      }
    }
    return active;
  }

  _drawCornerLabels(ctx, minR, maxR, minC, maxC) {
    const fontSize = Math.min(GAP_SIZE * 0.7, 6);
    if (fontSize < 2) return; // too small to read
    ctx.font = `${fontSize}px sans-serif`;
    ctx.fillStyle = CORNER_LABEL_COLOR;

    const step = CELL_SIZE + GAP_SIZE;
    const g = GAP_SIZE;
    // Position labels in the margin outside the PE bounding box.
    // The viewport includes a gap-width margin on all sides.
    const left = minC * step + g / 2;
    const right = maxC * step + g + CELL_SIZE + g / 2;
    const top = minR * step + g / 2;
    const bottom = maxR * step + g + CELL_SIZE + g / 2;

    const corners = [
      [minR, minC, left,  top,    "left",  "top"],
      [minR, maxC, right, top,    "right", "top"],
      [maxR, minC, left,  bottom, "left",  "bottom"],
      [maxR, maxC, right, bottom, "right", "bottom"],
    ];

    for (const [row, col, x, y, align, baseline] of corners) {
      const label = `P${col}.${this.rows - 1 - row}`;
      ctx.textAlign = align;
      ctx.textBaseline = baseline;
      ctx.fillText(label, x, y);
    }
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
