# Example instruments

Sixteen SuperCollider instruments that are known to sound like what they say they
are. Each file is a complete, ordinary `.scd`: it defines one `SynthDef` and one
`~helper` function to trigger it, and it opens with a paragraph naming the single
DSP idea it is built on.

**Start here instead of from nothing.** An agent that has never heard a patch has
nothing to ground a sound in — it guesses at a bell and gets a click, or at a gong
and gets noise, because the ratios, the ring times and the level ceiling are things
you learn by hearing them. These are the reference shelf.

## How to use them

```
sc_project action=examples                    # the catalogue
sc_project action=examples file="3"           # read 03 and load it into the session
sc_exec   code="~fmBell.value(440)"           # play it
sc_capture source="SynthDef(\\exFMBell, ...)" # measure it (see below)
```

`file` takes a number, a file name, or part of a name. Every file is also readable
on its own with `sc_project action=read` and editable with `write`, so an example
is a starting point rather than a black box.

## The shelf

| # | File | The idea |
|---|---|---|
| 01 | `01-modal-gong.scd` | Inharmonic modes struck by an impulse — the beating pairs are the metal |
| 02 | `02-plucked-string.scd` | A waveguide: a delay line whose feedback is filtered, so highs die first |
| 03 | `03-fm-bell.scd` | FM whose modulation index falls fast — that fall is the bell |
| 04 | `04-plucked-karplus.scd` | Karplus–Strong, the same waveguide built from a comb filter |
| 05 | `05-drum-kick.scd` | A sine with a fast downward pitch sweep, plus a click |
| 06 | `06-drum-snare.scd` | Two tuned head modes plus band-passed noise |
| 07 | `07-drum-hat.scd` | Inharmonic square waves, high-passed, very short |
| 08 | `08-pad-drone.scd` | Detuned saws through a slow, moving resonant low-pass |
| 09 | `09-formant-voice.scd` | A source driven into three resonances — vowels are the resonances |
| 10 | `10-glass-choir.scd` | Additive: inharmonic partials, each with its own decay |
| 11 | `11-additive-organ.scd` | Additive: harmonic partials, held — drawbars are the levels |
| 12 | `12-grain-cloud.scd` | Many very short windows over a live source |
| 13 | `13-feedback-drone.scd` | A filtered delay loop, damped so it sings instead of screaming |
| 14 | `14-fm-noise-texture.scd` | Filtered noise with a moving centre — wind and water |
| 15 | `15-bitcrush.scd` | Amplitude quantisation and sample-and-hold |
| 16 | `16-theremin.scd` | A glide and a vibrato, with no attack transient at all |

`npm run check:library` compiles every one of them and asserts its shape, so a file
that stops compiling fails the build rather than quietly teaching a mistake.

## Measure before you describe

An example sounding right is still not evidence that *your* patch sounds right.
`sc_capture` plays a def, records its own output, and answers with peak, RMS,
clipping, tonality and the strongest partials:

```
sc_capture source="<the SynthDef>" params={"freq": 220} seconds=3
```

Read it as: `peak` above 0.9 is clipping (and clipped resonators are heard as
noise); `rms` near zero is silence; `tonality` says whether it is a tone or a wall;
`strongest partials` is where you check the pitch you designed against the pitch
you got.

## Credit, and why nothing here is copied

The instruments are **original files written for this package**. They implement
long-established synthesis techniques, and the influence on the selection — which
sounds are worth having on a shelf, and how to build them — is the SuperCollider
project's own example collection:

> [`supercollider/supercollider`](https://github.com/supercollider/supercollider) —
> `examples/demonstrations/`, in particular `DrumSynths.scd` (Renick Bell's SOS
> drum recipes), `Modal Space.scd`, `100 FM Synths.scd`, `Theremin.scd`,
> `single_sample_feedback.scd` and `fft.scd`.

SuperCollider is licensed **GPL-3.0-or-later**, and this package is **MIT**. That
difference is why these files were written from the techniques rather than taken
from the source: copying GPL code into an MIT package would relicense the whole
project. If you want the originals — and you should look at them, they are
excellent — they are in that repository, under their own licence.

The techniques themselves are not anyone's property: a pitch-swept sine is a kick
drum, and an inharmonic mode bank is a bell, wherever you read it.
