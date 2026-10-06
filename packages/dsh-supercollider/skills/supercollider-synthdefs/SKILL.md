---
name: supercollider-synthdefs
description: Write, compile, load, debug and re-use SuperCollider SynthDefs with sc_synthdef - the unit of sound design in SuperCollider. Covers Out and ReplaceOut, argument naming, envelopes and doneAction, why a def must be loaded on a specific server before /s_new works, and how to read the compiler's error rather than guessing.
whenToUse: Use whenever a sound needs to exist as a re-usable definition rather than a one-off snippet - a named instrument, a voice for a pattern, a def to be triggered many times with different controls, or anything the user wants to save and recall after a server reboot.
---

# SynthDefs

## Start from a working instrument

**Before you write a def from nothing, look at the shelf.** This package ships
sixteen instruments that are known to sound like what they say they are — a modal
gong, an FM bell, a plucked string, three drum voices, a pad, a formant voice, a
glass choir, an organ, a grain cloud, a feedback drone, a noise texture, a
bitcrusher, a theremin:

```
sc_project action=examples                # the catalogue, with what each one is
sc_project action=examples file="3"        # read 03-fm-bell and load it into the session
sc_exec   code="~fmBell.value(440)"        # play it
```

Each file is a complete `.scd` that defines one `SynthDef` and one `~helper` to
trigger it, and opens by naming the single DSP idea it is built on. Reading how
`03-fm-bell.scd` falls its modulation index is faster and far more reliable than
reasoning about FM from scratch — and every one of them is already at a level that
does not clip, which is the mistake that turns a resonator bank into noise.

Then vary it rather than replacing it: `sc_project action=read` the file, change a
ratio or a decay, `action=write` it somewhere in the workspace, and `action=send`
it. That is the edit-here / hear-it loop, and it starts from something that works.

A `SynthDef` is a compiled description of one audio process: its unit generators,
its controls, and how it ends. It is the unit of sound design in SuperCollider,
and it is what a pattern's `\instrument` names.

The lifecycle is four steps, and knowing which step failed is most of the
debugging:

```
source  ->  compiled to .scsyndef bytes  ->  sent to ONE server  ->  /s_new makes a node
   |                  |                              |                        |
 sc_check        sc_synthdef define          sc_synthdef load            sc_nodes action=new
```

A SynthDef lives **per server**. "SynthDef not found" from a `/s_new` always means
step three did not happen on *that* server — not that the def is wrong.

## The smallest useful def

Give `sc_synthdef` a name and the body — the part inside `SynthDef(\name, { ... })`:

- action: `define`
- name: `tone`
- body: `|freq = 440, amp = 0.1, gate = 1| Out.ar(0, SinOsc.ar(freq) * amp * EnvGen.kr(Env.asr(0.01, 1, 0.2), gate, doneAction: 2))`

That compiles it, caches the bytes under `$DSH_HOME/dsh-supercollider/synthdefs/`
keyed by the source's digest, and sends it to the running server. Then:

- `sc_nodes` action=`new`, name=`tone`, params `{"freq": 220}`
- `sc_nodes` action=`set`, node=`1000`, params `{"freq": 330}`
- `sc_nodes` action=`free`, node=`1000`

## Writing the body

### Arguments are the controls

```supercollider
|freq = 440, amp = 0.1, pan = 0, gate = 1|
```

- Defaults make every argument optional at `/s_new` time.
- A name in `|...|` becomes a control you can `set` while the node plays.
- `gate` is the convention for a sustained voice: an `EnvGen` with `gate` and
  `doneAction: 2` holds the sound until `gate` goes to 0, then frees its own node.

### Output

`Out.ar(bus, signal)` adds to the bus; `ReplaceOut.ar(bus, signal)` replaces what
is there. On bus 0 (the hardware output) `Out` is what you want, so several
voices mix.

```supercollider
SynthDef(\tone1, { |freq = 440, amp = 0.1| Out.ar(0, SinOsc.ar(freq) * amp) })
```

For stereo, give the signal two channels — `SinOsc.ar([freq, freq * 1.001])`, or
`Pan2.ar(sig, pan)`.

### Envelopes, and why `doneAction` matters

