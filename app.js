import { Grid } from "./grid.js";
import { DataPacket } from "./packet.js";
import { AnimationLoop } from "./animation.js";
import { TraceParser } from "./trace-parser.js";
import { GRID_ROWS, GRID_COLS, CELL_SIZE, GAP } from "./constants.js";

let grid;
let animationLoop;
let canvas;
let ctx;
let simulationInterval;
let traceData = null;
let replayState = null;

function init() {
  canvas = document.getElementById("wseCanvas");
  ctx = canvas.getContext("2d");

  setGrid(GRID_ROWS, GRID_COLS);

  animationLoop = new AnimationLoop(update, draw);

  setupEventListeners();
}

function update() {
  grid.update();

  if (replayState && replayState.playing) {
    const now = performance.now();
    const elapsed = now - replayState.lastTickTime;
    const msPerCycle = 1000 / replayState.speed;
    const cyclesToAdvance = Math.floor(elapsed / msPerCycle);

    if (cyclesToAdvance > 0) {
      replayState.lastTickTime += cyclesToAdvance * msPerCycle;
      const endCycle = Math.min(
        replayState.currentCycle + cyclesToAdvance,
        replayState.maxCycle,
      );

      for (
        let cycle = replayState.currentCycle + 1;
        cycle <= endCycle;
        cycle++
      ) {
        applyCycleEvents(cycle, msPerCycle);
      }

      replayState.currentCycle = endCycle;
      updateScrubUI();

      if (endCycle >= replayState.maxCycle) {
        replayState.playing = false;
        document.getElementById("playPauseBtn").textContent = "\u25B6";
        document.getElementById("cycleDisplay").textContent =
          `Done (${traceData.totalEvents} events)`;
      }
    }
  }
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  grid.draw(ctx);
}

function startSimulation() {
  if (simulationInterval) return;

  showPanel("cg");
  setGrid(GRID_ROWS, GRID_COLS);
  animationLoop.start();

  simulationInterval = setInterval(() => {
    const row = Math.floor(Math.random() * GRID_ROWS);
    const col = Math.floor(Math.random() * GRID_COLS);
    grid.activatePE(row, col);

    const directions = [
      { dr: -1, dc: 0 },
      { dr: 1, dc: 0 },
      { dr: 0, dc: -1 },
      { dr: 0, dc: 1 },
    ];

    const dir = directions[Math.floor(Math.random() * directions.length)];
    const newRow = row + dir.dr;
    const newCol = col + dir.dc;

    if (
      newRow >= 0 &&
      newRow < GRID_ROWS &&
      newCol >= 0 &&
      newCol < GRID_COLS
    ) {
      grid.sendPacket(row, col, newRow, newCol);
    }
  }, 100);
}

function stopSimulation() {
  cancelReplay();
  if (simulationInterval) {
    clearInterval(simulationInterval);
    simulationInterval = null;
  }
  animationLoop.stop();
}

function setupEventListeners() {
  document
    .getElementById("startBtn")
    .addEventListener("click", startSimulation);
  document
    .getElementById("allReduceFullBtn")
    .addEventListener("click", startAllReduceFull);
  document.getElementById("spmvBtn").addEventListener("click", startSpMV);
  document.getElementById("cgBtn").addEventListener("click", startCG);
  document
    .getElementById("traceFileInput")
    .addEventListener("change", handleTraceFile);
  document.getElementById("scrubBar").addEventListener("input", (e) => {
    if (!replayState) return;
    seekToCycle(parseInt(e.target.value));
  });
  document.getElementById("playPauseBtn").addEventListener("click", () => {
    if (!replayState) return;
    replayState.playing = !replayState.playing;
    if (replayState.playing) {
      replayState.lastTickTime = performance.now();
      // Unfreeze any frozen packets from scrubbing
      const msPerCycle = 1000 / replayState.speed;
      const now = Date.now();
      for (const pkt of grid.packets) {
        if (pkt.startTime === Infinity) {
          pkt.startTime = now;
          pkt.duration = msPerCycle;
        }
      }
      document.getElementById("playPauseBtn").textContent = "\u23F8";
    } else {
      document.getElementById("playPauseBtn").textContent = "\u25B6";
    }
  });
  document.getElementById("speedDown").addEventListener("click", () => {
    if (!replayState || replayState.speed <= 1) return;
    replayState.speed /= 2;
    replayState.lastTickTime = performance.now();
    document.getElementById("speedDisplay").textContent = `${replayState.speed} cyc/s`;
  });
  document.getElementById("speedUp").addEventListener("click", () => {
    if (!replayState) return;
    replayState.speed *= 2;
    replayState.lastTickTime = performance.now();
    document.getElementById("speedDisplay").textContent = `${replayState.speed} cyc/s`;
  });
}

