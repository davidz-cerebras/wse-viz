const landingRegex =
  /^@(\d+) P(\d+)\.(\d+) \(\w+\) landing C(\d+) from link ([WESNR]),/;
const exOpRegex = /^@(\d+) P(\d+)\.(\d+):.*\[EX OP\]/;
const opcodeRegex = /T\d+(?:\.\w+)?\s+(\S+)/;

function parseLanding(line) {
  if (!line.includes(") landing C")) return null;
  const m = line.match(landingRegex);
  if (!m) return null;
  return {
    cycle: parseInt(m[1]),
    x: parseInt(m[2]),
    y: parseInt(m[3]),
    color: parseInt(m[4]),
    dir: m[5],
  };
}

function parseExOp(line) {
  if (!line.includes("[EX OP]")) return null;
  const m = line.match(exOpRegex);
  if (!m) return null;
  const busy = !line.includes("[EX OP] IDLE");
  let op = null;
  if (busy) {
    const afterExOp = line.split("[EX OP]")[1];
    const opcodeMatch = afterExOp.match(opcodeRegex);
    if (opcodeMatch) op = opcodeMatch[1];
  }
  return {
    cycle: parseInt(m[1]),
    x: parseInt(m[2]),
    y: parseInt(m[3]),
    busy,
    op,
  };
}

export class TraceParser {
  static async index(file) {
    let dimX = 0;
    let dimY = 0;
    let minCycle = Infinity;
    let maxCycle = -Infinity;
    let totalEvents = 0;

    const dimRegex = /^@\d+ dimX=(\d+), dimY=(\d+)/;
    const prevState = new Map();
    const peStateIndex = new Map();

    const tmpCycles = [];
    const tmpStarts = [];
    const tmpEnds = [];
    let currentCycle = -1;
    let blockByteStart = 0;
    let hasEvents = false;

    const processLine = (line, lineByteStart) => {
      if (line.charCodeAt(0) === 64) {
        const spaceIdx = line.indexOf(" ", 1);
        if (spaceIdx > 1) {
          const cycle = parseInt(line.substring(1, spaceIdx));
          if (cycle !== currentCycle) {
            if (hasEvents && currentCycle >= 0) {
              tmpCycles.push(currentCycle);
              tmpStarts.push(blockByteStart);
              tmpEnds.push(lineByteStart);
            }
            currentCycle = cycle;
            blockByteStart = lineByteStart;
            hasEvents = false;
          }
        }
      }

      if (dimX === 0) {
        const dimMatch = line.match(dimRegex);
        if (dimMatch) {
          dimX = parseInt(dimMatch[1]);
          dimY = parseInt(dimMatch[2]);
          return;
        }
      }

      const landing = parseLanding(line);
      if (landing) {
        if (landing.cycle < minCycle) minCycle = landing.cycle;
        if (landing.cycle > maxCycle) maxCycle = landing.cycle;
        totalEvents++;
        hasEvents = true;
      } else {
        const ex = parseExOp(line);
        if (ex) {
          const key = `${ex.x},${ex.y}`;
          const state = ex.busy ? `1:${ex.op}` : "0";
          if (prevState.get(key) !== state) {
            prevState.set(key, state);
            if (!peStateIndex.has(key)) peStateIndex.set(key, []);
            peStateIndex.get(key).push({ cycle: ex.cycle, busy: ex.busy, op: ex.op });
            if (ex.cycle < minCycle) minCycle = ex.cycle;
            if (ex.cycle > maxCycle) maxCycle = ex.cycle;
          }
          hasEvents = true;
        }
      }
    };

    const reader = file
      .stream()
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let partial = "";
    let byteOffset = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      partial += value;
      const lines = partial.split("\n");
      partial = lines.pop();

      for (const line of lines) {
        const lineByteStart = byteOffset;
        // Byte offset tracking assumes ASCII (1 byte per char). This is safe
        // because simfabric trace files are always pure ASCII.
        byteOffset += line.length + 1;
        processLine(line, lineByteStart);
      }
    }

    // Handle remaining partial line (file may not end with \n)
    if (partial.length > 0) {
      processLine(partial, byteOffset);
      byteOffset += partial.length;
    }

    // Flush last cycle block
    if (hasEvents && currentCycle >= 0) {
      tmpCycles.push(currentCycle);
      tmpStarts.push(blockByteStart);
      tmpEnds.push(byteOffset);
    }

    const len = tmpCycles.length;
    const cycleIndex = {
      cycles: new Float64Array(tmpCycles),
      starts: new Float64Array(tmpStarts),
      ends: new Float64Array(tmpEnds),
      length: len,
    };

    return {
      file,
      dimX,
      dimY,
      cycleIndex,
      peStateIndex,
      minCycle,
      maxCycle,
      totalEvents,
    };
  }

  static findCycleIndex(cycleIndex, cycle) {
    const { cycles, length } = cycleIndex;
    let lo = 0;
    let hi = length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cycles[mid] === cycle) return mid;
      if (cycles[mid] < cycle) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  static findCycleIndexGE(cycleIndex, cycle) {
    const { cycles, length } = cycleIndex;
    let lo = 0;
    let hi = length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cycles[mid] < cycle) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  static findCycleIndexLE(cycleIndex, cycle) {
    const { cycles, length } = cycleIndex;
    let lo = 0;
    let hi = length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cycles[mid] <= cycle) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  static async loadCycleRange(traceData, fromIdx, toIdx) {
    const { file, cycleIndex } = traceData;
    if (fromIdx < 0 || toIdx >= cycleIndex.length || fromIdx > toIdx) {
      return new Map();
    }

    const { starts, ends } = cycleIndex;
    const blob = file.slice(starts[fromIdx], ends[toIdx]);
    const text = await blob.text();

    const result = new Map();
    const prevState = new Map();

    function getOrCreateCycle(cycle) {
      let entry = result.get(cycle);
      if (!entry) {
        entry = { landings: [], execChanges: [] };
        result.set(cycle, entry);
      }
      return entry;
    }

    for (const line of text.split("\n")) {
      const landing = parseLanding(line);
      if (landing) {
        getOrCreateCycle(landing.cycle).landings.push(landing);
        continue;
      }
      const ex = parseExOp(line);
      if (ex) {
        const key = `${ex.x},${ex.y}`;
        const state = ex.busy ? `1:${ex.op}` : "0";
        if (prevState.get(key) !== state) {
          prevState.set(key, state);
          getOrCreateCycle(ex.cycle).execChanges.push(ex);
        }
      }
    }

    return result;
  }

  // Returns the source PE coordinates for a landing event. The direction
  // indicates which link the wavelet arrived on, NOT which compass direction
  // the source is in. "from link N" means the wavelet used the north-facing
  // link of the neighbor at y-1 (the tile to the south in trace coordinates).
  // This mapping is intentional and matches the simfabric trace format.
  static sourceCoords(x, y, dir) {
    switch (dir) {
      case "W":
        return { x: x - 1, y };
      case "E":
        return { x: x + 1, y };
      case "N":
        return { x, y: y - 1 };
      case "S":
        return { x, y: y + 1 };
      default:
        return null;
    }
  }

  static toGridCoords(x, y, dimY) {
    return { row: dimY - 1 - y, col: x };
  }
}
