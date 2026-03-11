import { drawPacketDot } from "./draw-utils.js";
import { RAMP_DEPTH, RAMP_LATERAL } from "./constants.js";
import { LANDING_DECODE, decodeDeparting } from "./trace-parser.js";

// Direction → trace coordinate delta
const DIR_DELTA = { E: [1, 0], W: [-1, 0], N: [0, -1], S: [0, 1] };

// Direction → opposite (for computing arrival direction at destination)
const DIR_OPPOSITE = { E: "W", W: "E", N: "S", S: "N" };

/**
 * Extracts linear branches from a TracedWavelet's hop list.
 * Each branch waypoint includes arrival/departure info for ramp positioning.
 */
export function extractBranches(wavelet) {
  const { hops } = wavelet;
  if (hops.cycles.length === 0) return [];

  // Decode typed arrays into lightweight objects.
  // hopsByPos: keyed by (cycle,x,y) for exact-cycle lookups.
  // hopsByPE: keyed by (x,y) with hops sorted by cycle, for forward scans.
  const hopsByPos = new Map();
  const hopsByPE = new Map();
  for (let i = 0; i < hops.cycles.length; i++) {
    const hop = {
      cycle: hops.cycles[i],
      x: hops.xs[i],
      y: hops.ys[i],
      landing: LANDING_DECODE[hops.landings[i]],
      departing: decodeDeparting(hops.departings[i]),
      consumed: !!hops.consumed[i],
    };
    const posKey = `${hop.cycle},${hop.x},${hop.y}`;
    if (!hopsByPos.has(posKey)) hopsByPos.set(posKey, []);
    hopsByPos.get(posKey).push(hop);

    const peKey = `${hop.x},${hop.y}`;
    if (!hopsByPE.has(peKey)) hopsByPE.set(peKey, []);
    hopsByPE.get(peKey).push(hop);
  }
  // Sort each PE's hops by cycle for forward scanning
  for (const arr of hopsByPE.values()) {
    if (arr.length > 1) arr.sort((a, b) => a.cycle - b.cycle);
  }

  const branches = [];
  // Track visited (cycle, x, y) arrivals to deduplicate converging branches.
  // In broadcast patterns, multiple fork branches can arrive at the same PE
  // at the same cycle; their onward paths are identical, so we only trace one.
  const visited = new Set();

  function getDepartures(cycle, x, y) {
    // Scan forward from the arrival cycle at this PE for a departure event
    const peHops = hopsByPE.get(`${x},${y}`) || [];
    for (const h of peHops) {
      if (h.cycle < cycle) continue;
      // At arrival cycle: check for immediate departure
      if (h.cycle === cycle && h.departing.length > 0) {
        return { dirs: h.departing, depCycle: h.cycle };
      }
      // After arrival: only consider continuation hops (landing="-")
      if (h.cycle > cycle && h.landing === "-" && h.departing.length > 0) {
        return { dirs: h.departing, depCycle: h.cycle };
      }
    }
    return null;
  }

  function isConsumedWithDepartures(cycle, x, y) {
    // Scan forward from arrival cycle for a hop that is both consumed and departing
    const peHops = hopsByPE.get(`${x},${y}`) || [];
    for (const h of peHops) {
      if (h.cycle < cycle) continue;
      if (h.consumed && h.departing.length > 0) return true;
      // Stop if we've passed continuation hops (new landing = new wavelet visit)
      if (h.cycle > cycle && h.landing !== "-") break;
    }
    return false;
  }

  function getLandingDir(cycle, x, y) {
    const hereHops = hopsByPos.get(`${cycle},${x},${y}`) || [];
    for (const h of hereHops) {
      if (h.landing !== "-") return h.landing;
    }
    return null;
  }

  function continueTrace(waypoints, cx, cy, cc) {
    for (;;) {
      const dep = getDepartures(cc, cx, cy);
      if (!dep) break;

      const fromX = cx, fromY = cy;
      let followed = false;
      let terminated = false; // true if main branch's destination was already visited

      // Deduplicate converging branches: when multiple branches arrive at the
      // same next PE at the same cycle, only the first one continues tracing
      // onward. All branches still get their departure waypoint set, so they
      // animate the crossing from on-ramp to off-ramp before merging.
      for (const dir of dep.dirs) {
        const d = DIR_DELTA[dir];
        if (!d) continue;
        const nx = fromX + d[0], ny = fromY + d[1];
        const nc = dep.depCycle + 1;

        if (!followed) {
          // Record departure on the current waypoint
          waypoints[waypoints.length - 1].departDir = dir;
          waypoints[waypoints.length - 1].depCycle = dep.depCycle;

          // Check if the next PE was already reached by another branch.
          // If so, the crossing animation still plays (departDir is set) but
          // we don't push an arrival waypoint — the dot stops at the off-ramp.
          const destKey = `${nc},${nx},${ny}`;
          if (visited.has(destKey)) {
            terminated = true;
            break; // no arrival pushed — skip remaining fork directions
          }
          visited.add(destKey);
          const nextArriveDir = getLandingDir(nc, nx, ny) || DIR_OPPOSITE[dir];
          waypoints.push({ cycle: nc, x: nx, y: ny, arriveDir: nextArriveDir, departDir: null, depCycle: null });
          cx = nx; cy = ny; cc = nc;
          followed = true;
        } else {
          // Fork: the wavelet splits here. The fork branch starts at the
          // same on-ramp as the parent (using the parent's arriveDir), then
          // crosses to this fork's off-ramp direction. This makes the packet
          // visually diverge from the parent — one dot becomes two.
          const forkPeWp = waypoints[waypoints.length - 2];
          const forkStart = {
            cycle: forkPeWp.cycle, x: fromX, y: fromY,
            arriveDir: forkPeWp.arriveDir, departDir: dir, depCycle: dep.depCycle,
          };

          // If destination already reached, emit a short branch that shows
          // the crossing animation (on-ramp → off-ramp) then terminates
          const destKey = `${nc},${nx},${ny}`;
          if (visited.has(destKey)) {
            const nextArriveDir = getLandingDir(nc, nx, ny) || DIR_OPPOSITE[dir];
            branches.push([forkStart, {
              cycle: nc, x: nx, y: ny,
              arriveDir: nextArriveDir, departDir: null, depCycle: null,
            }]);
            continue;
          }
          visited.add(destKey);

          const nextArriveDir = getLandingDir(nc, nx, ny) || DIR_OPPOSITE[dir];
          const forkDest = {
            cycle: nc, x: nx, y: ny,
            arriveDir: nextArriveDir, departDir: null, depCycle: null,
          };
          continueTrace([forkStart, forkDest], nx, ny, nc);
        }
      }

      // Multicast-and-consume: if the wavelet is both forwarded and consumed
      // at this PE, create a short branch that terminates here (the CE delivery).
      // The dot visually forks: one continues to the next PE, one stays here.
      // Check the arrival cycle at this PE (consumePeWp.cycle), not the departure cycle
      if (waypoints.length >= 2 && followed) {
        const arrivalCycle = waypoints[waypoints.length - 2].cycle;
        if (isConsumedWithDepartures(arrivalCycle, fromX, fromY)) {
          const consumePeWp = waypoints[waypoints.length - 2];
          branches.push([
            { cycle: consumePeWp.cycle, x: fromX, y: fromY,
              arriveDir: consumePeWp.arriveDir, departDir: null, depCycle: null },
            { cycle: dep.depCycle + 1, x: fromX, y: fromY,
              arriveDir: consumePeWp.arriveDir, departDir: null, depCycle: null },
          ]);
        }
      }

      if (!followed || terminated) break;
    }

    if (waypoints.length > 1) {
      branches.push(waypoints);
    }
  }

  const startWp = { cycle: hops.cycles[0], x: hops.xs[0], y: hops.ys[0],
    arriveDir: LANDING_DECODE[hops.landings[0]], departDir: null, depCycle: null };
  continueTrace([startWp], startWp.x, startWp.y, startWp.cycle);

  return branches;
}

