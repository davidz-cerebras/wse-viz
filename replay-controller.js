import { TraceParser } from "./trace-parser.js";
import { extractBranches, TracedPacket } from "./wavelet.js";
import { MAX_LOG_ENTRIES, PE_TRACE_WINDOW } from "./constants.js";

let grid, els, animationLoop, showPanel;

const replay = {
  traceData: null,
  state: null,
};

let isScrubbing = false;
let scrubWasPlaying = false;
let handleTraceGeneration = 0;

// PE selection state
let selectedPE = null; // { row, col, traceX, traceY, minCycle, cycleStates }
let peTraceWindowStart = 0; // first cycle rendered in the current DOM window
let peTraceWindowSize = 0;  // number of entries currently in the DOM
let peTraceScrollLock = false; // prevents scroll-handler re-entrancy
let lastReconstructedCycle = -1; // tracks when to call reconstructStateAtCycle

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

function appendLandingEvents(cycle, landings) {
  if (selectedPE || !landings) return;
  for (const evt of landings) {
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

function getBranches(wv) {
  if (!wv._branches) wv._branches = extractBranches(wv);
  return wv._branches;
}

function syncTracedPackets(cycle, fraction) {
  const fc = cycle + (fraction || 0);
  for (const pkt of grid.packets) {
    if (pkt instanceof TracedPacket) {
      pkt.setCycle(cycle);
      pkt.setFractionalCycle(fc);
    }
  }
}

function sendLandingPackets(landings, msPerCycle, startTime) {
  const dimY = replay.traceData.dimY;
  for (const evt of landings) {
    if (evt.dir === "R") continue;
    const src = TraceParser.sourceCoords(evt.x, evt.y, evt.dir);
    if (!src) continue;
    const srcGrid = TraceParser.toGridCoords(src.x, src.y, dimY);
    const destGrid = TraceParser.toGridCoords(evt.x, evt.y, dimY);
    grid.sendPacket(srcGrid.row, srcGrid.col, destGrid.row, destGrid.col, msPerCycle, startTime);
  }
}

/**
 * Reconstruct the full grid state at a given cycle. Used by both seek and playback
 * to ensure a single consistent code path for state reconstruction.
 */
function reconstructStateAtCycle(targetCycle, currentCycleLandings) {
  const td = replay.traceData;
  if (!td) return;

  grid.clearPackets();
  grid.resetAllPEs();

  // 1. Reconstruct EX OP state from peStateIndex (compact typed arrays)
  for (const [key, entry] of td.peStateIndex) {
    const found = TraceParser.findCycleIndexLE(
      { cycles: entry.cycles, length: entry.length },
      targetCycle,
    );
    if (found >= 0) {
      let exIdx = -1;
      for (let i = found; i >= 0; i--) {
        if (!entry.stall[i]) { exIdx = i; break; }
      }
      if (exIdx >= 0) {
        const [x, y] = key.split(",").map(Number);
        const { row, col } = TraceParser.toGridCoords(x, y, td.dimY);
        grid.setPEBusy(row, col, !!entry.busy[exIdx], entry.ops[exIdx], null);
      }
    }
  }

  // 2. Overlay stall state from peStallIndex ranges
  for (const [key, ranges] of td.peStallIndex) {
    for (const range of ranges) {
      if (targetCycle >= range.startCycle && targetCycle <= range.endCycle) {
        const [x, y] = key.split(",").map(Number);
        const { row, col } = TraceParser.toGridCoords(x, y, td.dimY);
        grid.setPEStall(row, col, "wavelet");
        break;
      }
    }
  }

  // 3. Create packets for in-flight wavelets or DataPackets for old traces
  if (td.hasWaveletData) {
    for (const [, wv] of td.waveletIndex) {
      const firstCycle = wv.hops.cycles[0];
      const lastCycle = wv.hops.cycles[wv.hops.length - 1];
      if (firstCycle > targetCycle || lastCycle < targetCycle) continue;
      const branches = getBranches(wv);
      for (const waypoints of branches) {
        const branchEnd = waypoints[waypoints.length - 1].cycle;
        if (branchEnd < targetCycle) continue;
        const pkt = new TracedPacket(waypoints, td.dimY);
        pkt.setCycle(targetCycle);
        pkt.setFractionalCycle(targetCycle);
        grid.packets.push(pkt);
      }
    }
  } else if (currentCycleLandings) {
    // Old traces: create DataPackets from landing events for the current cycle
    const msPerCycle = replay.state ? 1000 / replay.state.speed : 250;
    sendLandingPackets(currentCycleLandings, msPerCycle);
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
  const entry = replay.traceData.peStateIndex.get(key);

  grid.selectPE(row, col);
  peTraceScrollLock = false;

  const { minCycle, maxCycle } = replay.state;
  const totalCycles = maxCycle - minCycle + 1;

  // Build flat per-cycle state arrays for both pipeline stages:
  //   E stage (Execute): busyArr + opArr
  //   C stage (CalcAddr): stallArr + stallColorArr
  const busyArr = new Uint8Array(totalCycles);
  const opArr = new Array(totalCycles).fill(null);
  const predArr = new Array(totalCycles).fill(null);
  const stallArr = new Uint8Array(totalCycles);
  const stallColorArr = new Array(totalCycles).fill(null);

  // Fill E stage from EX OP events (forward-carry)
  if (entry) {
    let evtIdx = 0;
    let curBusy = 0;
    let curOp = null;
    let curPred = null;
    for (let i = 0; i < totalCycles; i++) {
      const cycle = minCycle + i;
      while (evtIdx < entry.length && entry.cycles[evtIdx] <= cycle) {
        if (!entry.stall[evtIdx]) {
          curBusy = entry.busy[evtIdx];
          curOp = entry.ops[evtIdx];
          curPred = entry.preds[evtIdx];
        }
        evtIdx++;
      }
      if (curBusy) {
        busyArr[i] = 1;
        opArr[i] = curOp;
        predArr[i] = curPred;
      }
    }
  }

  // Fill C stage from peStallIndex ranges
  const stallRanges = replay.traceData.peStallIndex.get(key) || [];
  for (const range of stallRanges) {
    const start = Math.max(0, range.startCycle - minCycle);
    const end = Math.min(totalCycles - 1, range.endCycle - minCycle);
    for (let i = start; i <= end; i++) {
      stallArr[i] = 1;
      stallColorArr[i] = range.color;
    }
  }

  // Count cycles per opcode for the bar chart (strip .NF/.T suffixes)
  const opCounts = new Map();
  for (let i = 0; i < totalCycles; i++) {
    if (busyArr[i]) {
      const o = (opArr[i] || "?").split(".")[0];
      opCounts.set(o, (opCounts.get(o) || 0) + 1);
    }
  }

  selectedPE = { row, col, traceX, traceY, minCycle, totalCycles, busyArr, stallArr, stallColorArr, opArr, predArr, opCounts };

  // Update panel header
  els.tracePanel.querySelector("h2").textContent = `P${traceX}.${traceY} Trace`;

  renderOpChart();
  renderPETraceWindow(replay.state.currentCycle);
  setupPETraceScroll();
}

function renderOpChart() {
  if (!selectedPE) return;
  const { opCounts } = selectedPE;

  els.opChart.innerHTML = "";
  els.opChart.classList.remove("hidden");
  els.panelResizer.classList.remove("hidden");

  if (opCounts.size === 0) {
    els.opChart.classList.add("hidden");
    els.panelResizer.classList.add("hidden");
    return;
  }

  // Sort by count descending
  const sorted = [...opCounts.entries()].sort((a, b) => b[1] - a[1]);
  const maxCount = sorted[0][1];

  for (const [op, count] of sorted) {
    const row = document.createElement("div");
    row.className = "op-chart-row";
    row.dataset.op = op;

    const label = document.createElement("span");
    label.className = "op-chart-label";
    label.textContent = op;

    const barContainer = document.createElement("div");
    barContainer.className = "op-chart-bar-container";

    const bar = document.createElement("div");
    bar.className = "op-chart-bar";
    bar.style.width = `${(count / maxCount) * 100}%`;

    const countSpan = document.createElement("span");
    countSpan.className = "op-chart-count";
    countSpan.textContent = count;

    barContainer.appendChild(bar);
    barContainer.appendChild(countSpan);
    row.appendChild(label);
    row.appendChild(barContainer);
    els.opChart.appendChild(row);
  }

  // Default height: show ~4.5 rows to hint that scrolling reveals more
  els.opChart.style.maxHeight = "";
  if (sorted.length > 4) {
    requestAnimationFrame(() => {
      const firstRow = els.opChart.querySelector(".op-chart-row");
      if (firstRow) {
        const rowH = firstRow.offsetHeight + 4; // 4px gap
        const padding = 16; // 0.5rem * 2
        els.opChart.style.maxHeight = `${Math.round(rowH * 4.5 + padding)}px`;
      }
    });
  }
}

function updateOpChartHighlight() {
  if (!selectedPE || !replay.state) return;
  const idx = replay.state.currentCycle - selectedPE.minCycle;
  let currentOp = null;
  if (idx >= 0 && idx < selectedPE.totalCycles && selectedPE.busyArr[idx]) {
    currentOp = (selectedPE.opArr[idx] || "?").split(".")[0];
  }

  for (const row of els.opChart.children) {
    row.classList.toggle("active", row.dataset.op === currentOp);
  }
}

function renderPETraceWindow(centerCycle) {
  if (!selectedPE) return;
  const { minCycle, totalCycles, busyArr, stallArr, stallColorArr, opArr, predArr } = selectedPE;

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
    const stalled = stallArr[i];
    const entry = document.createElement("div");
    entry.className = "trace-entry trace-pipeline";
    entry.dataset.cycle = cycle;

    const cycleSpan = document.createElement("span");
    cycleSpan.className = "trace-cycle";
    cycleSpan.textContent = `@${cycle}`;
    entry.appendChild(cycleSpan);

    // C stage (CalcAddr/operand fetch)
    const cSpan = document.createElement("span");
    cSpan.className = stalled ? "trace-pipe-stage trace-stall" : "trace-pipe-stage trace-pipe-empty";
    cSpan.textContent = stalled ? `STALL C${stallColorArr[i]}` : "\u2014";
    entry.appendChild(cSpan);

    // Predicate prefix
    const predSpan = document.createElement("span");
    predSpan.className = "trace-pipe-stage trace-pred";
    predSpan.textContent = predArr[i] || "";
    entry.appendChild(predSpan);

    // E stage (Execute)
    const eSpan = document.createElement("span");
    eSpan.className = busy ? "trace-pipe-stage trace-exec" : "trace-pipe-stage trace-idle";
    eSpan.textContent = busy ? (opArr[i] || "?") : "IDLE";
    entry.appendChild(eSpan);

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
    if (!selectedPE || peTraceScrollLock) return;
    const log = els.traceLog;
    const atTop = log.scrollTop < 40;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;

    if (atTop && peTraceWindowStart > 0) {
      peTraceScrollLock = true;
      try { renderPETraceWindow(selectedPE.minCycle + peTraceWindowStart - 1); }
      finally { peTraceScrollLock = false; }
    } else if (atBottom && peTraceWindowStart + peTraceWindowSize < selectedPE.totalCycles) {
      peTraceScrollLock = true;
      try { renderPETraceWindow(selectedPE.minCycle + peTraceWindowStart + peTraceWindowSize); }
      finally { peTraceScrollLock = false; }
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
  els.opChart.innerHTML = "";
  els.opChart.classList.add("hidden");
  els.panelResizer.classList.add("hidden");
  // Reset any explicit flex sizing from drag
  els.traceLog.style.flex = "";
  els.opChart.style.flex = "";
  els.opChart.style.maxHeight = "";
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
      peTraceScrollLock = true;
      try { entries[localIdx].scrollIntoView({ block: "nearest" }); }
      finally { peTraceScrollLock = false; }
    }
  }

  updateOpChartHighlight();
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

  // Always sync fractional position for smooth animation, even between cycle ticks
  const subCycleFraction = Math.min(elapsed / msPerCycle, 1);
  syncTracedPackets(replay.state.currentCycle, subCycleFraction);

  const cyclesToAdvance = Math.floor(elapsed / msPerCycle);
  if (cyclesToAdvance <= 0) return;

  const endCycle = Math.min(
    replay.state.currentCycle + cyclesToAdvance,
    replay.state.maxCycle,
  );

  // Append landing events — only for the tail of the range to avoid
  // wasteful DOM work when jumping many cycles (e.g. tab was backgrounded)
  const td = replay.traceData;
  const logStart = Math.max(replay.state.currentCycle + 1, endCycle - MAX_LOG_ENTRIES);
  for (let c = logStart; c <= endCycle; c++) {
    const landings = td.landingsByCycle.get(c);
    if (landings) appendLandingEvents(c, landings);
  }

  const actualAdvanced = endCycle - replay.state.currentCycle;
  replay.state.lastTickTime = Math.max(
    replay.state.lastTickTime + actualAdvanced * msPerCycle,
    timestamp - msPerCycle,
  );
  replay.state.currentCycle = endCycle;

  // Only reconstruct when the cycle actually changes (not every frame)
  if (endCycle !== lastReconstructedCycle) {
    const landings = td.landingsByCycle.get(endCycle);
    reconstructStateAtCycle(endCycle, landings || null);
    lastReconstructedCycle = endCycle;
  }
  const fraction = (timestamp - replay.state.lastTickTime) / msPerCycle;
  syncTracedPackets(endCycle, Math.min(fraction, 1));

  updateScrubUI();
  updatePETraceHighlight();

  if (endCycle >= replay.state.maxCycle) {
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
  if (!replay.state || !replay.traceData || !Number.isFinite(targetCycle)) return;

  grid.resetTimers();

  // Reconstruct state without landings (seek uses frozen packets separately)
  reconstructStateAtCycle(targetCycle);
  lastReconstructedCycle = targetCycle;

  if (!selectedPE) {
    els.traceLog.innerHTML = "";
  }
  replay.state.currentCycle = targetCycle;
  replay.state.lastTickTime = performance.now();
  updateScrubUI();
  updatePETraceHighlight();

  // For old traces without wavelet data, show frozen DataPackets for the target cycle
  const td = replay.traceData;
  if (!td.hasWaveletData) {
    const landings = td.landingsByCycle.get(targetCycle);
    if (landings) {
      const msPerCycle = 1000 / replay.state.speed;
      sendLandingPackets(landings, msPerCycle, Infinity);
    }
  }

  animationLoop.start();
}

export function cancelReplay() {
  handleTraceGeneration++;
  deselectPE();
  replay.state = null;
  lastReconstructedCycle = -1;
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

  // Null out stale replay/trace state so playback controls are inert during
  // indexing, and so a thrown exception doesn't leave stale traceData behind.
  replay.state = null;
  replay.traceData = null;

  // Show only the playback bar for progress text — don't call showPanel("trace")
  // yet, since that triggers resizeCanvas on the old grid.
  els.playbackBar.classList.remove("hidden");
  els.cycleDisplay.textContent = "Indexing\u2026";

  const traceData = await TraceParser.index(file, (pct) => {
    if (myGen !== handleTraceGeneration) return;
    els.cycleDisplay.textContent = `Indexing\u2026 ${pct}%`;
  });
  if (myGen !== handleTraceGeneration) return;

  if (traceData.dimX === 0 || traceData.dimY === 0 || traceData.minCycle > traceData.maxCycle) {
    els.cycleDisplay.textContent = "Error: invalid trace file";
    els.playbackBar.classList.add("hidden");
    deselectPE();
    replay.traceData = null;
    return;
  }

  deselectPE();
  lastReconstructedCycle = -1;
  replay.traceData = traceData;
  setGrid(traceData.dimY, traceData.dimX);
  animationLoop.start();
  showPanel("trace");
  els.traceLog.innerHTML = "";

  const { minCycle, maxCycle } = traceData;
  const speed = 4;
  els.speedDisplay.textContent = `${speed} cyc/s`;

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
      window.removeEventListener("pointercancel", onRelease);
      isScrubbing = false;
      if (!replay.state || !scrubWasPlaying) return;
      scrubWasPlaying = false;
      resumePlayback();
    };
    window.addEventListener("pointerup", onRelease);
    window.addEventListener("pointercancel", onRelease);
  });
  els.scrubBar.addEventListener("input", (e) => {
    if (!replay.state) return;
    seekToCycle(parseInt(e.target.value, 10));
  });

  // Panel resizer drag
  els.panelResizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    els.panelResizer.classList.add("dragging");
    els.panelResizer.setPointerCapture(e.pointerId);
    els.opChart.style.maxHeight = ""; // remove default cap so resizer is unconstrained

    const startY = e.clientY;
    const logStart = els.traceLog.getBoundingClientRect().height;
    const chartStart = els.opChart.getBoundingClientRect().height;

    const onMove = (ev) => {
      const dy = ev.clientY - startY;
      const newLog = Math.max(60, logStart + dy);
      const newChart = Math.max(60, chartStart - dy);
      const sum = newLog + newChart;
      els.traceLog.style.flex = `${newLog / sum}`;
      els.opChart.style.flex = `${newChart / sum}`;
    };

    const onUp = () => {
      els.panelResizer.classList.remove("dragging");
      els.panelResizer.removeEventListener("pointermove", onMove);
      els.panelResizer.removeEventListener("pointerup", onUp);
      els.panelResizer.removeEventListener("pointercancel", onUp);
    };

    els.panelResizer.addEventListener("pointermove", onMove);
    els.panelResizer.addEventListener("pointerup", onUp);
    els.panelResizer.addEventListener("pointercancel", onUp);
  });
}
