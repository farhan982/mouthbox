/* Capture worklet.
 *
 * MediaRecorder would be less code, but it hands back Opus, and lossy coding
 * smears exactly the transients the slicer depends on. This posts raw PCM
 * blocks straight off the audio thread instead.
 */

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.running = true;
    this.port.onmessage = (event) => {
      if (event.data === 'stop') this.running = false;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!this.running) return false;
    if (!input || !input.length) return true;

    const channel = input[0];
    if (!channel) return true;

    let peak = 0;
    for (let i = 0; i < channel.length; i++) {
      const a = Math.abs(channel[i]);
      if (a > peak) peak = a;
    }

    // Copy: the input buffer is reused by the audio thread after we return.
    this.port.postMessage({ block: new Float32Array(channel), peak });
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
