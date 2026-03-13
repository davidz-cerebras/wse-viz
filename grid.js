import { PE } from "./pe.js";
import { DataPacket } from "./packet.js";
import {
  CELL_SIZE, GAP_SIZE, ARROW_DEPTH, RAMP_LATERAL, ARROW_SIZE,
  ZOOM_PREVIEW_COLOR, CORNER_LABEL_COLOR,
  PE_COLOR_NOP, PE_COLOR_STALL_WAVELET, PE_COLOR_STALL_PIPE,
  RAMP_ON_ACTIVE, RAMP_ON_INACTIVE, RAMP_OFF_ACTIVE, RAMP_OFF_INACTIVE,
} from "./constants.js";


// Convert trace (x,y) to grid PE and add an active ramp triangle to the path.
function _addActiveRamp(path, trX, trY, dimY, dir, isOn, rows, cols, pes) {
  const r = dimY - 1 - trY, c = trX;
  if (r >= 0 && r < rows && c >= 0 && c < cols) {
    const pe = pes[r * cols + c];
    _addRampTriangle(path, pe.cx, pe.cy, dir, isOn);
    return true;
  }
  return false;
}

const DIRECTIONS = ["E", "N", "W", "S"];

// Add a single active ramp triangle to the given Path2D.
function _addRampTriangle(p, cx, cy, dir, isOn) {
  const s = ARROW_SIZE;
  let x, y;
  switch (dir) {
    case "E": x = cx + ARROW_DEPTH;
      if (isOn) { y = cy + RAMP_LATERAL; p.moveTo(x - s, y); p.lineTo(x + s, y - s); p.lineTo(x + s, y + s); }
      else      { y = cy - RAMP_LATERAL; p.moveTo(x + s, y); p.lineTo(x - s, y - s); p.lineTo(x - s, y + s); }
      break;
    case "N": y = cy + ARROW_DEPTH;
      if (isOn) { x = cx + RAMP_LATERAL; p.moveTo(x, y - s); p.lineTo(x - s, y + s); p.lineTo(x + s, y + s); }
      else      { x = cx - RAMP_LATERAL; p.moveTo(x, y + s); p.lineTo(x - s, y - s); p.lineTo(x + s, y - s); }
      break;
    case "W": x = cx - ARROW_DEPTH;
      if (isOn) { y = cy - RAMP_LATERAL; p.moveTo(x + s, y); p.lineTo(x - s, y - s); p.lineTo(x - s, y + s); }
      else      { y = cy + RAMP_LATERAL; p.moveTo(x - s, y); p.lineTo(x + s, y - s); p.lineTo(x + s, y + s); }
      break;
    case "S": y = cy - ARROW_DEPTH;
      if (isOn) { x = cx - RAMP_LATERAL; p.moveTo(x, y + s); p.lineTo(x - s, y - s); p.lineTo(x + s, y - s); }
      else      { x = cx + RAMP_LATERAL; p.moveTo(x, y - s); p.lineTo(x - s, y + s); p.lineTo(x + s, y + s); }
      break;
    default: return;
  }
  p.closePath();
}

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
    this.showRamps = false; // enabled only when trace has detailed wavelet routing data
    this._staticRampPaths = null; // cached {offPath, onPath} for inactive ramps
    this._cornerLabels = null;    // cached corner label data
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
    this._cornerLabels = null;
    this._staticRampPaths = null;
  }

  clearViewport() {
    this.viewport = null;
    this._cornerLabels = null;
    this._staticRampPaths = null;
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

  setPEStall(row, col, stall, reason) {
    const pe = this.getPE(row, col);
    if (pe) {
      pe.stall = stall || null;
      pe.stallReason = reason || null;
      // Stall color only shown when nothing is executing (op takes visual priority)
      if (stall && !pe.op) pe.fillColor = stall === "nop" ? PE_COLOR_NOP : stall === "wavelet" ? PE_COLOR_STALL_WAVELET : PE_COLOR_STALL_PIPE;
    }
  }

  refreshPEColors() {
    for (const pe of this.pes) {
      if (pe.opEntry) {
        pe.fillColor = pe.opEntry.fillColor;
      } else if (pe.stall && !pe.op) {
        pe.fillColor = pe.stall === "nop" ? PE_COLOR_NOP : pe.stall === "wavelet" ? PE_COLOR_STALL_WAVELET : PE_COLOR_STALL_PIPE;
      }
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

    this.packets.push(
      new DataPacket(
        fromPE.cx, fromPE.cy,
        toPE.cx, toPE.cy,
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
    if (this.showRamps) this.drawRamps(ctx, minR, maxR, minC, maxC);
    for (const packet of this.packets) packet.draw(ctx, now, this);
    this._drawCornerLabels(ctx, minR, maxR, minC, maxC);

    // Draw zoom preview: tint each selected PE during Shift+drag
    if (this.zoomPreview) {
      const zp = this.zoomPreview;
      ctx.fillStyle = ZOOM_PREVIEW_COLOR;
      const cols = this.cols;
      for (let row = zp.minRow; row <= zp.maxRow; row++) {
        for (let col = zp.minCol; col <= zp.maxCol; col++) {
          const pe = this.pes[row * cols + col];
          ctx.fillRect(pe.x, pe.y, CELL_SIZE, CELL_SIZE);
        }
      }
    }
  }

  // Build static (inactive) ramp Path2D objects for all viewport PEs.
  // Called once per viewport; cached until viewport changes.
  // Reuses _addRampTriangle to keep triangle geometry in one place.
  _buildStaticRampPaths(minR, maxR, minC, maxC) {
    const offPath = new Path2D();
    const onPath = new Path2D();
    const cols = this.cols;

    for (let row = minR; row <= maxR; row++) {
      for (let col = minC; col <= maxC; col++) {
        const pe = this.pes[row * cols + col];
        const { cx, cy } = pe;
        for (const dir of DIRECTIONS) {
          _addRampTriangle(offPath, cx, cy, dir, false);
          _addRampTriangle(onPath, cx, cy, dir, true);
        }
      }
    }

    this._staticRampPaths = { offPath, onPath };
  }

  drawRamps(ctx, minR, maxR, minC, maxC) {
    // Build static paths once per viewport
    if (!this._staticRampPaths) this._buildStaticRampPaths(minR, maxR, minC, maxC);

    // Draw all ramps in inactive style first
    ctx.fillStyle = RAMP_OFF_INACTIVE;
    ctx.fill(this._staticRampPaths.offPath);
    ctx.fillStyle = RAMP_ON_INACTIVE;
    ctx.fill(this._staticRampPaths.onPath);

    if (this.packets.length === 0) return;

    // Overlay active ramps (only the few that are currently active)
    const cols = this.cols;
    const rows = this.rows;
    const pes = this.pes;
    const offActive = new Path2D();
    const onActive = new Path2D();
    let hasOff = false, hasOn = false;

    for (const pkt of this.packets) {
      if (!pkt.waypoints || !pkt.visible) continue;
      const wpI = pkt.wpIdx;
      if (wpI < 0 || wpI >= pkt.waypoints.length) continue;
      const cur = pkt.waypoints[wpI];
      const fc = pkt.fractionalCycle;
      const depCycle = cur.depCycle;
      const dimY = pkt.dimY;

      if (depCycle !== null && fc < depCycle) {
        // Wavelet is at current PE waiting for departure.
        // Design intent: the destination off-ramp lights up at the start of
        // the departure cycle, while the packet is still visually at the
        // on-ramp. This previews the wavelet's intended next direction.
        if (cur.arriveDir && cur.arriveDir !== "R")
          hasOn = _addActiveRamp(onActive, cur.x, cur.y, dimY, cur.arriveDir, true, rows, cols, pes) || hasOn;
        if (cur.departDir)
          hasOff = _addActiveRamp(offActive, cur.x, cur.y, dimY, cur.departDir, false, rows, cols, pes) || hasOff;
      } else if (depCycle !== null && wpI < pkt.waypoints.length - 1) {
        if (cur.departDir)
          hasOff = _addActiveRamp(offActive, cur.x, cur.y, dimY, cur.departDir, false, rows, cols, pes) || hasOff;
        const next = pkt.waypoints[wpI + 1];
        if (next.arriveDir && next.arriveDir !== "R")
          hasOn = _addActiveRamp(onActive, next.x, next.y, dimY, next.arriveDir, true, rows, cols, pes) || hasOn;
      } else {
        if (cur.arriveDir && cur.arriveDir !== "R")
          hasOn = _addActiveRamp(onActive, cur.x, cur.y, dimY, cur.arriveDir, true, rows, cols, pes) || hasOn;
      }
    }

    if (hasOff) { ctx.fillStyle = RAMP_OFF_ACTIVE; ctx.fill(offActive); }
    if (hasOn)  { ctx.fillStyle = RAMP_ON_ACTIVE; ctx.fill(onActive); }
  }

  _drawCornerLabels(ctx, minR, maxR, minC, maxC) {
    if (!this._cornerLabels) {
      const fontSize = Math.min(GAP_SIZE * 0.7, 6);
      if (fontSize < 2) { this._cornerLabels = []; return; }
      const step = CELL_SIZE + GAP_SIZE;
      const g = GAP_SIZE;
      const left = minC * step + g / 2;
      const right = maxC * step + g + CELL_SIZE + g / 2;
      const top = minR * step + g / 2;
      const bottom = maxR * step + g + CELL_SIZE + g / 2;
      this._cornerLabels = [
        { label: `P${minC}.${this.rows - 1 - minR}`, x: left,  y: top,    align: "left",  baseline: "top",    fontSize },
        { label: `P${maxC}.${this.rows - 1 - minR}`, x: right, y: top,    align: "right", baseline: "top",    fontSize },
        { label: `P${minC}.${this.rows - 1 - maxR}`, x: left,  y: bottom, align: "left",  baseline: "bottom", fontSize },
        { label: `P${maxC}.${this.rows - 1 - maxR}`, x: right, y: bottom, align: "right", baseline: "bottom", fontSize },
      ];
    }
    if (this._cornerLabels.length === 0) return;
    ctx.font = `${this._cornerLabels[0].fontSize}px sans-serif`;
    ctx.fillStyle = CORNER_LABEL_COLOR;
    for (const c of this._cornerLabels) {
      ctx.textAlign = c.align;
      ctx.textBaseline = c.baseline;
      ctx.fillText(c.label, c.x, c.y);
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
