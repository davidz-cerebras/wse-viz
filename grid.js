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
    const phaseDelay = 700;

    for (let phase = 1; phase <= maxPhase; phase++) {
      setTimeout(
        () => {
          this.allReducePhase(phase);
        },
        (phase - 1) * phaseDelay,
      );
    }
  }
}
