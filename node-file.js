// File API adapter for Node.js — mimics browser File/Blob interface
// used by TraceParser.indexSegment(): file.size and file.slice(start, end).arrayBuffer()

import { openSync, readSync, statSync, closeSync } from "node:fs";

export class NodeFile {
  constructor(filePath) {
    this._fd = openSync(filePath, "r");
    this.size = statSync(filePath).size;
  }

  slice(start, end) {
    const fd = this._fd;
    return {
      arrayBuffer() {
        const len = end - start;
        const buf = Buffer.alloc(len);
        const bytesRead = readSync(fd, buf, 0, len, start);
        return Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead));
      }
    };
  }

  close() {
    closeSync(this._fd);
  }
}
