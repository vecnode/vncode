---
name: supercollider-live-coding
description: Build a SuperCollider piece up while it plays - start a sound, change it in place, layer it, and stop it cleanly - using the dsh-supercollider tools (sc_exec, sc_nodes, sc_play, sc_stop-via-sc_exec) and the idioms that make a session survive (Ndef, ProxySpace, Pbind, ~variables, s.freeAll).
whenToUse: Use when asked to make, play, improvise, accompany or live-code music or sound, when a piece should keep changing after it starts, when the user says "make a drone", "play something", "add a beat", "make it darker", "change the pitch while it runs" - and whenever more than one sound must exist at the same time.
---

# Live coding SuperCollider

## A shelf to start from

This package ships sixteen playable instruments — a modal gong, an FM bell, a
plucked string, three drum voices, a pad, a formant voice, a glass choir, an organ,
a grain cloud, a feedback drone, a noise texture, a bitcrusher, a theremin. They are
the fastest way to a piece that already sounds like something:

```
sc_project action=examples            # the catalogue
sc_project action=examples file="1"    # loads 01-modal-gong into the live session
sc_exec   code="~gong.value(62)"       # strike it
sc_exec   code="~gong.value(98)"       # and again, higher
```

Every file defines one `SynthDef` plus a `~helper`, so it slots straight into the
build-it-up workflow below: trigger the helper, layer a second one, then change the
running sound with `sc_nodes` action=set. Start there and edit, rather than
inventing an instrument when the user asks for "a bell" or "something that sounds
like water".

The point of a live session is that **the sound keeps playing while you change
it**. A SuperCollider session driven by `sc_exec` keeps its interpreter alive
between calls, so everything you define stays defined: a `~variable`, an `Ndef`,
a `Pbind` that is running. You build a piece by *adding* to it, not by
re-creating it.

Two rules decide whether a session is workable or a mess:

1. **Give every long-lived sound a name.** `Ndef(\drone, {...})` is a thing you
   can change later. `{ ... }.play` is a thing you can only stop by finding its
   node id.
2. **You are responsible for stopping.** Nothing cleans up after you. A drone
   left running is a drone the user has to kill.

## The three ways to make a sound

| What | Code | When |
|---|---|---|
| One-shot synth | `{ SinOsc.ar(440, 0, 0.2) }.play` | A click, a blip, a test. It plays until it is freed, so give it an envelope or a `doneAction`. |
| A named node you will change | `Ndef(\drone, { LFTri.ar(55) * 0.1 }).play` | Anything that should keep going and be edited. This is the main tool. |
| A pattern that schedules notes | `Pbind(...).play` | Rhythmic material: notes, events, sequences. |

### Start a drone and keep it editable

```supercollider
Ndef(\drone, { |freq = 55, amp = 0.12| LFTri.ar(freq) * amp }).play;
```

Change it while it sounds — no gap, no restart:

```supercollider
Ndef(\drone).set(\freq, 41.2);
Ndef(\drone).set(\amp, 0.06);
```

Change the *definition* while it sounds (the sound is replaced, not stopped and
restarted):

```supercollider
Ndef(\drone, { |freq = 41.2, amp = 0.08| LFSaw.ar([freq, freq * 1.005]) * amp * 0.5 });
```

### Layer a second voice under it

```supercollider
Ndef(\air, { |amp = 0.03| HPF.ar(PinkNoise.ar(amp), 1200) * LFTri.kr(0.07).range(0.2, 1) }).play;
```

### Add rhythmic material with a pattern

```supercollider
Pdef(\pulse,
	Pbind(
		\instrument, \default,
		\freq, Pseq([220, 330, 440, 330], inf),
		\dur, 0.25,
		\amp, 0.08
	)
).play;
```

`Pdef` names the pattern the same way `Ndef` names a synth, which is what makes
it stoppable with `Pdef(\pulse).stop` and re-definable without touching anything
else.

## Changing things in place

`Ndef(...).set(...)` is the cheapest and safest change: nothing is rebuilt, so
nothing clicks. Use it for parameters you will touch often.

```supercollider
Ndef(\drone).set(\freq, 36.7, \amp, 0.05);
```

Fades belong *inside* the definition, because a `set` is instantaneous:

```supercollider
Ndef(\drone, { |freq = 55, amp = 0.1| LFTri.ar(freq) * amp * EnvGen.kr(Env.asr(0.05, 1, 0.4), gate: 1) }).play;
```

For anything you cannot express as `Ndef`, work on the graph directly with
`sc_nodes`: `tree` shows the node ids, `set` changes a control on one, `free`
stops it.

## Stopping, in the right order

```supercollider
Ndef(\air).stop;      // stop one named synth
Pdef(\pulse).stop;    // stop one named pattern
Ndef.clear;           // stop every Ndef
s.freeAll;            // free every node on the server - the panic button
```

- `Ndef(\x).stop` removes that one and leaves everything else alone. Prefer it.
- `s.freeAll` frees *every* synth on the server, including ones another piece
  started — so call it when the user asks to stop everything, not to tidy up.
- `.clear` on a `Pbind`-family object stops the scheduling, but a node it already
  created keeps playing until its envelope ends. `s.freeAll` is what makes a
  rhythm stop now.

Tell the user what is still running. "A drone on 55 Hz, and I stopped the pulse"
is a useful answer; "done" is not.

## Idioms that keep a session workable

