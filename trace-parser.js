const landingRegex =
  /^@(\d+) P(\d+)\.(\d+) \(\w+\) landing C(\d+) from link ([WESNR]),/;
const exOpRegex = /^@(\d+) P(\d+)\.(\d+):.*\[EX OP\]/;
const opcodeRegex = /T\d+(?:\.\w+)?\s+(\S+)/;

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

      if (line.includes(") landing C")) {
        const m = line.match(landingRegex);
        if (m) {
          const cycle = parseInt(m[1]);
          if (cycle < minCycle) minCycle = cycle;
          if (cycle > maxCycle) maxCycle = cycle;
          totalEvents++;
          hasEvents = true;
        }
      } else if (line.includes("[EX OP]")) {
        const m = line.match(exOpRegex);
        if (m) {
          const cycle = parseInt(m[1]);
          const x = parseInt(m[2]);
          const y = parseInt(m[3]);
          const busy = !line.includes("[EX OP] IDLE");
          let op = null;
          if (busy) {
            const afterExOp = line.split("[EX OP]")[1];
            const opcodeMatch = afterExOp.match(opcodeRegex);
            if (opcodeMatch) op = opcodeMatch[1];
          }

          const key = `${x},${y}`;
          const state = busy ? `1:${op}` : "0";
          if (prevState.get(key) !== state) {
            prevState.set(key, state);
            if (!peStateIndex.has(key)) peStateIndex.set(key, []);
            peStateIndex.get(key).push({ cycle, busy, op });
            if (cycle < minCycle) minCycle = cycle;
            if (cycle > maxCycle) maxCycle = cycle;
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
        byteOffset += line.length + 1; // +1 for \n; correct for ASCII
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
      cycles: new Int32Array(tmpCycles),
      starts: new Uint32Array(tmpStarts),
      ends: new Uint32Array(tmpEnds),
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

  static async loadCycleRange(traceData, fromIdx, toIdx) {
    const { file, cycleIndex } = traceData;
    if (fromIdx < 0 || toIdx >= cycleIndex.length || fromIdx > toIdx) {
      return new Map();
    }

    const { starts, ends } = cycleIndex;
    const blob = file.slice(starts[fromIdx], ends[toIdx]);
    const text = await blob.text();

    const result = new Map();
    const lines = text.split("\n");

    for (const line of lines) {
      if (line.includes(") landing C")) {
        const m = line.match(landingRegex);
        if (m) {
          const cycle = parseInt(m[1]);
          if (!result.has(cycle))
            result.set(cycle, { landings: [], execChanges: [] });
          result
            .get(cycle)
            .landings.push({
              x: parseInt(m[2]),
              y: parseInt(m[3]),
              color: parseInt(m[4]),
              dir: m[5],
            });
        }
      } else if (line.includes("[EX OP]")) {
        const m = line.match(exOpRegex);
        if (m) {
          const cycle = parseInt(m[1]);
          const busy = !line.includes("[EX OP] IDLE");
          let op = null;
          if (busy) {
            const afterExOp = line.split("[EX OP]")[1];
            const opcodeMatch = afterExOp.match(opcodeRegex);
            if (opcodeMatch) op = opcodeMatch[1];
          }
          if (!result.has(cycle))
            result.set(cycle, { landings: [], execChanges: [] });
          result
            .get(cycle)
            .execChanges.push({
              x: parseInt(m[2]),
              y: parseInt(m[3]),
              busy,
              op,
            });
        }
      }
    }

    return result;
  }

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
