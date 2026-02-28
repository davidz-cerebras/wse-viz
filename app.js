import { Grid } from "./grid.js";
import { AnimationLoop } from "./animation.js";
import { TraceParser } from "./trace-parser.js";
import { GRID_ROWS, GRID_COLS, CELL_SIZE, GAP } from "./constants.js";

// Target canvas dimension derived from default grid columns
const BASE_CANVAS_SIZE = GRID_COLS * (CELL_SIZE + GAP) + GAP;
const PREFETCH_SIZE = 100;
const MAX_LOG_ENTRIES = 500;
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
let isScrubbing = false;
let scrubWasPlaying = false;

const replay = {
  traceData: null,
  state: null,
  cycleCache: new Map(),
  prefetchEndIdx: -1,
  prefetchInFlight: false,
  generation: 0,
};

function resetPrefetchState() {
  replay.generation++;
  replay.prefetchInFlight = false;
  replay.cycleCache.clear();
  replay.prefetchEndIdx = -1;
}

async function prefetchFrom(startCycle) {
  if (!replay.traceData || replay.prefetchInFlight) return;
  const { cycleIndex } = replay.traceData;
  const startIdx = TraceParser.findCycleIndexGE(cycleIndex, startCycle);
  if (startIdx >= cycleIndex.length) return;
  const endIdx = Math.min(startIdx + PREFETCH_SIZE - 1, cycleIndex.length - 1);

  const gen = replay.generation;
  replay.prefetchInFlight = true;
  try {
    const batch = await TraceParser.loadCycleRange(replay.traceData, startIdx, endIdx);
    if (gen !== replay.generation) return;
    for (const [cycle, events] of batch) {
      replay.cycleCache.set(cycle, events);
    }
    replay.prefetchEndIdx = endIdx;
  } finally {
    if (gen === replay.generation) {
      replay.prefetchInFlight = false;
    }
  }
}

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
  setupEventListeners();
}

function update(timestamp) {
  grid.update(timestamp);

  if (replay.state && replay.state.playing) {
    const elapsed = timestamp - replay.state.lastTickTime;
    const msPerCycle = 1000 / replay.state.speed;
    const cyclesToAdvance = Math.min(
      Math.floor(elapsed / msPerCycle),
      PREFETCH_SIZE,
    );

    if (cyclesToAdvance > 0) {
      const endCycle = Math.min(
        replay.state.currentCycle + cyclesToAdvance,
        replay.state.maxCycle,
      );

      let advancedTo = replay.state.currentCycle;
      let cacheMiss = false;
      const { cycleIndex } = replay.traceData;
      let idx = TraceParser.findCycleIndexGE(cycleIndex, replay.state.currentCycle + 1);
      while (idx < cycleIndex.length) {
        const cycle = cycleIndex.cycles[idx];
        if (cycle > endCycle) break;
        const events = replay.cycleCache.get(cycle);
        if (!events) {
          prefetchFrom(cycle).catch(() => {});
          cacheMiss = true;
          break;
        }
        applyCycleEvents(cycle, events, msPerCycle);
        replay.cycleCache.delete(cycle);
        advancedTo = cycle;
        idx++;
      }
      // Advance through empty cycles (cycles with no indexed events)
      if (!cacheMiss) advancedTo = endCycle;

      const actualAdvanced = advancedTo - replay.state.currentCycle;
      replay.state.lastTickTime = Math.max(
        replay.state.lastTickTime + actualAdvanced * msPerCycle,
        timestamp - msPerCycle,
      );
      replay.state.currentCycle = advancedTo;

      if (replay.prefetchEndIdx >= 0) {
        const currentIdx = TraceParser.findCycleIndexGE(replay.traceData.cycleIndex, advancedTo + 1);
        if (currentIdx >= replay.prefetchEndIdx - 20) {
          prefetchFrom(advancedTo + 1).catch(() => {});
        }
      }
      updateScrubUI();

      if (advancedTo >= replay.state.maxCycle) {
        replay.state.playing = false;
        els.playPauseBtn.textContent = "\u25B6";
        els.cycleDisplay.textContent =
          `Done (${replay.traceData.totalEvents} events)`;
      }
    }
  }

  // Auto-stop when truly idle: no simulation, no replay loaded, no visual activity
  if (!simulationInterval && !replay.state && !grid.hasActivity()) {
    animationLoop.stop();
  }
}

function draw(timestamp) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  grid.draw(ctx, timestamp);
}

