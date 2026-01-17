import { Grid } from "./grid.js";
import { AnimationLoop } from "./animation.js";

const GRID_ROWS = 32;
const GRID_COLS = 32;
const CELL_SIZE = 20;
const GAP = 4;

let grid;
let animationLoop;
let canvas;
let ctx;
let simulationInterval;
let speedMultiplier = 4;

function init() {
  canvas = document.getElementById("wseCanvas");
  ctx = canvas.getContext("2d");

  const totalWidth = GRID_COLS * (CELL_SIZE + GAP) + GAP;
  const totalHeight = GRID_ROWS * (CELL_SIZE + GAP) + GAP;

  canvas.width = totalWidth;
  canvas.height = totalHeight;

  grid = new Grid(GRID_ROWS, GRID_COLS, CELL_SIZE, GAP);

  animationLoop = new AnimationLoop(update, draw);

  setupEventListeners();
  updateStats();
}

function update() {
  grid.update();
  updateStats();
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  grid.draw(ctx);
}

function updateStats() {
  document.getElementById("peCount").textContent = `PEs: ${grid.pes.length}`;
  document.getElementById("activePEs").textContent =
    `Active: ${grid.getActivePECount()}`;
  document.getElementById("dataTransfers").textContent =
    `Transfers: ${grid.getPacketCount()}`;
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
  document.getElementById("fftBtn").addEventListener("click", startFFT);

  const speedSlider = document.getElementById("speedSlider");
  const speedValue = document.getElementById("speedValue");
  speedSlider.addEventListener("input", (e) => {
    speedMultiplier = parseFloat(e.target.value);
    speedValue.textContent = `${speedMultiplier}x`;
  });
}

function startAllReduceFull() {
  stopSimulation();
  animationLoop.start();
  grid.runAllReduce(speedMultiplier);
}

function startSpMV() {
  stopSimulation();
  animationLoop.start();
  grid.spmvPattern(speedMultiplier);
}

function startCG() {
  stopSimulation();
  animationLoop.start();
  clearCodeHighlight();
  grid.conjugateGradient(5, speedMultiplier, updateCodePanel);
}

function startFFT() {
  stopSimulation();
  animationLoop.start();
  clearCodeHighlight();
  grid.run2DFFT(speedMultiplier, updateCodePanel);
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

  if (phase === "row") {
    iterationValue.textContent = "Row FFT";
    stepValue.textContent = `${stage}/5`;
  } else if (phase === "col") {
    iterationValue.textContent = "Column FFT";
    stepValue.textContent = `${stage}/5`;
  } else if (phase === "transpose") {
    iterationValue.textContent = "Transpose";
    stepValue.textContent = "-";
  } else {
    iterationValue.textContent = `${phase + 1}/5`;
    stepValue.textContent = `${stage + 1}/7`;
  }

  operationValue.textContent = step.name;
}

document.addEventListener("DOMContentLoaded", init);
