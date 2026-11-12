/**
 * Cuts streamed text before the first stop sequence. A tail that could still turn into a stop
 * sequence is held back until the next chunk (or `flush`) decides it.
 */
export class StopSequenceFilter {
  private held = "";
  private hit = false;

  constructor(private readonly stops: string[]) {}

  /** True once a stop sequence was seen; everything after it is dropped. */
  get stopped(): boolean {
    return this.hit;
  }

  /** Returns the part of `text` that is safe to show now. */
  push(text: string): string {
    if (this.hit) return "";
    const buf = this.held + text;

    let cut = -1;
    for (const stop of this.stops) {
      const i = buf.indexOf(stop);
      if (i !== -1 && (cut === -1 || i < cut)) cut = i;
    }
    if (cut !== -1) {
      this.hit = true;
      this.held = "";
      return buf.slice(0, cut);
    }

    const hold = this.partialStopLength(buf);
    this.held = buf.slice(buf.length - hold);
    return buf.slice(0, buf.length - hold);
  }

  /** The held-back tail, once no more text will come. */
  flush(): string {
    const rest = this.hit ? "" : this.held;
    this.held = "";
    return rest;
  }

  /** Length of the longest suffix of `buf` that is a proper prefix of some stop sequence. */
  private partialStopLength(buf: string): number {
    let best = 0;
    for (const stop of this.stops) {
      for (let len = Math.min(buf.length, stop.length - 1); len > best; len--) {
        if (buf.endsWith(stop.slice(0, len))) {
          best = len;
          break;
        }
      }
    }
    return best;
  }
}
