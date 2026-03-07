// Demo-only constants, algorithms, and UI glue.

import { CELL_SIZE } from "./constants.js";
import { drawPacketDot } from "./draw-utils.js";

let grid, els, animationLoop, cancelReplay, showPanel, setGrid;

export function initDemo(deps) {
  grid = deps.grid;
  els = deps.els;
  animationLoop = deps.animationLoop;
  cancelReplay = deps.cancelReplay;
  showPanel = deps.showPanel;
  setGrid = deps.setGrid;
}

export function setDemoGrid(g) {
  grid = g;
}

// --- Demo constants ---

export const GRID_ROWS = 32;
export const GRID_COLS = 32;
export const DEMO_HOP_DELAY = 100;
const DEMO_STEP_DELAY = 150;
export const DEMO_PE_ON_DURATION = 200;
export const DEMO_PE_BRIGHTEN_DURATION = 25;
export const DEMO_PE_DIM_DURATION = 500;

// --- MultiHopPacket (used only by SpMV demo) ---

function buildManhattanPath(fromRow, fromCol, toRow, toCol) {
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

class MultiHopPacket {
  constructor(fromRow, fromCol, toRow, toCol, startTime) {
    this.fromRow = fromRow;
    this.fromCol = fromCol;
    this.toRow = toRow;
    this.toCol = toCol;
    this.startTime = startTime;
    this.path = buildManhattanPath(fromRow, fromCol, toRow, toCol);
  }

  getCurrentPosition(currentTime, grid) {
    const elapsed = currentTime - this.startTime;
    const half = CELL_SIZE / 2;
    if (elapsed <= 0 || this.path.length === 0) {
      const pe = grid.getPE(this.fromRow, this.fromCol);
      if (pe) return { x: pe.x + half, y: pe.y + half };
      return null;
    }
    if (elapsed >= this.path.length * DEMO_HOP_DELAY) {
      const pe = grid.getPE(this.toRow, this.toCol);
      if (pe) return { x: pe.x + half, y: pe.y + half };
      return null;
    }

    const hopIndex = Math.floor(elapsed / DEMO_HOP_DELAY);
    const hopProgress = (elapsed % DEMO_HOP_DELAY) / DEMO_HOP_DELAY;
    if (hopIndex >= this.path.length) return null;

    const prev = hopIndex === 0
      ? grid.getPE(this.fromRow, this.fromCol)
      : grid.getPE(this.path[hopIndex - 1].row, this.path[hopIndex - 1].col);
    const next = grid.getPE(this.path[hopIndex].row, this.path[hopIndex].col);
    if (!prev || !next) return null;

    return {
      x: prev.x + half + (next.x - prev.x) * hopProgress,
      y: prev.y + half + (next.y - prev.y) * hopProgress,
    };
  }

  isComplete(currentTime) {
    return currentTime - this.startTime >= this.path.length * DEMO_HOP_DELAY;
  }

  draw(ctx, currentTime, grid) {
    const pos = this.getCurrentPosition(currentTime, grid);
    if (!pos) return;
    drawPacketDot(ctx, pos.x, pos.y);
  }
}

// --- Algorithm helpers ---

function gridCenter(grid) {
  const centerCol1 = Math.floor((grid.cols - 1) / 2);
  const centerCol2 = grid.cols % 2 === 0 ? centerCol1 + 1 : centerCol1;
  const centerRow1 = Math.floor((grid.rows - 1) / 2);
  const centerRow2 = grid.rows % 2 === 0 ? centerRow1 + 1 : centerRow1;
  return { centerCol1, centerCol2, centerRow1, centerRow2 };
}

function allReducePhase(grid, phase) {
  const { centerCol1, centerCol2 } = gridCenter(grid);
  const excludeCount = phase - 1;

  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      if (col < excludeCount || col >= grid.cols - excludeCount) continue;
      const pe = grid.getPE(row, col);
      pe.activate();
      if (col === centerCol1 || col === centerCol2) continue;
      const nextCol = col < centerCol1 ? col + 1 : col - 1;
      grid.sendPacket(row, col, row, nextCol);
    }
  }
}

function allReduceVerticalPhase(grid, phase) {
  const { centerCol1, centerCol2, centerRow1, centerRow2 } = gridCenter(grid);
  const excludeCount = phase - 1;

  for (let col = centerCol1; col <= centerCol2; col++) {
    for (let row = 0; row < grid.rows; row++) {
      if (row < excludeCount || row >= grid.rows - excludeCount) continue;
      const pe = grid.getPE(row, col);
      pe.activate();
      if (row === centerRow1 || row === centerRow2) continue;
      const nextRow = row < centerRow1 ? row + 1 : row - 1;
      grid.sendPacket(row, col, nextRow, col);
    }
  }
}

