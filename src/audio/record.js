/* Microphone capture.
 *
 * Browsers will not start an AudioContext without a gesture, so everything
 * here assumes it is called from a click handler.
 */

const WORKLET_URL = new URL('./recorder-worklet.js', import.meta.url);

let context = null;
let workletReady = false;

export function audioContext() {
  if (!context) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    context = new Ctor({ latencyHint: 'interactive' });
  }
  return context;
}

export async function resume() {
  const ctx = audioContext();
  if (ctx.state !== 'running') await ctx.resume();
  return ctx;
}

/* Echo cancellation and noise suppression are tuned for speech and will chew
 * through beatboxing — they duck plosives and gate the quiet ghost notes. */
const CONSTRAINTS = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  },
};

export class Recorder {
  constructor({ onLevel } = {}) {
    this.onLevel = onLevel;
    this.blocks = [];
    this.stream = null;
    this.node = null;
    this.source = null;
    this.recording = false;
    this.startedAt = 0;
  }

  async start() {
    const ctx = await resume();

    if (!workletReady) {
      await ctx.audioWorklet.addModule(WORKLET_URL);
      workletReady = true;
    }

    this.stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
    this.source = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, 'capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });

    this.blocks = [];
    this.node.port.onmessage = (event) => {
      const { block, peak } = event.data;
      if (!this.recording) return;
      this.blocks.push(block);
      if (this.onLevel) this.onLevel(peak);
    };

    this.source.connect(this.node);
    this.recording = true;
    this.startedAt = ctx.currentTime;
  }

  /* Returns { samples, sampleRate, duration } for the whole take. */
  stop() {
    this.recording = false;
    if (this.node) {
      this.node.port.postMessage('stop');
      try { this.source.disconnect(this.node); } catch { /* already gone */ }
      this.node = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.source = null;

    const total = this.blocks.reduce((sum, b) => sum + b.length, 0);
    const samples = new Float32Array(total);
    let offset = 0;
    for (const block of this.blocks) {
      samples.set(block, offset);
      offset += block.length;
    }
    this.blocks = [];

    const sampleRate = audioContext().sampleRate;
    return { samples, sampleRate, duration: total / sampleRate };
  }

  get elapsed() {
    if (!this.recording) return 0;
    return audioContext().currentTime - this.startedAt;
  }
}

export async function micPermissionState() {
  if (!navigator.permissions?.query) return 'unknown';
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    return status.state;
  } catch {
    return 'unknown';
  }
}
