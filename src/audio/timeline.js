/* A song built from several takes.
 *
 * You cannot beatbox for four minutes without stopping, so a song is captured
 * as a series of segments that get stitched into one continuous performance.
 *
 * The stitching is the whole point. Segments are not simply concatenated —
 * each one is placed on the next bar line after the previous segment ends, at
 * the tempo the first segment established. So the pauses where you caught
 * your breath, changed position or lost your place disappear, and what you
 * recorded in six goes plays back as one unbroken take in time with itself.
 */

const BEATS_PER_BAR = 4;

export class Timeline {
  constructor({ sampleRate = 48000, bpm = null } = {}) {
    this.sampleRate = sampleRate;
    this.bpm = bpm;          // set once the first segment has been analysed
    this.segments = [];
  }

  get barDuration() {
    return this.bpm ? (60 / this.bpm) * BEATS_PER_BAR : null;
  }

  get isEmpty() {
    return this.segments.length === 0;
  }

  get endTime() {
    if (!this.segments.length) return 0;
    const last = this.segments[this.segments.length - 1];
    return last.startTime + last.duration;
  }

  /* Where the next segment will begin: the first bar line at or after the
   * end of what is already recorded. Without a tempo yet, straight after. */
  nextStart() {
    const bar = this.barDuration;
    if (!bar || !this.segments.length) return this.endTime;
    return Math.ceil(this.endTime / bar - 1e-6) * bar;
  }

  /* How long the count-in should run so the performer lands on the bar line. */
  countInDuration() {
    return this.barDuration || 0;
  }

  add(samples, { sampleRate = this.sampleRate, trimLead = 0 } = {}) {
    let data = samples;
    if (trimLead > 0) {
      const offset = Math.min(samples.length, Math.round(trimLead * sampleRate));
      data = samples.subarray(offset);
    }

    const segment = {
      id: `seg${this.segments.length + 1}_${Date.now().toString(36)}`,
      samples: Float32Array.from(data),
      sampleRate,
      duration: data.length / sampleRate,
      startTime: this.nextStart(),
    };
    this.segments.push(segment);
    return segment;
  }

  removeLast() {
    return this.segments.pop() || null;
  }

  remove(id) {
    const index = this.segments.findIndex((s) => s.id === id);
    if (index < 0) return false;
    this.segments.splice(index, 1);
    this.relayout();
    return true;
  }

  clear() {
    this.segments = [];
  }

  /* Re-places every segment after a removal or a tempo change. */
  relayout() {
    const bar = this.barDuration;
    let cursor = 0;
    for (const segment of this.segments) {
      segment.startTime = bar ? Math.ceil(cursor / bar - 1e-6) * bar : cursor;
      cursor = segment.startTime + segment.duration;
    }
  }

  setTempo(bpm) {
    this.bpm = bpm;
    this.relayout();
  }

  /* The whole performance as one buffer, ready for analysis. */
  render() {
    if (!this.segments.length) {
      return { samples: new Float32Array(0), sampleRate: this.sampleRate, duration: 0 };
    }

    const sampleRate = this.segments[0].sampleRate;
    const total = Math.ceil(this.endTime * sampleRate) + 1;
    const out = new Float32Array(total);

    for (const segment of this.segments) {
      const offset = Math.round(segment.startTime * sampleRate);
      const data = segment.samples;
      for (let i = 0; i < data.length; i++) {
        const t = offset + i;
        // Segments can abut on a bar line; summing rather than overwriting
        // keeps a hit that lands slightly early from being clipped away.
        if (t < total) out[t] += data[i];
      }
    }

    // Stitching can push a sample over full scale where two segments touch.
    let peak = 0;
    for (const v of out) { const a = Math.abs(v); if (a > peak) peak = a; }
    if (peak > 1) for (let i = 0; i < out.length; i++) out[i] /= peak;

    return { samples: out, sampleRate, duration: total / sampleRate };
  }

  /* Plain data for IndexedDB. Float32Array survives structured clone. */
  toJSON() {
    return {
      sampleRate: this.sampleRate,
      bpm: this.bpm,
      segments: this.segments.map((s) => ({
        id: s.id,
        samples: s.samples,
        sampleRate: s.sampleRate,
        duration: s.duration,
        startTime: s.startTime,
      })),
    };
  }

  static fromJSON(data) {
    const timeline = new Timeline({ sampleRate: data.sampleRate, bpm: data.bpm });
    timeline.segments = (data.segments || []).map((s) => ({
      ...s,
      samples: s.samples instanceof Float32Array ? s.samples : Float32Array.from(s.samples),
    }));
    return timeline;
  }
}
