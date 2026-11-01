/* Sorting the hits of a take into pads.
 *
 * Two stages. k-means groups hits that sound alike, which is the part that
 * actually matters — whatever you did twice ends up on one pad. Then a set of
 * rules looks at each group's average timbre and gives it a name, so you get
 * "Kick" and "Hat" instead of "Cluster 1" and "Cluster 2".
 */

const DIMENSIONS = [
  { key: 'centroid', scale: (v) => Math.log2(Math.max(50, v) / 50), weight: 1.4 },
  { key: 'rolloff', scale: (v) => Math.log2(Math.max(50, v) / 50), weight: 0.8 },
  { key: 'lowRatio', scale: (v) => v, weight: 1.3 },
  { key: 'highRatio', scale: (v) => v, weight: 1.0 },
  { key: 'flatness', scale: (v) => Math.sqrt(v), weight: 0.7 },
  { key: 'zcr', scale: (v) => v, weight: 0.6 },
  { key: 'decayMs', scale: (v) => Math.log2(Math.max(10, v) / 10), weight: 0.9 },
];

function vectorise(hits) {
  const raw = hits.map((h) => DIMENSIONS.map((d) => d.scale(h.features[d.key])));

  // z-score per dimension so one wide-ranging feature can't dominate.
  const dims = DIMENSIONS.length;
  const mean = new Array(dims).fill(0);
  const sd = new Array(dims).fill(0);
  for (const v of raw) for (let d = 0; d < dims; d++) mean[d] += v[d] / raw.length;
  for (const v of raw) for (let d = 0; d < dims; d++) sd[d] += (v[d] - mean[d]) ** 2 / raw.length;
  for (let d = 0; d < dims; d++) sd[d] = Math.sqrt(sd[d]) || 1;

  return raw.map((v) => v.map((x, d) => ((x - mean[d]) / sd[d]) * DIMENSIONS[d].weight));
}

function distance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

/* k-means++ seeding, then Lloyd iterations. Deterministic: seeded from the
 * data itself so re-analysing the same take gives the same pads. */
function kmeans(vectors, k, iterations = 40) {
  const n = vectors.length;
  if (k >= n) return vectors.map((_, i) => i);

  const centroids = [vectors[0].slice()];
  while (centroids.length < k) {
    let best = -1;
    let bestDist = -Infinity;
    for (let i = 0; i < n; i++) {
      let nearest = Infinity;
      for (const c of centroids) nearest = Math.min(nearest, distance(vectors[i], c));
      if (nearest > bestDist) { bestDist = nearest; best = i; }
    }
    centroids.push(vectors[best].slice());
  }

  const assign = new Array(n).fill(0);
  for (let iter = 0; iter < iterations; iter++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = distance(vectors[i], centroids[c]);
        if (d < bestDist) { bestDist = d; best = c; }
      }
      if (assign[i] !== best) { assign[i] = best; moved = true; }
    }
    if (!moved && iter > 0) break;

    for (let c = 0; c < centroids.length; c++) {
      const members = vectors.filter((_, i) => assign[i] === c);
      if (!members.length) continue;
      for (let d = 0; d < centroids[c].length; d++) {
        centroids[c][d] = members.reduce((s, m) => s + m[d], 0) / members.length;
      }
    }
  }

  return assign;
}

/* Mean silhouette width: how well separated the clusters are, -1 to 1. */
function silhouette(vectors, assign, k) {
  const n = vectors.length;
  if (k < 2 || n <= k) return -1;

  const groups = Array.from({ length: k }, () => []);
  assign.forEach((c, i) => groups[c].push(i));
  if (groups.some((g) => g.length === 0)) return -1;

  let total = 0;
  for (let i = 0; i < n; i++) {
    const own = groups[assign[i]];
    if (own.length === 1) continue; // singleton contributes 0
    const a = own.reduce((s, j) => (j === i ? s : s + distance(vectors[i], vectors[j])), 0)
      / (own.length - 1);
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === assign[i]) continue;
      const mean = groups[c].reduce((s, j) => s + distance(vectors[i], vectors[j]), 0)
        / groups[c].length;
      b = Math.min(b, mean);
    }
    total += (b - a) / Math.max(a, b);
  }
  return total / n;
}

