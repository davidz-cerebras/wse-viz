import { Grid } from "./grid.js";
import { AnimationLoop } from "./animation.js";

const GRID_ROWS = 20;
const GRID_COLS = 30;
const CELL_SIZE = 20;
const GAP = 4;

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

function resetSimulation() {
  stopSimulation();
  grid.init();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  grid.draw(ctx);
  updateStats();
}

function setupEventListeners() {
  document
    .getElementById("startBtn")
    .addEventListener("click", startSimulation);
  document.getElementById("stopBtn").addEventListener("click", stopSimulation);
  document
    .getElementById("resetBtn")
    .addEventListener("click", resetSimulation);
}

document.addEventListener("DOMContentLoaded", init);