A synth node does not stop when its sound becomes inaudible; it stops when
something frees it. Without a `doneAction`, a percussive one-shot keeps a node
alive forever at zero amplitude.

| Intent | Envelope |
|---|---|
| A click or a hit | `EnvGen.kr(Env.perc(0.005, 0.3), doneAction: 2)` |
| A sustained voice | `EnvGen.kr(Env.asr(0.01, 1, 0.3), gate, doneAction: 2)` |
| A note of fixed length | `EnvGen.kr(Env.linen(0.01, 0.4, 0.2), doneAction: 2)` |
| A drone that never ends | No envelope — and then *you* must free it |

### A complete percussive instrument

```supercollider
SynthDef(\blip, { |freq = 440, amp = 0.2, decay = 0.25|
	var env = EnvGen.kr(Env.perc(0.004, decay), doneAction: 2);
	var sig = SinOsc.ar(freq) * env * amp;
	Out.ar(0, Pan2.ar(sig, 0));
})
```

### A complete sustained voice

```supercollider
SynthDef(\pad, { |freq = 110, amp = 0.08, gate = 1, cutoff = 900|
	var env = EnvGen.kr(Env.asr(0.4, 1, 0.8), gate, doneAction: 2);
	var sig = LFSaw.ar([freq, freq * 1.004]);
	sig = RLPF.ar(sig, cutoff, 0.4) * env * amp;
	Out.ar(0, sig);
})
```

Set `cutoff` while it plays with `sc_nodes` action=`set` — that is the point of a
sustained voice.

### A filter on a noise source

```supercollider
SynthDef(\wind, { |amp = 0.05, cutoff = 800, rq = 0.4|
	var env = EnvGen.kr(Env.asr(0.5, 1, 0.6), gate: 1, doneAction: 2);
	var sig = BPF.ar(PinkNoise.ar, cutoff, rq);
	Out.ar(0, sig * env * amp);
})
```

## Using a def from a pattern

`Pbind`'s `\instrument` is the SynthDef's name, and every other key becomes a
control:

```supercollider
Pbind(
	\instrument, \blip,
	\freq, Pseq([440, 554.4, 659.3], inf),
	\decay, 0.2,
	\dur, 0.5,
	\amp, 0.15
).play;
```

## Prove it makes the sound you meant

**A node existing is not sound.** `/s_new` is fire-and-forget: it is answered by
nothing, so `sc_nodes action=new` and `sc_synthdef action=load` both report success
even when the server threw the node away with `FAILURE IN SERVER /s_new SynthDef
not found`. An agent that stops at "the node is there" can build an instrument,
hear nothing, and report a gong. That mistake is why this section exists.

**Measure it with `sc_capture`.** It compiles the def, plays it, records the def's
own output, and reports what actually came out. Call it with the def as `source`,
the control values as `params`, and enough `seconds` to catch the strike and some of
the decay:

