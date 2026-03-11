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
let selectedPE = null; // { row, col, traceX, traceY, minCycle, totalCycles, busyArr, stallReasonArr, opArr, predArr, opCounts }
let peTraceWindowStart = 0; // first cycle rendered in the current DOM window
let peTraceWindowSize = 0;  // number of entries currently in the DOM
let peTraceScrollLock = false; // prevents scroll-handler re-entrancy
let lastReconstructedCycle = -1; // tracks when to call reconstructStateAtCycle
let maxCycleStr = ""; // cached String(maxCycle) for updateScrubUI


// Server mode state
let serverMode = false;
let pendingStateFetch = null; // in-flight /api/state fetch, or null

/**
 * Strip dot-suffixes (.NF, .F, .T, etc.) from an opcode name and return
 * the base name, or null if the op is a NOP (which should be excluded from
 * busy-cycle accounting like the bar chart).
 */
function _baseOpName(op) {
  const base = (op || "?").split(".")[0];
  return base === "NOP" ? null : base;
}

/**
 * Build flat per-cycle state arrays from a sparse PE state entry via forward-carry.
 * Returns { busyArr, opArr, predArr, stallReasonArr, opCounts }.
 */
function _buildFlatPEState(entry, td, minCycle, maxCycle) {
  const totalCycles = maxCycle - minCycle + 1;
  const busyArr = new Uint8Array(totalCycles);
  const opArr = new Array(totalCycles).fill(null);
  const predArr = new Array(totalCycles).fill(null);
  const stallReasonArr = new Array(totalCycles).fill(null);

  if (entry) {
    let evtIdx = 0;
    let curBusy = 0, curOp = null, curPred = null;
    let curStallReason = null, curStallCycle = -1;
    for (let i = 0; i < totalCycles; i++) {
      const cycle = minCycle + i;
      while (evtIdx < entry.length && entry.cycles[evtIdx] <= cycle) {
        if (entry.stall[evtIdx]) {
          curStallReason = entry.stallReasons[evtIdx];
          curStallCycle = entry.cycles[evtIdx];
        } else {
          const opId = entry.opIds[evtIdx];
          if (td.opNopLookup[opId]) { curBusy = 0; }
          else { curBusy = entry.busy[evtIdx]; }
          curOp = td.opLookup[opId] ?? "";
          curPred = td.predLookup[entry.predIds[evtIdx]] ?? "";
          if (entry.cycles[evtIdx] > curStallCycle) curStallReason = null;
        }
        evtIdx++;
      }
      if (curBusy) {
        busyArr[i] = 1; opArr[i] = curOp; predArr[i] = curPred;
      } else if (curOp) {
        opArr[i] = curOp; predArr[i] = curPred;
      }
      stallReasonArr[i] = curStallReason;
    }
  }

  const opCounts = new Map();
  for (let i = 0; i < totalCycles; i++) {
    if (busyArr[i]) {
      const o = _baseOpName(opArr[i]);
      if (o) opCounts.set(o, (opCounts.get(o) || 0) + 1);
    }
  }

  return { busyArr, opArr, predArr, stallReasonArr, opCounts, totalCycles };
}

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
  if (!state) return;
  if (serverMode) { reconstructFromServer(targetCycle); return; }
  const td = traceData;
  if (!td) return;

  // 1. Reconstruct PE execution and stall state.
  grid.clearPackets();

  const rows = grid.rows;
  const cols = grid.cols;
  const pes = grid.pes;
  for (const item of td.peStateList) {
    if (item.row >= rows || item.col >= cols) continue;
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
        if (td.opNopLookup[opId]) {
          pe.setBusy(false, null, null);
        } else {
          pe.setBusy(!!entry.busy[exIdx], td.opLookup[opId], td.opEntryLookup[opId]);
        }
      } else {
        pe.setBusy(false, null, null);
      }
      if (stallIdx >= 0) {
        const reasons = entry.stallReasons[stallIdx];
        const primary = reasons[0];
        grid.setPEStall(item.row, item.col, primary.type, primary.reason);
      }
    } else {
      pe.setBusy(false, null, null);
    }
  }

  // 2. Create packets for in-flight wavelets or DataPackets for old traces.
  // waveletList is sorted by firstCycle. Two binary searches give the scan range:
  //   - Upper bound: first index where firstCycle > targetCycle (exact)
  //   - Lower bound: first index where prefMaxLastCycle >= targetCycle
  //     (prefMaxLastCycle[i] = max of lastCycle[0..i]; monotonically non-decreasing,
  //     so binary-searchable). Everything before this index is guaranteed dead.
  //     Some dead wavelets after the lower bound may be included but are filtered
  //     by the per-wavelet lastCycle check in the loop.
  if (td.waveletList) {
    const wvList = td.waveletList;
    const wvLen = wvList.length;
    const prefMax = td.wavPrefMaxLastCycle;

    // Upper bound: first index where firstCycle > targetCycle
    let lo = 0, hi = wvLen;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (wvList[mid].firstCycle <= targetCycle) lo = mid + 1;
      else hi = mid;
    }
    const upperBound = lo;

    // Lower bound: first index where prefMaxLastCycle >= targetCycle
    // prefMax is non-decreasing; everything before lowerBound has max lastCycle < targetCycle
    lo = 0; hi = upperBound;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (prefMax[mid] < targetCycle) lo = mid + 1;
      else hi = mid;
    }
    const lowerBound = lo;

    for (let wi = lowerBound; wi < upperBound; wi++) {
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
    sendLandingPackets(currentCycleLandings, msPerCycle, performance.now());
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

  if (serverMode) {
    selectPEFromServer(row, col, traceX, traceY);
    return;
  }

  const key = `${traceX},${traceY}`;
  const td = traceData;
  const entry = td.peStateIndex.get(key);

  grid.selectPE(row, col);
  els.tracePanel.classList.remove("hidden");
  requestAnimationFrame(resizeCanvas);
  peTraceScrollLock = false;

  const { minCycle, maxCycle } = state;
  const flat = _buildFlatPEState(entry, td, minCycle, maxCycle);

  selectedPE = { row, col, traceX, traceY, minCycle, ...flat };

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
    currentOp = _baseOpName(selectedPE.opArr[idx]);
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
    eSpan.textContent = busy ? (opArr[i] || "?") : (opArr[i] || "IDLE");
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

let peSelectGeneration = 0;

async function selectPEFromServer(row, col, traceX, traceY) {
  grid.selectPE(row, col);
  els.tracePanel.classList.remove("hidden");
  requestAnimationFrame(resizeCanvas);

  const myGen = ++peSelectGeneration;
  const td = traceData;
  const { minCycle, maxCycle } = state;

  let resp;
  try { resp = await fetch(`/api/pe-trace?x=${traceX}&y=${traceY}`); }
  catch { return; }
  if (myGen !== peSelectGeneration) return; // stale response — user clicked another PE

  let data;
  try { data = await resp.json(); }
  catch { return; }
  if (myGen !== peSelectGeneration) return;

  const entry = data.found ? data.entry : null;
  const flat = _buildFlatPEState(entry, td, minCycle, maxCycle);

  selectedPE = { row, col, traceX, traceY, minCycle, ...flat };
  els.tracePanel.querySelector("h2").textContent = `PE (${traceX}, ${traceY})`;
  renderOpChart();
  renderPETraceWindow(state.currentCycle);
  setupPETraceScroll();
}

export function deselectPE() {
  if (!selectedPE) return;
  grid.deselectAllPEs();
  selectedPE = null;
  peTraceWindowStart = 0;
  peTraceWindowSize = 0;
  _highlightedEntry = null;
  _lastScrolledEntry = null;
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
let _lastScrolledEntry = null; // avoid calling scrollIntoView every frame for the same entry

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
      if (_lastScrolledEntry !== _highlightedEntry) {
        _lastScrolledEntry = _highlightedEntry;
        peTraceScrollLock = true;
        try { entries[localIdx].scrollIntoView({ block: "nearest" }); }
        finally { peTraceScrollLock = false; }
      }
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
    const frac = dir * Math.min(Math.max(0, elapsed) / msPerCycle, 1);
    syncTracedPackets(state.currentCycle, frac);
    return;
  }

  // Advance (or retreat) by direction × cycles, clamped to trace bounds
  const limit = dir > 0 ? state.maxCycle : state.minCycle;
  const endCycle = dir > 0
    ? Math.min(state.currentCycle + cyclesToAdvance, limit)
    : Math.max(state.currentCycle - cyclesToAdvance, limit);

  const actualAdvanced = Math.abs(endCycle - state.currentCycle);
  state.lastTickTime = Math.max(
    state.lastTickTime + actualAdvanced * msPerCycle,
    timestamp - msPerCycle,
  );
  state.currentCycle = endCycle;

  if (endCycle !== lastReconstructedCycle && traceData) {
    const range = TraceParser.getLandingRange(traceData.landingIndex, endCycle);
    reconstructStateAtCycle(endCycle, range);
    lastReconstructedCycle = endCycle;
  }
  const fraction = dir * Math.min(Math.max(0, timestamp - state.lastTickTime) / msPerCycle, 1);
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

  // Set packets to starting position immediately so the first draw doesn't
  // flash them at the target position before the animation begins.
  syncTracedPackets(targetCycle, -direction);

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
  if (!serverMode) {
    const td = traceData;
    if (!td.hasWaveletData) {
      const range = TraceParser.getLandingRange(td.landingIndex, targetCycle);
      if (range) {
        const msPerCycle = 1000 / state.speed;
        sendLandingPackets(range, msPerCycle, Infinity);
      }
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
  isScrubbing = false;
  scrubWasPlaying = false;
  serverMode = false;
  pendingStateFetch = null;
  maxCycleStr = "";
  showPanel(null);
  els.cycleDisplay.textContent = "";
}

// ---------------------------------------------------------------------------
// Server mode — state is fetched from /api/* instead of computed locally
// ---------------------------------------------------------------------------

export function initServerMode(meta, setGrid) {
  cancelReplay();
  serverMode = true;

  const { entries: opEntryLookup, nops: opNopLookup } = buildOpEntryLookup(meta.opLookup);

  traceData = {
    dimX: meta.dimX,
    dimY: meta.dimY,
    opLookup: meta.opLookup,
    opEntryLookup,
    opNopLookup,
    predLookup: meta.predLookup,
    hasWaveletData: meta.hasWaveletData,
    minCycle: meta.minCycle,
    maxCycle: meta.maxCycle,
    // These are null in server mode — data lives on the server
    peStateIndex: null,
    peStateList: null,
    waveletList: null,
    landingIndex: null,
  };

  setGrid(meta.dimY, meta.dimX);
  grid.showRamps = meta.hasWaveletData;
  showPanel("trace");

  const { minCycle, maxCycle } = meta;
  maxCycleStr = maxCycle.toLocaleString();
  const speed = 4;
  els.speedDisplay.textContent = `${speed} Hz`;

  state = {
    currentCycle: minCycle,
    speed,
    playing: false,
    direction: 1,
    lastTickTime: performance.now(),
    minCycle,
    maxCycle,
  };

  els.scrubBar.min = minCycle;
  els.scrubBar.max = maxCycle;
  els.scrubBar.value = minCycle;
  updateTransportUI();
  seekToCycle(minCycle);
}

/** Apply a /api/state response to the grid. */
function applyServerState(data) {
  const td = traceData;
  grid.clearPackets();

  // Apply PE states
  const cols = grid.cols;
  const pes = grid.pes;
  // Reset all PEs to idle first
  for (const pe of pes) pe.setBusy(false, null, null);

  for (const rec of data.pes) {
    const [row, col, busy, opId, stallType, stallReason] = rec;
    if (row >= grid.rows || col >= cols) continue;
    const pe = pes[row * cols + col];
    if (busy || opId) {
      pe.setBusy(!!busy, td.opLookup[opId] ?? null, td.opEntryLookup[opId] ?? null);
    }
    if (stallType) {
      grid.setPEStall(row, col, stallType, stallReason);
    }
  }

  // Create TracedPackets from wavelet waypoints
  for (const wvData of data.wavelets) {
    const [color, ctrl, lf, branchTuples] = wvData;
    const waypoints = branchTuples.map(t => ({
      cycle: t[0], x: t[1], y: t[2],
      arriveDir: t[3], departDir: t[4], depCycle: t[5],
    }));
    const pkt = new TracedPacket(waypoints, td.dimY, color, ctrl, lf);
    pkt.syncTo(state.currentCycle, state.currentCycle);
    grid.packets.push(pkt);
  }
}

/** Server-mode version of reconstructStateAtCycle. */
function reconstructFromServer(targetCycle) {
  if (pendingStateFetch) return; // don't spam requests
  pendingStateFetch = fetch(`/api/state?cycle=${targetCycle}`)
    .then(r => r.json())
    .then(data => {
      pendingStateFetch = null;
      // Only apply if we haven't moved far past this cycle
      if (!state) return;
      applyServerState(data);
      lastReconstructedCycle = data.cycle;
      animationLoop.start();
    })
    .catch(() => { pendingStateFetch = null; });
}

export function handleTraceFile(event, setGrid) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = "";

  // Reset all replay state so playback controls are inert during loading,
  // and so a thrown exception doesn't leave stale state behind.
  cancelReplay();

  const myGen = ++handleTraceGeneration;

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
      let wavPrefMaxLastCycle = null;
      if (d.hasWaveletData) {
        waveletList = d.waveletEntries.map(e => e[1]);
        for (const wv of waveletList) {
          wv.firstCycle = wv.hops.cycles[0];
          wv.lastCycle = wv.hops.cycles[wv.hops.cycles.length - 1];
        }
        waveletList.sort((a, b) => a.firstCycle - b.firstCycle);
        // Prefix max of lastCycle: prefMax[i] = max(lastCycle[0..i]).
        // Non-decreasing, enabling binary search for the lower bound of
        // live wavelets at any cycle (everything before lowerBound is dead).
        wavPrefMaxLastCycle = new Float64Array(waveletList.length);
        let runMax = -Infinity;
        for (let i = 0; i < waveletList.length; i++) {
          runMax = Math.max(runMax, waveletList[i].lastCycle);
          wavPrefMaxLastCycle[i] = runMax;
        }
      }

      const { entries: opEntryLookup, nops: opNopLookup } = buildOpEntryLookup(d.opLookup);

      const td = {
        dimX: d.dimX,
        dimY: d.dimY,
        landingIndex: d.landingIndex,
        peStateIndex,
        peStateList,
        opLookup: d.opLookup,
        opEntryLookup,
        opNopLookup,
        predLookup: d.predLookup,
        waveletList,
        wavPrefMaxLastCycle,
        hasWaveletData: d.hasWaveletData,
        minCycle: d.minCycle,
        maxCycle: d.maxCycle,
      };

      els.loadingBar.classList.add("hidden");

      if (td.dimX === 0 || td.dimY === 0 || td.minCycle > td.maxCycle) {
        els.cycleDisplay.textContent = "Error: invalid trace file";
        els.playbackBar.classList.add("hidden");
        return;
      }

      els.playbackControls.classList.remove("hidden");

      lastReconstructedCycle = -1;
      traceData = td;
      setGrid(td.dimY, td.dimX);
      grid.showRamps = td.hasWaveletData;
      animationLoop.start();
      showPanel("trace");
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
      seekToCycle(minCycle);
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
      try {
        if (!state || !scrubWasPlaying) return;
        startPlaying(state.direction);
      } finally {
        scrubWasPlaying = false;
      }
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
