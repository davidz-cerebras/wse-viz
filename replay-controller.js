import { TraceParser, LANDING_DECODE } from "./trace-parser.js";
import { extractBranches, TracedPacket } from "./wavelet.js";
import { buildOpEntryLookup } from "./pe.js";
import { MAX_LOG_ENTRIES, PE_TRACE_WINDOW } from "./constants.js";

let grid, els, animationLoop, showPanel;

const replay = {
  traceData: null,
  state: null,
};

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

function appendLandingEvents(cycle, landingRange) {
  if (selectedPE || !landingRange) return;
  const li = replay.traceData.landingIndex;
  const { start, end } = landingRange;
  for (let i = start; i < end; i++) {
    const entry = document.createElement("div");
    entry.className = "trace-entry trace-landing";
    const dirChar = LANDING_DECODE[li.dirs[i]];
    const dir = dirChar === "R" ? "local" : `\u2190 ${dirChar}`;
    const cycleSpan = document.createElement("span");
    cycleSpan.className = "trace-cycle";
    cycleSpan.textContent = `@${cycle}`;
    entry.appendChild(cycleSpan);
    entry.appendChild(document.createTextNode(` P${li.xs[i]}.${li.ys[i]} ${dir} C${li.colors[i]}`));
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

function sendLandingPackets(landingRange, msPerCycle, startTime) {
  const td = replay.traceData;
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
  const td = replay.traceData;
  if (!td) return;

  grid.clearPackets();

  // 1. Reconstruct EX OP + stall state from peStateList (pre-computed grid coords).
  //
  // Instead of resetAllPEs() + re-apply, we directly set each PE to its
  // correct state (busy/idle/stalled). This avoids touching each PE twice.
  //
  // The peStateIndex interleaves EX OP and stall events in cycle order.
  // We scan backward from targetCycle to find the most recent EX OP event
  // (exIdx) and the most recent stall event (stallIdx). Both can be active
  // simultaneously because they originate from different pipeline stages —
  // a stall at the issue stage doesn't prevent execution at the EX stage.
  // setPEBusy sets the op (and clears stall); setPEStall overlays the stall. In pe.draw(),
  // the op takes visual priority (see execution/stall model in pe.js).
  for (const pe of td.peStateList) {
    const entry = pe.entry;
    const found = TraceParser.findCycleIndexLE(
      { cycles: entry.cycles, length: entry.length },
      targetCycle,
    );
    if (found >= 0) {
      let exIdx = -1;
      let stallIdx = -1;
      for (let i = found; i >= 0; i--) {
        if (!entry.stall[i]) { exIdx = i; break; }
        if (stallIdx < 0) stallIdx = i;
      }
      if (exIdx >= 0) {
        const opId = entry.opIds[exIdx];
        grid.setPEBusy(pe.row, pe.col, !!entry.busy[exIdx], td.opLookup[opId], td.opEntryLookup[opId]);
      } else {
        grid.setPEBusy(pe.row, pe.col, false, null, null);
      }
      if (stallIdx >= 0 && (exIdx < 0 || stallIdx > exIdx)) {
        const reasons = entry.stallReasons[stallIdx];
        const primary = reasons[0];
        grid.setPEStall(pe.row, pe.col, primary.type, primary.reason);
      }
    } else {
      grid.setPEBusy(pe.row, pe.col, false, null, null);
    }
  }

  // 2. Create packets for in-flight wavelets or DataPackets for old traces.
  // waveletList is sorted by firstCycle, so we scan with early termination to skip wavelets
  // that start after targetCycle, and iterate only the relevant prefix.
  if (td.waveletList) {
    const wvList = td.waveletList;
    for (let wi = 0; wi < wvList.length; wi++) {
      const wv = wvList[wi];
      const firstCycle = wv.hops.cycles[0];
      if (firstCycle > targetCycle) break; // sorted: all remaining start later
      const lastCycle = wv.hops.cycles[wv.hops.length - 1];
      if (lastCycle < targetCycle) continue;
      const branches = getBranches(wv);
      for (const waypoints of branches) {
        const branchEnd = waypoints[waypoints.length - 1].cycle;
        if (branchEnd < targetCycle) continue;
        const pkt = new TracedPacket(waypoints, td.dimY, wv.color, wv.ctrl, wv.lf);
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

  // Clean up previous PE selection before switching to the new one
  if (selectedPE) deselectPE();

  const key = `${traceX},${traceY}`;
  const td = replay.traceData;
  const entry = td.peStateIndex.get(key);

  grid.selectPE(row, col);
  peTraceScrollLock = false;

  const { minCycle, maxCycle } = replay.state;
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
    entry.className = "trace-entry trace-pipeline";
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
  const maxStr = String(replay.state.maxCycle);
  const curStr = String(replay.state.currentCycle).padStart(maxStr.length);
  els.cycleDisplay.textContent = `Cycle ${curStr} / ${maxStr}`;
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
    const range = TraceParser.getLandingRange(td.landingIndex, c);
    if (range) appendLandingEvents(c, range);
  }

  const actualAdvanced = endCycle - replay.state.currentCycle;
  replay.state.lastTickTime = Math.max(
    replay.state.lastTickTime + actualAdvanced * msPerCycle,
    timestamp - msPerCycle,
  );
  replay.state.currentCycle = endCycle;

  // Only reconstruct when the cycle actually changes (not every frame)
  if (endCycle !== lastReconstructedCycle) {
    const range = TraceParser.getLandingRange(td.landingIndex, endCycle);
    reconstructStateAtCycle(endCycle, range);
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
      seekToCycle(replay.state.minCycle);
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
  els.speedDisplay.textContent = `${newSpeed} Hz`;
}

// Step one cycle forward or backward with smooth animation.
// Rate-limited to 16 steps/second — further presses are ignored until
// the animation for the current step completes (62.5ms).
const STEP_MS = 1000 / 16;
let lastStepTime = 0;
let stepAnimationId = 0;

export function stepCycle(direction) {
  if (!replay.state || !replay.traceData) return;
  const now = performance.now();
  if (now - lastStepTime < STEP_MS) return;
  lastStepTime = now;

  if (replay.state.playing) {
    replay.state.playing = false;
    els.playPauseBtn.textContent = "\u25B6";
  }

  const targetCycle = replay.state.currentCycle + direction;
  if (targetCycle < replay.state.minCycle || targetCycle > replay.state.maxCycle) return;

  seekToCycle(targetCycle);

  // Animate TracedPackets smoothly over the step duration.
  // Interpolate fractional cycle from the previous cycle to the new one.
  const startCycle = targetCycle - direction;
  const stepStart = now;
  if (stepAnimationId) cancelAnimationFrame(stepAnimationId);

  function stepAnimate(timestamp) {
    if (!replay.state || replay.state.playing) return;
    const t = Math.min((timestamp - stepStart) / STEP_MS, 1);
    const fc = startCycle + direction * t;
    syncTracedPackets(targetCycle, fc - targetCycle);
    animationLoop.start();
    if (t < 1) {
      stepAnimationId = requestAnimationFrame(stepAnimate);
    }
  }
  stepAnimationId = requestAnimationFrame(stepAnimate);
}

function seekToCycle(targetCycle) {
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
    const range = TraceParser.getLandingRange(td.landingIndex, targetCycle);
    if (range) {
      const msPerCycle = 1000 / replay.state.speed;
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
  replay.state = null;
  replay.traceData = null;
  lastReconstructedCycle = -1;
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
  replay.state = null;
  replay.traceData = null;

  // Show the playback bar with loading progress — hide playback controls
  // since they're inert during loading (replay.state is null).
  els.playbackBar.classList.remove("hidden");
  els.playbackControls.classList.add("hidden");
  els.loadingBar.classList.remove("hidden");
  els.loadingBar.querySelector(".loading-label").textContent = "Loading\u2026";
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

    if (msg.type === "progress") {
      if (myGen !== handleTraceGeneration) return;
      els.loadingFill.style.width = `${msg.pct}%`;
      els.loadingPct.textContent = `${msg.pct.toFixed(1)}%`;
      return;
    }

    if (msg.type === "merging") {
      if (myGen !== handleTraceGeneration) return;
      els.loadingBar.querySelector(".loading-label").textContent = msg.step;
      els.loadingFill.style.width = `${msg.pct}%`;
      els.loadingPct.textContent = `${msg.pct.toFixed(1)}%`;
      return;
    }

    if (msg.type === "transferring") {
      if (myGen !== handleTraceGeneration) return;
      els.loadingBar.querySelector(".loading-label").textContent = "Transferring\u2026";
      els.loadingFill.style.width = "100%";
      els.loadingPct.textContent = "";
      return;
    }

    if (msg.type === "error") {
      worker.terminate(); activeWorker = null;
      if (myGen !== handleTraceGeneration) return;
      els.loadingBar.classList.add("hidden");
      els.playbackControls.classList.remove("hidden");
      els.cycleDisplay.textContent = `Error: ${msg.message}`;
      return;
    }

    if (msg.type === "done") {
      worker.terminate(); activeWorker = null;
      if (myGen !== handleTraceGeneration) return;

      els.loadingBar.querySelector(".loading-label").textContent = "Building grid\u2026";
      els.loadingPct.textContent = "";

      // Reconstruct Maps from the transferred entry arrays
      const d = msg.data;
      const peStateIndex = new Map(d.peStateEntries);
      const waveletIndex = new Map(d.waveletEntries);

      // Pre-compute grid row/col for each PE key to avoid
      // key.split(",").map(Number) on every reconstruction (~3650× per frame).
      const peStateList = [];
      for (const [key, entry] of peStateIndex) {
        const [x, y] = key.split(",").map(Number);
        const { row, col } = TraceParser.toGridCoords(x, y, d.dimY);
        peStateList.push({ key, entry, row, col });
      }

      // Pre-sort wavelets by first cycle for fast range filtering.
      // At 512 Hz with 63K wavelets, iterating all of them per frame is too slow.
      // Sorted by firstCycle, we binary-search to find the start of the active range.
      let waveletList = null;
      if (d.hasWaveletData) {
        waveletList = [...waveletIndex.values()];
        waveletList.sort((a, b) => a.hops.cycles[0] - b.hops.cycles[0]);
      }

      const traceData = {
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
      els.speedDisplay.textContent = `${speed} Hz`;

      replay.state = {
        currentCycle: minCycle,
        speed,
        playing: false,
        lastTickTime: performance.now(),
        minCycle,
        maxCycle,
      };

      els.scrubBar.min = minCycle;
      els.scrubBar.max = maxCycle;
      els.scrubBar.value = minCycle;
      els.playPauseBtn.textContent = "\u25B6";
      updateScrubUI();
    }
  };

  worker.postMessage({ file });
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
