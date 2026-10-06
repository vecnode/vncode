---
name: supercollider-language
description: The SuperCollider language itself - function blocks and argument syntax, UGen rate methods (.ar/.kr/.ir), multi-channel expansion, var scoping, ~environment variables, the class library's shape, and the error messages that mean a specific mistake. Written for an agent that knows audio DSP but not this language.
whenToUse: Use before writing sclang you are not certain compiles - whenever a snippet raised a syntax or "not understood" error, when a UGen call needs the right rate method, when a value unexpectedly became an array of channels, or when you need to know whether a name is a class, a method or a variable.
---

# The SuperCollider language

SuperCollider's language is small and peculiar. It is worth ten minutes here,
because its failure modes are quiet: a wrong rate method compiles and sounds
wrong; a misplaced `var` is a syntax error with a message that reads oddly; a
number where a signal belongs broadcasts into an array in a way that is usually
what you want and occasionally not.

## Everything is a message

`1 + 2` is `1.+(2)`. `SinOsc.ar(440)` is the class `SinOsc` receiving `ar` with
`440`. There is no operator precedence to memorise beyond the arithmetic you
expect, and every "operator" can be written as a method call:

```supercollider
(1 + 2).postln;
(1.add(2)).postln;
```

Chains are read left to right:

```supercollider
SinOsc.ar(440, 0, 0.1).distort.tanh.postln;
```

## Function blocks

Curly braces are a **function**, not a scope. It does not run until something
calls it.

```supercollider
{ 1 + 1 };            // a Function. Nothing happens.
{ 1 + 1 }.value;      // 2
{ 1 + 1 }.postln;     // prints a Function, not 2
```

Arguments go between pipes at the front:

```supercollider
{ |a, b = 10| a + b }.value(1);      // 11
{ |a, b = 10| a + b }.value(1, 2);   // 3
```

A function with no arguments still needs the pipes if you want to *name* the
argument that a UGen will pass:

```supercollider
Ndef(\x, { |freq = 220| SinOsc.ar(freq) * 0.1 });
```

`.play` on a function is what makes a sound, and it is what creates a synth node:

```supercollider
{ SinOsc.ar(440, 0, 0.1) * EnvGen.kr(Env.perc(0.01, 0.3), doneAction: 2) }.play;
```

## `var` — and the one error everyone hits

`var` declares a local. It must be the **first thing** in the block, before any
statement:

```supercollider
(
var a = 1;
var b = 2;
a + b;
)
```

Put it anywhere else and the compile fails:

```supercollider invalid
(
1 + 1;
var a = 2;      // illegal: not at the top of the block
a;
)
```

The `sc_exec` wrapper puts your code inside a block, so **a `var` in the middle
of a submission reads as `unexpected VAR`** even though the same text works in a
`.scd` file where it sits at the top of its own block. Declare at the top, or
assign to a `~variable`.

```supercollider
(
var base = 110;
[base, base * 1.5, base * 2].do { |freq| SinOsc.ar(freq) * 0.03 };
)
```

### Where `var` is legal, exactly

`var` is legal as the first statement of **its own enclosing braces** — a function
body. A block passed to `try`, to `if`, to `do`, to `collect` is a function body, so
a `var` inside one is fine. All of this is legal, and all of it was measured:

```supercollider
try {
	var inside = 2;        // legal: the try branch is a function body
	inside
} { |err| err.errorString };
```

```supercollider
if (true) { var a = 41; a } { 0 };     // legal: 41
[1, 2, 3].collect { |n| var d = n * 2; d };   // legal: [2, 4, 6]
```

The failure is narrower than "a var anywhere but the top", and it is worth knowing
precisely, because the mistake that produces it is usually not in the code you
wrote — it is in code that got rewritten:

```supercollider invalid
(
1 + 1;
var a = 2;      // a var that is NOT the first statement of its block
a;
)
```

The enclosing braces matter, and nothing else does. A `.scd` file is full of blocks
where a `var` is perfectly legal; the same text fails only when it is flattened so
that the `var` is no longer first. That is the real trap, and it is why this engine
writes multi-line code to a file and `interpret`s it by path instead of collapsing
it into one line: **collapsing a file is what moves a `var` off the top of its
block.** If you ever see `unexpected VAR` for code that is obviously correct, look
for something that rewrote the text, not for the `var`.

## `~variables` — the environment

A name starting with `~` lives in the interpreter's current environment, not in a
local scope, so it survives between submissions:

```supercollider
~root = 55;
~root * 2;          // 110
```

That is why a live session is useful and a per-call interpreter is not. Use `~`
for anything you will want on the next call; use `var` for anything local to one
block.

## Rate methods: `.ar`, `.kr`, `.ir`, `.new`

A UGen class is instantiated by a rate method, and the rate decides where it can
live:

