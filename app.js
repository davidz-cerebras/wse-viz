import { Grid } from "./grid.js";
import { AnimationLoop } from "./animation.js";
import {
  initDemo, setDemoGrid,
  startSimulation, stopSimulation, isSimulationRunning,
  startAllReduceFull, startSpMV, startCG,
  GRID_ROWS, GRID_COLS,
} from "./demo.js";
import {
  initReplay, setReplayGrid, getReplayState, getIsScrubbing,
  updateReplayTick, transportFwdPlay, transportRevPlay, transportPause,
  transportStepFwd, transportStepBack, adjustSpeed,
  cancelReplay, handleTraceFile, setupScrubListeners,
  selectPE, deselectPE, initServerMode,
} from "./replay-controller.js";
import { setOpBitmapScale, setCatEnabled } from "./pe.js";
import { setLabelBitmapScale } from "./draw-utils.js";
import {
  CELL_SIZE, GAP_SIZE,
  PE_COLOR_FP_ARITH, PE_COLOR_INT_ARITH, PE_COLOR_CTRL,
  PE_COLOR_TASK, PE_COLOR_MEM_READ, PE_COLOR_MEM_WRITE,
} from "./constants.js";

let grid;
let animationLoop;
let canvas;
let ctx;
let els;
let canvasScale = 1;
let viewportOffsetX = 0;
let viewportOffsetY = 0;
let gridNaturalWidth = 0;
let gridNaturalHeight = 0;

// Shift+drag zoom selection state
let zoomDrag = null; // { startX, startY, canvasOffX, canvasOffY } or null
let suppressNextClick = false;
let viewportStack = []; // stack of previous viewports for undo
let canvasBorder = 0;   // cached canvas border width (px)

function init() {
  canvas = document.getElementById("wseCanvas");
  ctx = canvas.getContext("2d");
  canvasBorder = parseFloat(getComputedStyle(canvas).borderWidth) || 0;

  els = {
    scrubBar: document.getElementById("scrubBar"),
    revPlayBtn: document.getElementById("revPlayBtn"),
    stepBackBtn: document.getElementById("stepBackBtn"),
    pauseBtn: document.getElementById("pauseBtn"),
    stepFwdBtn: document.getElementById("stepFwdBtn"),
    fwdPlayBtn: document.getElementById("fwdPlayBtn"),
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
    undoZoomBtn: document.getElementById("undoZoomBtn"),
    resetZoomBtn: document.getElementById("resetZoomBtn"),
    zoomOverlay: document.getElementById("zoomOverlay"),
    loadingBar: document.getElementById("loadingBar"),
    loadingFill: document.getElementById("loadingFill"),
    loadingPct: document.getElementById("loadingPct"),
    loadingLabel: document.querySelector("#loadingBar .loading-label"),
    playbackControls: document.getElementById("playbackControls"),
    serverStatus: document.getElementById("serverStatus"),
    tabPipeline: document.getElementById("tabPipeline"),
    tabCode: document.getElementById("tabCode"),
    pipelineView: document.getElementById("pipelineView"),
    codeView: document.getElementById("codeView"),
    codeLog: document.getElementById("codeLog"),
  };

  setGrid(GRID_ROWS, GRID_COLS);
  animationLoop = new AnimationLoop(update, draw);
  initReplay({ grid, els, animationLoop, showPanel, resizeCanvas });
  initDemo({ grid, els, animationLoop, cancelReplay, showPanel, setGrid });
  setupEventListeners();

  // Detect server mode: if /api/meta responds, load from server.
  // Demo controls start hidden (HTML `hidden` attr) to prevent flash;
  // shown only after confirming we're not in server mode.
  const demoControls = document.querySelectorAll(".demo-ctrl");
  fetch("/api/meta").then(r => r.ok ? r.json() : null).then(meta => {
    if (!meta) { for (const el of demoControls) el.hidden = false; return; }
    initServerMode(meta, setGrid);
  }).catch(() => { for (const el of demoControls) el.hidden = false; });
}

function update(timestamp) {
  if (!getReplayState()) grid.update(timestamp);
  updateReplayTick(timestamp);

  // Auto-stop when truly idle: no simulation, no replay loaded, no visual activity
  if (!isSimulationRunning() && !getReplayState() && !grid.hasActivity()) {
    animationLoop.stop();
  }
}

