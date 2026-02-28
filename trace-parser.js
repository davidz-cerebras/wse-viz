export class TraceParser {
  static async parse(file) {
    let dimX = 0;
    let dimY = 0;
    const eventsByCycle = new Map();
    let minCycle = Infinity;
    let maxCycle = -Infinity;
    let totalEvents = 0;

    const dimRegex = /^@\d+ dimX=(\d+), dimY=(\d+)/;
    const landingRegex =
      /^@(\d+) P(\d+)\.(\d+) \(\w+\) landing C(\d+) from link ([WESNR]),/;
    const exOpRegex = /^@(\d+) P(\d+)\.(\d+):.*\[EX OP\]/;
    const opcodeRegex = /T\d+(?:\.\w+)?\s+(\S+)/;

    const prevState = new Map();

    const reader = file
      .stream()
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let partial = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      partial += value;
      const lines = partial.split("\n");
      partial = lines.pop();

      for (const line of lines) {
        if (dimX === 0) {
          const dimMatch = line.match(dimRegex);
          if (dimMatch) {
            dimX = parseInt(dimMatch[1]);
            dimY = parseInt(dimMatch[2]);
            continue;
          }
        }

        if (line.includes(") landing C")) {
          const m = line.match(landingRegex);
          if (m) {
            const cycle = parseInt(m[1]);
            const x = parseInt(m[2]);
            const y = parseInt(m[3]);
            const color = parseInt(m[4]);
            const dir = m[5];

            if (!eventsByCycle.has(cycle)) {
              eventsByCycle.set(cycle, { landings: [], execChanges: [] });
            }
            eventsByCycle.get(cycle).landings.push({ x, y, color, dir });

            if (cycle < minCycle) minCycle = cycle;
            if (cycle > maxCycle) maxCycle = cycle;
            totalEvents++;
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
              if (!eventsByCycle.has(cycle)) {
                eventsByCycle.set(cycle, { landings: [], execChanges: [] });
              }
              eventsByCycle.get(cycle).execChanges.push({ x, y, busy, op });

              if (cycle < minCycle) minCycle = cycle;
              if (cycle > maxCycle) maxCycle = cycle;
            }
          }
        }
      }
    }

    return { dimX, dimY, eventsByCycle, minCycle, maxCycle, totalEvents };
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
