/* Checks that takes recorded in several passes stitch back into one
 * performance in time with itself.
 *
 *   node tests/timeline.mjs
 */

import { Timeline } from '../src/audio/timeline.js';

const SR = 48000;
let failures = 0;

function check(label, condition, detail = '') {
  if (!condition) failures++;
  console.log(`  [${condition ? 'pass' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

/* A segment of `seconds` with a marker spike at its very start, so placement
 * can be verified by finding the spikes in the rendered mix. */
function segment(seconds) {
  const data = new Float32Array(Math.round(seconds * SR));
  data[0] = 1;
  for (let i = 1; i < data.length; i++) data[i] = 0.001;
  return data;
}

const BPM = 120;
const BAR = (60 / BPM) * 4;   // 2 seconds

console.log(`Timeline at ${BPM} BPM (${BAR}s bars)\n`);

console.log('Placement');
const t = new Timeline({ sampleRate: SR });
t.add(segment(3.2));                     // first pass, free start
check('first part starts at zero', t.segments[0].startTime === 0);

t.setTempo(BPM);
check('tempo sets the bar grid', t.barDuration === BAR, `${t.barDuration}s`);

// 3.2s of audio ends mid-bar-2, so the next part belongs at bar 3 (4.0s).
check('next part lands on the next bar line', Math.abs(t.nextStart() - 4) < 1e-6,
  `${t.nextStart()}s, expected 4`);

t.add(segment(1.9));
check('second part placed on the bar line', Math.abs(t.segments[1].startTime - 4) < 1e-6,
  `${t.segments[1].startTime}s`);

t.add(segment(2.5));
check('third part skips the gap to bar 4', Math.abs(t.segments[2].startTime - 6) < 1e-6,
  `${t.segments[2].startTime}s, expected 6`);

console.log('\nCount-in');
check('count-in is one bar', Math.abs(t.countInDuration() - BAR) < 1e-6, `${t.countInDuration()}s`);

const trimmed = new Timeline({ sampleRate: SR, bpm: BPM });
trimmed.add(segment(3), { sampleRate: SR });
const lead = 0.5;
const withLead = new Float32Array(Math.round(3.5 * SR));
withLead.set(segment(3), Math.round(lead * SR));
trimmed.add(withLead, { sampleRate: SR, trimLead: lead });
check('count-in is trimmed off the front',
  Math.abs(trimmed.segments[1].duration - 3) < 0.01,
  `${trimmed.segments[1].duration.toFixed(2)}s, expected 3`);

console.log('\nRendering');
const rendered = t.render();
check('renders to the end of the last part',
  Math.abs(rendered.duration - (6 + 2.5)) < 0.01,
  `${rendered.duration.toFixed(2)}s, expected 8.5`);

// Each marker spike should sit exactly on its segment's start time.
const spikes = [];
for (let i = 0; i < rendered.samples.length; i++) {
  if (rendered.samples[i] > 0.5) spikes.push(i / SR);
}
check('every part lands where it was placed',
  spikes.length === 3
  && Math.abs(spikes[0] - 0) < 0.01
  && Math.abs(spikes[1] - 4) < 0.01
  && Math.abs(spikes[2] - 6) < 0.01,
  `spikes at ${spikes.map((s) => s.toFixed(2)).join(', ')}`);

const bars = spikes.map((s) => s / BAR);
check('every part starts on a bar line',
  bars.every((b) => Math.abs(b - Math.round(b)) < 0.01),
  `bars ${bars.map((b) => b.toFixed(2)).join(', ')}`);

console.log('\nEditing');
const removed = t.segments[1].id;
t.remove(removed);
check('removing a part closes the gap', t.segments.length === 2
  && Math.abs(t.segments[1].startTime - 4) < 1e-6,
  `second part now at ${t.segments[1].startTime}s`);
check('parts stay on bar lines after a removal',
  t.segments.every((s) => Math.abs(s.startTime / BAR - Math.round(s.startTime / BAR)) < 0.01));

console.log('\nRound trip');
const revived = Timeline.fromJSON(JSON.parse(JSON.stringify(t.toJSON(), (k, v) =>
  (v instanceof Float32Array ? Array.from(v) : v))));
check('survives being stored and reloaded',
  revived.segments.length === t.segments.length
  && Math.abs(revived.endTime - t.endTime) < 1e-6
  && revived.bpm === t.bpm,
  `${revived.segments.length} parts, ends at ${revived.endTime.toFixed(2)}s`);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