function circularExchange(grid) {
  const { centerCol1, centerCol2, centerRow1, centerRow2 } = gridCenter(grid);
  grid.activatePE(centerRow1, centerCol1);
  grid.activatePE(centerRow1, centerCol2);
  grid.activatePE(centerRow2, centerCol1);
  grid.activatePE(centerRow2, centerCol2);
  grid.sendPacket(centerRow1, centerCol1, centerRow2, centerCol1);
  grid.sendPacket(centerRow2, centerCol1, centerRow2, centerCol2);
  grid.sendPacket(centerRow2, centerCol2, centerRow1, centerCol2);
  grid.sendPacket(centerRow1, centerCol2, centerRow1, centerCol1);
}

function broadcast(grid, onComplete) {
  const { centerCol1, centerCol2, centerRow1, centerRow2 } = gridCenter(grid);
  const { cols } = grid;
  const visited = new Set();
  let queue = [];

  for (let row = centerRow1; row <= centerRow2; row++) {
    for (let col = centerCol1; col <= centerCol2; col++) {
      const pe = grid.getPE(row, col);
      if (pe) {
        pe.activate();
        queue.push({ row, col, isCenterCol: true });
        visited.add(row * cols + col);
      }
    }
  }

  const tryExpand = (fromRow, fromCol, toRow, toCol, isCenterCol, nextQueue) => {
    const key = toRow * cols + toCol;
    const pe = grid.getPE(toRow, toCol);
    if (!pe || visited.has(key)) return;
    pe.activate();
    grid.sendPacket(fromRow, fromCol, toRow, toCol);
    visited.add(key);
    nextQueue.push({ row: toRow, col: toCol, isCenterCol });
  };

  const broadcastStep = () => {
    if (grid.cancelled) return;
    if (queue.length === 0) { if (onComplete) onComplete(); return; }

    const nextQueue = [];
    for (const { row, col, isCenterCol } of queue) {
      if (!grid.getPE(row, col)) continue;
      if (isCenterCol) {
        tryExpand(row, col, row - 1, col, true, nextQueue);
        tryExpand(row, col, row + 1, col, true, nextQueue);
      }
      tryExpand(row, col, row, col - 1, false, nextQueue);
      tryExpand(row, col, row, col + 1, false, nextQueue);
    }

    queue = nextQueue;
    if (queue.length > 0) {
      grid._setTimeout(broadcastStep, DEMO_STEP_DELAY);
    } else if (onComplete) {
      onComplete();
    }
  };

  broadcastStep();
}

// --- Exported algorithm functions ---

function runAllReduce(grid, onComplete) {
  const maxPhase = Math.ceil(grid.cols / 2);
  const maxVerticalPhase = Math.ceil(grid.rows / 2);
  const circularIterations = 3;

  const runHorizontalPhase = (phase) => {
    if (grid.cancelled) return;
    if (phase > maxPhase) { runVerticalPhase(1); return; }
    allReducePhase(grid, phase);
    grid._setTimeout(() => runHorizontalPhase(phase + 1), DEMO_STEP_DELAY);
  };

  const runVerticalPhase = (phase) => {
    if (grid.cancelled) return;
    if (phase > maxVerticalPhase) { runCircular(0); return; }
    allReduceVerticalPhase(grid, phase);
    grid._setTimeout(() => runVerticalPhase(phase + 1), DEMO_STEP_DELAY);
  };

  const runCircular = (i) => {
    if (grid.cancelled) return;
    if (i >= circularIterations) { broadcast(grid, onComplete); return; }
    circularExchange(grid);
    grid._setTimeout(() => runCircular(i + 1), DEMO_STEP_DELAY);
  };

  runHorizontalPhase(1);
}

function spmvPattern(grid, onComplete) {
  const packetQueue = [];

  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const pe = grid.getPE(row, col);
      if (!pe) continue;
      pe.activate();

      const numTargets = Math.floor(Math.random() * 10) + 1;
      const seen = new Set();
      for (let attempts = 0; seen.size < numTargets && attempts < 100; attempts++) {
        const tr = row + Math.floor(Math.random() * 7) - 3;
        const tc = col + Math.floor(Math.random() * 7) - 3;
        if (tr < 0 || tr >= grid.rows || tc < 0 || tc >= grid.cols) continue;
        if (tr === row && tc === col) continue;
        const key = tr * grid.cols + tc;
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

    grid._setTimeout(() => {
      if (grid.cancelled) return;
      const targetPE = grid.getPE(packet.toRow, packet.toCol);
      if (targetPE) {
        grid._setTimeout(() => {
          if (grid.cancelled) return;
          targetPE.activate();
        }, DEMO_HOP_DELAY * distance);

        grid.packets.push(
          new MultiHopPacket(
            packet.fromRow, packet.fromCol,
            packet.toRow, packet.toCol,
            performance.now(),
          ),
        );
      }
    }, cycle * DEMO_HOP_DELAY);
  });

  if (onComplete) {
    const lastPacketAnimation = maxDistance * DEMO_HOP_DELAY;
    const totalDuration = maxCycle * DEMO_HOP_DELAY + lastPacketAnimation;
    grid._setTimeout(() => {
      if (grid.cancelled) return;
      onComplete();
    }, totalDuration);
  }
}