**Use `~variables` for things you will re-use.**

```supercollider
(
~root = 55;
Ndef(\drone, { |freq = 55| LFTri.ar(freq) * 0.1 }).play;
~root = 41.2;
Ndef(\drone).set(\freq, ~root);
)
```

Inside a function body a `~variable` reads its value **when the function is
evaluated**, so it is a snapshot rather than a live link: changing `~root` later
does not move a sound that is already playing. Use `.set` for that.

```supercollider
(
~root = 41.2;
Ndef(\drone, { |freq = 55| LFTri.ar(freq) * 0.1 }).play;
Ndef(\drone).set(\freq, ~root * 1.5);
)
```

**Wrap long submissions in one block.** `sc_exec` takes a block, and a `var`
declaration is only legal at the top of one:

```supercollider
(
var freqs = [55, 82.4, 110];
freqs.do { |f, i|
	Ndef(("drone" ++ i).asSymbol, { |amp = 0.05| SinOsc.ar(f) * amp }).play;
};
)
```

**Give every one-shot an envelope with `doneAction: 2`**, so it frees its own node
and does not accumulate:

```supercollider
{ SinOsc.ar(880, 0, 0.2) * EnvGen.kr(Env.perc(0.005, 0.35), doneAction: 2) }.play;
```

**Cap your amplitudes.** `amp` in the region of 0.05–0.2 per voice. Ten voices
at 0.2 is clipping and possibly a startled user — this is their real speakers.

## Recovering from trouble

| Symptom | Cause | Fix |
|---|---|---|
| `sc_exec` answered "the interpreter was restarted" | The snippet never returned: an infinite loop, or `.wait` on the main thread (headless `sclang` deadlocks on it) | Nothing is left of the old session. Re-define what you need. Never `.wait` at the top level. |
| `WARNING: server 'localhost' not running` | The snippet called `.play` before a server was bound | Run `sc_play` (or `sc_server` action=boot) first, then re-run the snippet. |
| A drone will not stop | It was started with `.play` and you do not have its node id | `sc_nodes` action=tree to find it, then `free`; or `s.freeAll` |
| Sound stopped entirely | All nodes were freed, or the server quit | `sc_status` says whether the server still answers |

## A worked example

```supercollider
(
// one drone, one moving filter, one pulse
Ndef(\drone, { |freq = 55, amp = 0.1|
	LFTri.ar(freq) * amp
}).play;

Ndef(\drone).set(\freq, 41.2);

Ndef(\air, {
	HPF.ar(PinkNoise.ar(0.02), LFTri.kr(0.05).range(400, 2400))
}).play;
)
```

```supercollider
// later: take it somewhere else, then stop cleanly
Ndef(\drone).set(\amp, 0.05);
Ndef(\air).stop;
Ndef(\drone).stop;
```

## Check what you actually made

Live coding is the easiest place to fool yourself: a node is playing, the tool
said OK, and the sound is not what you think it is. Before you describe a sound to
the user — especially before you call it a bell, a gong, a pluck or a drum — run
`sc_capture` on it and read the numbers. It reports peak, RMS, clipping, tonality
and the strongest partials, so "it sounds like noise" becomes a specific,
actionable fact instead of an argument.

Two things it catches that nothing else does:

- **The node exists but is not what you asked for.** `/s_new` has no reply, so a
  refused node looks exactly like a working one. `sc_capture` proves sound came out;
  `sc_server action=diagnose` prints the server log that names the refusal.
- **Clipping.** A resonator bank sums its modes, so an instrument that is lovely at
  one velocity squares off at another and is heard as noise. If `peak` is above 0.9,
  lower the gain and measure again.

## What this environment does and does not give you

Some of these are properties of a headless `sclang` driven over pipes, and knowing
them saves an hour of chasing a bug that is not in your code:

- **The interpreter cannot receive server replies.** Anything that waits for
  scsynth to answer — `s.sync`, `Buffer:loadToFloatArray`, `Bus:get`, `/b_getn`
  from the language — will hang or come back empty. This is why measurement is a
  tool (`sc_capture`) that talks OSC itself rather than something you do in
  sclang.
- **`.wait` is illegal on the main thread.** It deadlocks, the call times out, and
  the interpreter is restarted, losing everything. `.wait` is only legal inside a
  `Routine` or a `Task`.
- **Language-side scheduling is not reliable here.** `SystemClock.sched` and a
  `Routine` started with `.play` may never run, because the interpreter only
  advances when it is given work. To sequence sounds over time, schedule them **on
  the server** with a timestamped bundle, which needs no interpreter at all:

  ```supercollider
  // three strikes at 0.2 s, 6.5 s and 14 s: the server plays them, the
  // interpreter is not involved
  Server.default.sendBundle(0.2,  ["/s_new", "gong", 2001, 0, 0, "amp", 1.0]);
  Server.default.sendBundle(6.5,  ["/s_new", "gong", 2002, 0, 0, "amp", 0.85]);
  Server.default.sendBundle(14.0, ["/s_new", "gong", 2003, 0, 0, "amp", 0.7]);
  ```

- **A multi-line submission is written to a file and `interpret`ed by path**, so
  comments and newlines reach the compiler as written. Short single-line snippets
  are normalised instead. Either way, you do not have to rewrite your code to suit
  the transport.
- **A timed-out call restarts the interpreter** and everything it defined is gone.
  Keep snippets quick; put long unrolling in the server, not in a loop.
