import { TraceParser, LANDING_DECODE } from "./trace-parser.js";
import { extractBranches, TracedPacket } from "./wavelet.js";
import { buildOpEntryLookup } from "./pe.js";
import { PE_TRACE_WINDOW } from "./constants.js";

let grid, els, animationLoop, showPanel, resizeCanvas;

let traceData = null;
let state = null;

let isScrubbing = false;
let scrubWasPlaying = false;
let handleTraceGeneration = 0;
let activeWorker = null; // current trace-loading worker, terminated on cancel/re-load

// PE selection state
let selectedPE = null; // { row, col, traceX, traceY, minCycle, cycleStates }
let peTraceWindowStart = 0; // first cycle rendered in the current DOM window
let peTraceWindowSize = 0;  // number of entries currently in the DOM
let peTraceScrollLock = false; // prevents scroll-handler re-entrancy
let lastReconstructedCycle = -1; // tracks when to call reconstructStateAtCycle
let maxCycleStr = ""; // cached String(maxCycle) for updateScrubUI

let wavScanStart = 0; // low-water mark: wavelets before this index have expired

export function initReplay(deps) {
  grid = deps.grid;
  els = deps.els;
  animationLoop = deps.animationLoop;
  showPanel = deps.showPanel;
  resizeCanvas = deps.resizeCanvas;
}

export function setReplayGrid(g) {
  grid = g;
}

export function getReplayState() {
  return state;
}

export function getIsScrubbing() {
  return isScrubbing;
}


function getBranches(wv) {
  if (!wv._branches) wv._branches = extractBranches(wv);
  return wv._branches;
}

function syncTracedPackets(cycle, fraction) {
  const fc = cycle + (fraction ?? 0);
  for (const pkt of grid.packets) {
    if (pkt.syncTo) pkt.syncTo(cycle, fc);
  }
}

function sendLandingPackets(landingRange, msPerCycle, startTime) {
  const td = traceData;
  const li = td.landingIndex;
  const { start, end } = landingRange;
  for (let i = start; i < end; i++) {
    const dirChar = LANDING_DECODE[li.dirs[i]];
    if (dirChar === "R") continue;
    const src = TraceParser.sourceCoords(li.xs[i], li.ys[i], dirChar);
    if (!src) continue;
    const srcGrid = TraceParser.toGridCoords(src.x, src.y, td.dimY);
    const destGrid = TraceParser.toGridCoords(li.xs[i], li.ys[i], td.dimY);
    grid.sendPacket(srcGrid.row, srcGrid.col, destGrid.row, destGrid.col, msPerCycle, startTime);
  }
}

/**
 * Reconstruct the full grid state at a given cycle. Used by both seek and playback
 * to ensure a single consistent code path for state reconstruction.
 */