// Ramp positions in the gap around a PE.
//
// Trace → screen coordinate mapping (Y-axis flipped):
//   trace N (y-1) → screen down, trace S (y+1) → screen up
//   trace E (x+1) → screen right, trace W (x-1) → screen left
//
// Lateral offsets separate on-ramps from off-ramps:
//   N: off-ramp left (-X), on-ramp right (+X)
//   S: on-ramp left (-X), off-ramp right (+X)
//   E: off-ramp above (-Y), on-ramp below (+Y)
//   W: on-ramp above (-Y), off-ramp below (+Y)

function onRampPos(grid, x, y, dimY, dir) {
  return _rampPos(grid, x, y, dimY, dir, true);
}

function offRampPos(grid, x, y, dimY, dir) {
  return _rampPos(grid, x, y, dimY, dir, false);
}

function _rampPos(grid, x, y, dimY, dir, isOnRamp) {
  const row = dimY - 1 - y;
  const col = x;
  const pe = grid.getPE(row, col);
  if (!pe) return null;

  const { cx, cy } = pe;

  if (!dir || dir === "R") return { x: cx, y: cy };

  // lat: lateral offset sign. Positive = right/down in screen coords.
  // Per user spec:
  //   N off-ramp: left (-X), N on-ramp: right (+X)
  //   S on-ramp: left (-X), S off-ramp: right (+X)
  //   E off-ramp: above (-Y), E on-ramp: below (+Y)
  //   W on-ramp: above (-Y), W off-ramp: below (+Y)
  const lat = RAMP_LATERAL;

  switch (dir) {
    case "E": // screen right; lateral = screen Y axis
      return { x: cx + RAMP_DEPTH, y: cy + (isOnRamp ? lat : -lat) };
    case "W": // screen left; lateral = screen Y axis
      return { x: cx - RAMP_DEPTH, y: cy + (isOnRamp ? -lat : lat) };
    case "N": // screen DOWN (trace y-1 = grid row+1 = screen lower)
      return { x: cx + (isOnRamp ? lat : -lat), y: cy + RAMP_DEPTH };
    case "S": // screen UP (trace y+1 = grid row-1 = screen higher)
      return { x: cx + (isOnRamp ? -lat : lat), y: cy - RAMP_DEPTH };
    default:
      return { x: cx, y: cy };
  }
}

