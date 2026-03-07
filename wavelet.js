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
  if (hops.length === 0) return [];

  // Decode typed arrays into lightweight objects for the hopsByPos Map
  const hopsByPos = new Map();
  for (let i = 0; i < hops.length; i++) {
    const hop = {
      cycle: hops.cycles[i],
      x: hops.xs[i],
      y: hops.ys[i],
      landing: LANDING_DECODE[hops.landings[i]],
      departing: decodeDeparting(hops.departings[i]),
      consumed: !!hops.consumed[i],
    };
    const key = `${hop.cycle},${hop.x},${hop.y}`;
    if (!hopsByPos.has(key)) hopsByPos.set(key, []);
    hopsByPos.get(key).push(hop);
  }

  const branches = [];

  function getDepartures(cycle, x, y) {
    const hereHops = hopsByPos.get(`${cycle},${x},${y}`) || [];
    for (const h of hereHops) {
      if (h.departing.length > 0) return { dirs: h.departing, depCycle: h.cycle };
    }
    for (let dc = 1; dc <= 3; dc++) {
      const futureHops = hopsByPos.get(`${cycle + dc},${x},${y}`) || [];
      for (const h of futureHops) {
        if (h.landing === "-" && h.departing.length > 0) {
          return { dirs: h.departing, depCycle: h.cycle };
        }
      }
    }
    return null;
  }

  function isConsumedWithDepartures(cycle, x, y) {
    // Check the hop at the arrival cycle and a few cycles after (the wavelet
    // may have separate hop records for arrival and departure at the same PE)
    for (let dc = 0; dc <= 3; dc++) {
      const hereHops = hopsByPos.get(`${cycle + dc},${x},${y}`) || [];
      for (const h of hereHops) {
        if (h.consumed && h.departing.length > 0) return true;
      }
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

  function traceBranch(startCycle, startX, startY, arriveDir) {
    const waypoints = [{ cycle: startCycle, x: startX, y: startY, arriveDir, departDir: null, depCycle: null }];
    let cx = startX, cy = startY, cc = startCycle;
    continueTrace(waypoints, cx, cy, cc);
  }

  function continueTrace(waypoints, cx, cy, cc) {

    for (;;) {
      const dep = getDepartures(cc, cx, cy);
      if (!dep) break;

      const fromX = cx, fromY = cy;
      let followed = false;

      for (const dir of dep.dirs) {
        const d = DIR_DELTA[dir];
        if (!d) continue;
        const nx = fromX + d[0], ny = fromY + d[1];
        const nc = dep.depCycle + 1;

        if (!followed) {
          // Record departure on the current waypoint
          waypoints[waypoints.length - 1].departDir = dir;
          waypoints[waypoints.length - 1].depCycle = dep.depCycle;
          // Add arrival at the next PE
          const nextArriveDir = getLandingDir(nc, nx, ny) || DIR_OPPOSITE[dir];
          waypoints.push({ cycle: nc, x: nx, y: ny, arriveDir: nextArriveDir, departDir: null, depCycle: null });
          cx = nx; cy = ny; cc = nc;
          followed = true;
        } else {
          // Fork: the wavelet splits here. The fork branch starts at the
          // same on-ramp as the parent (using the parent's arriveDir), then
          // crosses to this fork's off-ramp direction. This makes the packet
          // visually diverge from the parent — one dot becomes two.
          // The fork PE is the second-to-last waypoint (the last one is the next PE
          // that was just pushed for the main branch's first direction)
          const forkPeWp = waypoints[waypoints.length - 2];
          const parentArriveDir = forkPeWp.arriveDir;
          const nextArriveDir = getLandingDir(dep.depCycle + 1, fromX + d[0], fromY + d[1]) || DIR_OPPOSITE[dir];
          const forkCrossingStart = forkPeWp.cycle;
          const forkStart = {
            cycle: forkCrossingStart, x: fromX, y: fromY,
            arriveDir: parentArriveDir, departDir: dir, depCycle: dep.depCycle,
          };
          const forkDest = {
            cycle: dep.depCycle + 1, x: fromX + d[0], y: fromY + d[1],
            arriveDir: nextArriveDir, departDir: null, depCycle: null,
          };
          continueTrace([forkStart, forkDest], fromX + d[0], fromY + d[1], dep.depCycle + 1);
        }
      }

      // Multicast-and-consume: if the wavelet is both forwarded and consumed
      // at this PE, create a short branch that terminates here (the CE delivery).
      // The dot visually forks: one continues to the next PE, one stays here.
      // Check the arrival cycle at this PE (consumePeWp.cycle), not the departure cycle
      const arrivalCycle = waypoints[waypoints.length - 2].cycle;
      if (followed && isConsumedWithDepartures(arrivalCycle, fromX, fromY)) {
        const consumePeWp = waypoints[waypoints.length - 2];
        branches.push([
          // Start at the on-ramp (same arrival as the parent branch)
          { cycle: consumePeWp.cycle, x: fromX, y: fromY,
            arriveDir: consumePeWp.arriveDir, departDir: null, depCycle: null },
          // Terminal waypoint: the dot lingers at the on-ramp for one cycle,
          // visually indicating consumption while the forwarded dot moves on.
          { cycle: dep.depCycle + 1, x: fromX, y: fromY,
            arriveDir: consumePeWp.arriveDir, departDir: null, depCycle: null },
        ]);
      }

      if (!followed) break;
    }

    if (waypoints.length > 1) {
      branches.push(waypoints);
    }
  }

  traceBranch(hops.cycles[0], hops.xs[0], hops.ys[0], LANDING_DECODE[hops.landings[0]]);

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
    this.done = false;
    this.visible = false;
  }

  setCycle(cycle) {
    this.done = cycle > this.endCycle;
    this.visible = cycle >= this.startCycle;
  }

  /** Set a fractional cycle for smooth sub-cycle animation */
  setFractionalCycle(fc) {
    this.fractionalCycle = fc;
  }

  getCurrentPosition(_currentTime, grid) {
    const fc = this.fractionalCycle;

    // Find which waypoint we're at or between
    let wpIdx = 0;
    for (let i = 1; i < this.waypoints.length; i++) {
      if (this.waypoints[i].cycle > fc) break;
      wpIdx = i;
    }

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
