import { Grid } from "./grid.js";
import { AnimationLoop } from "./animation.js";
import { TraceParser } from "./trace-parser.js";
import { GRID_ROWS, GRID_COLS, CELL_SIZE, GAP, MS_PER_CYCLE } from "./constants.js";

let grid;
let animationLoop;
let canvas;
let ctx;
let simulationInterval;
let traceData = null;
let replayTimeouts = [];
let isReplaying = false;

function init() {
  canvas = document.getElementById("wseCanvas");
  ctx = canvas.getContext("2d");

  setGrid(GRID_ROWS, GRID_COLS);

  animationLoop = new AnimationLoop(update, draw);

  setupEventListeners();
}

function update() {
  grid.update();
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  grid.draw(ctx);
}

function startSimulation() {
  if (simulationInterval) return;

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
  document
    .getElementById("replayTraceBtn")
    .addEventListener("click", replayTrace);
}

function startAllReduceFull() {
  stopSimulation();
  animationLoop.start();
  grid.runAllReduce();
}

function startSpMV() {
  stopSimulation();
  animationLoop.start();
  grid.spmvPattern();
}

function startCG() {
  stopSimulation();
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

  const statusEl = document.getElementById("traceStatus");
  statusEl.textContent = "Parsing...";

  traceData = await TraceParser.parse(file);

  statusEl.textContent =
    `${traceData.dimX}x${traceData.dimY} grid, ` +
    `${traceData.totalEvents} events, ` +
    `cycles ${traceData.minCycle}\u2013${traceData.maxCycle}`;

  setGrid(traceData.dimY, traceData.dimX);
  document.getElementById("replayTraceBtn").disabled = false;
}

function replayTrace() {
  if (!traceData || isReplaying) return;

  stopSimulation();
  isReplaying = true;
  animationLoop.start();

  setGrid(traceData.dimY, traceData.dimX);

  const { eventsByCycle, minCycle, maxCycle } = traceData;
  const cycleDisplay = document.getElementById("cycleDisplay");
  const activeCycles = Array.from(eventsByCycle.keys()).sort((a, b) => a - b);

  for (const cycle of activeCycles) {
    const delayMs = (cycle - minCycle) * MS_PER_CYCLE;
    const events = eventsByCycle.get(cycle);

    const timeoutId = setTimeout(() => {
      cycleDisplay.textContent = `Cycle ${cycle} / ${maxCycle}`;

      for (const evt of events) {
        const dest = TraceParser.toGridCoords(evt.x, evt.y, traceData.dimY);
        grid.activatePE(dest.row, dest.col);

        if (evt.dir !== "R") {
          const src = TraceParser.sourceCoords(evt.x, evt.y, evt.dir);
          if (src) {
            const srcGrid = TraceParser.toGridCoords(src.x, src.y, traceData.dimY);
            grid.sendPacket(srcGrid.row, srcGrid.col, dest.row, dest.col);
          }
        }
      }
    }, delayMs);

    replayTimeouts.push(timeoutId);
  }

  const totalDuration = (maxCycle - minCycle) * MS_PER_CYCLE + 500;
  const endTimeout = setTimeout(() => {
    isReplaying = false;
    cycleDisplay.textContent = `Done (${traceData.totalEvents} events)`;
  }, totalDuration);
  replayTimeouts.push(endTimeout);
}

function cancelReplay() {
  for (const id of replayTimeouts) {
    clearTimeout(id);
  }
  replayTimeouts = [];
  isReplaying = false;
  document.getElementById("cycleDisplay").textContent = "";
}

document.addEventListener("DOMContentLoaded", init);