/**
 * TracedPacket animates a wavelet along a single branch.
 * Position is driven by the replay cycle counter.
 *
 * Within each PE visit, the wavelet goes through phases:
 *   1. Arrive at on-ramp (arrival cycle)
 *   2. Cross through PE center to off-ramp (between arrival and departure cycles)
 *   3. Transit to next PE's on-ramp (departure cycle to next arrival cycle)
 *
 * Between integer cycles the position is interpolated for smooth animation.
 */
export class TracedPacket {
  constructor(waypoints, dimY, color, ctrl, lf) {
    this.waypoints = waypoints;
    this.dimY = dimY;
    this.color = color;
    this.ctrl = ctrl;   // true = control wavelet, false = data wavelet
    this.lf = lf;       // true = last-in-flight
    this.startCycle = waypoints[0].cycle;
    this.endCycle = waypoints[waypoints.length - 1].cycle;
    this.fractionalCycle = this.startCycle;
    this.wpIdx = 0;     // cached waypoint index, updated by syncTo
    this.done = false;
    this.visible = false;
  }

  /** Update cycle state and fractional position in one call. */
  syncTo(cycle, fc) {
    this.done = cycle > this.endCycle;
    this.visible = cycle >= this.startCycle && !this.done;
    this.fractionalCycle = fc;
    // Update cached waypoint index, starting from previous position for
    // amortized O(1) during forward playback. Falls back to scanning
    // backward for seeks.
    const wp = this.waypoints;
    let idx = this.wpIdx;
    if (idx < wp.length && wp[idx].cycle <= fc) {
      // Forward: advance from current position
      while (idx + 1 < wp.length && wp[idx + 1].cycle <= fc) idx++;
    } else {
      // Backward seek: scan from start
      idx = 0;
      for (let i = 1; i < wp.length; i++) {
        if (wp[i].cycle > fc) break;
        idx = i;
      }
    }
    this.wpIdx = idx;
  }

  getCurrentPosition(_currentTime, grid) {
    const fc = this.fractionalCycle;
    const wpIdx = this.wpIdx;
    const wp = this.waypoints[wpIdx];
    const nextWp = wpIdx < this.waypoints.length - 1 ? this.waypoints[wpIdx + 1] : null;
    const depCycle = wp.depCycle;

    const dimY = this.dimY;

    // Phase 1: At on-ramp, waiting for departure.
    // The dot sits at the on-ramp from arrival until one cycle before departure,
    // then crosses to the off-ramp during the final cycle before departing.
    // This reflects the physical model: the wavelet is in the fabric switch
    // being processed, not physically traversing the PE.
    if (depCycle !== null && fc < depCycle) {
      const from = onRampPos(grid, wp.x, wp.y, dimY, wp.arriveDir);
      if (!from) return null;
      const crossStart = depCycle - 1; // begin crossing one cycle before departure
      if (fc <= crossStart) return from; // sitting at on-ramp
      // Crossing from on-ramp to off-ramp in the final cycle
      const to = offRampPos(grid, wp.x, wp.y, dimY, wp.departDir);
      if (!to) return from;
      const t = fc - crossStart; // 0..1 over the final cycle
      return {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
      };
    }

    // Phase 2: Departing off-ramp → transiting to next PE's on-ramp
    if (nextWp && depCycle !== null && fc >= depCycle && fc < nextWp.cycle) {
      const from = offRampPos(grid, wp.x, wp.y, dimY, wp.departDir);
      const to = onRampPos(grid, nextWp.x, nextWp.y, dimY, nextWp.arriveDir);
      if (!from || !to) return null;

      const span = nextWp.cycle - depCycle;
      if (span <= 0) return from;
      const t = (fc - depCycle) / span;
      return {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
      };
    }

    // Phase 3: Sitting at final destination on-ramp or off-ramp
    if (wp.departDir) {
      return offRampPos(grid, wp.x, wp.y, dimY, wp.departDir);
    }
    return onRampPos(grid, wp.x, wp.y, dimY, wp.arriveDir);
  }

  isComplete(_currentTime) {
    return this.done;
  }

  draw(ctx, currentTime, grid) {
    if (!this.visible) return;
    const pos = this.getCurrentPosition(currentTime, grid);
    if (!pos) return;
    drawPacketDot(ctx, pos.x, pos.y, this.color, this.ctrl, this.lf);
  }
}
