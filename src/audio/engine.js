/* Sample playback.
 *
 * One voice per triggered step: source -> envelope -> filter -> pan -> pad
 * gain -> master. Voices are disposable; pad nodes persist so parameter
 * changes are heard immediately without rebuilding anything.
 */

import { renderDrum, blendGains } from './drums.js';

/* Audio buffers live here rather than on the pad objects, so app state stays
 * plain serialisable data. */
export class SampleBank {
  constructor(ctx) {
    this.ctx = ctx;
    this.buffers = new Map();   // id -> AudioBuffer
    this.reversed = new Map();  // id -> AudioBuffer
    this.nextId = 1;
  }

  add(samples, sampleRate) {
    const id = `s${this.nextId++}`;
    const buffer = this.ctx.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    this.buffers.set(id, buffer);
    return id;
  }

  get(id, reverse = false) {
    if (!reverse) return this.buffers.get(id) || null;

    let flipped = this.reversed.get(id);
    if (!flipped) {
      const source = this.buffers.get(id);
      if (!source) return null;
      flipped = this.ctx.createBuffer(1, source.length, source.sampleRate);
      const from = source.getChannelData(0);
      const to = flipped.getChannelData(0);
      for (let i = 0; i < from.length; i++) to[i] = from[from.length - 1 - i];
      this.reversed.set(id, flipped);
    }
    return flipped;
  }

  /* Moves every sample into a new context.
   *
   * Needed when the context is rebuilt to get iOS out of record routing.
   * Buffers are copied rather than reused: an AudioBuffer from a closed
   * context is legal to play, but the new context may be running at a
   * different sample rate and copying keeps each buffer's own rate intact.
   */
  rehome(ctx) {
    const moved = new Map();
    for (const [id, buffer] of this.buffers) {
      const next = ctx.createBuffer(1, buffer.length, buffer.sampleRate);
      next.copyToChannel(buffer.getChannelData(0), 0);
      moved.set(id, next);
    }
    this.ctx = ctx;
    this.buffers = moved;
    this.reversed.clear(); // regenerated on demand, in the new context
  }

  peaks(id, buckets = 48) {
    const buffer = this.buffers.get(id);
    if (!buffer) return [];
    const data = buffer.getChannelData(0);
    const size = Math.max(1, Math.floor(data.length / buckets));
    const out = [];
    for (let b = 0; b < buckets; b++) {
      let peak = 0;
      const start = b * size;
      const end = Math.min(data.length, start + size);
      for (let i = start; i < end; i++) {
        const a = Math.abs(data[i]);
        if (a > peak) peak = a;
      }
      out.push(peak);
    }
    return out;
  }
}

export function defaultPad(id, name, sampleIds) {
  return {
    id,
    name,
    sampleIds,
    // A synthesised drum sitting under the recorded sound. The type is
    // chosen when the kit is built, but blend starts at zero so the kit
    // sounds exactly like the performance until it is deliberately turned up.
    drum: { type: 'none', blend: 0 },
    tone: {},        // measured timbre, used to tune the drum layer
    gain: 0.85,
    pitch: 0,        // semitones
    pan: 0,          // -1 .. 1
    filterType: 'none',
    cutoff: 12000,
    resonance: 0.6,
    attack: 0.001,   // seconds
    decay: 0,        // 0 = play the sample out in full
    reverse: false,
    roundRobin: true,
    mute: false,
    solo: false,
    choke: 0,        // 0 = no choke group
  };
}

export class Engine {
  constructor(ctx, bank) {
    this.ctx = ctx;
    this.bank = bank;
    this.drumCache = new Map();
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;

    // A gentle limiter: beatbox samples stacked on a grid clip easily.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 3;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;

    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    this.padNodes = new Map();
    this.rotation = new Map();
    this.chokeVoices = new Map();
  }

  /* Builds (or returns) the persistent gain+pan nodes for a pad. */
  nodesFor(pad) {
    let nodes = this.padNodes.get(pad.id);
    if (!nodes) {
      const gain = this.ctx.createGain();
      const panner = this.ctx.createStereoPanner
        ? this.ctx.createStereoPanner()
        : null;
      if (panner) {
        gain.connect(panner);
        panner.connect(this.master);
      } else {
        gain.connect(this.master);
      }
      nodes = { gain, panner };
      this.padNodes.set(pad.id, nodes);
    }
    nodes.gain.gain.value = pad.mute ? 0 : pad.gain;
    if (nodes.panner) nodes.panner.pan.value = pad.pan;
    return nodes;
  }

  sync(pads) {
    const anySolo = pads.some((p) => p.solo);
    for (const pad of pads) {
      const nodes = this.nodesFor(pad);
      const audible = !pad.mute && (!anySolo || pad.solo);
      nodes.gain.gain.value = audible ? pad.gain : 0;
      if (nodes.panner) nodes.panner.pan.value = pad.pan;
    }
    for (const id of [...this.padNodes.keys()]) {
      if (!pads.some((p) => p.id === id)) {
        const nodes = this.padNodes.get(id);
        try { nodes.gain.disconnect(); } catch { /* already gone */ }
        this.padNodes.delete(id);
      }
    }
  }

