import { Grid } from "./grid.js";
import { AnimationLoop } from "./animation.js";
import { runAllReduce, spmvPattern, conjugateGradient } from "./algorithms.js";
import {
  initReplay, setReplayGrid, getReplayState, getIsScrubbing,
  updateReplayTick, togglePlayback, adjustSpeed, stepCycle,
  cancelReplay, handleTraceFile, setupScrubListeners,
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
let viewportOffsetX = 0;
let viewportOffsetY = 0;
let gridNaturalWidth = 0;
let gridNaturalHeight = 0;

// Shift+drag zoom selection state
let zoomDrag = null; // { startX, startY, canvasOffX, canvasOffY } or null
let suppressNextClick = false;

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
    resetZoomBtn: document.getElementById("resetZoomBtn"),
    zoomOverlay: document.getElementById("zoomOverlay"),
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
  // Clear in device coordinates to avoid sub-pixel rounding gaps at edges
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
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
  canvas.addEventListener("pointerdown", handleZoomDragStart);
  els.resetZoomBtn.addEventListener("click", resetZoom);
  setupScrubListeners();
  els.playPauseBtn.addEventListener("click", togglePlayback);
  document.getElementById("speedDown").addEventListener("click", () => adjustSpeed(0.5));
  document.getElementById("speedUp").addEventListener("click", () => adjustSpeed(2));
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    if (e.code === "Space") {
      e.preventDefault();
      if (!getIsScrubbing()) togglePlayback();
    } else if (e.key === "Escape" || e.key === "q") {
      if (grid && grid.viewport) resetZoom();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      stepCycle(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      stepCycle(-1);
    } else if (e.key === "]") {
      adjustSpeed(2);
    } else if (e.key === "[") {
      adjustSpeed(0.5);
    }
  });
  // Prevent Space keyup from triggering a click on any focused button.
  // Our Space handling is fully in keydown above; the native keyup-click
  // would fire startSimulation/etc. if those buttons happen to have focus.
  document.addEventListener("keyup", (e) => {
    if (e.code === "Space" && e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA") {
      e.preventDefault();
    }
  });
}

// --- Zoom selection via Shift+drag ---

// Convert a pointer event to a position relative to the canvas-container
// (which is the positioned ancestor of the zoom overlay).
function eventToContainerPos(e) {
  const containerRect = canvas.parentElement.getBoundingClientRect();
  return { x: e.clientX - containerRect.left, y: e.clientY - containerRect.top };
}

// Convert a pointer event to a position relative to the canvas content area
// (inside the border), for grid coordinate mapping.
function eventToCanvasCSS(e) {
  const rect = canvas.getBoundingClientRect();
  const border = parseFloat(getComputedStyle(canvas).borderWidth) || 0;
  return { x: e.clientX - rect.left - border, y: e.clientY - rect.top - border };
}

function cssToLogical(cssX, cssY) {
  // Convert canvas-relative CSS pixel position to full-grid logical coords
  const rect = canvas.getBoundingClientRect();
  const border = parseFloat(getComputedStyle(canvas).borderWidth) || 0;
  const innerW = rect.width - 2 * border;
  const innerH = rect.height - 2 * border;
  return {
    x: (cssX / innerW) * gridNaturalWidth + viewportOffsetX,
    y: (cssY / innerH) * gridNaturalHeight + viewportOffsetY,
  };
}

function cssToGridRowCol(cssX, cssY) {
  const { x, y } = cssToLogical(cssX, cssY);
  const col = Math.floor((x - GAP) / (CELL_SIZE + GAP));
  const row = Math.floor((y - GAP) / (CELL_SIZE + GAP));
  return { row, col };
}

// Returns the tight PE range whose central cells overlap the rectangle
// defined by two logical corners. A PE is only included if the selection
// actually enters its CELL_SIZE square, not its surrounding gap/ramp area.
function logicalRectToPERange(x0, y0, x1, y1) {
  const step = CELL_SIZE + GAP;
  // For minRow/minCol: find the first PE whose cell right/bottom edge is past the rect start
  // A PE cell at col c spans from (c*step + GAP) to (c*step + GAP + CELL_SIZE)
  const minCol = Math.ceil((x0 - GAP - CELL_SIZE) / step);
  const minRow = Math.ceil((y0 - GAP - CELL_SIZE) / step);
  // For maxRow/maxCol: find the last PE whose cell left/top edge is before the rect end
  const maxCol = Math.floor((x1 - GAP) / step);
  const maxRow = Math.floor((y1 - GAP) / step);
  return { minRow, maxRow, minCol, maxCol };
}

