import { PE } from "./pe.js";
import { DataPacket } from "./packet.js";
import { MultiHopPacket } from "./multihop-packet.js";

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
    this.packets = [];
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
    this.packets.forEach((packet) => {
      if (packet instanceof MultiHopPacket) {
        packet.draw(ctx, Date.now(), this);
      } else {
        packet.draw(ctx, Date.now());
      }
    });
  }

  getActivePECount() {
    return this.pes.filter((pe) => pe.active).length;
  }

  getPacketCount() {
    return this.packets.length;
  }

  allReducePhase1() {
    const isEvenCols = this.cols % 2 === 0;
    const centerCol1 = Math.floor((this.cols - 1) / 2);
    const centerCol2 = isEvenCols ? centerCol1 + 1 : centerCol1;

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const pe = this.getPE(row, col);
        pe.activate();

        if (col === centerCol1 || col === centerCol2) continue;

        let nextCol;
        if (col < centerCol1) {
          nextCol = col + 1;
        } else if (col > centerCol2) {
          nextCol = col - 1;
        } else {
          nextCol = col < centerCol2 ? centerCol1 : centerCol2;
        }

        this.sendPacket(row, col, row, nextCol, 600);
      }
    }
  }

  allReducePhase2() {
    const isEvenCols = this.cols % 2 === 0;
    const centerCol1 = Math.floor((this.cols - 1) / 2);
    const centerCol2 = isEvenCols ? centerCol1 + 1 : centerCol1;

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        if (col === 0 || col === this.cols - 1) continue;

        const pe = this.getPE(row, col);
        pe.activate();

        if (col === centerCol1 || col === centerCol2) continue;

        let nextCol;
        if (col < centerCol1) {
          nextCol = col + 1;
        } else if (col > centerCol2) {
          nextCol = col - 1;
        } else {
          nextCol = col < centerCol2 ? centerCol1 : centerCol2;
        }

        this.sendPacket(row, col, row, nextCol, 600);
      }
    }
  }

  allReducePhase(phase) {
    const isEvenCols = this.cols % 2 === 0;
    const centerCol1 = Math.floor((this.cols - 1) / 2);
    const centerCol2 = isEvenCols ? centerCol1 + 1 : centerCol1;
    const excludeCount = phase - 1;

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        if (col < excludeCount || col >= this.cols - excludeCount) continue;

        const pe = this.getPE(row, col);
        pe.activate();

        if (col === centerCol1 || col === centerCol2) continue;

        let nextCol;
        if (col < centerCol1) {
          nextCol = col + 1;
        } else if (col > centerCol2) {
          nextCol = col - 1;
        } else {
          nextCol = col < centerCol2 ? centerCol1 : centerCol2;
        }

        this.sendPacket(row, col, row, nextCol, 600);
      }
    }
  }

  runAllReduce(speedMultiplier = 1, onComplete) {
    const maxPhase = Math.ceil(this.cols / 2);
    const phaseDelay = 450 / speedMultiplier;

    for (let phase = 1; phase <= maxPhase; phase++) {
      setTimeout(
        () => {
          this.allReducePhase(phase);
        },
        (phase - 1) * phaseDelay,
      );
    }

    const verticalStartDelay = maxPhase * phaseDelay;
    const maxVerticalPhase = Math.ceil(this.rows / 2);

    for (let phase = 1; phase <= maxVerticalPhase; phase++) {
      setTimeout(
        () => {
          this.allReduceVerticalPhase(phase);
        },
        verticalStartDelay + (phase - 1) * phaseDelay,
      );
    }

    const circularStartDelay =
      verticalStartDelay + maxVerticalPhase * phaseDelay;
    const circularIterations = 3;

    for (let i = 0; i < circularIterations; i++) {
      setTimeout(
        () => {
          this.circularExchange();
        },
        circularStartDelay + i * phaseDelay,
      );
    }

    const broadcastStartDelay =
      circularStartDelay + circularIterations * phaseDelay;
    setTimeout(() => {
      this.broadcast(speedMultiplier, onComplete);
    }, broadcastStartDelay);
  }

  allReduceVerticalPhase(phase) {
    const isEvenCols = this.cols % 2 === 0;
    const centerCol1 = Math.floor((this.cols - 1) / 2);
    const centerCol2 = isEvenCols ? centerCol1 + 1 : centerCol1;
    const isEvenRows = this.rows % 2 === 0;
    const centerRow1 = Math.floor((this.rows - 1) / 2);
    const centerRow2 = isEvenRows ? centerRow1 + 1 : centerRow1;
    const excludeCount = phase - 1;

    for (let col = centerCol1; col <= centerCol2; col++) {
      for (let row = 0; row < this.rows; row++) {
        if (row < excludeCount || row >= this.rows - excludeCount) continue;

        const pe = this.getPE(row, col);
        pe.activate();

        if (row === centerRow1 || row === centerRow2) continue;

        let nextRow;
        if (row < centerRow1) {
          nextRow = row + 1;
        } else if (row > centerRow2) {
          nextRow = row - 1;
        } else {
          nextRow = row < centerRow2 ? centerRow1 : centerRow2;
        }

        this.sendPacket(row, col, nextRow, col, 600);
      }
    }
  }

  circularExchange() {
    const isEvenCols = this.cols % 2 === 0;
    const centerCol1 = Math.floor((this.cols - 1) / 2);
    const centerCol2 = isEvenCols ? centerCol1 + 1 : centerCol1;
    const isEvenRows = this.rows % 2 === 0;
    const centerRow1 = Math.floor((this.rows - 1) / 2);
    const centerRow2 = isEvenRows ? centerRow1 + 1 : centerRow1;

    const topLeft = this.getPE(centerRow1, centerCol1);
    const topRight = this.getPE(centerRow1, centerCol2);
    const bottomRight = this.getPE(centerRow2, centerCol2);
    const bottomLeft = this.getPE(centerRow2, centerCol1);

    if (topLeft) topLeft.activate();
    if (topRight) topRight.activate();
    if (bottomRight) bottomRight.activate();
    if (bottomLeft) bottomLeft.activate();

    this.sendPacket(centerRow1, centerCol1, centerRow2, centerCol1, 600);
    this.sendPacket(centerRow2, centerCol1, centerRow2, centerCol2, 600);
    this.sendPacket(centerRow2, centerCol2, centerRow1, centerCol2, 600);
    this.sendPacket(centerRow1, centerCol2, centerRow1, centerCol1, 600);
  }

  broadcast(speedMultiplier = 1, onComplete) {
    const isEvenCols = this.cols % 2 === 0;
    const centerCol1 = Math.floor((this.cols - 1) / 2);
    const centerCol2 = isEvenCols ? centerCol1 + 1 : centerCol1;
    const isEvenRows = this.rows % 2 === 0;
    const centerRow1 = Math.floor((this.rows - 1) / 2);
    const centerRow2 = isEvenRows ? centerRow1 + 1 : centerRow1;

    const visited = new Set();
    const queue = [];

    for (let row = centerRow1; row <= centerRow2; row++) {
      for (let col = centerCol1; col <= centerCol2; col++) {
        const pe = this.getPE(row, col);
        if (pe) {
          pe.activate();
          queue.push({ row, col, isCenter: true, isCenterCol: true });
          visited.add(`${row},${col}`);
        }
      }
    }

    const broadcastStep = (step) => {
      if (queue.length === 0) {
        if (onComplete) onComplete();
        return;
      }

      const nextQueue = [];
      const delay = 450 / speedMultiplier;

      for (const item of queue) {
        const { row, col, isCenter, isCenterCol } = item;
        const pe = this.getPE(row, col);
        if (!pe) continue;

        if (isCenter || isCenterCol) {
          const up = this.getPE(row - 1, col);
          const down = this.getPE(row + 1, col);

          if (up && !visited.has(`${row - 1},${col}`)) {
            up.activate();
            this.sendPacket(row, col, row - 1, col, 600);
            visited.add(`${row - 1},${col}`);
            nextQueue.push({ row: row - 1, col, isCenterCol: true });
          }

          if (down && !visited.has(`${row + 1},${col}`)) {
            down.activate();
            this.sendPacket(row, col, row + 1, col, 600);
            visited.add(`${row + 1},${col}`);
            nextQueue.push({ row: row + 1, col, isCenterCol: true });
          }
        }

        const left = this.getPE(row, col - 1);
        const right = this.getPE(row, col + 1);

        if (left && !visited.has(`${row},${col - 1}`)) {
          left.activate();
          this.sendPacket(row, col, row, col - 1, 600);
          visited.add(`${row},${col - 1}`);
          nextQueue.push({ row, col: col - 1 });
        }

        if (right && !visited.has(`${row},${col + 1}`)) {
          right.activate();
          this.sendPacket(row, col, row, col + 1, 600);
          visited.add(`${row},${col + 1}`);
          nextQueue.push({ row, col: col + 1 });
        }
      }

      queue.length = 0;
      queue.push(...nextQueue);

      if (queue.length > 0) {
        setTimeout(() => broadcastStep(step + 1), delay);
      } else {
        if (onComplete) onComplete();
      }
    };

    broadcastStep(0);
  }

  spmvPattern(speedMultiplier = 1, onComplete) {
    const hopDelay = 300 / speedMultiplier;
    const packetQueue = [];

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const pe = this.getPE(row, col);
        if (!pe) continue;

        pe.activate();

        const numTargets = Math.floor(Math.random() * 10) + 1;
        const targets = new Set();
        let attempts = 0;
        const maxAttempts = 100;

        while (targets.size < numTargets && attempts < maxAttempts) {
          attempts++;
          const targetRow = row + Math.floor(Math.random() * 7) - 3;
          const targetCol = col + Math.floor(Math.random() * 7) - 3;

          if (
            targetRow >= 0 &&
            targetRow < this.rows &&
            targetCol >= 0 &&
            targetCol < this.cols &&
            (targetRow !== row || targetCol !== col)
          ) {
            targets.add(`${targetRow},${targetCol}`);
          }
        }

        targets.forEach((targetKey) => {
          const [targetRow, targetCol] = targetKey.split(",").map(Number);
          packetQueue.push({
            fromRow: row,
            fromCol: col,
            toRow: targetRow,
            toCol: targetCol,
          });
        });
      }
    }

    const getPacketPath = (packet) => {
      const path = [];
      let currentRow = packet.fromRow;
      let currentCol = packet.fromCol;

      const horizontalDirection = packet.toCol > packet.fromCol ? 1 : -1;
      const verticalDirection = packet.toRow > packet.fromRow ? 1 : -1;

      const horizontalSteps = Math.abs(packet.toCol - packet.fromCol);
      const verticalSteps = Math.abs(packet.toRow - packet.fromRow);

      for (let i = 0; i < horizontalSteps; i++) {
        const nextCol = currentCol + horizontalDirection;
        path.push({
          from: { row: currentRow, col: currentCol },
          to: { row: currentRow, col: nextCol },
        });
        currentCol = nextCol;
      }

      for (let i = 0; i < verticalSteps; i++) {
        const nextRow = currentRow + verticalDirection;
        path.push({
          from: { row: currentRow, col: currentCol },
          to: { row: nextRow, col: currentCol },
        });
        currentRow = nextRow;
      }

      return path;
    };

    const getLinkId = (from, to) => {
      if (from.row === to.row) {
        const minCol = Math.min(from.col, to.col);
        return `h-${from.row}-${minCol}`;
      } else {
        const minRow = Math.min(from.row, to.row);
        return `v-${minRow}-${from.col}`;
      }
    };

    const schedulePackets = () => {
      const scheduled = [];
      const unscheduled = [...packetQueue];
      let cycle = 0;

      while (unscheduled.length > 0) {
        const cycleLinks = new Set();
        const cyclePackets = [];

        for (let i = unscheduled.length - 1; i >= 0; i--) {
          const packet = unscheduled[i];
          const path = getPacketPath(packet);
          let canSchedule = true;

          for (const hop of path) {
            const linkId = getLinkId(hop.from, hop.to);
            if (cycleLinks.has(linkId)) {
              canSchedule = false;
              break;
            }
          }

          if (canSchedule) {
            for (const hop of path) {
              const linkId = getLinkId(hop.from, hop.to);
              cycleLinks.add(linkId);
            }
            cyclePackets.push({ packet, cycle });
            unscheduled.splice(i, 1);
          }
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

      setTimeout(() => {
        const targetPE = this.getPE(packet.toRow, packet.toCol);
        if (targetPE) {
          setTimeout(() => {
            targetPE.activate();
          }, hopDelay * distance);

          this.packets.push(
            new MultiHopPacket(
              packet.fromRow,
              packet.fromCol,
              packet.toRow,
              packet.toCol,
              Date.now(),
              hopDelay,
            ),
          );
        }
      }, cycle * hopDelay);
    });

    if (onComplete) {
      const totalDuration = (maxCycle + maxDistance) * hopDelay + 200;
      setTimeout(onComplete, totalDuration);
    }
  }

  conjugateGradient(iterations = 5, speedMultiplier = 1, onStep) {
    const runStep = (step, stepIndex, iter, callback) => {
      if (onStep) {
        onStep(iter, stepIndex, step);
      }

      if (step.type === "spmv") {
        this.spmvPattern(speedMultiplier, callback);
      } else if (step.type === "dot") {
        this.runAllReduce(speedMultiplier * 2, callback);
      } else if (step.type === "axpy") {
        for (let row = 0; row < this.rows; row++) {
          for (let col = 0; col < this.cols; col++) {
            const pe = this.getPE(row, col);
            if (pe) {
              pe.activate();
            }
          }
        }
        setTimeout(callback, 600 / speedMultiplier);
      } else if (step.type === "check") {
        setTimeout(callback, 400 / speedMultiplier);
      }
    };

    const runIteration = (iter, callback) => {
      const steps = [
        { name: "SpMV: Ap = A × p", type: "spmv", line: 4 },
        { name: "Dot: α = (rᵀr) / (pᵀAp)", type: "dot", line: 5 },
        { name: "AXPY: x = x + αp", type: "axpy", line: 6 },
        { name: "AXPY: r = r - αAp", type: "axpy", line: 7 },
        { name: "Dot: β = (rᵀr) / (rᵀr)₍ₖ₋₁₎", type: "dot", line: 8 },
        { name: "AXPY: p = r + βp", type: "axpy", line: 9 },
        { name: "Check convergence", type: "check", line: 10 },
      ];

      let stepIndex = 0;

      const runNextStep = () => {
        if (stepIndex < steps.length) {
          const step = steps[stepIndex];
          runStep(step, stepIndex, iter, () => {
            stepIndex++;
            runNextStep();
          });
        } else if (callback) {
          callback();
        }
      };

      runNextStep();
    };

    setTimeout(() => {
      for (let row = 0; row < this.rows; row++) {
        for (let col = 0; col < this.cols; col++) {
          const pe = this.getPE(row, col);
          if (pe) {
            pe.activate();
          }
        }
      }
      if (onStep)
        onStep("init", 0, {
          name: "Initialize: r = b - Ax₀, p = r",
          type: "init",
          line: 1,
        });

      let currentIteration = 0;

      const runNextIteration = () => {
        if (currentIteration < iterations) {
          runIteration(currentIteration, () => {
            currentIteration++;
            runNextIteration();
          });
        }
      };

      setTimeout(runNextIteration, 800 / speedMultiplier);
    }, 0);
  }
}