  pickSample(pad) {
    if (!pad.sampleIds.length) return null;
    if (!pad.roundRobin || pad.sampleIds.length === 1) return pad.sampleIds[0];
    const next = ((this.rotation.get(pad.id) || 0) + 1) % pad.sampleIds.length;
    this.rotation.set(pad.id, next);
    return pad.sampleIds[next];
  }

  /* The synthesised drum layer for a pad, as an AudioBuffer in this context.
   * Cached: a pad retriggers constantly and the synthesis is deterministic. */
  drumBuffer(pad) {
    const drum = pad.drum;
    if (!drum || !drum.type || drum.type === 'none') return null;

    const { type, blend, ...params } = drum;
    const key = `${type}|${pad.reverse ? 'r' : 'f'}|${JSON.stringify(params)}`;
    let buffer = this.drumCache.get(key);
    if (buffer !== undefined) return buffer;

    // Dragging a parameter slider mints a buffer per step, so the cache is
    // bounded. These are cheap to regenerate.
    if (this.drumCache.size > 64) this.drumCache.clear();

    const data = renderDrum(type, params, this.ctx.sampleRate);
    if (!data) {
      this.drumCache.set(key, null);
      return null;
    }

    buffer = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
    if (pad.reverse) {
      const flipped = new Float32Array(data.length);
      for (let i = 0; i < data.length; i++) flipped[i] = data[data.length - 1 - i];
      buffer.copyToChannel(flipped, 0);
    } else {
      buffer.copyToChannel(data, 0);
    }
    this.drumCache.set(key, buffer);
    return buffer;
  }

  /* Triggers one hit.
   *
   * Two layers can sound: the recorded mouth sound and a synthesised drum
   * under it, mixed with an equal-power crossfade so sliding between them
   * does not dip in the middle. Both run through the same pad chain, so
   * level, pan, filter and envelope apply to the pair.
   */
  trigger(pad, when = this.ctx.currentTime, velocity = 1, sampleId = null) {
    const gains = blendGains(pad.drum?.blend ?? 0);
    const drum = gains.drum > 0.0001 ? this.drumBuffer(pad) : null;

    const voices = [];
    if (drum) voices.push(this.playLayer(pad, drum, when, velocity * gains.drum));

    // Fully crossfaded onto the drum: skip the recording entirely rather
    // than spending a voice on silence.
    if (gains.sample > 0.0001) {
      const id = sampleId || this.pickSample(pad);
      const buffer = id ? this.bank.get(id, pad.reverse) : null;
      if (buffer) voices.push(this.playLayer(pad, buffer, when, velocity * gains.sample));
    }

    if (!voices.length) return null;

    // Choking applies to the whole hit, both layers together. Doing it
    // per-layer would have the sample layer cut off the drum layer of the
    // very same hit.
    if (pad.choke > 0) {
      const previous = this.chokeVoices.get(pad.choke);
      if (previous) {
        for (const voice of previous) {
          if (voices.includes(voice)) continue;
          try {
            voice.env.gain.cancelScheduledValues(when);
            voice.env.gain.setTargetAtTime(0, when, 0.004);
            voice.source.stop(when + 0.05);
          } catch { /* already stopped */ }
        }
      }
      this.chokeVoices.set(pad.choke, voices);
    }

    return voices[voices.length - 1].source;
  }

  /* One voice: source -> envelope -> filter -> pad chain. */
  playLayer(pad, buffer, when, velocity) {
    const nodes = this.nodesFor(pad);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = 2 ** (pad.pitch / 12);

    const env = this.ctx.createGain();
    const attack = Math.max(0.0005, pad.attack);
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(velocity, when + attack);

    const playLength = buffer.duration / source.playbackRate.value;
    let stopAt = when + playLength;

    if (pad.decay > 0) {
      const end = when + attack + pad.decay;
      env.gain.setTargetAtTime(0, when + attack, Math.max(0.005, pad.decay / 4));
      stopAt = Math.min(stopAt, end + 0.05);
    }

    let tail = env;
    if (pad.filterType !== 'none') {
      const filter = this.ctx.createBiquadFilter();
      filter.type = pad.filterType;
      filter.frequency.value = pad.cutoff;
      filter.Q.value = pad.resonance;
      env.connect(filter);
      tail = filter;
    }

    source.connect(env);
    tail.connect(nodes.gain);
    source.start(when);
    source.stop(stopAt);

    source.onended = () => {
      try { source.disconnect(); env.disconnect(); } catch { /* fine */ }
    };

    return { source, env };
  }

  setMasterGain(value) {
    this.master.gain.value = value;
  }
}
