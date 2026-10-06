---
name: supercollider-live-coding
description: Build a SuperCollider piece up while it plays - start a sound, change it in place, layer it, and stop it cleanly - using the dsh-supercollider tools (sc_exec, sc_nodes, sc_play, sc_stop-via-sc_exec) and the idioms that make a session survive (Ndef, ProxySpace, Pbind, ~variables, s.freeAll).
whenToUse: Use when asked to make, play, improvise, accompany or live-code music or sound, when a piece should keep changing after it starts, when the user says "make a drone", "play something", "add a beat", "make it darker", "change the pitch while it runs" - and whenever more than one sound must exist at the same time.
---

# Live coding SuperCollider

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
