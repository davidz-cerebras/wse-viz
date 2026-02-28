import { PE } from "./pe.js";
import { DataPacket } from "./packet.js";
import { MultiHopPacket, buildManhattanPath } from "./multihop-packet.js";
import { HOP_DELAY } from "./constants.js";

// Delay between animation phases in demo algorithms (ms)
const STEP_DELAY = 150;

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

  _setTimeout(fn, delay) {
    const id = setTimeout(() => {
      this.pendingTimers.delete(id);
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

  allReducePhase(phase) {
    const { centerCol1, centerCol2 } = this;
    const excludeCount = phase - 1;

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        if (col < excludeCount || col >= this.cols - excludeCount) continue;
        const pe = this.getPE(row, col);
        pe.activate();
        if (col === centerCol1 || col === centerCol2) continue;
        const nextCol = col < centerCol1 ? col + 1 : col - 1;
        this.sendPacket(row, col, row, nextCol);
      }
    }
  }

  runAllReduce(onComplete) {
    const maxPhase = Math.ceil(this.cols / 2);
    const maxVerticalPhase = Math.ceil(this.rows / 2);
    const circularIterations = 3;

    const runHorizontalPhase = (phase) => {
      if (this.cancelled) return;
      if (phase > maxPhase) { runVerticalPhase(1); return; }
      this.allReducePhase(phase);
      this._setTimeout(() => runHorizontalPhase(phase + 1), STEP_DELAY);
    };

    const runVerticalPhase = (phase) => {
      if (this.cancelled) return;
      if (phase > maxVerticalPhase) { runCircular(0); return; }
      this.allReduceVerticalPhase(phase);
      this._setTimeout(() => runVerticalPhase(phase + 1), STEP_DELAY);
    };

    const runCircular = (i) => {
      if (this.cancelled) return;
      if (i >= circularIterations) { this.broadcast(onComplete); return; }
      this.circularExchange();
      this._setTimeout(() => runCircular(i + 1), STEP_DELAY);
    };

    runHorizontalPhase(1);
  }

  allReduceVerticalPhase(phase) {
    const { centerCol1, centerCol2, centerRow1, centerRow2 } = this;
    const excludeCount = phase - 1;

    for (let col = centerCol1; col <= centerCol2; col++) {
      for (let row = 0; row < this.rows; row++) {
        if (row < excludeCount || row >= this.rows - excludeCount) continue;
        const pe = this.getPE(row, col);
        pe.activate();
        if (row === centerRow1 || row === centerRow2) continue;
        const nextRow = row < centerRow1 ? row + 1 : row - 1;
        this.sendPacket(row, col, nextRow, col);
      }
    }
  }

  circularExchange() {
    const { centerCol1, centerCol2, centerRow1, centerRow2 } = this;
    this.activatePE(centerRow1, centerCol1);
    this.activatePE(centerRow1, centerCol2);
    this.activatePE(centerRow2, centerCol1);
    this.activatePE(centerRow2, centerCol2);
    this.sendPacket(centerRow1, centerCol1, centerRow2, centerCol1);
    this.sendPacket(centerRow2, centerCol1, centerRow2, centerCol2);
    this.sendPacket(centerRow2, centerCol2, centerRow1, centerCol2);
    this.sendPacket(centerRow1, centerCol2, centerRow1, centerCol1);
  }

  broadcast(onComplete) {
    const { centerCol1, centerCol2, centerRow1, centerRow2, cols } = this;
    const visited = new Set();
    let queue = [];

    for (let row = centerRow1; row <= centerRow2; row++) {
      for (let col = centerCol1; col <= centerCol2; col++) {
        const pe = this.getPE(row, col);
        if (pe) {
          pe.activate();
          queue.push({ row, col, isCenterCol: true });
          visited.add(row * cols + col);
        }
      }
    }

    const tryExpand = (fromRow, fromCol, toRow, toCol, isCenterCol, nextQueue) => {
      const key = toRow * cols + toCol;
      const pe = this.getPE(toRow, toCol);
      if (!pe || visited.has(key)) return;
      pe.activate();
      this.sendPacket(fromRow, fromCol, toRow, toCol);
      visited.add(key);
      nextQueue.push({ row: toRow, col: toCol, isCenterCol });
    };

    const broadcastStep = () => {
      if (this.cancelled) return;
      if (queue.length === 0) { if (onComplete) onComplete(); return; }

      const nextQueue = [];
      for (const { row, col, isCenterCol } of queue) {
        if (!this.getPE(row, col)) continue;
        if (isCenterCol) {
          tryExpand(row, col, row - 1, col, true, nextQueue);
          tryExpand(row, col, row + 1, col, true, nextQueue);
        }
        tryExpand(row, col, row, col - 1, false, nextQueue);
        tryExpand(row, col, row, col + 1, false, nextQueue);
      }

      queue = nextQueue;
      if (queue.length > 0) {
        this._setTimeout(broadcastStep, STEP_DELAY);
      } else if (onComplete) {
        onComplete();
      }
    };

    broadcastStep();
  }

  spmvPattern(onComplete) {
    const scheduleDelay = HOP_DELAY;
    const packetQueue = [];

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const pe = this.getPE(row, col);
        if (!pe) continue;
        pe.activate();

        const numTargets = Math.floor(Math.random() * 10) + 1;
        const seen = new Set();
        for (let attempts = 0; seen.size < numTargets && attempts < 100; attempts++) {
          const tr = row + Math.floor(Math.random() * 7) - 3;
          const tc = col + Math.floor(Math.random() * 7) - 3;
          if (tr < 0 || tr >= this.rows || tc < 0 || tc >= this.cols) continue;
          if (tr === row && tc === col) continue;
          const key = tr * this.cols + tc;
          if (seen.has(key)) continue;
          seen.add(key);
          packetQueue.push({ fromRow: row, fromCol: col, toRow: tr, toCol: tc });
        }
      }
    }

    const getLinkId = (from, to) => {
      if (from.row === to.row) return `h-${from.row}-${Math.min(from.col, to.col)}`;
      return `v-${Math.min(from.row, to.row)}-${from.col}`;
    };

    const getPacketLinks = (packet) => {
      const path = buildManhattanPath(packet.fromRow, packet.fromCol, packet.toRow, packet.toCol);
      let prev = { row: packet.fromRow, col: packet.fromCol };
      const links = [];
      for (const hop of path) {
        links.push(getLinkId(prev, hop));
        prev = hop;
      }
      return links;
    };

    // Greedy link-conflict scheduler. Reverse iteration is for safe splice-during-iteration.
    const schedulePackets = () => {
      const scheduled = [];
      const unscheduled = [...packetQueue];
      let cycle = 0;

      while (unscheduled.length > 0) {
        const cycleLinks = new Set();
        const cyclePackets = [];

        for (let i = unscheduled.length - 1; i >= 0; i--) {
          const linkIds = getPacketLinks(unscheduled[i]);
          if (linkIds.some((id) => cycleLinks.has(id))) continue;
          for (const id of linkIds) cycleLinks.add(id);
          cyclePackets.push({ packet: unscheduled[i], cycle });
          unscheduled.splice(i, 1);
        }

        scheduled.push(...cyclePackets);
        cycle++;
      }

      return scheduled;
    };

    const scheduledPackets = schedulePackets();
    let maxCycle = 0;
    let maxDistance = 0;

    scheduledPackets.forEach(({ packet, cycle }) => {
      maxCycle = Math.max(maxCycle, cycle);
      const distance =
        Math.abs(packet.toRow - packet.fromRow) +
        Math.abs(packet.toCol - packet.fromCol);
      maxDistance = Math.max(maxDistance, distance);

      this._setTimeout(() => {
        if (this.cancelled) return;
        const targetPE = this.getPE(packet.toRow, packet.toCol);
        if (targetPE) {
          this._setTimeout(() => {
            if (this.cancelled) return;
            targetPE.activate();
          }, HOP_DELAY * distance);

          this.packets.push(
            new MultiHopPacket(
              packet.fromRow, packet.fromCol,
              packet.toRow, packet.toCol,
              performance.now(),
            ),
          );
        }
      }, cycle * scheduleDelay);
    });

    if (onComplete) {
      const lastPacketAnimation = maxDistance * HOP_DELAY;
      const totalDuration = maxCycle * scheduleDelay + lastPacketAnimation;
      this._setTimeout(() => {
        if (this.cancelled) return;
        onComplete();
      }, totalDuration);
    }
  }

  conjugateGradient(iterations = 5, onStep) {
    const runStep = (step, stepIndex, iter, callback) => {
      if (onStep) onStep(iter, stepIndex, step);

      switch (step.type) {
        case "spmv": this.spmvPattern(callback); break;
        case "dot": this.runAllReduce(callback); break;
        case "axpy":
          this.activateAllPEs();
          this._setTimeout(callback, STEP_DELAY);
          break;
        case "check":
          this._setTimeout(callback, STEP_DELAY);
          break;
      }
    };

    const runIteration = (iter, callback) => {
      const steps = [
        { name: "SpMV: Ap = A × p", type: "spmv", line: 4 },
        { name: "Dot: \u03B1 = (r\u1D40r) / (p\u1D40Ap)", type: "dot", line: 5 },
        { name: "AXPY: x = x + \u03B1p", type: "axpy", line: 6 },
        { name: "AXPY: r = r - \u03B1Ap", type: "axpy", line: 7 },
        { name: "Dot: \u03B2 = (r\u1D40r) / (r\u1D40r)\u208D\u2096\u208B\u2081\u208E", type: "dot", line: 8 },
        { name: "AXPY: p = r + \u03B2p", type: "axpy", line: 9 },
        { name: "Check convergence", type: "check", line: 10 },
      ];

      let stepIndex = 0;
      const runNextStep = () => {
        if (this.cancelled) return;
        if (stepIndex < steps.length) {
          runStep(steps[stepIndex], stepIndex, iter, () => { stepIndex++; runNextStep(); });
        } else if (callback) {
          callback();
        }
      };
      runNextStep();
    };

    this._setTimeout(() => {
      if (this.cancelled) return;
      this.activateAllPEs();
      if (onStep)
        onStep(0, -1, { name: "Initialize: r = b - Ax\u2080, p = r", type: "init", line: 1 });

      let currentIteration = 0;
      const runNextIteration = () => {
        if (currentIteration < iterations) {
          runIteration(currentIteration, () => { currentIteration++; runNextIteration(); });
        }
      };
      this._setTimeout(runNextIteration, STEP_DELAY);
    }, 0);
  }
}
