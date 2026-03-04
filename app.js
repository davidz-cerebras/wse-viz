import { Grid } from "./grid.js";
import { AnimationLoop } from "./animation.js";
import { runAllReduce, spmvPattern, conjugateGradient } from "./algorithms.js";
import {
  initReplay, setReplayGrid, getReplayState, getIsScrubbing,
  updateReplayTick, resumePlayback, togglePlayback, adjustSpeed,
  seekToCycle, cancelReplay, handleTraceFile, setupScrubListeners,
  selectPE, deselectPE,
} from "./replay-controller.js";
import { GRID_ROWS, GRID_COLS, CELL_SIZE, GAP } from "./constants.js";

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
let canvasScale = 1;
let gridNaturalWidth = 0;
let gridNaturalHeight = 0;

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
    opChart: document.getElementById("opChart"),
    panelResizer: document.getElementById("panelResizer"),
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
  ctx.clearRect(0, 0, gridNaturalWidth, gridNaturalHeight);
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
  window.addEventListener("resize", resizeCanvas);
  document.getElementById("startBtn").addEventListener("click", startSimulation);
  document.getElementById("allReduceFullBtn").addEventListener("click", startAllReduceFull);
  document.getElementById("spmvBtn").addEventListener("click", startSpMV);
  document.getElementById("cgBtn").addEventListener("click", startCG);
  document.getElementById("traceFileInput").addEventListener("change", (e) => {
    stopSimulation();
    handleTraceFile(e, setGrid);
  });
  canvas.addEventListener("click", handleCanvasClick);
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
  // Refit canvas after panel visibility changes the available space
  requestAnimationFrame(resizeCanvas);
}

function handleCanvasClick(e) {
  if (!getReplayState()) return;
  const rect = canvas.getBoundingClientRect();
  const border = parseFloat(getComputedStyle(canvas).borderWidth) || 0;
  const logicalX = (e.clientX - rect.left - border) * (canvas.width / (rect.width - 2 * border)) / canvasScale;
  const logicalY = (e.clientY - rect.top - border) * (canvas.height / (rect.height - 2 * border)) / canvasScale;

  const col = Math.floor((logicalX - GAP) / (CELL_SIZE + GAP));
  const row = Math.floor((logicalY - GAP) / (CELL_SIZE + GAP));

  if (row < 0 || row >= grid.rows || col < 0 || col >= grid.cols) {
    deselectPE();
    return;
  }

  // Check click is within the PE cell, not in the gap
  const peX = col * (CELL_SIZE + GAP) + GAP;
  const peY = row * (CELL_SIZE + GAP) + GAP;
  if (logicalX < peX || logicalX > peX + CELL_SIZE ||
      logicalY < peY || logicalY > peY + CELL_SIZE) {
    deselectPE();
    return;
  }

  const traceX = col;
  const traceY = grid.rows - 1 - row;
  selectPE(row, col, traceX, traceY);
}

function setGrid(rows, cols) {
  if (grid) grid.cancel();
  grid = new Grid(rows, cols, CELL_SIZE, GAP);
  setReplayGrid(grid);
  gridNaturalWidth = cols * (CELL_SIZE + GAP) + GAP;
  gridNaturalHeight = rows * (CELL_SIZE + GAP) + GAP;
  resizeCanvas();
}

function resizeCanvas() {
  if (!gridNaturalWidth || !gridNaturalHeight) return;

  const container = canvas.parentElement;
  const maxW = container.clientWidth;
  const maxH = container.clientHeight;
  if (maxW <= 0 || maxH <= 0) return;

  const aspect = gridNaturalWidth / gridNaturalHeight;

  let displayW, displayH;
  if (maxW / maxH > aspect) {
    displayH = maxH;
    displayW = maxH * aspect;
  } else {
    displayW = maxW;
    displayH = maxW / aspect;
  }

  const newW = Math.round(displayW);
  const newH = Math.round(displayH);

  // Only reset the canvas buffer if dimensions actually changed
  // (setting canvas.width/height clears the buffer and resets context state)
  if (canvas.width !== newW || canvas.height !== newH) {
    canvasScale = displayW / gridNaturalWidth;
    canvas.width = newW;
    canvas.height = newH;
    canvas.style.width = `${Math.round(displayW)}px`;
    canvas.style.height = `${Math.round(displayH)}px`;
    ctx.setTransform(canvasScale, 0, 0, canvasScale, 0, 0);
    // Draw immediately so the canvas is never left blank after resize.
    // Can't rely on the animation loop because update() may auto-stop
    // before draw() runs if there's no active simulation or replay.
    draw(performance.now());
    if (animationLoop) animationLoop.start();
  }
}

document.addEventListener("DOMContentLoaded", init);