const CG_STEPS = [
  { name: "SpMV: Ap = A \u00d7 p", type: "spmv", line: 4 },
  { name: "Dot: \u03B1 = (r\u1D40r) / (p\u1D40Ap)", type: "dot", line: 5 },
  { name: "AXPY: x = x + \u03B1p", type: "axpy", line: 6 },
  { name: "AXPY: r = r - \u03B1Ap", type: "axpy", line: 7 },
  { name: "Dot: \u03B2 = (r\u1D40r) / (r\u1D40r)\u208D\u2096\u208B\u2081\u208E", type: "dot", line: 8 },
  { name: "AXPY: p = r + \u03B2p", type: "axpy", line: 9 },
  { name: "Check convergence", type: "check", line: 10 },
];

function conjugateGradient(grid, iterations = 5, onStep) {
  const runStep = (step, stepIndex, iter, callback) => {
    if (onStep) onStep(iter, stepIndex, step);

    switch (step.type) {
      case "spmv": spmvPattern(grid, callback); break;
      case "dot": runAllReduce(grid, callback); break;
      case "axpy":
        grid.activateAllPEs();
        grid._setTimeout(callback, DEMO_STEP_DELAY);
        break;
      case "check":
        grid._setTimeout(callback, DEMO_STEP_DELAY);
        break;
    }
  };

  const runIteration = (iter, callback) => {
    let stepIndex = 0;
    const runNextStep = () => {
      if (grid.cancelled) return;
      if (stepIndex < CG_STEPS.length) {
        runStep(CG_STEPS[stepIndex], stepIndex, iter, () => { stepIndex++; runNextStep(); });
      } else if (callback) {
        callback();
      }
    };
    runNextStep();
  };

  grid.activateAllPEs();
  if (onStep)
    onStep(0, -1, { name: "Initialize: r = b - Ax\u2080, p = r", type: "init", line: 1 });

  let currentIteration = 0;
  const runNextIteration = () => {
    if (currentIteration < iterations) {
      runIteration(currentIteration, () => { currentIteration++; runNextIteration(); });
    }
  };
  grid._setTimeout(runNextIteration, DEMO_STEP_DELAY);
}

// --- Demo UI glue (called from app.js) ---

const DIRECTIONS = [
  { dr: -1, dc: 0 },
  { dr: 1, dc: 0 },
  { dr: 0, dc: -1 },
  { dr: 0, dc: 1 },
];

let simulationInterval;

export function startSimulation() {
  if (simulationInterval) return;
  cancelReplay();
  showPanel(null);
  setGrid(GRID_ROWS, GRID_COLS);
  animationLoop.start();

  simulationInterval = setInterval(() => {
    const row = Math.floor(Math.random() * grid.rows);
    const col = Math.floor(Math.random() * grid.cols);
    grid.activatePE(row, col);
    const dir = DIRECTIONS[Math.floor(Math.random() * DIRECTIONS.length)];
    const newRow = row + dir.dr;
    const newCol = col + dir.dc;
    if (newRow >= 0 && newRow < grid.rows && newCol >= 0 && newCol < grid.cols) {
      grid.sendPacket(row, col, newRow, newCol);
    }
  }, 100);
}

export function stopSimulation() {
  cancelReplay();
  if (simulationInterval) {
    clearInterval(simulationInterval);
    simulationInterval = null;
  }
  animationLoop.stop();
}

export function isSimulationRunning() {
  return !!simulationInterval;
}

function startAlgorithm() {
  stopSimulation();
  setGrid(GRID_ROWS, GRID_COLS);
  animationLoop.start();
}

export function startAllReduceFull() {
  startAlgorithm();
  showPanel(null);
  runAllReduce(grid);
}

export function startSpMV() {
  startAlgorithm();
  showPanel(null);
  spmvPattern(grid);
}

export function startCG() {
  startAlgorithm();
  showPanel("cg");
  clearCodeHighlight();
  conjugateGradient(grid, 5, (phase, stage, step) => {
    clearCodeHighlight();
    const line = document.querySelector(`.code-line[data-line="${step.line}"]`);
    if (line) line.classList.add("active");
    els.iterationValue.textContent = stage < 0 ? "-" : `${phase + 1}/5`;
    els.stepValue.textContent = stage < 0 ? "Init" : `${stage + 1}/7`;
    els.operationValue.textContent = step.name;
  });
}

function clearCodeHighlight() {
  document.querySelectorAll(".code-line").forEach((line) => {
    line.classList.remove("active");
  });
}