function startSimulation() {
  if (simulationInterval) return;
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

function resumePlayback() {
  if (!replay.state || replay.state.currentCycle >= replay.state.maxCycle) return;
  const now = performance.now();
  const msPerCycle = 1000 / replay.state.speed;
  replay.state.playing = true;
  replay.state.lastTickTime = now;
  for (const pkt of grid.packets) {
    if (pkt.startTime === Infinity) {
      pkt.startTime = now;
      pkt.duration = msPerCycle;
    }
  }
  prefetchFrom(replay.state.currentCycle + 1).catch(() => {});
  els.playPauseBtn.textContent = "\u23F8";
  animationLoop.start();
}

function togglePlayback() {
  if (!replay.state) return;
  if (replay.state.playing) {
    replay.state.playing = false;
    els.playPauseBtn.textContent = "\u25B6";
  } else {
    if (replay.state.currentCycle >= replay.state.maxCycle) {
      seekToCycle(replay.state.minCycle - 1);
    }
    resumePlayback();
  }
}

function adjustSpeed(factor) {
  if (!replay.state) return;
  const newSpeed = replay.state.speed * factor;
  if (newSpeed < 1) return;
  replay.state.speed = newSpeed;
  replay.state.lastTickTime = performance.now();
  els.speedDisplay.textContent = `${newSpeed} cyc/s`;
}

function setupEventListeners() {
  document.getElementById("startBtn").addEventListener("click", startSimulation);
  document.getElementById("allReduceFullBtn").addEventListener("click", startAllReduceFull);
  document.getElementById("spmvBtn").addEventListener("click", startSpMV);
  document.getElementById("cgBtn").addEventListener("click", startCG);
  document.getElementById("traceFileInput").addEventListener("change", handleTraceFile);
  els.scrubBar.addEventListener("pointerdown", () => {
    if (!replay.state || isScrubbing) return;
    isScrubbing = true;
    scrubWasPlaying = replay.state.playing;
    if (replay.state.playing) {
      replay.state.playing = false;
      els.playPauseBtn.textContent = "\u25B6";
    }
    const onRelease = () => {
      window.removeEventListener("pointerup", onRelease);
      isScrubbing = false;
      if (!replay.state || !scrubWasPlaying) return;
      scrubWasPlaying = false;
      resumePlayback();
    };
    window.addEventListener("pointerup", onRelease);
  });
  els.scrubBar.addEventListener("input", (e) => {
    if (!replay.state) return;
    seekToCycle(parseInt(e.target.value));
  });
  els.playPauseBtn.addEventListener("click", togglePlayback);
  document.getElementById("speedDown").addEventListener("click", () => adjustSpeed(0.5));
  document.getElementById("speedUp").addEventListener("click", () => adjustSpeed(2));
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    if (e.code === "Space") {
      e.preventDefault();
      if (!isScrubbing) togglePlayback();
    } else if (e.key === "]") {
      adjustSpeed(2);
    } else if (e.key === "[") {
      adjustSpeed(0.5);
    }
  });
}

function startAlgorithm() {
  stopSimulation();
  showPanel("cg");
  setGrid(GRID_ROWS, GRID_COLS);
  animationLoop.start();
}

function startAllReduceFull() { startAlgorithm(); grid.runAllReduce(); }
function startSpMV() { startAlgorithm(); grid.spmvPattern(); }
function startCG() {
  startAlgorithm();
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
  const line = document.querySelector(`.code-line[data-line="${step.line}"]`);
  if (line) line.classList.add("active");
  els.iterationValue.textContent = `${phase + 1}/5`;
  els.stepValue.textContent = `${stage + 1}/7`;
  els.operationValue.textContent = step.name;
}

function showPanel(panel) {
  els.cgPanel.style.display = panel === "cg" ? "flex" : "none";
  els.tracePanel.style.display = panel === "trace" ? "flex" : "none";
  els.playbackBar.style.display = panel === "trace" ? "flex" : "none";
}

function appendLandingEvents(cycle, events) {
  for (const evt of events.landings) {
    const entry = document.createElement("div");
    entry.className = "trace-entry trace-landing";
    const dir = evt.dir === "R" ? "local" : `\u2190 ${evt.dir}`;
    const cycleSpan = document.createElement("span");
    cycleSpan.className = "trace-cycle";
    cycleSpan.textContent = `@${cycle}`;
    entry.appendChild(cycleSpan);
    entry.appendChild(document.createTextNode(` P${evt.x}.${evt.y} ${dir} C${evt.color}`));
    els.traceLog.appendChild(entry);
  }

  while (els.traceLog.children.length > MAX_LOG_ENTRIES) {
    els.traceLog.removeChild(els.traceLog.firstChild);
  }
  els.traceLog.scrollTop = els.traceLog.scrollHeight;
}