function handleZoomDragStart(e) {
  if (!e.shiftKey || e.button !== 0) return;
  e.preventDefault();

  const containerPos = eventToContainerPos(e);
  const canvasPos = eventToCanvasCSS(e);
  zoomDrag = { startContX: containerPos.x, startContY: containerPos.y,
               startCssX: canvasPos.x, startCssY: canvasPos.y };

  const overlay = els.zoomOverlay;
  overlay.style.left = `${containerPos.x}px`;
  overlay.style.top = `${containerPos.y}px`;
  overlay.style.width = "0";
  overlay.style.height = "0";
  overlay.classList.remove("hidden");

  // Clear any previous zoom highlight
  grid.zoomPreview = null;

  const onMove = (ev) => {
    if (!zoomDrag) return;
    const cur = eventToContainerPos(ev);
    const x = Math.min(zoomDrag.startContX, cur.x);
    const y = Math.min(zoomDrag.startContY, cur.y);
    const w = Math.abs(cur.x - zoomDrag.startContX);
    const h = Math.abs(cur.y - zoomDrag.startContY);
    overlay.style.left = `${x}px`;
    overlay.style.top = `${y}px`;
    overlay.style.width = `${w}px`;
    overlay.style.height = `${h}px`;

    // Compute which PEs have their cell under the selection and highlight them
    const curCss = eventToCanvasCSS(ev);
    const lo = cssToLogical(Math.min(zoomDrag.startCssX, curCss.x), Math.min(zoomDrag.startCssY, curCss.y));
    const hi = cssToLogical(Math.max(zoomDrag.startCssX, curCss.x), Math.max(zoomDrag.startCssY, curCss.y));
    const range = logicalRectToPERange(lo.x, lo.y, hi.x, hi.y);
    grid.zoomPreview = {
      minRow: Math.max(0, range.minRow),
      maxRow: Math.min(grid.rows - 1, range.maxRow),
      minCol: Math.max(0, range.minCol),
      maxCol: Math.min(grid.cols - 1, range.maxCol),
    };
    animationLoop.start();
  };

  const onUp = (ev) => {
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("pointercancel", onUp);
    try { canvas.releasePointerCapture(ev.pointerId); } catch (_) {}
    overlay.classList.add("hidden");
    grid.zoomPreview = null;
    suppressNextClick = true;

    if (!zoomDrag) return;
    const endCss = eventToCanvasCSS(ev);
    const lo = cssToLogical(Math.min(zoomDrag.startCssX, endCss.x), Math.min(zoomDrag.startCssY, endCss.y));
    const hi = cssToLogical(Math.max(zoomDrag.startCssX, endCss.x), Math.max(zoomDrag.startCssY, endCss.y));
    const range = logicalRectToPERange(lo.x, lo.y, hi.x, hi.y);
    zoomDrag = null;

    // Clamp to grid bounds
    const minRow = Math.max(0, range.minRow);
    const maxRow = Math.min(grid.rows - 1, range.maxRow);
    const minCol = Math.max(0, range.minCol);
    const maxCol = Math.min(grid.cols - 1, range.maxCol);

    // Need at least 2×2 region to zoom
    if (maxRow - minRow < 1 || maxCol - minCol < 1) {
      animationLoop.start(); // redraw to clear highlight
      return;
    }

    grid.setViewport(minRow, maxRow, minCol, maxCol);
    els.resetZoomBtn.classList.remove("hidden");
    applyViewport();
  };

  canvas.setPointerCapture(e.pointerId);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
}

function resetZoom() {
  if (!grid) return;
  grid.clearViewport();
  els.resetZoomBtn.classList.add("hidden");
  applyViewport();
}

function applyViewport() {
  const vp = grid.getViewportNaturalSize();
  gridNaturalWidth = vp.width;
  gridNaturalHeight = vp.height;
  const off = grid.getViewportOffset();
  viewportOffsetX = off.x;
  viewportOffsetY = off.y;
  // Force full re-apply by resetting canvas dimensions (resizeCanvas skips
  // when dimensions and scale haven't changed).
  canvas.width = 0;
  canvas.height = 0;
  resizeCanvas();
}

// --- End zoom selection ---

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
  // Ignore clicks that were part of a shift+drag zoom selection
  if (e.shiftKey || suppressNextClick) { suppressNextClick = false; return; }
  suppressNextClick = false;
  if (!getReplayState()) return;

  const cssPos = eventToCanvasCSS(e);
  const { row, col } = cssToGridRowCol(cssPos.x, cssPos.y);

  if (row < 0 || row >= grid.rows || col < 0 || col >= grid.cols) {
    deselectPE();
    return;
  }

  // Check click is within the PE cell, not in the gap
  const { x: preciseX, y: preciseY } = cssToLogical(cssPos.x, cssPos.y);
  const peX = col * (CELL_SIZE + GAP) + GAP;
  const peY = row * (CELL_SIZE + GAP) + GAP;
  if (preciseX < peX || preciseX > peX + CELL_SIZE ||
      preciseY < peY || preciseY > peY + CELL_SIZE) {
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
  // Reset viewport/zoom state
  zoomDrag = null;
  viewportOffsetX = 0;
  viewportOffsetY = 0;
  els.resetZoomBtn.classList.add("hidden");
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

  // Re-apply if the canvas pixel dimensions changed OR the scale changed
  // (same-aspect-ratio grid transitions produce identical pixel dimensions
  // but need a different transform scale for the new gridNaturalWidth).
  const newScale = displayW / gridNaturalWidth;
  if (canvas.width !== newW || canvas.height !== newH || canvasScale !== newScale) {
    canvasScale = newScale;
    canvas.width = newW;
    canvas.height = newH;
    canvas.style.width = `${newW}px`;
    canvas.style.height = `${newH}px`;
    ctx.setTransform(canvasScale, 0, 0, canvasScale, -viewportOffsetX * canvasScale, -viewportOffsetY * canvasScale);
    // Draw immediately so the canvas is never left blank after resize.
    // Can't rely on the animation loop because update() may auto-stop
    // before draw() runs if there's no active simulation or replay.
    draw(performance.now());
    if (animationLoop) animationLoop.start();
  }
}

document.addEventListener("DOMContentLoaded", init);