function startAllReduceFull() {
  stopSimulation();
  showPanel("cg");
  setGrid(GRID_ROWS, GRID_COLS);
  animationLoop.start();
  grid.runAllReduce();
}

function startSpMV() {
  stopSimulation();
  showPanel("cg");
  setGrid(GRID_ROWS, GRID_COLS);
  animationLoop.start();
  grid.spmvPattern();
}

function startCG() {
  stopSimulation();
  showPanel("cg");
  setGrid(GRID_ROWS, GRID_COLS);
  animationLoop.start();
  clearCodeHighlight();
  grid.conjugateGradient(5, updateCodePanel);
}

function clearCodeHighlight() {
  document.querySelectorAll(".code-line").forEach((line) => {
    line.classList.remove("active");
  });
}

function updateCodePanel(phase, stage, step) {
  clearCodeHighlight();

  const lineNumber = step.line;
  const line = document.querySelector(`.code-line[data-line="${lineNumber}"]`);

  if (line) {
    line.classList.add("active");
  }

  const iterationValue = document.getElementById("iterationValue");
  const stepValue = document.getElementById("stepValue");
  const operationValue = document.getElementById("operationValue");

  iterationValue.textContent = `${phase + 1}/5`;
  stepValue.textContent = `${stage + 1}/7`;

  operationValue.textContent = step.name;
}

const MAX_LOG_ENTRIES = 500;

function showPanel(panel) {
  document.getElementById("cgPanel").style.display =
    panel === "cg" ? "flex" : "none";
  document.getElementById("tracePanel").style.display =
    panel === "trace" ? "flex" : "none";
  document.getElementById("playbackBar").style.display =
    panel === "trace" ? "flex" : "none";
}

function appendTraceEvents(cycle, events) {
  const log = document.getElementById("traceLog");

  for (const evt of events.landings) {
    const entry = document.createElement("div");
    entry.className = "trace-entry trace-landing";
    const dir = evt.dir === "R" ? "local" : `\u2190 ${evt.dir}`;
    entry.innerHTML =
      `<span class="trace-cycle">@${cycle}</span> P${evt.x}.${evt.y} ${dir} C${evt.color}`;
    log.appendChild(entry);
  }

  while (log.children.length > MAX_LOG_ENTRIES) {
    log.removeChild(log.firstChild);
  }

  log.scrollTop = log.scrollHeight;
}

const DEFAULT_DISPLAY_SIZE = GRID_COLS * (CELL_SIZE + GAP) + GAP;

function setGrid(rows, cols) {
  grid = new Grid(rows, cols, CELL_SIZE, GAP);
  const naturalWidth = cols * (CELL_SIZE + GAP) + GAP;
  const naturalHeight = rows * (CELL_SIZE + GAP) + GAP;
  const scale = DEFAULT_DISPLAY_SIZE / Math.max(naturalWidth, naturalHeight);
  canvas.width = Math.round(naturalWidth * scale);
  canvas.height = Math.round(naturalHeight * scale);
  canvas.style.width = "";
  canvas.style.height = "";
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
}

