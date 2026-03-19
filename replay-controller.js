import { TraceParser, LANDING_DECODE } from "./trace-parser.js";
import { getBranches, TracedPacket } from "./wavelet.js";
import { buildOpEntryLookup } from "./pe.js";
import { PE_TRACE_WINDOW, STEP_ANIMATION_MS, SERVER_MAX_PREFETCH_INFLIGHT } from "./constants.js";

let grid, els, animationLoop, showPanel, resizeCanvas;

let traceData = null;
let state = null;

let isScrubbing = false;
let scrubWasPlaying = false;
let handleTraceGeneration = 0;
let activeWorker = null; // current trace-loading worker, terminated on cancel/re-load

// PE selection state
let selectedPE = null; // { row, col, traceX, traceY, minCycle, totalCycles, busyArr, stallReasonArr, opArr, predArr, pcArr }
let peTraceWindowStart = 0; // first cycle rendered in the current DOM window
let peTraceWindowSize = 0;  // number of entries currently in the DOM
let peTraceScrollLock = false; // prevents scroll-handler re-entrancy
let lastReconstructedCycle = -1; // tracks when to call reconstructStateAtCycle
let maxCycleStr = ""; // cached String(maxCycle) for updateScrubUI
let activeTraceTab = "pipeline"; // "pipeline" or "code"
let codeViewData = null; // cached /api/pe-memory response or local pcIndex data
let _lastCodeScrolled = null; // dedup scrollIntoView for code tab
let _codeViewAbort = null; // AbortController for in-flight /api/pe-memory fetch


// Server mode state
let serverMode = false;
let serverGeneration = 0; // incremented on cancel; stale prefetch callbacks check this
let pendingStateFetch = null; // in-flight /api/state fetch, or null
let serverStateCache = new Map(); // cycle → parsed /api/state response
let prefetchInFlight = 0; // number of prefetch requests currently in-flight
let serverError = false; // true if last fetch failed

/**
 * Build flat per-cycle state arrays from a sparse PE state entry via forward-carry.
 */
function _buildFlatPEState(entry, td, minCycle, maxCycle) {
  const totalCycles = maxCycle - minCycle + 1;
  const busyArr = new Uint8Array(totalCycles);
  const opArr = new Array(totalCycles).fill(null);
  const predArr = new Array(totalCycles).fill(null);
  const stallReasonArr = new Array(totalCycles).fill(null);
  const pcArr = new Uint16Array(totalCycles).fill(0xFFFF); // 0xFFFF = idle/stall sentinel

  if (entry) {
    let evtIdx = 0;
    let curBusy = 0, curOp = null, curPred = null, curPC = 0xFFFF;
    let curStallReason = null, curStallCycle = -1;
    for (let i = 0; i < totalCycles; i++) {
      const cycle = minCycle + i;
      while (evtIdx < entry.length && entry.cycles[evtIdx] <= cycle) {
        if (entry.stall[evtIdx]) {
          // stall[i] is an interned ID; resolve via stallLookup
          curStallReason = td.stallLookup
            ? td.stallLookup[entry.stall[evtIdx]]
            : (entry.stallReasons ? entry.stallReasons[evtIdx] : null);
          curStallCycle = entry.cycles[evtIdx];
        } else {
          const opId = entry.opIds[evtIdx];
          if (td.opNopLookup[opId]) { curBusy = 0; }
          else { curBusy = entry.busy[evtIdx]; }
          curOp = td.opLookup[opId] ?? "";
          curPred = td.predLookup[entry.predIds[evtIdx]] ?? "";
          curPC = entry.pcs ? entry.pcs[evtIdx] : 0xFFFF;
          if (entry.cycles[evtIdx] > curStallCycle) curStallReason = null;
        }
        evtIdx++;
      }
      if (curBusy) {
        busyArr[i] = 1; opArr[i] = curOp; predArr[i] = curPred; pcArr[i] = curPC;
      } else if (curOp) {
        opArr[i] = curOp; predArr[i] = curPred; pcArr[i] = curPC;
      }
      stallReasonArr[i] = curStallReason;
    }
  }

  return { busyArr, opArr, predArr, stallReasonArr, pcArr, totalCycles };
}

