/* The clock.
 *
 * setInterval is far too jittery to trigger audio directly, so it only runs a
 * scheduler: every tick it books every step falling inside the next 120 ms
 * with the audio clock, which is sample-accurate.
 */

const LOOKAHEAD = 0.12;      // seconds of audio scheduled in advance
const TICK_MS = 25;

/* Swing pushes the second 16th of each pair later. */
export function stepOffset(step, stepDuration, swing) {
  if (!swing) return 0;
  return step % 2 === 1 ? stepDuration * swing * 0.5 : 0;
}

export class Sequencer {
  constructor(ctx, engine) {
    this.ctx = ctx;
    this.engine = engine;
    this.playing = false;
    this.timer = null;

    this.bpm = 120;
    this.swing = 0;
    this.pads = [];
    this.pattern = null;

    // Song mode: a list of { patternId, repeats }.
    this.chain = null;
    this.patterns = new Map();
    this.chainIndex = 0;
    this.chainRepeat = 0;

    this.step = 0;
    this.nextStepTime = 0;
    this.scheduled = [];   // { step, time } for the playhead
    this.onEnd = null;
  }

  get stepDuration() {
    return 60 / this.bpm / 4;
  }

  configure({ bpm, swing, pads, pattern, chain, patterns }) {
    if (bpm != null) this.bpm = bpm;
    if (swing != null) this.swing = swing;
    if (pads) this.pads = pads;
    if (pattern !== undefined) this.pattern = pattern;
    if (chain !== undefined) this.chain = chain;
    if (patterns) this.patterns = patterns;
  }

  activePattern() {
    if (this.chain && this.chain.length) {
      const entry = this.chain[this.chainIndex % this.chain.length];
      return this.patterns.get(entry.patternId) || null;
    }
    return this.pattern;
  }

  start() {
    if (this.playing) return;
    this.playing = true;
    this.step = 0;
    this.chainIndex = 0;
    this.chainRepeat = 0;
    this.nextStepTime = this.ctx.currentTime + 0.06;
    this.scheduled = [];
    this.timer = setInterval(() => this.schedule(), TICK_MS);
    this.schedule();
  }

  stop() {
    this.playing = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.scheduled = [];
  }

  schedule() {
    if (!this.playing) return;
    const horizon = this.ctx.currentTime + LOOKAHEAD;

    while (this.nextStepTime < horizon) {
      const pattern = this.activePattern();
      if (!pattern) { this.stop(); return; }

      const duration = this.stepDuration;
      const time = this.nextStepTime + stepOffset(this.step, duration, this.swing);

      pattern.steps.forEach((lane, padIndex) => {
        const cell = lane[this.step];
        if (!cell) return;
        const pad = this.pads[padIndex];
        if (!pad) return;
        this.engine.trigger(pad, time, cell.velocity, cell.sampleId || null);
      });

      this.scheduled.push({ step: this.step, time, pattern: pattern.id });

      this.nextStepTime += duration;
      this.step++;

      if (this.step >= pattern.length) {
        this.step = 0;
        if (this.chain && this.chain.length) {
          const entry = this.chain[this.chainIndex % this.chain.length];
          this.chainRepeat++;
          if (this.chainRepeat >= (entry.repeats || 1)) {
            this.chainRepeat = 0;
            this.chainIndex++;
            if (this.chainIndex >= this.chain.length) {
              this.chainIndex = 0;
              if (this.onEnd && this.onEnd() === 'stop') { this.stop(); return; }
            }
          }
        }
      }
    }
  }

  /* What the playhead should be showing right now. Called from rAF. */
  currentStep() {
    const now = this.ctx.currentTime;
    let current = null;
    while (this.scheduled.length && this.scheduled[0].time <= now) {
      current = this.scheduled.shift();
    }
    return current;
  }
}

/* Flattens a song into a finite list of events, for offline rendering. */
export function collectEvents({ pads, patterns, chain, pattern, bpm, swing, repeats = 1 }) {
  const stepDuration = 60 / bpm / 4;
  const events = [];
  let cursor = 0;

  const sequence = [];
  if (chain && chain.length) {
    for (let r = 0; r < repeats; r++) {
      for (const entry of chain) {
        for (let i = 0; i < (entry.repeats || 1); i++) {
          const found = patterns.get(entry.patternId);
          if (found) sequence.push(found);
        }
      }
    }
  } else if (pattern) {
    for (let r = 0; r < repeats; r++) sequence.push(pattern);
  }

  for (const pat of sequence) {
    for (let step = 0; step < pat.length; step++) {
      const time = cursor + step * stepDuration + stepOffset(step, stepDuration, swing);
      pat.steps.forEach((lane, padIndex) => {
        const cell = lane[step];
        if (!cell) return;
        const pad = pads[padIndex];
        if (!pad) return;
        events.push({ pad, time, velocity: cell.velocity, sampleId: cell.sampleId || null });
      });
    }
    cursor += pat.length * stepDuration;
  }

  return { events, duration: cursor };
}