function draw(timestamp) {
  // Clear in device coordinates, then restore the grid transform
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const dpr = window.devicePixelRatio || 1;
  const s = canvasScale * dpr;
  ctx.setTransform(s, 0, 0, s, -viewportOffsetX * s, -viewportOffsetY * s);
  grid.draw(ctx, timestamp);
}

let _dprMql = null;
function _onDPRChange() { resizeCanvas(); watchDPR(); }
function watchDPR() {
  if (_dprMql) _dprMql.removeEventListener("change", _onDPRChange);
  _dprMql = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  _dprMql.addEventListener("change", _onDPRChange, { once: true });
}

function setupEventListeners() {
  window.addEventListener("resize", resizeCanvas);
  watchDPR();
  // Sidebar toggle
  const headerEl = document.querySelector("header");
  document.documentElement.style.setProperty("--header-height", headerEl.offsetHeight + "px");
  const sidebarBtn = document.getElementById("sidebarBtn");
  const sidebar = document.getElementById("sidebar");
  function updateSidebarBounds() {
    const pbH = els.playbackBar.classList.contains("hidden") ? 0 : els.playbackBar.offsetHeight;
    document.documentElement.style.setProperty("--playback-height", pbH + "px");
  }
  const sidebarObserver = new MutationObserver(updateSidebarBounds);
  sidebarObserver.observe(els.playbackBar, { attributes: true, attributeFilter: ["class"] });
  sidebarBtn.addEventListener("click", () => {
    updateSidebarBounds();
    sidebar.classList.toggle("open");
  });
  document.addEventListener("click", (e) => {
    if (!sidebar.contains(e.target) && e.target !== sidebarBtn) {
      sidebar.classList.remove("open");
    }
  });

  // Category coloring checkboxes — also set swatch colors from constants
  const catCheckboxes = [
    ["colorFpArith", "fp-arith", PE_COLOR_FP_ARITH],
    ["colorIntArith", "int-arith", PE_COLOR_INT_ARITH],
    ["colorCtrl", "ctrl", PE_COLOR_CTRL],
    ["colorTask", "task", PE_COLOR_TASK],
    ["colorMemRead", "mem-read", PE_COLOR_MEM_READ],
    ["colorMemWrite", "mem-write", PE_COLOR_MEM_WRITE],
  ];
  for (const [id, cat, color] of catCheckboxes) {
    const checkbox = document.getElementById(id);
    const swatch = checkbox.parentElement.querySelector(".color-swatch");
    if (swatch) swatch.style.background = color;
    checkbox.addEventListener("change", (e) => {
      setCatEnabled(cat, e.target.checked);
      if (grid) grid.refreshPEColors();
    });
  }

  document.getElementById("startBtn").addEventListener("click", startSimulation);
  document.getElementById("allReduceFullBtn").addEventListener("click", startAllReduceFull);
  document.getElementById("spmvBtn").addEventListener("click", startSpMV);
  document.getElementById("cgBtn").addEventListener("click", startCG);
  document.getElementById("traceFileInput").addEventListener("change", (e) => {
    stopSimulation();
    handleTraceFile(e, setGrid);
  });
  canvas.addEventListener("click", handleCanvasClick);
  // Attach zoom drag to the container (not just the canvas) so the user
  // can start a shift+drag from the blank space around the grid.
  canvas.parentElement.addEventListener("pointerdown", handleZoomDragStart);
  els.undoZoomBtn.addEventListener("click", undoZoom);
  els.resetZoomBtn.addEventListener("click", resetZoom);
  setupScrubListeners();
  els.revPlayBtn.addEventListener("click", transportRevPlay);
  els.stepBackBtn.addEventListener("click", transportStepBack);
  els.pauseBtn.addEventListener("click", transportPause);
  els.stepFwdBtn.addEventListener("click", transportStepFwd);
  els.fwdPlayBtn.addEventListener("click", transportFwdPlay);
  document.getElementById("speedDown").addEventListener("click", () => adjustSpeed(0.5));
  document.getElementById("speedUp").addEventListener("click", () => adjustSpeed(2));
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    if (e.code === "Space") {
      e.preventDefault();
      if (!getIsScrubbing()) transportPause();
    } else if (e.key === "q" || e.key === "u" || e.key === "z") {
      if (viewportStack.length > 0) undoZoom();
    } else if (e.key === "Escape") {
      if (viewportStack.length > 0) resetZoom();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      transportStepFwd();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      transportStepBack();
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
  return { x: e.clientX - rect.left - canvasBorder, y: e.clientY - rect.top - canvasBorder };
}

function cssToLogical(cssX, cssY) {
  return {
    x: cssX / canvasScale + viewportOffsetX,
    y: cssY / canvasScale + viewportOffsetY,
  };
}

function cssToGridRowCol(cssX, cssY) {
  const { x, y } = cssToLogical(cssX, cssY);
  const col = Math.floor((x - GAP_SIZE) / (CELL_SIZE + GAP_SIZE));
  const row = Math.floor((y - GAP_SIZE) / (CELL_SIZE + GAP_SIZE));
  return { row, col };
}

// Returns the tight PE range whose central cells overlap the rectangle
// defined by two logical corners. A PE is only included if the selection
// actually enters its CELL_SIZE square, not its surrounding gap/ramp area.
function logicalRectToPERange(x0, y0, x1, y1) {
  const step = CELL_SIZE + GAP_SIZE;
  // For minRow/minCol: find the first PE whose cell right/bottom edge is past the rect start
  // A PE cell at col c spans from (c*step + GAP_SIZE) to (c*step + GAP_SIZE + CELL_SIZE)
  const minCol = Math.ceil((x0 - GAP_SIZE - CELL_SIZE) / step);
  const minRow = Math.ceil((y0 - GAP_SIZE - CELL_SIZE) / step);
  // For maxRow/maxCol: find the last PE whose cell left/top edge is before the rect end
  const maxCol = Math.floor((x1 - GAP_SIZE) / step);
  const maxRow = Math.floor((y1 - GAP_SIZE) / step);
  return { minRow, maxRow, minCol, maxCol };
}

function clampPERange(range) {
  return {
    minRow: Math.max(0, range.minRow),
    maxRow: Math.min(grid.rows - 1, range.maxRow),
    minCol: Math.max(0, range.minCol),
    maxCol: Math.min(grid.cols - 1, range.maxCol),
  };
}

function handleZoomDragStart(e) {
  if (!e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  suppressNextClick = false; // clear stale flag from any previous drag

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

  // Cache rects at drag start to avoid getBoundingClientRect() on every pointermove
  const containerRect = canvas.parentElement.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  const evtToContainer = (ev) => ({ x: ev.clientX - containerRect.left, y: ev.clientY - containerRect.top });
  const evtToCanvasCSS = (ev) => ({ x: ev.clientX - canvasRect.left - canvasBorder, y: ev.clientY - canvasRect.top - canvasBorder });

  const onMove = (ev) => {
    if (!zoomDrag) return;
    const cur = evtToContainer(ev);
    const x = Math.min(zoomDrag.startContX, cur.x);
    const y = Math.min(zoomDrag.startContY, cur.y);
    const w = Math.abs(cur.x - zoomDrag.startContX);
    const h = Math.abs(cur.y - zoomDrag.startContY);
    overlay.style.left = `${x}px`;
    overlay.style.top = `${y}px`;
    overlay.style.width = `${w}px`;
    overlay.style.height = `${h}px`;

    // Compute which PEs have their cell under the selection and highlight them
    const curCss = evtToCanvasCSS(ev);
    const lo = cssToLogical(Math.min(zoomDrag.startCssX, curCss.x), Math.min(zoomDrag.startCssY, curCss.y));
    const hi = cssToLogical(Math.max(zoomDrag.startCssX, curCss.x), Math.max(zoomDrag.startCssY, curCss.y));
    grid.zoomPreview = clampPERange(logicalRectToPERange(lo.x, lo.y, hi.x, hi.y));
    animationLoop.start();
  };

  const container = canvas.parentElement;

  const onUp = (ev) => {
    container.removeEventListener("pointermove", onMove);
    container.removeEventListener("pointerup", onUp);
    container.removeEventListener("pointercancel", onUp);
    try { container.releasePointerCapture(ev.pointerId); } catch (_) {}
    overlay.classList.add("hidden");
    grid.zoomPreview = null;

    if (!zoomDrag) return;
    const endCss = evtToCanvasCSS(ev);
    const lo = cssToLogical(Math.min(zoomDrag.startCssX, endCss.x), Math.min(zoomDrag.startCssY, endCss.y));
    const hi = cssToLogical(Math.max(zoomDrag.startCssX, endCss.x), Math.max(zoomDrag.startCssY, endCss.y));
    const range = logicalRectToPERange(lo.x, lo.y, hi.x, hi.y);
    zoomDrag = null;

    const { minRow, maxRow, minCol, maxCol } = clampPERange(range);

    // Need at least 2×2 region to zoom
    if (maxRow - minRow < 1 || maxCol - minCol < 1) {
      animationLoop.start(); // redraw to clear highlight
      return;
    }

    // Push current viewport (or null for full grid) onto the stack before zooming
    suppressNextClick = true;
    viewportStack.push(grid.viewport ? { ...grid.viewport } : null);
    grid.setViewport(minRow, maxRow, minCol, maxCol);
    updateZoomButtons();
    applyViewport();
  };

  container.setPointerCapture(e.pointerId);
  container.addEventListener("pointermove", onMove);
  container.addEventListener("pointerup", onUp);
  container.addEventListener("pointercancel", onUp);
}

function undoZoom() {
  if (viewportStack.length === 0) return;
  const prev = viewportStack.pop();
  if (prev) {
    grid.setViewport(prev.minRow, prev.maxRow, prev.minCol, prev.maxCol);
  } else {
    grid.clearViewport();
  }
  updateZoomButtons();
  applyViewport();
}

function resetZoom() {
  grid.clearViewport();
  viewportStack.length = 0;
  updateZoomButtons();
  applyViewport();
}

function updateZoomButtons() {
  const zoomed = !!grid.viewport;
  els.undoZoomBtn.classList.toggle("hidden", !zoomed);
  els.resetZoomBtn.classList.toggle("hidden", !zoomed);
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

function showPanel(panel) {
  els.cgPanel.classList.toggle("hidden", panel !== "cg");
  // Trace panel is shown/hidden by selectPE/deselectPE, not by showPanel
  if (panel !== "trace") els.tracePanel.classList.add("hidden");
  els.playbackBar.classList.toggle("hidden", panel !== "trace");
  // In trace mode, hide demo/load buttons; in other modes restore them
  for (const el of document.querySelectorAll(".demo-ctrl")) {
    el.hidden = panel === "trace";
  }
  // Refit canvas after panel visibility changes the available space
  requestAnimationFrame(resizeCanvas);
}

function handleCanvasClick(e) {
  // Ignore clicks that were part of a shift+drag zoom selection
  if (suppressNextClick) { suppressNextClick = false; return; }
  if (e.shiftKey) return;
  if (!getReplayState()) return;

  const cssPos = eventToCanvasCSS(e);
  const { row, col } = cssToGridRowCol(cssPos.x, cssPos.y);

  if (row < 0 || row >= grid.rows || col < 0 || col >= grid.cols) {
    deselectPE();
    return;
  }

  // Check click is within the PE cell, not in the gap
  const { x: preciseX, y: preciseY } = cssToLogical(cssPos.x, cssPos.y);
  const peX = col * (CELL_SIZE + GAP_SIZE) + GAP_SIZE;
  const peY = row * (CELL_SIZE + GAP_SIZE) + GAP_SIZE;
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
  grid = new Grid(rows, cols);
  setReplayGrid(grid);
  setDemoGrid(grid);
  // Reset viewport/zoom state
  zoomDrag = null;
  viewportStack.length = 0;
  viewportOffsetX = 0;
  viewportOffsetY = 0;
  updateZoomButtons();
  const vp = grid.getViewportNaturalSize();
  gridNaturalWidth = vp.width;
  gridNaturalHeight = vp.height;
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
  const dpr = window.devicePixelRatio || 1;

  // Re-apply if the canvas pixel dimensions changed OR the scale changed
  // (same-aspect-ratio grid transitions produce identical pixel dimensions
  // but need a different transform scale for the new gridNaturalWidth).
  const newScale = displayW / gridNaturalWidth;
  const bufW = Math.round(newW * dpr);
  const bufH = Math.round(newH * dpr);
  if (canvas.width !== bufW || canvas.height !== bufH || canvasScale !== newScale) {
    canvasScale = newScale;
    canvas.width = bufW;
    canvas.height = bufH;
    canvas.style.width = `${newW}px`;
    canvas.style.height = `${newH}px`;
    const s = canvasScale * dpr;
    setOpBitmapScale(s);
    setLabelBitmapScale(s);
    ctx.setTransform(s, 0, 0, s, -viewportOffsetX * s, -viewportOffsetY * s);
    // Draw immediately so the canvas is never left blank after resize.
    // Can't rely on the animation loop because update() may auto-stop
    // before draw() runs if there's no active simulation or replay.
    draw(performance.now());
    if (animationLoop) animationLoop.start();
  }
}

document.addEventListener("DOMContentLoaded", init);