async function handleTraceFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  stopSimulation();
  traceData = await TraceParser.parse(file);

  setGrid(traceData.dimY, traceData.dimX);
  animationLoop.start();
  showPanel("trace");
  document.getElementById("traceLog").innerHTML = "";

  const { minCycle, maxCycle } = traceData;
  const speed = 4;
  document.getElementById("speedDisplay").textContent = `${speed} cyc/s`;

  replayState = {
    currentCycle: minCycle,
    speed,
    playing: false,
    lastTickTime: performance.now(),
    minCycle,
    maxCycle,
  };

  const scrubBar = document.getElementById("scrubBar");
  scrubBar.min = minCycle;
  scrubBar.max = maxCycle;
  scrubBar.value = minCycle;

  document.getElementById("playPauseBtn").textContent = "\u25B6";
  updateScrubUI();
}

function applyCycleEvents(cycle, msPerCycle) {
  const events = traceData.eventsByCycle.get(cycle);
  if (!events) return;

  appendTraceEvents(cycle, events);

  for (const evt of events.landings) {
    const dest = TraceParser.toGridCoords(evt.x, evt.y, traceData.dimY);

    if (evt.dir !== "R") {
      const src = TraceParser.sourceCoords(evt.x, evt.y, evt.dir);
      if (src) {
        const srcGrid = TraceParser.toGridCoords(src.x, src.y, traceData.dimY);
        grid.sendPacket(srcGrid.row, srcGrid.col, dest.row, dest.col, msPerCycle);
      }
    }
  }

  for (const evt of events.execChanges) {
    const { row, col } = TraceParser.toGridCoords(evt.x, evt.y, traceData.dimY);
    grid.setPEBusy(row, col, evt.busy, evt.op);
  }
}

function updateScrubUI() {
  if (!replayState) return;
  const scrubBar = document.getElementById("scrubBar");
  const cycleDisplay = document.getElementById("cycleDisplay");
  scrubBar.value = replayState.currentCycle;
  cycleDisplay.textContent =
    `Cycle ${replayState.currentCycle} / ${replayState.maxCycle}`;
}

function seekToCycle(targetCycle) {
  if (!replayState || !traceData) return;

  // Clear in-flight packets
  grid.packets.length = 0;

  // Reconstruct PE states from peStateIndex via binary search
  const { peStateIndex } = traceData;

  // Reset all PEs
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      grid.setPEBusy(r, c, false, null);
    }
  }

  // Apply last known state at or before targetCycle for each PE
  for (const [key, events] of peStateIndex) {
    // Binary search for last event with cycle <= targetCycle
    let lo = 0;
    let hi = events.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid].cycle <= targetCycle) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (found >= 0) {
      const evt = events[found];
      const [x, y] = key.split(",").map(Number);
      const { row, col } = TraceParser.toGridCoords(x, y, traceData.dimY);
      grid.setPEBusy(row, col, evt.busy, evt.op);
    }
  }

  // Create frozen packets at origin for this cycle's landings
  const events = traceData.eventsByCycle.get(targetCycle);
  if (events) {
    for (const evt of events.landings) {
      if (evt.dir === "R") continue;
      const src = TraceParser.sourceCoords(evt.x, evt.y, evt.dir);
      if (!src) continue;
      const srcGrid = TraceParser.toGridCoords(src.x, src.y, traceData.dimY);
      const destGrid = TraceParser.toGridCoords(evt.x, evt.y, traceData.dimY);
      const fromPE = grid.getPE(srcGrid.row, srcGrid.col);
      const toPE = grid.getPE(destGrid.row, destGrid.col);
      if (fromPE && toPE) {
        const fromX = fromPE.x + grid.cellSize / 2;
        const fromY = fromPE.y + grid.cellSize / 2;
        const toX = toPE.x + grid.cellSize / 2;
        const toY = toPE.y + grid.cellSize / 2;
        grid.packets.push(
          new DataPacket(fromX, fromY, toX, toY, Infinity, 1000 / replayState.speed),
        );
      }
    }
  }

  // Clear trace log and update state
  document.getElementById("traceLog").innerHTML = "";
  replayState.currentCycle = targetCycle;
  replayState.lastTickTime = performance.now();
  updateScrubUI();
}

function cancelReplay() {
  replayState = null;
  document.getElementById("cycleDisplay").textContent = "";
  document.getElementById("playbackBar").style.display = "none";
}

document.addEventListener("DOMContentLoaded", init);
