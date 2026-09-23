'use strict';

/**
 * FIFO буфер s16le PCM. Программа эфира кладёт сюда декодированное,
 * микшер забирает строго по CHUNK_BYTES за тик.
 */
class PcmFifo {
  constructor() {
    this.parts = [];
    this.length = 0;
  }

  push(buf) {
    if (!buf || !buf.length) return;
    this.parts.push(buf);
    this.length += buf.length;
  }

  /** Вернёт Buffer длиной ровно n или null, если данных мало. */
  readExact(n) {
    if (this.length < n) return null;
    if (this.parts[0].length === n) {
      this.length -= n;
      return this.parts.shift();
    }
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const head = this.parts[0];
      const take = Math.min(head.length, n - filled);
      head.copy(out, filled, 0, take);
      if (take === head.length) this.parts.shift();
      else this.parts[0] = head.subarray(take);
      filled += take;
    }
    this.length -= n;
    return out;
  }

  drain(n) {
    // выкинуть до n байт (сброс хвоста источника)
    let dropped = 0;
    while (this.parts.length && dropped < n) {
      const head = this.parts.shift();
      dropped += head.length;
    }
    this.length = Math.max(0, this.length - dropped);
    return dropped;
  }

  clear() {
    this.parts = [];
    this.length = 0;
  }
}

module.exports = { PcmFifo };