function sendLandingPackets(events, msPerCycle, startTime) {
  const dimY = replay.traceData.dimY;
  for (const evt of events.landings) {
    if (evt.dir === "R") continue;
    const src = TraceParser.sourceCoords(evt.x, evt.y, evt.dir);
    if (!src) continue;
    const srcGrid = TraceParser.toGridCoords(src.x, src.y, dimY);
    const destGrid = TraceParser.toGridCoords(evt.x, evt.y, dimY);
    grid.sendPacket(srcGrid.row, srcGrid.col, destGrid.row, destGrid.col, msPerCycle, startTime);
  }
}

function setGrid(rows, cols) {
  if (grid) grid.cancel();
  grid = new Grid(rows, cols, CELL_SIZE, GAP);
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

async function handleTraceFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = "";

  stopSimulation();
  replay.traceData = await TraceParser.index(file);

  setGrid(replay.traceData.dimY, replay.traceData.dimX);
  animationLoop.start();
  showPanel("trace");
  els.traceLog.innerHTML = "";

  const { minCycle, maxCycle } = replay.traceData;
  const speed = 4;
  els.speedDisplay.textContent = `${speed} cyc/s`;

  resetPrefetchState();

  replay.state = {
    currentCycle: minCycle - 1,
    speed,
    playing: false,
    lastTickTime: performance.now(),
    minCycle,
    maxCycle,
  };

  els.scrubBar.min = minCycle - 1;
  els.scrubBar.max = maxCycle;
  els.scrubBar.value = minCycle - 1;
  els.playPauseBtn.textContent = "\u25B6";
  updateScrubUI();

  await prefetchFrom(minCycle);
}

function applyCycleEvents(cycle, events, msPerCycle) {
  appendLandingEvents(cycle, events);
  sendLandingPackets(events, msPerCycle);

  for (const evt of events.execChanges) {
    const { row, col } = TraceParser.toGridCoords(evt.x, evt.y, replay.traceData.dimY);
    grid.setPEBusy(row, col, evt.busy, evt.op);
  }
}

function updateScrubUI() {
  if (!replay.state) return;
  els.scrubBar.value = replay.state.currentCycle;
  els.cycleDisplay.textContent =
    `Cycle ${replay.state.currentCycle} / ${replay.state.maxCycle}`;
}

function seekToCycle(targetCycle) {
  if (!replay.state || !replay.traceData) return;

  resetPrefetchState();
  grid.cancel();
  grid.cancelled = false;
  grid.clearPackets();
  grid.resetAllPEs();

  const { peStateIndex, cycleIndex } = replay.traceData;

  for (const [key, events] of peStateIndex) {
    const found = TraceParser.findCycleIndexLE({ cycles: new Float64Array(events.map(e => e.cycle)), length: events.length }, targetCycle);
    if (found >= 0) {
      const evt = events[found];
      const [x, y] = key.split(",").map(Number);
      const { row, col } = TraceParser.toGridCoords(x, y, replay.traceData.dimY);
      grid.setPEBusy(row, col, evt.busy, evt.op);
    }
  }

  els.traceLog.innerHTML = "";
  replay.state.currentCycle = targetCycle;
  replay.state.lastTickTime = performance.now();
  updateScrubUI();

  const gen = replay.generation;
  const idx = TraceParser.findCycleIndex(cycleIndex, targetCycle);
  if (idx !== -1) {
    TraceParser.loadCycleRange(replay.traceData, idx, idx).then((batch) => {
      if (gen !== replay.generation || !replay.state) return;
      const events = batch.get(targetCycle);
      if (!events) return;
      const msPerCycle = 1000 / replay.state.speed;
      sendLandingPackets(events, msPerCycle, Infinity);
      animationLoop.start();
    }).catch(() => {});
  }

  prefetchFrom(targetCycle).catch(() => {});
}

function cancelReplay() {
  resetPrefetchState();
  replay.state = null;
  els.cycleDisplay.textContent = "";
  els.playbackBar.style.display = "none";
}

document.addEventListener("DOMContentLoaded", init);