function reconstructStateAtCycle(targetCycle, currentCycleLandings) {
  const td = traceData;
  if (!td) return;

  grid.clearPackets();

  // Retreat wavelet scan low-water mark on backward seek
  if (targetCycle < lastReconstructedCycle) {
    while (wavScanStart > 0 && td.waveletList[wavScanStart - 1].lastCycle >= targetCycle) {
      wavScanStart--;
    }
  }

  const cols = grid.cols;
  const pes = grid.pes;
  for (const item of td.peStateList) {
    const entry = item.entry;
    const pe = pes[item.row * cols + item.col];
    const found = TraceParser.findCycleIndexLE(entry.cycles, entry.length, targetCycle);
    if (found >= 0) {
      let exIdx = -1;
      let stallIdx = -1;
      for (let i = found; i >= 0; i--) {
        if (!entry.stall[i]) { exIdx = i; break; }
        if (stallIdx < 0) stallIdx = i;
      }
      // Also check for a same-cycle stall just before the EX entry.
      // The pipeline can have a stall (e.g., at issue stage) and an
      // executing op (at EX stage) simultaneously at the same cycle.
      if (exIdx >= 0 && stallIdx < 0 && exIdx > 0 &&
          entry.stall[exIdx - 1] && entry.cycles[exIdx - 1] === entry.cycles[exIdx]) {
        stallIdx = exIdx - 1;
      }
      if (exIdx >= 0) {
        const opId = entry.opIds[exIdx];
        pe.setBusy(!!entry.busy[exIdx], td.opLookup[opId], td.opEntryLookup[opId]);
      } else {
        pe.setBusy(false, null, null);
      }
      if (stallIdx >= 0 && (exIdx < 0 || entry.cycles[stallIdx] >= entry.cycles[exIdx])) {
        const reasons = entry.stallReasons[stallIdx];
        const primary = reasons[0];
        grid.setPEStall(item.row, item.col, primary.type, primary.reason);
      }
    } else {
      pe.setBusy(false, null, null);
    }
  }

  // 2. Create packets for in-flight wavelets or DataPackets for old traces.
  // waveletList is sorted by firstCycle. Binary search for upper bound,
  // low-water mark skips expired wavelets from the bottom.
  if (td.waveletList) {
    const wvList = td.waveletList;
    const wvLen = wvList.length;

    // Binary search: find first index where firstCycle > targetCycle
    let lo = wavScanStart, hi = wvLen;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (wvList[mid].firstCycle <= targetCycle) lo = mid + 1;
      else hi = mid;
    }
    const upperBound = lo;

    // Advance low-water mark past expired wavelets
    while (wavScanStart < upperBound && wvList[wavScanStart].lastCycle < targetCycle) {
      wavScanStart++;
    }

    for (let wi = wavScanStart; wi < upperBound; wi++) {
      const wv = wvList[wi];
      if (wv.lastCycle < targetCycle) continue;
      const branches = getBranches(wv);
      for (const waypoints of branches) {
        const branchEnd = waypoints[waypoints.length - 1].cycle;
        if (branchEnd < targetCycle) continue;
        const pkt = new TracedPacket(waypoints, td.dimY, wv.color, wv.ctrl, wv.lf);
        pkt.syncTo(targetCycle, targetCycle);
        grid.packets.push(pkt);
      }
    }
  } else if (currentCycleLandings) {
    const msPerCycle = 1000 / state.speed;
    sendLandingPackets(currentCycleLandings, msPerCycle);
  }

}

export function selectPE(row, col, traceX, traceY) {
  if (!traceData || !state) return;

  // Toggle off if clicking the same PE
  if (selectedPE && selectedPE.row === row && selectedPE.col === col) {
    deselectPE();
    return;
  }

  // Clean up previous PE selection before switching to the new one
  if (selectedPE) deselectPE();

  const key = `${traceX},${traceY}`;
  const td = traceData;
  const entry = td.peStateIndex.get(key);

  grid.selectPE(row, col);
  els.tracePanel.classList.remove("hidden");
  requestAnimationFrame(resizeCanvas);
  peTraceScrollLock = false;

  const { minCycle, maxCycle } = state;
  const totalCycles = maxCycle - minCycle + 1;

  // Build flat per-cycle state arrays:
  //   E stage (Execute): busyArr + opArr + predArr
  //   Stalls: stallReasonArr (array of {reason, type} objects, or null)
  const busyArr = new Uint8Array(totalCycles);
  const opArr = new Array(totalCycles).fill(null);
  const predArr = new Array(totalCycles).fill(null);
  const stallReasonArr = new Array(totalCycles).fill(null);

  // Fill from peStateIndex events (forward-carry)
  if (entry) {
    let evtIdx = 0;
    let curBusy = 0;
    let curOp = null;
    let curPred = null;
    let curStallReason = null;
    for (let i = 0; i < totalCycles; i++) {
      const cycle = minCycle + i;
      while (evtIdx < entry.length && entry.cycles[evtIdx] <= cycle) {
        if (entry.stall[evtIdx]) {
          curStallReason = entry.stallReasons[evtIdx];
        } else {
          curBusy = entry.busy[evtIdx];
          curOp = td.opLookup[entry.opIds[evtIdx]];
          curPred = td.predLookup[entry.predIds[evtIdx]];
          curStallReason = null;
        }
        evtIdx++;
      }
      if (curBusy) {
        busyArr[i] = 1;
        opArr[i] = curOp;
        predArr[i] = curPred;
      }
      stallReasonArr[i] = curStallReason;
    }
  }

  // Count cycles per opcode for the bar chart (strip .NF/.T suffixes)
  const opCounts = new Map();
  for (let i = 0; i < totalCycles; i++) {
    if (busyArr[i]) {
      const o = (opArr[i] || "?").split(".")[0];
      if (o !== "NOP") opCounts.set(o, (opCounts.get(o) || 0) + 1);
    }
  }

  selectedPE = { row, col, traceX, traceY, minCycle, totalCycles, busyArr, stallReasonArr, opArr, predArr, opCounts };

  // Update panel header
  els.tracePanel.querySelector("h2").textContent = `P${traceX}.${traceY} Trace`;

  renderOpChart();
  renderPETraceWindow(state.currentCycle);
  setupPETraceScroll();
}