export function initReplay(deps) {
  grid = deps.grid;
  els = deps.els;
  animationLoop = deps.animationLoop;
  showPanel = deps.showPanel;
  resizeCanvas = deps.resizeCanvas;
  // Tab switching
  els.tabPipeline.addEventListener("click", () => switchTraceTab("pipeline"));
  els.tabCode.addEventListener("click", () => switchTraceTab("code"));
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
  if (serverMode) return reconstructFromServer(targetCycle);
  const td = traceData;
  if (!td) return;

  // 1. Reconstruct PE execution and stall state.
  grid.clearPackets();

  const rows = grid.rows;
  const cols = grid.cols;
  const pes = grid.pes;
  for (const item of td.peStateList) {
    if (item.row < 0 || item.row >= rows || item.col < 0 || item.col >= cols) continue;
    const pe = pes[item.row * cols + item.col];
    const rec = TraceParser.reconstructPEAtCycle(item.entry, td.opNopLookup, td.stallLookup, targetCycle);
    if (rec) {
      if (rec.busy) {
        pe.setBusy(true, td.opLookup[rec.opId], td.opEntryLookup[rec.opId]);
      } else {
        pe.setBusy(false, null, null);
      }
      if (rec.stallType) {
        grid.setPEStall(item.row, item.col, rec.stallType, rec.stallReason);
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
  // targetCycle - 1: consumed wavelets linger one cycle past their last hop,
  // so we widen the binary search to include wavelets that ended one cycle ago.
  const wvRange = TraceParser.findLiveWaveletRange(td.waveletList, td.wavPrefMaxLastCycle, targetCycle - 1);
  if (wvRange) {
    const wvList = td.waveletList;
    for (let wi = wvRange.lowerBound; wi < wvRange.upperBound; wi++) {
      const wv = wvList[wi];
      // +1: consumed wavelets linger one cycle past their last hop for the
      // ramp-to-center animation, so we must include them at lastCycle + 1.
      if (wv.lastCycle + 1 < targetCycle) continue;
      const branches = getBranches(wv);
      for (const waypoints of branches) {
        const lastBranchWp = waypoints[waypoints.length - 1];
        if ((lastBranchWp.lingerUntil || lastBranchWp.cycle) < targetCycle) continue;
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
  els.tracePanel.querySelector("h2").textContent = `P${traceX}.${traceY}`;

  renderPETraceWindow(state.currentCycle);
  setupPETraceScroll();
  applyTraceTab();
}

/** Apply the current tab state (visual toggle + data loading if needed). */
function applyTraceTab() {
  els.tabPipeline.classList.toggle("active", activeTraceTab === "pipeline");
  els.tabCode.classList.toggle("active", activeTraceTab === "code");
  els.pipelineView.classList.toggle("hidden", activeTraceTab !== "pipeline");
  els.codeView.classList.toggle("hidden", activeTraceTab !== "code");
  if (activeTraceTab === "code" && selectedPE && !codeViewData) {
    loadCodeView(selectedPE.traceX, selectedPE.traceY);
  }
}

function _buildTraceEntry(i) {
  const { minCycle, busyArr, stallReasonArr, opArr, predArr } = selectedPE;
  const cycle = minCycle + i;
  const busy = busyArr[i];
  const stallReasons = stallReasonArr[i];
  const entry = document.createElement("div");
  entry.className = "trace-entry";
  entry.dataset.idx = i;

  const cycleSpan = document.createElement("span");
  cycleSpan.className = "trace-cycle";
  cycleSpan.textContent = `@${cycle}`;
  entry.appendChild(cycleSpan);

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

  const instrSpan = document.createElement("span");
  instrSpan.className = "trace-pipe-stage";
  if (predArr[i]) {
    const predSpan = document.createElement("span");
    predSpan.className = "trace-pred";
    predSpan.textContent = predArr[i] + " ";
    instrSpan.appendChild(predSpan);
  }
  const opText = document.createElement("span");
  opText.className = busy ? "trace-exec" : "trace-idle";
  opText.textContent = busy ? (opArr[i] || "?") : (opArr[i] || "IDLE");
  instrSpan.appendChild(opText);
  entry.appendChild(instrSpan);

  return entry;
}

function renderPETraceWindow(centerCycle) {
  if (!selectedPE) return;
  const { minCycle, totalCycles } = selectedPE;

  const centerIdx = Math.max(0, Math.min(centerCycle - minCycle, totalCycles - 1));
  const halfWin = Math.floor(PE_TRACE_WINDOW / 2);
  let startIdx = Math.max(0, centerIdx - halfWin);
  let endIdx = Math.min(totalCycles, startIdx + PE_TRACE_WINDOW);
  startIdx = Math.max(0, endIdx - PE_TRACE_WINDOW);

  els.traceLog.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (let i = startIdx; i < endIdx; i++) {
    frag.appendChild(_buildTraceEntry(i));
  }
  els.traceLog.appendChild(frag);

  peTraceWindowStart = startIdx;
  peTraceWindowSize = endIdx - startIdx;

  updatePETraceHighlight();
}

/** Extend the rendered window by appending/prepending entries without replacing. */
function _extendTraceWindow(direction) {
  if (!selectedPE) return;
  const { totalCycles } = selectedPE;
  const log = els.traceLog;
  const CHUNK = Math.floor(PE_TRACE_WINDOW / 4);

  if (direction > 0) {
    // Append at bottom, remove from top
    const newEnd = Math.min(totalCycles, peTraceWindowStart + peTraceWindowSize + CHUNK);
    const addCount = newEnd - (peTraceWindowStart + peTraceWindowSize);
    if (addCount <= 0) return;

    const frag = document.createDocumentFragment();
    for (let i = peTraceWindowStart + peTraceWindowSize; i < newEnd; i++) {
      frag.appendChild(_buildTraceEntry(i));
    }
    log.appendChild(frag);
    peTraceWindowSize += addCount;

    // Remove excess from top to keep window bounded
    const excess = peTraceWindowSize - PE_TRACE_WINDOW;
    if (excess > 0) {
      const scrollBefore = log.scrollTop;
      // Measure actual height of entries being removed to avoid sub-pixel drift
      let removedHeight = 0;
      for (let j = 0; j < excess; j++) {
        const child = log.children[j];
        if (child) removedHeight += child.offsetHeight;
      }
      for (let j = 0; j < excess; j++) {
        if (!log.firstChild) break;
        log.firstChild.remove();
      }
      peTraceWindowStart += excess;
      peTraceWindowSize -= excess;
      log.scrollTop = scrollBefore - removedHeight;
    }
  } else {
    // Prepend at top, remove from bottom
    const newStart = Math.max(0, peTraceWindowStart - CHUNK);
    const addCount = peTraceWindowStart - newStart;
    if (addCount <= 0) return;

    const frag = document.createDocumentFragment();
    for (let i = newStart; i < peTraceWindowStart; i++) {
      frag.appendChild(_buildTraceEntry(i));
    }
    // Measure actual height of prepended entries after insertion
    log.prepend(frag);
    let addedHeight = 0;
    for (let j = 0; j < addCount; j++) {
      const child = log.children[j];
      if (child) addedHeight += child.offsetHeight;
    }
    const scrollBefore = log.scrollTop;
    log.scrollTop = scrollBefore + addedHeight;

    peTraceWindowStart = newStart;
    peTraceWindowSize += addCount;

    // Remove excess from bottom
    const excess = peTraceWindowSize - PE_TRACE_WINDOW;
    if (excess > 0) {
      for (let j = 0; j < excess; j++) {
        if (!log.lastChild) break;
        log.lastChild.remove();
      }
      peTraceWindowSize -= excess;
    }
  }
}

// ---------------------------------------------------------------------------
// Trace panel tabs: Pipeline / Code
// ---------------------------------------------------------------------------

function switchTraceTab(tab) {
  if (tab === activeTraceTab) return;
  activeTraceTab = tab;
  applyTraceTab();
  if (tab === "pipeline" && selectedPE) {
    updatePETraceHighlight();
  }
}

function loadCodeView(traceX, traceY) {
  if (serverMode) {
    const gen = peSelectGeneration;
    if (_codeViewAbort) _codeViewAbort.abort();
    _codeViewAbort = new AbortController();
    els.codeLog.innerHTML = "<div style='color: var(--color-text-muted); padding: 0.5rem;'>Loading...</div>";
    fetch(`/api/pe-memory?x=${traceX}&y=${traceY}`, { signal: _codeViewAbort.signal })
      .then(r => r.json())
      .then(data => {
        if (gen !== peSelectGeneration) return;
        if (!data.found) { codeViewData = []; }
        else { codeViewData = data.instructions; }
        renderCodeView();
      })
      .catch(err => {
        if (err.name === "AbortError") return;
        if (gen !== peSelectGeneration) return;
        console.error("[wse-viz] Code view load failed:", err);
        els.codeLog.innerHTML = "<div style='color: #ef5350; padding: 0.5rem;'>Failed to load</div>";
      });
  } else {
    // Local mode: read from traceData.pcIndex
    const key = `${traceX},${traceY}`;
    const m = traceData && traceData.pcIndex ? traceData.pcIndex.get(key) : null;
    if (!m) { codeViewData = []; }
    else {
      codeViewData = [...m.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([pc, rec]) => [pc, rec.op, rec.pred, rec.count, rec.firstCycle, rec.lastCycle, rec.operands || null]);
    }
    renderCodeView();
  }
}

function renderCodeView() {
  const log = els.codeLog;
  log.innerHTML = "";
  if (!codeViewData || codeViewData.length === 0) {
    log.innerHTML = "<div style='color: var(--color-text-muted); padding: 0.5rem;'>No instructions recorded</div>";
    return;
  }

  const frag = document.createDocumentFragment();
  let prevPC = -1;
  for (const [pc, op, pred, count, firstCycle, lastCycle, operands] of codeViewData) {
    // Skip placeholder records from IS OP that were never executed
    if (!op || count === 0) continue;
    // Insert a section break if there's a gap in the instruction stream
    // (instructions are 32-bit = 2 × 16-bit words, so consecutive PCs differ by 2)
    if (prevPC >= 0 && pc !== prevPC + 2) {
      const hr = document.createElement("div");
      hr.className = "code-break";
      frag.appendChild(hr);
    }
    prevPC = pc;

    const div = document.createElement("div");
    div.className = "code-entry";
    div.dataset.pc = pc;

    const addrSpan = document.createElement("span");
    addrSpan.className = "code-addr";
    addrSpan.textContent = `0x${pc.toString(16).toUpperCase().padStart(4, "0")}`;

    const instrSpan = document.createElement("span");
    instrSpan.className = "code-instr";
    if (pred) {
      const predSpan = document.createElement("span");
      predSpan.className = "code-pred";
      predSpan.textContent = pred + " ";
      instrSpan.appendChild(predSpan);
    }
    const opText = document.createElement("span");
    opText.className = "code-op";
    opText.textContent = op;
    instrSpan.appendChild(opText);

    div.appendChild(addrSpan);
    div.appendChild(instrSpan);
    if (operands) {
      const opsSpan = document.createElement("span");
      opsSpan.className = "code-operands";
      opsSpan.textContent = operands;
      div.appendChild(opsSpan);
    }
    const countSpan = document.createElement("span");
    countSpan.className = "code-count";
    countSpan.textContent = `×${count}`;
    div.appendChild(countSpan);

    // Click to seek to nearest execution of this instruction from current cycle
    div.addEventListener("click", () => {
      if (!state || !selectedPE || !selectedPE.pcArr) return;
      const targetPC = pc;
      const cur = state.currentCycle - selectedPE.minCycle;
      const len = selectedPE.totalCycles;
      const arr = selectedPE.pcArr;
      // Scan outward from current position: forward first, then backward
      for (let d = 0; d < len; d++) {
        const fwd = cur + d;
        if (fwd < len && arr[fwd] === targetPC) {
          seekToCycle(selectedPE.minCycle + fwd);
          return;
        }
        const bwd = cur - d;
        if (d > 0 && bwd >= 0 && arr[bwd] === targetPC) {
          seekToCycle(selectedPE.minCycle + bwd);
          return;
        }
      }
    });

    frag.appendChild(div);
  }
  log.appendChild(frag);
  updateCodeViewHighlight();
}

function updateCodeViewHighlight() {
  if (activeTraceTab !== "code" || !state || !codeViewData || !selectedPE) return;
  // Find the PC currently executing at this cycle
  const idx = state.currentCycle - selectedPE.minCycle;
  const currentPC = (idx >= 0 && idx < selectedPE.totalCycles && selectedPE.pcArr)
    ? selectedPE.pcArr[idx] : 0xFFFF;
  let activeEl = null;
  for (const el of els.codeLog.children) {
    if (!el.dataset.pc) continue; // skip break divs
    const pc = parseInt(el.dataset.pc, 10);
    const active = currentPC !== 0xFFFF && pc === currentPC;
    el.classList.toggle("current", active);
    if (active && !activeEl) activeEl = el;
  }
  if (activeEl && activeEl !== _lastCodeScrolled) {
    _lastCodeScrolled = activeEl;
    activeEl.scrollIntoView({ block: "center" });
  } else if (!activeEl) {
    _lastCodeScrolled = null;
  }
}

function setupPETraceScroll() {
  els.traceLog.onscroll = () => {
    if (!selectedPE || peTraceScrollLock) return;
    const log = els.traceLog;
    const nearTop = log.scrollTop < 80;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;

    if (nearTop && peTraceWindowStart > 0) {
      peTraceScrollLock = true;
      try { _extendTraceWindow(-1); }
      finally { peTraceScrollLock = false; }
    }
    if (nearBottom && peTraceWindowStart + peTraceWindowSize < selectedPE.totalCycles) {
      peTraceScrollLock = true;
      try { _extendTraceWindow(1); }
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

  // On failure, clean up the visual state we set eagerly above
  function abortSelection() {
    grid.deselectAllPEs();
    els.tracePanel.classList.add("hidden");
    requestAnimationFrame(resizeCanvas);
  }

  let resp;
  try { resp = await fetch(`/api/pe-trace?x=${traceX}&y=${traceY}`); }
  catch { if (myGen === peSelectGeneration) abortSelection(); return; }
  if (myGen !== peSelectGeneration) return;

  let data;
  try { data = await resp.json(); }
  catch { if (myGen === peSelectGeneration) abortSelection(); return; }
  if (myGen !== peSelectGeneration) return;

  if (!state) return; // cancelled while fetch was in-flight

  const entry = data.found ? data.entry : null;
  // Server provides stallLookup alongside the entry for stall ID resolution
  const tdWithStall = data.stallLookup ? { ...td, stallLookup: data.stallLookup } : td;
  const flat = _buildFlatPEState(entry, tdWithStall, minCycle, maxCycle);

  selectedPE = { row, col, traceX, traceY, minCycle, ...flat };
  els.tracePanel.querySelector("h2").textContent = `P${traceX}.${traceY}`;
  renderPETraceWindow(state.currentCycle);
  setupPETraceScroll();
  applyTraceTab();
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
  els.tracePanel.querySelector("h2").textContent = "";
  els.traceLog.innerHTML = "";
  // Reset code view data (but preserve activeTraceTab across PE switches)
  codeViewData = null;
  _lastCodeScrolled = null;
  if (_codeViewAbort) { _codeViewAbort.abort(); _codeViewAbort = null; }
  els.codeLog.innerHTML = "";
}

let _highlightedEntry = null; // cached reference to avoid querySelector per frame
let _lastScrolledEntry = null; // avoid calling scrollIntoView every frame for the same entry

function updatePETraceHighlight() {
  if (!selectedPE || !state) return;
  if (activeTraceTab === "code") { updateCodeViewHighlight(); return; }

  const idx = state.currentCycle - selectedPE.minCycle;
  const localIdx = idx - peTraceWindowStart;

  // Remove previous highlight
  if (_highlightedEntry) { _highlightedEntry.classList.remove("current"); _highlightedEntry = null; }

  if (idx < 0 || idx >= selectedPE.totalCycles) return;

  // If current cycle is outside the rendered window, re-render centered on it
  if (localIdx < 0 || localIdx >= peTraceWindowSize) {
    renderPETraceWindow(state.currentCycle);
    return; // renderPETraceWindow calls us recursively
  }

  // If near the edges of the window, extend incrementally
  if (localIdx < PE_TRACE_WINDOW / 4 && peTraceWindowStart > 0) {
    peTraceScrollLock = true;
    try { _extendTraceWindow(-1); } finally { peTraceScrollLock = false; }
  } else if (localIdx > peTraceWindowSize - PE_TRACE_WINDOW / 4 &&
             peTraceWindowStart + peTraceWindowSize < selectedPE.totalCycles) {
    peTraceScrollLock = true;
    try { _extendTraceWindow(1); } finally { peTraceScrollLock = false; }
  }

  // Recompute localIdx after possible extension
  const newLocalIdx = idx - peTraceWindowStart;
  const entries = els.traceLog.children;
  if (newLocalIdx >= 0 && newLocalIdx < entries.length) {
    _highlightedEntry = entries[newLocalIdx];
    _highlightedEntry.classList.add("current");
    if (_lastScrolledEntry !== _highlightedEntry) {
      _lastScrolledEntry = _highlightedEntry;
      peTraceScrollLock = true;
      try { _highlightedEntry.scrollIntoView({ block: "center" }); }
      finally { peTraceScrollLock = false; }
    }
  }
}

function updateScrubUI() {
  if (!state) return;
  els.scrubBar.value = state.currentCycle;
  const curStr = state.currentCycle.toLocaleString().padStart(maxCycleStr.length);
  els.cycleDisplay.textContent = `Cycle ${curStr} / ${maxCycleStr}`;
  if (serverMode) updatePrefetchIndicator();
}

/**
 * Update the scrub bar background to show prefetched regions.
 * Builds a linear-gradient with cached (accent) and uncached (border) bands.
 */
let _lastPrefetchGradient = "";
function updatePrefetchIndicator() {
  if (!state) return;
  const { minCycle, maxCycle } = state;
  const range = maxCycle - minCycle;
  if (range <= 0) return;

  // Sample at ~200 points to keep gradient manageable
  const steps = Math.min(range, 200);
  const stepSize = range / steps;
  const cached = "var(--color-prefetch)";
  const uncached = "var(--color-border)";

  let gradient = "";
  let prevCached = false;
  for (let i = 0; i <= steps; i++) {
    const cycle = Math.round(minCycle + i * stepSize);
    const val = serverStateCache.has(cycle) && serverStateCache.get(cycle) !== null;
    const pct = (i / steps * 100).toFixed(1);
    if (i === 0) {
      gradient = `${val ? cached : uncached} ${pct}%`;
      prevCached = val;
    } else if (val !== prevCached) {
      gradient += `, ${prevCached ? cached : uncached} ${pct}%, ${val ? cached : uncached} ${pct}%`;
      prevCached = val;
    }
  }
  gradient += `, ${prevCached ? cached : uncached} 100%`;
  const full = `linear-gradient(to right, ${gradient})`;
  if (full !== _lastPrefetchGradient) {
    _lastPrefetchGradient = full;
    els.scrubBar.style.background = full;
  }
}

export function updateReplayTick(timestamp) {
  if (!state || !state.playing) return;

  const dir = state.direction;
  const elapsed = timestamp - state.lastTickTime;
  const msPerCycle = 1000 / state.speed;

  // In server mode, don't advance to the next cycle until the server has
  // delivered the state for the current one. This keeps PEs and wavelets
  // visually consistent — wavelets won't move ahead of PE state.
  const serverBlocked = serverMode && pendingStateFetch;
  if (serverBlocked && elapsed >= msPerCycle) {
    console.warn(`[wse-viz] Playback hitch: waiting for server (cycle ${state.currentCycle}, ${elapsed.toFixed(0)}ms stalled)`);
  }

  const cyclesToAdvance = serverBlocked ? 0 : Math.floor(elapsed / msPerCycle);
  if (cyclesToAdvance <= 0) {
    // No cycle change — just sync fractional position for smooth animation
    const frac = serverBlocked ? 0 : dir * Math.min(Math.max(0, elapsed) / msPerCycle, 1);
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
    const range = serverMode ? null : TraceParser.getLandingRange(traceData.landingIndex, endCycle);
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

let lastStepTime = 0;
let stepAnimationId = 0;

function doStep(direction) {
  if (!state || !traceData) return;
  const now = performance.now();
  if (now - lastStepTime < STEP_ANIMATION_MS) return;

  const targetCycle = state.currentCycle + direction;
  if (targetCycle < state.minCycle || targetCycle > state.maxCycle) return;

  lastStepTime = now;
  state.playing = false;
  state.direction = direction;
  updateTransportUI();

  const ready = seekToCycle(targetCycle);

  function startStepAnimation() {
    const startCycle = targetCycle - direction;
    const stepStart = performance.now();
    if (stepAnimationId) cancelAnimationFrame(stepAnimationId);

    // Set packets to starting position immediately so the first draw doesn't
    // flash them at the target position before the animation begins.
    syncTracedPackets(targetCycle, -direction);

    function stepAnimate(timestamp) {
      if (!state || state.playing) return;
      const t = Math.min((timestamp - stepStart) / STEP_ANIMATION_MS, 1);
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

  // In server mode, wait for reconstruction to complete before animating.
  // Cache hits resolve immediately so there's no visible delay.
  if (ready && typeof ready.then === "function") {
    ready.then(() => { if (state && !state.playing) startStepAnimation(); });
  } else {
    startStepAnimation();
  }
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
  if (serverMode) { serverError = false; clearServerStatus(); }

  // Reconstruct state without landings (seek uses frozen packets separately).
  // Returns a Promise in server mode (resolved immediately on cache hit).
  const ready = reconstructStateAtCycle(targetCycle);
  // In local mode, reconstruction is synchronous — mark as done immediately.
  // In server mode, reconstructFromServer sets lastReconstructedCycle when the
  // fetch completes. Setting it eagerly here would cause updateReplayTick to
  // skip reconstruction, leaving wavelets missing until the next seek.
  if (!serverMode) lastReconstructedCycle = targetCycle;

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
  return ready;
}

function _initPlaybackState(minCycle, maxCycle) {
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
  serverGeneration++;
  if (pendingFetchAbort) { pendingFetchAbort.abort(); pendingFetchAbort = null; }
  pendingStateFetch = null;
  serverStateCache.clear();
  prefetchInFlight = 0;
  serverError = false;
  maxCycleStr = "";
  _lastPrefetchGradient = "";
  els.scrubBar.style.background = "";
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

  _initPlaybackState(meta.minCycle, meta.maxCycle);
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
    if (row < 0 || row >= grid.rows || col < 0 || col >= cols) continue;
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
    const waypoints = branchTuples.map(t => {
      const wp = { cycle: t[0], x: t[1], y: t[2],
        arriveDir: t[3], departDir: t[4], depCycle: t[5], consumed: !!t[6] };
      if (t[7]) wp.lingerUntil = t[7];
      return wp;
    });
    const pkt = new TracedPacket(waypoints, td.dimY, color, ctrl, lf);
    pkt.syncTo(state.currentCycle, state.currentCycle);
    grid.packets.push(pkt);
  }
}

function showServerStatus(msg) {
  els.serverStatus.textContent = msg;
  els.serverStatus.classList.remove("hidden");
}

function clearServerStatus() {
  els.serverStatus.textContent = "";
  els.serverStatus.classList.add("hidden");
}

/** Fetch a single cycle from the server. Returns a Promise of the parsed response. */
function fetchServerState(cycle, signal) {
  return fetch(`/api/state?cycle=${cycle}`, signal ? { signal } : undefined)
    .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); });
}

/**
 * Server-mode version of reconstructStateAtCycle.
 * Returns a Promise that resolves when the grid state has been applied
 * (immediately for cache hits, after fetch for misses).
 */
let pendingFetchAbort = null; // AbortController for the in-flight primary fetch

function reconstructFromServer(targetCycle) {
  // Check cache first — if hit, apply synchronously (no latency)
  const cached = serverStateCache.get(targetCycle);
  if (cached) {
    if (serverError) { serverError = false; clearServerStatus(); }
    applyServerState(cached);
    lastReconstructedCycle = targetCycle;
    serverPrefetch(); // keep the cache warm
    animationLoop.start();
    return Promise.resolve();
  }

  // Abort any previous in-flight primary fetch — the user has moved on
  if (pendingFetchAbort) pendingFetchAbort.abort();
  pendingFetchAbort = new AbortController();
  const { signal } = pendingFetchAbort;

  if (state && state.playing) {
    console.warn(`[wse-viz] Cache miss at cycle ${targetCycle} (cache size: ${serverStateCache.size})`);
  }
  pendingStateFetch = fetchServerState(targetCycle, signal)
    .then(data => {
      pendingStateFetch = null;
      pendingFetchAbort = null;
      if (serverError) { serverError = false; clearServerStatus(); }
      if (!state) return;
      serverStateCache.set(targetCycle, data);
      applyServerState(data);
      lastReconstructedCycle = targetCycle;
      // Reset tick time so the next updateReplayTick doesn't see the time
      // spent waiting for the fetch as elapsed playback time.
      if (state.playing) state.lastTickTime = performance.now();
      serverPrefetch(); // start filling cache ahead
      animationLoop.start();
    })
    .catch(err => {
      pendingStateFetch = null;
      pendingFetchAbort = null;
      if (err.name === "AbortError") return; // superseded by a newer seek
      serverError = true;
      if (state) {
        state.playing = false;
        updateTransportUI();
      }
      showServerStatus(`Server error: ${err.message || "connection lost"}`);
    });
  return pendingStateFetch;
}

/**
 * Continuously prefetch all cycles into the cache.
 * Prioritizes the playback direction from the current position, then fills
 * the other direction. Keeps firing until the entire trace is cached.
 */
function serverPrefetch() {
  if (!state || !serverMode) return;
  const { minCycle, maxCycle, currentCycle, direction: dir } = state;

  // Find uncached cycles, starting from current position in playback direction
  function nextUncached() {
    // Playback direction first
    if (dir > 0) {
      for (let c = currentCycle + 1; c <= maxCycle; c++)
        if (!serverStateCache.has(c)) return c;
      for (let c = currentCycle - 1; c >= minCycle; c--)
        if (!serverStateCache.has(c)) return c;
    } else {
      for (let c = currentCycle - 1; c >= minCycle; c--)
        if (!serverStateCache.has(c)) return c;
      for (let c = currentCycle + 1; c <= maxCycle; c++)
        if (!serverStateCache.has(c)) return c;
    }
    return -1; // fully cached
  }

  const gen = serverGeneration;
  while (prefetchInFlight < SERVER_MAX_PREFETCH_INFLIGHT) {
    const cycle = nextUncached();
    if (cycle < 0) break; // everything cached
    // Mark as "pending" to avoid duplicate requests
    serverStateCache.set(cycle, null);
    prefetchInFlight++;
    fetchServerState(cycle)
      .then(data => {
        if (gen !== serverGeneration) return; // stale session
        prefetchInFlight--;
        serverStateCache.set(cycle, data);
        updatePrefetchIndicator();
        serverPrefetch(); // keep filling
      })
      .catch(() => {
        if (gen !== serverGeneration) return; // stale session
        prefetchInFlight--;
        serverStateCache.delete(cycle); // clear the null placeholder
        // Don't retry immediately — avoids infinite retry storm on persistent
        // failure. Prefetching resumes on the next cache hit or playback tick.
      });
  }
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

  const worker = new Worker("trace-worker.js", { type: "module" });
  activeWorker = worker;

  worker.onerror = (err) => {
    worker.terminate(); activeWorker = null;
    if (myGen !== handleTraceGeneration) return;
    els.loadingBar.classList.add("hidden");
    els.playbackBar.classList.add("hidden");
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
      els.playbackBar.classList.add("hidden");
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
        const wvRaw = d.waveletEntries.map(e => e[1]);
        ({ waveletList, wavPrefMaxLastCycle } = TraceParser.prepareWaveletList(wvRaw));
      }

      const { entries: opEntryLookup, nops: opNopLookup } = buildOpEntryLookup(d.opLookup);

      // Rebuild pcIndex from serialized pcEntries
      const pcIndex = TraceParser._rebuildPCMaps(d.pcEntries || []);

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
        stallLookup: d.stallLookup,
        minCycle: d.minCycle,
        maxCycle: d.maxCycle,
        pcIndex,
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
      _initPlaybackState(traceData.minCycle, traceData.maxCycle);
    } // case "done"
    } // switch
  };

  worker.postMessage({ file });
}

function handleTraceLogClick(e) {
  if (!selectedPE || !state) return;
  const entry = e.target.closest(".trace-entry");
  if (!entry || entry.dataset.idx === undefined) return;
  const cycle = selectedPE.minCycle + parseInt(entry.dataset.idx, 10);
  seekToCycle(cycle);
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

}
