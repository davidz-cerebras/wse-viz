import { TraceParser } from "./trace-parser.js";

const PREFETCH_SIZE = 100;
const MAX_LOG_ENTRIES = 500;

let grid, els, animationLoop, showPanel;

const replay = {
  traceData: null,
  state: null,
  cycleCache: new Map(),
  prefetchEndIdx: -1,
  prefetchInFlight: false,
  generation: 0,
};

let isScrubbing = false;
let scrubWasPlaying = false;
let handleTraceGeneration = 0;

// PE selection state
let selectedPE = null; // { row, col, traceX, traceY, minCycle, cycleStates }
let peTraceWindowStart = 0; // first cycle rendered in the current DOM window
let peTraceWindowSize = 0;  // number of entries currently in the DOM
const PE_TRACE_WINDOW = 500; // max DOM entries rendered at once

export function initReplay(deps) {
  grid = deps.grid;
  els = deps.els;
  animationLoop = deps.animationLoop;
  showPanel = deps.showPanel;
}

export function setReplayGrid(g) {
  grid = g;
}

export function getReplayState() {
  return replay.state;
}

export function getIsScrubbing() {
  return isScrubbing;
}

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

function appendLandingEvents(cycle, events) {
  if (selectedPE) return; // PE-specific trace is showing instead
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

function applyCycleEvents(cycle, events, msPerCycle) {
  appendLandingEvents(cycle, events);
  sendLandingPackets(events, msPerCycle);

  for (const evt of events.execChanges) {
    const { row, col } = TraceParser.toGridCoords(evt.x, evt.y, replay.traceData.dimY);
    grid.setPEBusy(row, col, evt.busy, evt.op);
  }
}

export function selectPE(row, col, traceX, traceY) {
  if (!replay.traceData || !replay.state) return;

  // Toggle off if clicking the same PE
  if (selectedPE && selectedPE.row === row && selectedPE.col === col) {
    deselectPE();
    return;
  }

  const key = `${traceX},${traceY}`;
  const events = replay.traceData.peStateIndex.get(key) || [];

  grid.deselectAllPEs();
  grid.selectPE(row, col);

  const { minCycle, maxCycle } = replay.state;
  const totalCycles = maxCycle - minCycle + 1;

  // Build flat per-cycle state array: cycleStates[i] = { busy, op } for cycle minCycle+i
  // Uses compact parallel arrays to avoid object-per-cycle overhead
  const busyArr = new Uint8Array(totalCycles); // 0=idle, 1=busy
  const opArr = new Array(totalCycles).fill(null);
  let evtIdx = 0;
  let busy = false;
  let op = null;
  for (let i = 0; i < totalCycles; i++) {
    const cycle = minCycle + i;
    while (evtIdx < events.length && events[evtIdx].cycle <= cycle) {
      busy = events[evtIdx].busy;
      op = events[evtIdx].op;
      evtIdx++;
    }
    if (busy) {
      busyArr[i] = 1;
      opArr[i] = op;
    }
  }

  selectedPE = { row, col, traceX, traceY, minCycle, totalCycles, busyArr, opArr };

  // Update panel header
  els.tracePanel.querySelector("h2").textContent = `PE P${traceX}.${traceY} Trace`;

  renderPETraceWindow(replay.state.currentCycle);
  setupPETraceScroll();
}

function renderPETraceWindow(centerCycle) {
  if (!selectedPE) return;
  const { minCycle, totalCycles, busyArr, opArr } = selectedPE;

  const centerIdx = Math.max(0, Math.min(centerCycle - minCycle, totalCycles - 1));
  const halfWin = Math.floor(PE_TRACE_WINDOW / 2);
  let startIdx = Math.max(0, centerIdx - halfWin);
  let endIdx = Math.min(totalCycles, startIdx + PE_TRACE_WINDOW);
  startIdx = Math.max(0, endIdx - PE_TRACE_WINDOW);

  // Skip re-render if window hasn't changed
  if (peTraceWindowStart === startIdx && peTraceWindowSize === endIdx - startIdx) {
    updatePETraceHighlight();
    return;
  }

  els.traceLog.innerHTML = "";
  const frag = document.createDocumentFragment();

  for (let i = startIdx; i < endIdx; i++) {
    const cycle = minCycle + i;
    const busy = busyArr[i];
    const entry = document.createElement("div");
    entry.className = busy ? "trace-entry trace-exec" : "trace-entry trace-idle";
    entry.dataset.cycle = cycle;

    const cycleSpan = document.createElement("span");
    cycleSpan.className = "trace-cycle";
    cycleSpan.textContent = `@${cycle}`;
    entry.appendChild(cycleSpan);
    entry.appendChild(document.createTextNode(busy ? ` EX ${opArr[i] || "?"}` : " IDLE"));

    frag.appendChild(entry);
  }
  els.traceLog.appendChild(frag);

  peTraceWindowStart = startIdx;
  peTraceWindowSize = endIdx - startIdx;

  updatePETraceHighlight();
}

function setupPETraceScroll() {
  // Re-render window when user scrolls to edges
  els.traceLog.onscroll = () => {
    if (!selectedPE) return;
    const log = els.traceLog;
    const atTop = log.scrollTop < 40;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;

    if (atTop && peTraceWindowStart > 0) {
      renderPETraceWindow(selectedPE.minCycle + peTraceWindowStart - 1);
    } else if (atBottom && peTraceWindowStart + peTraceWindowSize < selectedPE.totalCycles) {
      renderPETraceWindow(selectedPE.minCycle + peTraceWindowStart + peTraceWindowSize);
    }
  };
}

export function deselectPE() {
  if (!selectedPE) return;
  grid.deselectAllPEs();
  selectedPE = null;
  peTraceWindowStart = 0;
  peTraceWindowSize = 0;
  els.traceLog.onscroll = null;

  // Restore panel header
  els.tracePanel.querySelector("h2").textContent = "Trace Events";
  els.traceLog.innerHTML = "";
}

function updatePETraceHighlight() {
  if (!selectedPE || !replay.state) return;

  const idx = replay.state.currentCycle - selectedPE.minCycle;
  const localIdx = idx - peTraceWindowStart;

  // Remove previous highlight
  const prev = els.traceLog.querySelector(".trace-entry.current");
  if (prev) prev.classList.remove("current");

  // If current cycle is outside the rendered window, re-render around it
  if (idx >= 0 && idx < selectedPE.totalCycles) {
    if (localIdx < 0 || localIdx >= peTraceWindowSize) {
      renderPETraceWindow(replay.state.currentCycle);
      return; // renderPETraceWindow calls us recursively
    }
    const entries = els.traceLog.children;
    if (localIdx < entries.length) {
      entries[localIdx].classList.add("current");
      entries[localIdx].scrollIntoView({ block: "nearest" });
    }
  }
}

function updateScrubUI() {
  if (!replay.state) return;
  els.scrubBar.value = replay.state.currentCycle;
  els.cycleDisplay.textContent =
    `Cycle ${replay.state.currentCycle} / ${replay.state.maxCycle}`;
}

export function updateReplayTick(timestamp) {
  if (!replay.state || !replay.state.playing) return;

  const elapsed = timestamp - replay.state.lastTickTime;
  const msPerCycle = 1000 / replay.state.speed;
  const cyclesToAdvance = Math.min(
    Math.floor(elapsed / msPerCycle),
    PREFETCH_SIZE,
  );

  if (cyclesToAdvance <= 0) return;

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
  updatePETraceHighlight();

  if (advancedTo >= replay.state.maxCycle) {
    replay.state.playing = false;
    els.playPauseBtn.textContent = "\u25B6";
    els.cycleDisplay.textContent =
      `Done (${replay.traceData.totalEvents} events)`;
  }
}

export function resumePlayback() {
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

export function togglePlayback() {
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

export function adjustSpeed(factor) {
  if (!replay.state) return;
  const newSpeed = replay.state.speed * factor;
  if (newSpeed < 1) return;
  replay.state.speed = newSpeed;
  replay.state.lastTickTime = performance.now();
  els.speedDisplay.textContent = `${newSpeed} cyc/s`;
}

export function seekToCycle(targetCycle) {
  if (!replay.state || !replay.traceData) return;

  resetPrefetchState();
  grid.resetTimers();
  grid.clearPackets();
  grid.resetAllPEs();

  const { peStateIndex, cycleIndex } = replay.traceData;

  for (const [key, events] of peStateIndex) {
    const found = TraceParser.findCycleIndexLE(
      { cycles: events.cycleArray, length: events.length },
      targetCycle,
    );
    if (found >= 0) {
      const evt = events[found];
      const [x, y] = key.split(",").map(Number);
      const { row, col } = TraceParser.toGridCoords(x, y, replay.traceData.dimY);
      grid.setPEBusy(row, col, evt.busy, evt.op);
    }
  }

  if (!selectedPE) {
    els.traceLog.innerHTML = "";
  }
  replay.state.currentCycle = targetCycle;
  replay.state.lastTickTime = performance.now();
  updateScrubUI();
  updatePETraceHighlight();

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

export function cancelReplay() {
  resetPrefetchState();
  deselectPE();
  replay.state = null;
  isScrubbing = false;
  scrubWasPlaying = false;
  showPanel(null);
  els.cycleDisplay.textContent = "";
}

export async function handleTraceFile(event, setGrid) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = "";

  const myGen = ++handleTraceGeneration;

  const traceData = await TraceParser.index(file);
  if (myGen !== handleTraceGeneration) return;

  deselectPE();
  replay.traceData = traceData;
  setGrid(traceData.dimY, traceData.dimX);
  animationLoop.start();
  showPanel("trace");
  els.traceLog.innerHTML = "";

  const { minCycle, maxCycle } = traceData;
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

function handleTraceLogClick(e) {
  if (!selectedPE || !replay.state) return;
  const entry = e.target.closest(".trace-entry");
  if (!entry || !entry.dataset.cycle) return;
  seekToCycle(parseInt(entry.dataset.cycle, 10));
}

export function setupScrubListeners() {
  els.traceLog.addEventListener("click", handleTraceLogClick);
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
    seekToCycle(parseInt(e.target.value, 10));
  });
}