function renderOpChart() {
  if (!selectedPE) return;
  const { opCounts } = selectedPE;

  els.opChart.innerHTML = "";

  if (opCounts.size === 0) {
    els.opChart.classList.add("hidden");
    els.panelResizer.classList.add("hidden");
    return;
  }

  els.opChart.classList.remove("hidden");
  els.panelResizer.classList.remove("hidden");

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
  if (!selectedPE || !state) return;
  const idx = state.currentCycle - selectedPE.minCycle;
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
  const { minCycle, totalCycles, busyArr, stallReasonArr, opArr, predArr } = selectedPE;

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
    const stallReasons = stallReasonArr[i];
    const entry = document.createElement("div");
    entry.className = "trace-entry";
    entry.dataset.cycle = cycle;

    const cycleSpan = document.createElement("span");
    cycleSpan.className = "trace-cycle";
    cycleSpan.textContent = `@${cycle}`;
    entry.appendChild(cycleSpan);

    // Stall reason (show first reason, ellipsis if multiple)
    const cSpan = document.createElement("span");
    if (stallReasons) {
      cSpan.className = "trace-pipe-stage trace-stall";
      cSpan.textContent = stallReasons.length > 1
        ? stallReasons[0].reason + "\u2026"
        : stallReasons[0].reason;
    } else {
      cSpan.className = "trace-pipe-stage trace-pipe-empty";
      cSpan.textContent = "\u2014";
    }
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
  _highlightedEntry = null;
  els.traceLog.onscroll = null;

  els.tracePanel.classList.add("hidden");
  requestAnimationFrame(resizeCanvas);
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

let _highlightedEntry = null; // cached reference to avoid querySelector per frame

function updatePETraceHighlight() {
  if (!selectedPE || !state) return;

  const idx = state.currentCycle - selectedPE.minCycle;
  const localIdx = idx - peTraceWindowStart;

  // Remove previous highlight
  if (_highlightedEntry) { _highlightedEntry.classList.remove("current"); _highlightedEntry = null; }

  // If current cycle is outside the rendered window, re-render around it
  if (idx >= 0 && idx < selectedPE.totalCycles) {
    if (localIdx < 0 || localIdx >= peTraceWindowSize) {
      renderPETraceWindow(state.currentCycle);
      return; // renderPETraceWindow calls us recursively
    }
    const entries = els.traceLog.children;
    if (localIdx < entries.length) {
      _highlightedEntry = entries[localIdx];
      _highlightedEntry.classList.add("current");
      peTraceScrollLock = true;
      try { entries[localIdx].scrollIntoView({ block: "nearest" }); }
      finally { peTraceScrollLock = false; }
    }
  }

  updateOpChartHighlight();
}

function updateScrubUI() {
  if (!state) return;
  els.scrubBar.value = state.currentCycle;
  const curStr = state.currentCycle.toLocaleString().padStart(maxCycleStr.length);
  els.cycleDisplay.textContent = `Cycle ${curStr} / ${maxCycleStr}`;
}

export function updateReplayTick(timestamp) {
  if (!state || !state.playing) return;

  const dir = state.direction;
  const elapsed = timestamp - state.lastTickTime;
  const msPerCycle = 1000 / state.speed;

  const cyclesToAdvance = Math.floor(elapsed / msPerCycle);
  if (cyclesToAdvance <= 0) {
    // No cycle change — just sync fractional position for smooth animation
    const frac = dir * Math.min(elapsed / msPerCycle, 1);
    syncTracedPackets(state.currentCycle, frac);
    return;
  }

  // Advance (or retreat) by direction × cycles, clamped to trace bounds
  const limit = dir > 0 ? state.maxCycle : state.minCycle;
  const endCycle = dir > 0
    ? Math.min(state.currentCycle + cyclesToAdvance, limit)
    : Math.max(state.currentCycle - cyclesToAdvance, limit);

  const td = traceData;

  const actualAdvanced = Math.abs(endCycle - state.currentCycle);
  state.lastTickTime = Math.max(
    state.lastTickTime + actualAdvanced * msPerCycle,
    timestamp - msPerCycle,
  );
  state.currentCycle = endCycle;

  if (endCycle !== lastReconstructedCycle) {
    const range = TraceParser.getLandingRange(td.landingIndex, endCycle);
    reconstructStateAtCycle(endCycle, range);
    lastReconstructedCycle = endCycle;
  }
  const fraction = dir * Math.min((timestamp - state.lastTickTime) / msPerCycle, 1);
  syncTracedPackets(endCycle, fraction);

  updateScrubUI();
  updatePETraceHighlight();

  // Stop at trace boundary
  if ((dir > 0 && endCycle >= state.maxCycle) ||
      (dir < 0 && endCycle <= state.minCycle)) {
    state.playing = false;
    updateTransportUI();
  }
}


// --- Transport state machine ---
// States: forward-play, reverse-play, forward-paused, reverse-paused
// state.direction: +1 (forward) or -1 (reverse)
// state.playing: true (playing) or false (paused)

function updateTransportUI() {
  els.fwdPlayBtn.classList.toggle("active", state.playing && state.direction === 1);
  els.revPlayBtn.classList.toggle("active", state.playing && state.direction === -1);
  els.pauseBtn.classList.toggle("active", !state.playing);
}

function startPlaying(direction) {
  if (!state) return;
  state.direction = direction;
  state.playing = true;
  const now = performance.now();
  state.lastTickTime = now;
  // Unfreeze any frozen DataPackets (from old traces after seek)
  const msPerCycle = 1000 / state.speed;
  for (const pkt of grid.packets) {
    if (pkt.startTime === Infinity) {
      pkt.startTime = now;
      pkt.duration = msPerCycle;
    }
  }
  updateTransportUI();
  animationLoop.start();
}

export function transportFwdPlay() {
  if (!state) return;
  if (state.playing && state.direction === 1) {
    state.playing = false;
    updateTransportUI();
    return;
  }
  if (state.currentCycle >= state.maxCycle) {
    seekToCycle(state.minCycle);
  }
  startPlaying(1);
}

export function transportRevPlay() {
  if (!state) return;
  if (state.playing && state.direction === -1) {
    state.playing = false;
    updateTransportUI();
    return;
  }
  if (state.currentCycle <= state.minCycle) {
    seekToCycle(state.maxCycle);
  }
  startPlaying(-1);
}

export function transportPause() {
  if (!state) return;
  if (state.playing) {
    state.playing = false;
    updateTransportUI();
  } else {
    // At boundary, wrap around before resuming
    if (state.direction > 0 && state.currentCycle >= state.maxCycle) {
      seekToCycle(state.minCycle);
    } else if (state.direction < 0 && state.currentCycle <= state.minCycle) {
      seekToCycle(state.maxCycle);
    }
    startPlaying(state.direction);
  }
}

const STEP_MS = 1000 / 16;
let lastStepTime = 0;
let stepAnimationId = 0;

function doStep(direction) {
  if (!state || !traceData) return;
  const now = performance.now();
  if (now - lastStepTime < STEP_MS) return;
  lastStepTime = now;

  state.playing = false;
  state.direction = direction;
  updateTransportUI();

  const targetCycle = state.currentCycle + direction;
  if (targetCycle < state.minCycle || targetCycle > state.maxCycle) return;

  seekToCycle(targetCycle);

  const startCycle = targetCycle - direction;
  const stepStart = now;
  if (stepAnimationId) cancelAnimationFrame(stepAnimationId);

  function stepAnimate(timestamp) {
    if (!state || state.playing) return;
    const t = Math.min((timestamp - stepStart) / STEP_MS, 1);
    const fc = startCycle + direction * t;
    syncTracedPackets(targetCycle, fc - targetCycle);
    animationLoop.start();
    if (t < 1) {
      stepAnimationId = requestAnimationFrame(stepAnimate);
    } else {
      stepAnimationId = 0;
    }
  }
  stepAnimationId = requestAnimationFrame(stepAnimate);
}

export function transportStepFwd() { doStep(1); }
export function transportStepBack() { doStep(-1); }

export function adjustSpeed(factor) {
  if (!state) return;
  const newSpeed = state.speed * factor;
  if (newSpeed < 1) return;
  state.speed = newSpeed;
  state.lastTickTime = performance.now();
  els.speedDisplay.textContent = `${newSpeed} Hz`;
}

function seekToCycle(targetCycle) {
  if (!state || !traceData || !Number.isFinite(targetCycle)) return;

  grid.resetTimers();

  // Reconstruct state without landings (seek uses frozen packets separately)
  reconstructStateAtCycle(targetCycle);
  lastReconstructedCycle = targetCycle;

  state.currentCycle = targetCycle;
  state.lastTickTime = performance.now();
  updateScrubUI();
  updatePETraceHighlight();

  // For old traces without wavelet data, show frozen DataPackets for the target cycle
  const td = traceData;
  if (!td.hasWaveletData) {
    const range = TraceParser.getLandingRange(td.landingIndex, targetCycle);
    if (range) {
      const msPerCycle = 1000 / state.speed;
      sendLandingPackets(range, msPerCycle, Infinity);
    }
  }

  animationLoop.start();
}

export function cancelReplay() {
  handleTraceGeneration++;
  if (activeWorker) { activeWorker.terminate(); activeWorker = null; }
  if (stepAnimationId) { cancelAnimationFrame(stepAnimationId); stepAnimationId = 0; }
  lastStepTime = 0;
  deselectPE();
  state = null;
  traceData = null;
  lastReconstructedCycle = -1;
  wavScanStart = 0;
  isScrubbing = false;
  scrubWasPlaying = false;
  showPanel(null);
  els.cycleDisplay.textContent = "";
}

export function handleTraceFile(event, setGrid) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = "";

  const myGen = ++handleTraceGeneration;

  // Null out stale replay/trace state so playback controls are inert during
  // loading, and so a thrown exception doesn't leave stale traceData behind.
  state = null;
  traceData = null;

  // Show the playback bar with loading progress — hide playback controls
  // since they're inert during loading (state is null).
  els.playbackBar.classList.remove("hidden");
  els.playbackControls.classList.add("hidden");
  els.loadingBar.classList.remove("hidden");
  els.loadingLabel.textContent = "Loading\u2026";
  els.loadingFill.style.width = "0%";
  els.loadingPct.textContent = "0.0%";

  if (activeWorker) activeWorker.terminate();
  const worker = new Worker("trace-worker.js", { type: "module" });
  activeWorker = worker;

  worker.onerror = (err) => {
    worker.terminate(); activeWorker = null;
    if (myGen !== handleTraceGeneration) return;
    els.loadingBar.classList.add("hidden");
    els.playbackControls.classList.remove("hidden");
    els.cycleDisplay.textContent = `Error: ${err.message || "worker failed to load"}`;
  };

  worker.onmessage = (e) => {
    const msg = e.data;

    switch (msg.type) {
    case "progress":
      if (myGen !== handleTraceGeneration) return;
      els.loadingFill.style.width = `${msg.pct}%`;
      els.loadingPct.textContent = `${msg.pct.toFixed(1)}%`;
      return;
    case "merging":
      if (myGen !== handleTraceGeneration) return;
      els.loadingLabel.textContent = msg.step;
      els.loadingFill.style.width = `${msg.pct}%`;
      els.loadingPct.textContent = `${msg.pct.toFixed(1)}%`;
      return;
    case "transferring":
      if (myGen !== handleTraceGeneration) return;
      els.loadingLabel.textContent = "Transferring\u2026";
      els.loadingFill.style.width = "100%";
      els.loadingPct.textContent = "";
      return;
    case "error":
      worker.terminate(); activeWorker = null;
      if (myGen !== handleTraceGeneration) return;
      els.loadingBar.classList.add("hidden");
      els.playbackControls.classList.remove("hidden");
      els.cycleDisplay.textContent = `Error: ${msg.message}`;
      return;
    case "done": {
      worker.terminate(); activeWorker = null;
      if (myGen !== handleTraceGeneration) return;

      els.loadingLabel.textContent = "Building grid\u2026";
      els.loadingPct.textContent = "";

      // Reconstruct Maps from the transferred entry arrays
      const d = msg.data;
      const peStateIndex = new Map(d.peStateEntries);

      // Pre-compute grid row/col for each PE key to avoid
      // key.split(",").map(Number) on every reconstruction (~3650× per frame).
      const peStateList = [];
      for (const [key, entry] of peStateIndex) {
        const [x, y] = key.split(",").map(Number);
        const { row, col } = TraceParser.toGridCoords(x, y, d.dimY);
        peStateList.push({ key, entry, row, col });
      }

      // Pre-sort wavelets by first cycle for fast range filtering.
      let waveletList = null;
      if (d.hasWaveletData) {
        waveletList = d.waveletEntries.map(e => e[1]);
        for (const wv of waveletList) {
          wv.firstCycle = wv.hops.cycles[0];
          wv.lastCycle = wv.hops.cycles[wv.hops.cycles.length - 1];
        }
        waveletList.sort((a, b) => a.firstCycle - b.firstCycle);
      }

      const td = {
        dimX: d.dimX,
        dimY: d.dimY,
        landingIndex: d.landingIndex,
        peStateIndex,
        peStateList,
        opLookup: d.opLookup,
        opEntryLookup: buildOpEntryLookup(d.opLookup),
        predLookup: d.predLookup,
        waveletList,
        hasWaveletData: d.hasWaveletData,
        minCycle: d.minCycle,
        maxCycle: d.maxCycle,
        totalEvents: d.totalEvents,
      };

      // Swap from loading bar back to playback controls
      els.loadingBar.classList.add("hidden");
      els.playbackControls.classList.remove("hidden");

      if (td.dimX === 0 || td.dimY === 0 || td.minCycle > td.maxCycle) {
        els.cycleDisplay.textContent = "Error: invalid trace file";
        els.playbackBar.classList.add("hidden");
        deselectPE();
        return;
      }

      deselectPE();
      lastReconstructedCycle = -1;
      wavScanStart = 0;
      traceData = td;
      setGrid(td.dimY, td.dimX);
      grid.showRamps = td.hasWaveletData;
      animationLoop.start();
      showPanel("trace");
      els.traceLog.innerHTML = "";

      const { minCycle, maxCycle } = traceData;
      maxCycleStr = maxCycle.toLocaleString();
      const speed = 4;
      els.speedDisplay.textContent = `${speed} Hz`;

      state = {
        currentCycle: minCycle,
        speed,
        playing: false,
        direction: 1, // +1 = forward, -1 = reverse
        lastTickTime: performance.now(),
        minCycle,
        maxCycle,
      };

      els.scrubBar.min = minCycle;
      els.scrubBar.max = maxCycle;
      els.scrubBar.value = minCycle;
      updateTransportUI();
      updateScrubUI();
    } // case "done"
    } // switch
  };

  worker.postMessage({ file });
}

function handleTraceLogClick(e) {
  if (!selectedPE || !state) return;
  const entry = e.target.closest(".trace-entry");
  if (!entry || !entry.dataset.cycle) return;
  seekToCycle(parseInt(entry.dataset.cycle, 10));
}

export function setupScrubListeners() {
  els.traceLog.addEventListener("click", handleTraceLogClick);
  els.scrubBar.addEventListener("pointerdown", () => {
    if (!state || isScrubbing) return;
    isScrubbing = true;
    scrubWasPlaying = state.playing;
    state.playing = false;
    const onRelease = () => {
      window.removeEventListener("pointerup", onRelease);
      window.removeEventListener("pointercancel", onRelease);
      isScrubbing = false;
      if (!state || !scrubWasPlaying) return;
      scrubWasPlaying = false;
      startPlaying(state.direction);
    };
    window.addEventListener("pointerup", onRelease);
    window.addEventListener("pointercancel", onRelease);
  });
  els.scrubBar.addEventListener("input", (e) => {
    if (!state) return;
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
