import { Grid } from "./grid.js";
import { AnimationLoop } from "./animation.js";
import { runAllReduce, spmvPattern, conjugateGradient } from "./algorithms.js";
import {
  initReplay, setReplayGrid, getReplayState, getIsScrubbing,
  updateReplayTick, resumePlayback, togglePlayback, adjustSpeed,
  seekToCycle, cancelReplay, handleTraceFile, setupScrubListeners,
} from "./replay-controller.js";
import { GRID_ROWS, GRID_COLS, CELL_SIZE, GAP } from "./constants.js";

// Target canvas dimension derived from default grid columns
const BASE_CANVAS_SIZE = GRID_COLS * (CELL_SIZE + GAP) + GAP;
const DIRECTIONS = [
  { dr: -1, dc: 0 },
  { dr: 1, dc: 0 },
  { dr: 0, dc: -1 },
  { dr: 0, dc: 1 },
];

let grid;
let animationLoop;
let canvas;
let ctx;
let simulationInterval;
let els;

function init() {
  canvas = document.getElementById("wseCanvas");
  ctx = canvas.getContext("2d");

  els = {
    scrubBar: document.getElementById("scrubBar"),
    playPauseBtn: document.getElementById("playPauseBtn"),
    speedDisplay: document.getElementById("speedDisplay"),
    cycleDisplay: document.getElementById("cycleDisplay"),
    traceLog: document.getElementById("traceLog"),
    cgPanel: document.getElementById("cgPanel"),
    tracePanel: document.getElementById("tracePanel"),
    playbackBar: document.getElementById("playbackBar"),
    iterationValue: document.getElementById("iterationValue"),
    stepValue: document.getElementById("stepValue"),
    operationValue: document.getElementById("operationValue"),
  };

  setGrid(GRID_ROWS, GRID_COLS);
  animationLoop = new AnimationLoop(update, draw);
  initReplay({ grid, els, animationLoop, showPanel });
  setupEventListeners();
}

function update(timestamp) {
  grid.update(timestamp);
  updateReplayTick(timestamp);

  // Auto-stop when truly idle: no simulation, no replay loaded, no visual activity
  if (!simulationInterval && !getReplayState() && !grid.hasActivity()) {
    animationLoop.stop();
  }
}

function draw(timestamp) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  grid.draw(ctx, timestamp);
}

function startSimulation() {
  if (simulationInterval) return;
  cancelReplay();
  showPanel(null);
  setGrid(GRID_ROWS, GRID_COLS);
  animationLoop.start();

  simulationInterval = setInterval(() => {
    const row = Math.floor(Math.random() * GRID_ROWS);
    const col = Math.floor(Math.random() * GRID_COLS);
    grid.activatePE(row, col);
    const dir = DIRECTIONS[Math.floor(Math.random() * DIRECTIONS.length)];
    const newRow = row + dir.dr;
    const newCol = col + dir.dc;
    if (newRow >= 0 && newRow < GRID_ROWS && newCol >= 0 && newCol < GRID_COLS) {
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
  document.getElementById("startBtn").addEventListener("click", startSimulation);
  document.getElementById("allReduceFullBtn").addEventListener("click", startAllReduceFull);
  document.getElementById("spmvBtn").addEventListener("click", startSpMV);
  document.getElementById("cgBtn").addEventListener("click", startCG);
  document.getElementById("traceFileInput").addEventListener("change", (e) => {
    stopSimulation();
    handleTraceFile(e, setGrid);
  });
  setupScrubListeners();
  els.playPauseBtn.addEventListener("click", togglePlayback);
  document.getElementById("speedDown").addEventListener("click", () => adjustSpeed(0.5));
  document.getElementById("speedUp").addEventListener("click", () => adjustSpeed(2));
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    if (e.code === "Space") {
      e.preventDefault();
      if (!getIsScrubbing()) togglePlayback();
    } else if (e.key === "]") {
      adjustSpeed(2);
    } else if (e.key === "[") {
      adjustSpeed(0.5);
    }
  });
}

function startAlgorithm() {
  stopSimulation();
  setGrid(GRID_ROWS, GRID_COLS);
  animationLoop.start();
}

function startAllReduceFull() {
  startAlgorithm();
  showPanel(null);
  runAllReduce(grid);
}

function startSpMV() {
  startAlgorithm();
  showPanel(null);
  spmvPattern(grid);
}

function startCG() {
  startAlgorithm();
  showPanel("cg");
  clearCodeHighlight();
  conjugateGradient(grid, 5, updateCodePanel);
}

function clearCodeHighlight() {
  document.querySelectorAll(".code-line").forEach((line) => {
    line.classList.remove("active");
  });
}

function updateCodePanel(phase, stage, step) {
  clearCodeHighlight();
  const line = document.querySelector(`.code-line[data-line="${step.line}"]`);
  if (line) line.classList.add("active");
  els.iterationValue.textContent = `${phase + 1}/5`;
  els.stepValue.textContent = `${stage + 1}/7`;
  els.operationValue.textContent = step.name;
}

function showPanel(panel) {
  els.cgPanel.classList.toggle("hidden", panel !== "cg");
  els.tracePanel.classList.toggle("hidden", panel !== "trace");
  els.playbackBar.classList.toggle("hidden", panel !== "trace");
}

function setGrid(rows, cols) {
  if (grid) grid.cancel();
  grid = new Grid(rows, cols, CELL_SIZE, GAP);
  setReplayGrid(grid);
  const naturalWidth = cols * (CELL_SIZE + GAP) + GAP;
  const naturalHeight = rows * (CELL_SIZE + GAP) + GAP;
  const scale = BASE_CANVAS_SIZE / Math.max(naturalWidth, naturalHeight);
  canvas.width = Math.round(naturalWidth * scale);
  canvas.height = Math.round(naturalHeight * scale);
  // Reset inline styles so canvas renders at its attribute dimensions
  canvas.style.width = "";
  canvas.style.height = "";
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
}

document.addEventListener("DOMContentLoaded", init);
