/* The take, drawn, with a marker on every detected hit.
 *
 * This exists for trust: the sensitivity slider is meaningless unless you can
 * see what it is doing to your beat.
 */

import { el } from './ui.js';
import { padColor } from './colors.js';

const HEIGHT = 120;

function peaks(samples, buckets) {
  const size = Math.max(1, Math.floor(samples.length / buckets));
  const out = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    const start = b * size;
    const end = Math.min(samples.length, start + size);
    let peak = 0;
    for (let i = start; i < end; i++) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
    }
    out[b] = peak;
  }
  return out;
}

/* `assignments` maps each onset to the pad index it ended up on, so markers
 * are coloured like the pads they produced. */
export function drawWaveform(canvas, { samples, sampleRate, onsetTimes = [], assignments = [] }) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 600;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(HEIGHT * ratio);

  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, HEIGHT);

  const mid = HEIGHT / 2;
  const duration = samples.length / sampleRate;

  const data = peaks(samples, Math.max(1, Math.floor(width)));
  let loudest = 0;
  for (const v of data) if (v > loudest) loudest = v;
  const scale = loudest > 0 ? (mid - 8) / loudest : 0;

  ctx.strokeStyle = 'rgba(255,255,255,0.32)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < data.length; x++) {
    const h = data[x] * scale;
    ctx.moveTo(x + 0.5, mid - h);
    ctx.lineTo(x + 0.5, mid + h);
  }
  ctx.stroke();

  onsetTimes.forEach((time, i) => {
    const x = duration > 0 ? (time / duration) * width : 0;
    const color = assignments[i] != null ? padColor(assignments[i]) : '#ffffff';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 4);
    ctx.lineTo(x, HEIGHT - 4);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, 6, 3, 0, Math.PI * 2);
    ctx.fill();
  });
}

export function waveformCanvas() {
  return el('canvas', { class: 'waveform', height: HEIGHT });
}

/* A live input meter while recording. */
export function levelMeter() {
  const bar = el('div', { class: 'meter-fill' });
  const node = el('div', { class: 'meter' }, [bar]);
  let peakHold = 0;
  return {
    node,
    update(level) {
      peakHold = Math.max(level, peakHold * 0.92);
      const pct = Math.min(100, Math.round(peakHold * 140));
      bar.style.width = `${pct}%`;
      bar.classList.toggle('meter-hot', peakHold > 0.92);
    },
    reset() {
      peakHold = 0;
      bar.style.width = '0%';
    },
  };
}