| Method | Rate | Use for |
|---|---|---|
| `.ar` | audio rate (one value per sample) | anything you hear: oscillators, filters, envelopes shaping audio |
| `.kr` | control rate (one value per block) | modulation: LFOs, envelope shapes, control signals |
| `.ir` | initialisation rate (one value, at synth creation) | a constant fixed when the node starts |
| `.new` | not a signal — a language-side object | `Buffer.new`, `Bus.new` |

Mixing them is normal and correct:

```supercollider
{ SinOsc.ar(440) * LFTri.kr(0.5).range(0.02, 0.2) }.play;
```

`SinOsc*` is audio; `LFTri*` at `.kr` is a slow modulator. `.ar` on a UGen that
has no audio-rate implementation fails at compile time with
`ERROR: ... ar not understood`.

## Multi-channel expansion

This is the feature that surprises people, and it is deliberate: **a UGen with an
array argument becomes an array of UGens.**

```supercollider
SinOsc.ar([440, 550]).postln;      // an Array of two SinOscs
Out.ar(0, SinOsc.ar([440, 550]) * 0.1);   // two channels, one per output
```

So a stereo voice needs no `Pan2`, just an array:

```supercollider
{ SinOsc.ar([440, 441]) * 0.1 }.play;
```

And a `SinOsc.ar(440)` multiplied by an array becomes an array too. That is
usually what you want; when it is not, reduce the array first
(`.sum`, `.mean`, `.first`).

```supercollider
{ (SinOsc.ar([220, 330, 440]) * 0.05).sum }.play;
```

## Collections and the control-flow verbs

`do`, `collect`, `select`, `inject` are the loop vocabulary. There is a `while`,
but in a live session it is a trap: nothing yields, so a `while(true)` blocks the
interpreter until its deadline and the session is restarted.

```supercollider
[55, 82.4, 110].do { |freq, index| (index.asString ++ ": " ++ freq).postln };
[1, 2, 3, 4].select { |n| n.even };
[1, 2, 3].collect { |n| n * n };
```

For anything that should unfold over time, use a **pattern** or a **routine**,
not a loop: a `Routine` yields, so the clock can advance.

```supercollider
Routine { 4.do { |i| i.postln; 0.25.wait } }.play;
```

`.wait` is legal inside a `Routine` and **illegal on the main thread** — headless
sclang deadlocks on it, which is why the session has a deadline at all.

## Printing and inspecting

```supercollider
440.postln;              // prints 440
[1, 2, 3].postln;        // prints [ 1, 2, 3 ]
1.class.postln;          // prints Integer
```

```supercollider output
440
[ 1, 2, 3 ]
Integer
```

`.postln` prints and returns the receiver, so it can be dropped mid-chain. A very
large print out of `sc_exec` is written to a file instead of being returned
inline.

## Classes you will actually use

| Class | What it is |
|---|---|
| `SinOsc`, `LFTri`, `LFSaw`, `Pulse`, `Saw` | oscillators |
| `WhiteNoise`, `PinkNoise`, `BrownNoise` | noise |
| `RLPF`, `RHPF`, `BPF`, `LPF`, `HPF`, `MoogFF` | filters |
| `Env`, `EnvGen`, `Line`, `XLine` | envelopes and ramps |
| `Out`, `ReplaceOut`, `Pan2`, `PanAz` | putting signal on a bus |
| `SynthDef`, `Synth`, `Ndef`, `NodeProxy` | definitions and running nodes |
| `Pbind`, `Pseq`, `Pwhite`, `Pdef` | patterns (timed event streams) |
| `Buffer`, `PlayBuf`, `BufRd` | sample playback |
| `Server`, `Bus`, `Group`, `Node` | the server-side graph |
| `Routine`, `Task` | language-side scheduled code |

Every one of these has a help page. Read it with `sc_help` before guessing at an
argument name — the page has the argument list, and the argument names are what
`sc_nodes` action=`set` needs.

## The errors, and what each one means

| Message | Meaning |
|---|---|
| `ERROR: syntax error, unexpected VAR` | A `var` that is not at the top of its block |
| `ERROR: Variable 'x' not defined` | Misspelled name, or used before declaration, or a `~` missing |
| `ERROR: Message 'foo' not understood` | No such method on that receiver — usually a wrong UGen name, or an `.ar` where `.kr` belongs |
| `ERROR: ... doesNotUnderstand` | A receiver that is `nil`: something returned nothing where a value was expected |
| `WARNING: server 'localhost' not running` | `.play` / `Synth(...)` before a server was bound — run `sc_play` or `sc_server` action=boot first |
| `FAILURE IN SERVER /s_new: SynthDef not found` | The def is not loaded on that server: `sc_synthdef` action=load |
| `FAILURE IN SERVER /n_set Node not found` | The node id is wrong or the node already ended: `sc_nodes` action=tree |
| `ERROR: Command line parse failed` | The submitted block did not parse as a whole — usually an unbalanced parenthesis |

When a message is unfamiliar, `sc_help` action=`search` with the operator or
class name finds the documentation that explains it. That is faster than
reasoning about it.
