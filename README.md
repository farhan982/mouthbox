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
npm test
```

Four suites: `pipeline.mjs` (onsets, tempo, classification, breath rejection,
with `DIAG=1` for per-hit measurements and `SWEEP=1` for threshold tuning),
`timeline.mjs` (multi-pass stitching), `drums.mjs` (the synthesised voices,
measured with the same feature extractor the classifier uses) and
`arrange.mjs` (structure recovery from a song with a known shape).

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

**Breath rejection** (`breath.js`) — a song-length take is mostly breathing,
and per-slice timbre cannot find it: a kick and an inhale can share a crest
factor. What separates them is onset strength, which the detector already
computes, plus context — one breath trips the detector several times, so a run
of weak onsets condemns the hit-like slice at its head. Tuned so that every
real hit in the test fixture survives; losing a hit you performed is a worse
failure than leaving one breath in.

**Stitching** (`timeline.js`) — you cannot beatbox for four minutes without
stopping, so a song is recorded in passes. The first sets the tempo; each one
after gets a bar of count-in and a click locked to it, and is placed on the
next bar line after the previous part ends. The breaks disappear and the
passes play back as one performance.

**Arrangement** (`arrange.js`) — a song-length take comes out as one enormous
grid, which is unusable: you cannot edit two hundred bars on a step
sequencer, and it throws away the fact that you played the same eight bars
four times. The grid is cut into blocks, blocks that are the same thing
played again are grouped, and the result is a handful of sections plus the
order they occur in — expressed as patterns and a chain, which the app
already understands.

Section length is chosen by trying 8, 4, 16 then 2 bars and taking the first
that explains the song, *not* the one that scores highest. Scoring highest is
the wrong target: the repeat ratio always rises as sections get shorter,
because shorter sections mean more blocks to find repeats among, so a pure
maximum collapses every song to the smallest candidate. A groove that loops
every bar is not a one-bar song.

Repeats are consolidated by majority vote: a step survives if most takes of
that section have it, at the average velocity of the ones that do. Playing a
part four times is what makes this pay off — a hit you fluffed once gets
voted out, a hit you meant every time survives.

Sections get a role hint (break, intro, drop) from their density relative to
the rest. This is a hint, not an understanding: the app cannot know whether a
sparse section is a breakdown or where you lost your place, so it is shown as
a suggestion and never acted on.

**Drums** (`drums.js`) — synthesised, not sampled. A sample pack would mean
licensed audio and megabytes of download in an app that otherwise ships no
assets; synthesis costs a few KB and lets each voice be tuned to the mouth
sound it sits under, so a deep mouth kick gets a deep synth kick. Blending
between your voice and the drum uses an equal-power crossfade, so the middle
of the slider does not dip. The aesthetic is a drum machine rather than an
acoustic kit, which suits an app about imitating one.

## The app

Four tabs. **Record** captures the song in as many passes as you need, shows
the detected hits on the waveform with rejected breaths dimmed, and lets you
adjust and rebuild without performing anything again. **Pads** plays and shapes each
sound (level, pitch, pan, decay, filter, reverse, choke, sample cycling) and
sets its drum layer.
**Steps** is the grid — click toggles, drag paints, clicking an active step
cycles its accent. **Song** shows the arrangement as
blocks you can reorder, repeat, duplicate and delete, blends every drum layer
at once, and exports.

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

Working and verified: analysis, multi-pass stitching, the drum voices, pads,
sequencing, persistence and export.

Verified on a real performance: a single take recorded on a phone, which is
how the iOS earpiece-routing bug and an over-eager pad merge were found.

**Not yet exercised on a real performance:** multi-pass recording, breath
rejection and the drum layer. All three are tested against synthetic audio,
which is a fair starting point and not the same thing as a person beatboxing
into a phone.

Arrangement is verified end to end from audio: a synthesised 32-bar
performance of A A B A comes back as two 8-bar sections with the chain
A×2 B×1 A×1, exports to exactly 76.8 seconds, and the B section keeps the
hats out the way it was played.

Not built: filling a deliberate pause before a drop with something that
belongs there. The honest blocker is that the app cannot tell a pause you
meant from one where you ran out of breath — the section roles are the
nearest usable approximation, and they are suggestions.