```supercollider
// sc_capture source="SynthDef(\\bell, { |out = 0, freq = 440, amp = 0.2| Out.ar(out, Klank.ar(`[[freq, freq * 2.7], nil, [3, 1.5]], Impulse.ar(0, 0, 0.02)) * amp * EnvGen.kr(Env.perc(0.002, 4), doneAction: 2)) })" params={"freq": 220} seconds=3
```

Read the answer as a checklist:

| Number | What it tells you | Act when |
|---|---|---|
| `peak` | Headroom. The server hard-clips at 1.0 | `peak` > 0.9: lower the output gain. Clipping a modal model is **heard as noise** |
| `rms` | Whether it is audible at all | below ~0.0005: the def is silent — check `Out.ar` and the envelope |
| `tonality` | Tonal vs broadband, from spectral flatness | `noise` on a struck or plucked model: excitation too loud or too noisy, or ring times too short |
| `strongest partials` | The frequencies that actually ring | Compare with what you designed. A model meant to ring at 62 Hz with no energy there has lost its fundamental |
| `crest` | Peak-to-RMS. A strike and a ring is 4–8 | near 1 on a percussive model: it is a wall, not a hit |

**What "sounds like noise" usually is.** Ranked by how often it was actually the
cause, not by how likely it sounds:

1. **Clipping.** Every mode of a resonator bank sums. Sixteen modes that each peak
   at 0.5 reach 8.0 together, and everything above 1.0 is squared off — which is
   broadband distortion. Fix the gain; `sc_capture` will show `peak` above 1.
2. **A hard nonlinearity on the sum.** `tanh`, `distort`, `clip` on a bank that is
   already near full scale turns a chord into noise. Weight saturation by the
   signal's own level (`x.tanh * x.abs.min(1)`) so it does nothing until it is loud.
3. **Noise layers above the resonators.** A short broadband burst is an attack; a
   loud one is the sound. Keep the exciter small — the resonators supply the gain.
4. **Excitation too small, so you only hear the top modes.** This was measured on a
   gong: an exciter of `0.006` and a steep mode-weighting left the fundamental
   absent and the output at **−55 dBFS**, a thin, quiet shimmer. `peak` and
   `partials` are what caught it.

**The level rule for a modal model.** The excitation should be small (of order
`0.01`–`0.05`) and the resonator bank is the gain stage. Set the overall level once,
on the final signal, and nothing else: a def with a gain on the exciter *and* on the
bank *and* an `amp` control is a def you cannot reason about.

## Debugging a def that will not work

**1. Compile errors.** `sc_synthdef` returns the interpreter's own text. Read it;
it names the line and the token. The usual causes:

| Message | Cause |
|---|---|
| `Variable 'x' not defined` | A name used before it is declared, or a typo. Declare with `var` at the top of the function body. |
| `ERROR: syntax error, unexpected VAR` | A `var` that is not the first statement of its own enclosing braces. Legal inside `try`, `if`, `do` and `collect` blocks — the failure usually means the text was **flattened** by something, not that the `var` was wrong. See the language skill. |
| `ERROR: Message 'ar' not understood` | A UGen name that does not exist, or a server-side UGen used in a `kr`-only context. Check the class with `sc_help`. |
| `WARNING: ... not a valid UGen input` | A number where a signal belongs (`mul` given an array, a `nil` default). |
| `SynthDef: missing Out` | The body builds no output. It has to reach `Out.ar`. |

**2. It compiled but `/s_new` says "SynthDef not found".** The def is not loaded on
that server. `sc_synthdef` action=`load`, then try again. After
`sc_server` action=`reboot`, **every** def is gone — reload before creating nodes.

**3. A def with the same name is not being replaced.** A def is loaded per server
and the engine skips a re-send when it believes the name is already resident. If you
changed the body and the sound did not change, that is the cache: give the def a new
name, or reload it explicitly. A def's name is its identity, so a new name is the
honest way to say "this is a different instrument".

**4. It plays but makes no sound.** In order of likelihood:

- `amp` is 0 or the mix is not on bus 0 — check `Out.ar(0, ...)`.
- The envelope closed immediately (`gate` defaulted to 0, or the attack is
  shorter than the call). `sc_nodes` action=`tree` shows whether the node exists.
- The node exists but is silent: set `amp` higher with `sc_nodes` action=`set`.
- The server is not running: `sc_status`.
- **You have not measured it.** Run `sc_capture`; "no sound" and "quiet sound" and
  "noise" need different fixes and the numbers tell you which one you have.

**5. It plays forever.** No `doneAction` on an envelope, or no envelope at all.
Add `doneAction: 2`, or free the node with `sc_nodes` action=`free`.

**6. The server refused the node and nobody told you.** `/s_new` has no reply. When
a node does not exist and everything reported success, read the server's own log:

```
sc_server action=diagnose
```

It prints the log tail, where each refusal appears in full: `FAILURE IN SERVER /s_new
SynthDef not found`, `/g_new Group 1 not found`, `/n_set Node not found`. That log is
the only place a fire-and-forget command reports failure, and it is where the reason
always is.

## Names and re-use

- A def name is an identifier: letters, digits and `_`, not starting with a digit.
  `\blip_2` is fine; `\2blip` is not.
- Re-defining a name replaces the def; nodes already running keep the old one
  until they end. That is usually what you want for editing an instrument live.
- `sc_synthdef` action=`list` shows what this session compiled and which defs a
  given server port has. `action=source` gives back the source of a compiled def,
  which is how you edit one you only have as bytes.
- Prefer a handful of well-argued defs over a new one per sound: `\blip` with
  `freq`, `decay` and `amp` covers most of what percussive material needs.
