# Mouthbox

Beatbox a phrase. Get back a playable kit and the pattern you just performed,
sitting on a grid, ready to rearrange.

The premise: a beatboxer performs a *phrase*, with the groove already in it.
Sampler apps make you record a blob of audio and then drag slice markers
around by hand. Mouthbox takes the whole take and does that work — finds every
hit, sorts them onto pads by how they sound, reads the tempo out of your own
timing, and hands you a sequence. The sequencer is the tool; the capture is the
reason to use it.

## Running it

```bash
python3 serve.py 8940
```

Then open <http://localhost:8940>. It needs to be served over HTTP (or HTTPS) —
ES modules and `getUserMedia` do not work from `file://`. It is a static site
with no build step and no dependencies.

```bash
npm test     # or: node tests/pipeline.mjs
```

## How the analysis works

The whole pipeline lives in `src/audio/` and is pure — no DOM, no Web Audio —
so it runs under node and has a real test.

**Onsets** (`onsets.js`) — spectral flux over a 1024/256 STFT rather than plain
energy. A hat landing in the tail of a kick barely moves the envelope but shows
up clearly as new high-frequency content, and beatboxers do that constantly.
Peak-picked against an adaptive local-median threshold; the sensitivity slider
rides that threshold.

**Slicing** (`slice.js`) — each hit is cut from its onset to where its own RMS
falls ~30 dB, capped at the next onset. Slices are normalised so pads sound
even, but the original peak is kept, which is how the derived pattern recovers
the dynamics that were performed instead of flattening everything.

**Classification** (`classify.js`) — seven timbre features (centroid, rolloff,
flatness, ZCR, low/high energy ratios, decay time), z-scored and weighted, then
k-means with k chosen by silhouette score. Naming is *relative*, not absolute:
the darkest cluster in a take is the kick and the brightest is the hat.
Absolute Hz thresholds cannot work here — one person's kick is another's floor
tom, mic distance moves every number, and a mouth kick carries a lot of high
transient.

**Tempo** (`tempo.js`) — a comb filter swept across 60–200 BPM over the onset
envelope, scoring how much onset energy lands on each candidate's beats, with
the best phase giving the downbeat. Weighted toward 124 BPM, because the
classic failure mode is the octave error: 75 and 150 score nearly identically.
Hits are then quantised onto a 16th grid and rounded up to whole bars.

## The app

Four tabs. **Record** captures a take, shows you the detected hits on the
waveform, and lets you adjust before committing. **Pads** plays and shapes each
sound (level, pitch, pan, decay, filter, reverse, choke, sample cycling).
**Steps** is the grid — click toggles, drag paints, clicking an active step
cycles its accent. **Song** chains patterns and exports.

Export renders through the same engine you are hearing, inside an
`OfflineAudioContext`, so the WAV matches the preview.

## Notes

- Audio is captured as raw PCM through an `AudioWorklet`, not `MediaRecorder` —
  Opus smears exactly the transients the slicer depends on.
- `echoCancellation`, `noiseSuppression` and `autoGainControl` are all disabled.
  They are tuned for speech and will duck plosives and gate ghost notes.
- Kits persist to IndexedDB, not localStorage: a few seconds of 48 kHz audio is
  already past the 5 MB localStorage ceiling.
- iOS Safari will not start audio without a tap, and its latency is mediocre.
  Fine for building; a native app would be better for tight live pad playing.

## Status

Everything above works and is verified end to end, except one thing that cannot
be tested without a microphone and a person: **the capture path has only been
exercised with synthetic takes.** The DSP is tested against a synthesised
two-bar pattern at a known tempo (`tests/pipeline.mjs`), and the UI, playback,
persistence and export were driven with that same synthetic audio. Recording an
actual beatbox take is the first thing to try.
