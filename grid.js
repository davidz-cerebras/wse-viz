import { PE } from "./pe.js";
import { DataPacket } from "./packet.js";

export class Grid {
  constructor(rows, cols, cellSize, gap) {
    this.rows = rows;
    this.cols = cols;
    this.cellSize = cellSize;
    this.gap = gap;
    this.pes = [];
    this.packets = [];
    this.init();
  }

  init() {
    this.pes = [];
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const x = col * (this.cellSize + this.gap) + this.gap;
        const y = row * (this.cellSize + this.gap) + this.gap;
        this.pes.push(new PE(x, y, this.cellSize));
      }
    }
  }

  getPE(row, col) {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) {
      return null;
    }
    return this.pes[row * this.cols + col];
  }

  activatePE(row, col) {
    const pe = this.getPE(row, col);
    if (pe) {
      pe.activate();
    }
  }

  sendPacket(fromRow, fromCol, toRow, toCol, duration = 600) {
    const fromPE = this.getPE(fromRow, fromCol);
    const toPE = this.getPE(toRow, toCol);

    if (!fromPE || !toPE) {
      return;
    }

    const fromX = fromPE.x + this.cellSize / 2;
    const fromY = fromPE.y + this.cellSize / 2;
    const toX = toPE.x + this.cellSize / 2;
    const toY = toPE.y + this.cellSize / 2;

    this.packets.push(
      new DataPacket(fromX, fromY, toX, toY, Date.now(), duration),
    );
  }

  update() {
    this.pes.forEach((pe) => pe.update());
    this.packets = this.packets.filter(
      (packet) => !packet.isComplete(Date.now()),
    );
  }

  draw(ctx) {
    this.pes.forEach((pe) => pe.draw(ctx));
    this.packets.forEach((packet) => packet.draw(ctx, Date.now()));
  }

  getActivePECount() {
    return this.pes.filter((pe) => pe.active).length;
  }

  getPacketCount() {
    return this.packets.length;
  }

  allReducePhase1() {
    const isEvenCols = this.cols % 2 === 0;
    const centerCol1 = Math.floor((this.cols - 1) / 2);
    const centerCol2 = isEvenCols ? centerCol1 + 1 : centerCol1;

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const pe = this.getPE(row, col);
        pe.activate();

        if (col === centerCol1 || col === centerCol2) continue;

        let nextCol;
        if (col < centerCol1) {
          nextCol = col + 1;
        } else if (col > centerCol2) {
          nextCol = col - 1;
        } else {
          nextCol = col < centerCol2 ? centerCol1 : centerCol2;
        }

        this.sendPacket(row, col, row, nextCol, 600);
      }
    }
  }

  allReducePhase2() {
    const isEvenCols = this.cols % 2 === 0;
    const centerCol1 = Math.floor((this.cols - 1) / 2);
    const centerCol2 = isEvenCols ? centerCol1 + 1 : centerCol1;

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        if (col === 0 || col === this.cols - 1) continue;

        const pe = this.getPE(row, col);
        pe.activate();

        if (col === centerCol1 || col === centerCol2) continue;

        let nextCol;
        if (col < centerCol1) {
          nextCol = col + 1;
        } else if (col > centerCol2) {
          nextCol = col - 1;
        } else {
          nextCol = col < centerCol2 ? centerCol1 : centerCol2;
        }

        this.sendPacket(row, col, row, nextCol, 600);
      }
    }
  }

  allReducePhase(phase) {
    const isEvenCols = this.cols % 2 === 0;
    const centerCol1 = Math.floor((this.cols - 1) / 2);
    const centerCol2 = isEvenCols ? centerCol1 + 1 : centerCol1;
    const excludeCount = phase - 1;

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        if (col < excludeCount || col >= this.cols - excludeCount) continue;

        const pe = this.getPE(row, col);
        pe.activate();

        if (col === centerCol1 || col === centerCol2) continue;

        let nextCol;
        if (col < centerCol1) {
          nextCol = col + 1;
        } else if (col > centerCol2) {
          nextCol = col - 1;
        } else {
          nextCol = col < centerCol2 ? centerCol1 : centerCol2;
        }

        this.sendPacket(row, col, row, nextCol, 600);
      }
    }
  }

  runAllReduce() {
    const maxPhase = Math.ceil(this.cols / 2);
    const phaseDelay = 450;

    for (let phase = 1; phase <= maxPhase; phase++) {
      setTimeout(
        () => {
          this.allReducePhase(phase);
        },
        (phase - 1) * phaseDelay,
      );
    }

    const verticalStartDelay = maxPhase * phaseDelay;
    const maxVerticalPhase = Math.ceil(this.rows / 2);

    for (let phase = 1; phase <= maxVerticalPhase; phase++) {
      setTimeout(
        () => {
          this.allReduceVerticalPhase(phase);
        },
        verticalStartDelay + (phase - 1) * phaseDelay,
      );
    }

    const circularStartDelay =
      verticalStartDelay + maxVerticalPhase * phaseDelay;
    const circularIterations = 3;

    for (let i = 0; i < circularIterations; i++) {
      setTimeout(
        () => {
          this.circularExchange();
        },
        circularStartDelay + i * phaseDelay,
      );
    }

    const broadcastStartDelay =
      circularStartDelay + circularIterations * phaseDelay;
    setTimeout(() => {
      this.broadcast();
    }, broadcastStartDelay);
  }

  allReduceVerticalPhase(phase) {
    const isEvenCols = this.cols % 2 === 0;
    const centerCol1 = Math.floor((this.cols - 1) / 2);
    const centerCol2 = isEvenCols ? centerCol1 + 1 : centerCol1;
    const isEvenRows = this.rows % 2 === 0;
    const centerRow1 = Math.floor((this.rows - 1) / 2);
    const centerRow2 = isEvenRows ? centerRow1 + 1 : centerRow1;
    const excludeCount = phase - 1;

    for (let col = centerCol1; col <= centerCol2; col++) {
      for (let row = 0; row < this.rows; row++) {
        if (row < excludeCount || row >= this.rows - excludeCount) continue;

        const pe = this.getPE(row, col);
        pe.activate();

        if (row === centerRow1 || row === centerRow2) continue;

        let nextRow;
        if (row < centerRow1) {
          nextRow = row + 1;
        } else if (row > centerRow2) {
          nextRow = row - 1;
        } else {
          nextRow = row < centerRow2 ? centerRow1 : centerRow2;
        }

        this.sendPacket(row, col, nextRow, col, 600);
      }
    }
  }

  circularExchange() {
    const isEvenCols = this.cols % 2 === 0;
    const centerCol1 = Math.floor((this.cols - 1) / 2);
    const centerCol2 = isEvenCols ? centerCol1 + 1 : centerCol1;
    const isEvenRows = this.rows % 2 === 0;
    const centerRow1 = Math.floor((this.rows - 1) / 2);
    const centerRow2 = isEvenRows ? centerRow1 + 1 : centerRow1;

    const topLeft = this.getPE(centerRow1, centerCol1);
    const topRight = this.getPE(centerRow1, centerCol2);
    const bottomRight = this.getPE(centerRow2, centerCol2);
    const bottomLeft = this.getPE(centerRow2, centerCol1);

    if (topLeft) topLeft.activate();
    if (topRight) topRight.activate();
    if (bottomRight) bottomRight.activate();
    if (bottomLeft) bottomLeft.activate();

    this.sendPacket(centerRow1, centerCol1, centerRow2, centerCol1, 600);
    this.sendPacket(centerRow2, centerCol1, centerRow2, centerCol2, 600);
    this.sendPacket(centerRow2, centerCol2, centerRow1, centerCol2, 600);
    this.sendPacket(centerRow1, centerCol2, centerRow1, centerCol1, 600);
  }

  broadcast() {
    const isEvenCols = this.cols % 2 === 0;
    const centerCol1 = Math.floor((this.cols - 1) / 2);
    const centerCol2 = isEvenCols ? centerCol1 + 1 : centerCol1;
    const isEvenRows = this.rows % 2 === 0;
    const centerRow1 = Math.floor((this.rows - 1) / 2);
    const centerRow2 = isEvenRows ? centerRow1 + 1 : centerRow1;

    const visited = new Set();
    const queue = [];

    for (let row = centerRow1; row <= centerRow2; row++) {
      for (let col = centerCol1; col <= centerCol2; col++) {
        const pe = this.getPE(row, col);
        if (pe) {
          pe.activate();
          queue.push({ row, col, isCenter: true, isCenterCol: true });
          visited.add(`${row},${col}`);
        }
      }
    }

    const broadcastStep = (step) => {
      if (queue.length === 0) return;

      const nextQueue = [];
      const delay = 450;

      for (const item of queue) {
        const { row, col, isCenter, isCenterCol } = item;
        const pe = this.getPE(row, col);
        if (!pe) continue;

        if (isCenter || isCenterCol) {
          const up = this.getPE(row - 1, col);
          const down = this.getPE(row + 1, col);

          if (up && !visited.has(`${row - 1},${col}`)) {
            up.activate();
            this.sendPacket(row, col, row - 1, col, 600);
            visited.add(`${row - 1},${col}`);
            nextQueue.push({ row: row - 1, col, isCenterCol: true });
          }

          if (down && !visited.has(`${row + 1},${col}`)) {
            down.activate();
            this.sendPacket(row, col, row + 1, col, 600);
            visited.add(`${row + 1},${col}`);
            nextQueue.push({ row: row + 1, col, isCenterCol: true });
          }
        }

        const left = this.getPE(row, col - 1);
        const right = this.getPE(row, col + 1);

        if (left && !visited.has(`${row},${col - 1}`)) {
          left.activate();
          this.sendPacket(row, col, row, col - 1, 600);
          visited.add(`${row},${col - 1}`);
          nextQueue.push({ row, col: col - 1 });
        }

        if (right && !visited.has(`${row},${col + 1}`)) {
          right.activate();
          this.sendPacket(row, col, row, col + 1, 600);
          visited.add(`${row},${col + 1}`);
          nextQueue.push({ row, col: col + 1 });
        }
      }

      queue.length = 0;
      queue.push(...nextQueue);

      if (queue.length > 0) {
        setTimeout(() => broadcastStep(step + 1), delay);
      }
    };

    broadcastStep(0);
  }
}
