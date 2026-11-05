/* Checks the synthesised drum voices.
 *
 * Measured with the same feature extractor the classifier uses on real
 * recordings, so the assertions are about what the sounds actually are, not
 * about the code paths that made them.
 *
 *   node tests/drums.mjs
 */

import { renderDrum, suggestDrum, blendGains, DRUM_TYPES } from '../src/audio/drums.js';
import { features } from '../src/audio/slice.js';

const SR = 48000;
let failures = 0;

function check(label, condition, detail = '') {
  if (!condition) failures++;
  console.log(`  [${condition ? 'pass' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

const voices = ['kick', 'snare', 'clap', 'hat', 'openhat', 'rim', 'tom', 'cymbal'];
const measured = {};

console.log('Rendering\n');
for (const type of voices) {
  const buffer = renderDrum(type, {}, SR);
  measured[type] = { buffer, f: features(buffer, SR) };
}

console.log('  voice     centroid   low   high  decay  dur');
for (const type of voices) {
  const { buffer, f } = measured[type];
  console.log(`  ${type.padEnd(9)} ${Math.round(f.centroid).toString().padStart(6)}  `
    + `${f.lowRatio.toFixed(2)}  ${f.highRatio.toFixed(2)}  `
    + `${Math.round(f.decayMs).toString().padStart(4)}ms  ${Math.round(buffer.length / SR * 1000)}ms`);
}

console.log('\nEvery voice makes a sound');
for (const type of voices) {
  const { buffer } = measured[type];
  let peak = 0;
  for (const v of buffer) peak = Math.max(peak, Math.abs(v));
  check(`${type} is audible and normalised`, peak > 0.8 && peak <= 0.9, `peak ${peak.toFixed(2)}`);
}

console.log('\nThey sound like what they claim to be');
const c = (t) => measured[t].f.centroid;
check('kick is the darkest', c('kick') === Math.min(...voices.map(c)),
  `kick ${Math.round(c('kick'))} Hz`);
check('kick is mostly low end', measured.kick.f.lowRatio > 0.5,
  `lowRatio ${measured.kick.f.lowRatio.toFixed(2)}`);
check('hat is bright', measured.hat.f.highRatio > 0.5,
  `highRatio ${measured.hat.f.highRatio.toFixed(2)}`);
check('snare sits between kick and hat', c('snare') > c('kick') && c('snare') < c('hat'),
  `${Math.round(c('kick'))} < ${Math.round(c('snare'))} < ${Math.round(c('hat'))} Hz`);
check('clap sits in the mids like a snare',
  Math.abs(c('clap') - c('snare')) < c('hat') * 0.5,
  `clap ${Math.round(c('clap'))} Hz vs snare ${Math.round(c('snare'))} Hz`);
check('open hat rings longer than closed',
  measured.openhat.buffer.length > measured.hat.buffer.length * 2,
  `${Math.round(measured.openhat.buffer.length / SR * 1000)}ms vs ${Math.round(measured.hat.buffer.length / SR * 1000)}ms`);
check('rim is the shortest', measured.rim.buffer.length === Math.min(...voices.map((t) => measured[t].buffer.length)),
  `${Math.round(measured.rim.buffer.length / SR * 1000)}ms`);
check('cymbal is the longest', measured.cymbal.buffer.length === Math.max(...voices.map((t) => measured[t].buffer.length)),
  `${Math.round(measured.cymbal.buffer.length / SR * 1000)}ms`);
check('tom is pitched, not noisy', measured.tom.f.flatness < measured.snare.f.flatness,
  `tom ${measured.tom.f.flatness.toFixed(3)} vs snare ${measured.snare.f.flatness.toFixed(3)}`);

console.log('\nTuning follows the parameters');
const low = features(renderDrum('kick', { tune: 40 }, SR), SR);
const high = features(renderDrum('kick', { tune: 70 }, SR), SR);
check('a higher tune makes a brighter kick', high.centroid > low.centroid,
  `${Math.round(low.centroid)} Hz at tune 40, ${Math.round(high.centroid)} Hz at tune 70`);

const shortHat = renderDrum('hat', { decay: 0.03 }, SR);
const longHat = renderDrum('hat', { decay: 0.12 }, SR);
check('decay changes the length', longHat.length > shortHat.length * 2,
  `${Math.round(shortHat.length / SR * 1000)}ms vs ${Math.round(longHat.length / SR * 1000)}ms`);

console.log('\nPad names map to voices');
const cases = [
  ['Kick', 'kick'], ['Bass', 'kick'], ['Snare', 'snare'], ['Hat', 'hat'],
  ['Open Hat', 'openhat'], ['Cymbal', 'cymbal'], ['Rim', 'rim'], ['Clap', 'clap'],
];
for (const [name, expected] of cases) {
  const got = suggestDrum(name, { centroid: 2000, decayMs: 100 });
  check(`${name} maps to ${expected}`, got.type === expected, `got ${got.type}`);
}
check('a deep mouth kick suggests a deep synth kick',
  suggestDrum('Kick', { centroid: 400, decayMs: 120 }).tune
  < suggestDrum('Kick', { centroid: 2500, decayMs: 120 }).tune,
  `${suggestDrum('Kick', { centroid: 400 }).tune.toFixed(0)} Hz vs ${suggestDrum('Kick', { centroid: 2500 }).tune.toFixed(0)} Hz`);
check('an unknown dark pad still gets something sensible',
  suggestDrum('Perc 2', { centroid: 300, decayMs: 100 }).type === 'kick');

console.log('\nBlending');
for (const b of [0, 0.25, 0.5, 0.75, 1]) {
  const g = blendGains(b);
  const power = g.sample ** 2 + g.drum ** 2;
  check(`blend ${b} holds its level`, Math.abs(power - 1) < 1e-6, `power ${power.toFixed(4)}`);
}
check('blend 0 is all you', blendGains(0).drum < 1e-9);
check('blend 1 is all drum', blendGains(1).sample < 1e-9);

console.log('\nCaching');
check('the same parameters return the same buffer',
  renderDrum('kick', { tune: 50 }, SR) === renderDrum('kick', { tune: 50 }, SR));
check('different parameters do not collide',
  renderDrum('kick', { tune: 50 }, SR) !== renderDrum('kick', { tune: 60 }, SR));
check('"none" renders nothing', renderDrum('none', {}, SR) === null);
check('every listed type can render',
  DRUM_TYPES.filter((t) => t.id !== 'none').every((t) => renderDrum(t.id, {}, SR)?.length > 0));

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
