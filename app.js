import { Grid } from "./grid.js";
import { AnimationLoop } from "./animation.js";
import { GRID_ROWS, GRID_COLS, CELL_SIZE, GAP } from "./constants.js";

let grid;
let animationLoop;
let canvas;
let ctx;
let simulationInterval;

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

document.addEventListener("DOMContentLoaded", init);