/* Names a group from its average timbre, in isolation. */
function nameGroup(f) {
  const bright = f.centroid > 3800 || f.highRatio > 0.33;
  const subby = f.lowRatio > 0.42 || f.centroid < 450;
  const noisy = f.flatness > 0.11 || f.zcr > 0.22;
  const short = f.decayMs < 110;
  const long = f.decayMs > 320;

  if (subby && !bright) return long ? 'Bass' : 'Kick';
  if (bright && short) return 'Hat';
  if (bright && long) return 'Open Hat';
  if (bright) return 'Cymbal';
  if (noisy && short) return 'Rim';
  if (noisy) return 'Snare';
  if (long && !noisy) return 'Tone';
  return 'Perc';
}

/* Names groups by their position within this kit, not by absolute frequency.
 *
 * Absolute thresholds cannot work here: one person's kick is another person's
 * floor tom, mic distance moves every number, and a mouth kick carries a lot
 * of high transient. What is reliable is the ordering — the darkest thing in
 * a beatbox take is the kick and the brightest is the hat — so the naming
 * works off rank, with absolute checks only as a sanity guard for kits that
 * genuinely contain no kick or no hat.
 */
function assignNames(pads) {
  const n = pads.length;
  if (n === 1) {
    pads[0].name = nameGroup(pads[0].mean);
    return;
  }

  const darkest = pads[0];
  const brightest = pads[n - 1];

  const looksLow = darkest.mean.lowRatio > 0.22 || darkest.mean.centroid < 2200;
  darkest.name = looksLow
    ? (darkest.mean.decayMs > 320 ? 'Bass' : 'Kick')
    : nameGroup(darkest.mean);

  const looksHigh = brightest.mean.highRatio > 0.28 || brightest.mean.centroid > 2600;
  brightest.name = looksHigh
    ? (brightest.mean.decayMs > 220 ? 'Open Hat' : 'Hat')
    : nameGroup(brightest.mean);

  for (let i = 1; i < n - 1; i++) {
    const f = pads[i].mean;
    if (f.highRatio > 0.55 && f.decayMs < 110) pads[i].name = 'Hat';
    else if (f.lowRatio > 0.45) pads[i].name = 'Kick';
    // "Rim" is reserved for genuine clicks; a mouth snare is short too.
    else if (f.flatness > 0.06 || f.zcr > 0.16) pads[i].name = f.decayMs < 42 ? 'Rim' : 'Snare';
    else if (f.decayMs > 320) pads[i].name = 'Tone';
    else pads[i].name = 'Perc';
  }
}

function meanFeatures(hits) {
  const keys = ['centroid', 'rolloff', 'flatness', 'zcr', 'lowRatio', 'midRatio',
    'highRatio', 'decayMs', 'durationMs'];
  const out = {};
  for (const key of keys) {
    out[key] = hits.reduce((s, h) => s + h.features[key], 0) / hits.length;
  }
  return out;
}

/* Groups hits into pads.
 *
 * Pass a number for `groups` to force a pad count, or leave it out and the
 * silhouette score picks one.
 */
export function classify(hits, { groups = 'auto', maxGroups = 8 } = {}) {
  if (!hits.length) return [];

  const vectors = vectorise(hits);
  let assign;

  if (groups === 'auto') {
    const limit = Math.min(maxGroups, hits.length);
    let best = null;
    for (let k = 2; k <= limit; k++) {
      const candidate = kmeans(vectors, k);
      const score = silhouette(vectors, candidate, k);
      // Preference for fewer pads: a beat with 3 clean sounds should not be
      // split into 6 because two kicks differed slightly. Tuned so a split
      // has to be clearly better, not marginally better, to be taken.
      const adjusted = score - (k - 2) * 0.055;
      if (!best || adjusted > best.adjusted) best = { assign: candidate, adjusted, k };
    }
    assign = best ? best.assign : new Array(hits.length).fill(0);
  } else {
    assign = kmeans(vectors, Math.max(1, Math.min(groups, hits.length)));
  }

  const count = Math.max(...assign) + 1;
  const buckets = Array.from({ length: count }, () => []);
  assign.forEach((c, i) => buckets[c].push(hits[i]));

  const pads = buckets
    .filter((b) => b.length > 0)
    .map((members) => ({ members, mean: meanFeatures(members), name: 'Perc' }));

  // Lowest/darkest sounds first — kick at the bottom left, like a drum rack.
  pads.sort((a, b) => a.mean.centroid - b.mean.centroid);

  assignNames(pads);

  // Disambiguate repeated names.
  const seen = new Map();
  for (const pad of pads) {
    const n = (seen.get(pad.name) || 0) + 1;
    seen.set(pad.name, n);
    if (n > 1) pad.name = `${pad.name} ${n}`;
  }

  return pads;
}
