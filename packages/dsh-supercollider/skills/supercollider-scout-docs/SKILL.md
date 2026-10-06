---
name: supercollider-scout-docs
description: Find the answer in the SuperCollider documentation that ships with the install instead of guessing - what sc_help's search, answer, class and index actions return, what the .schelp tree looks like (over a thousand files: Classes, Guides, Reference, Overviews), how to read a class page for its argument names, and where the server's OSC commands are written down.
whenToUse: Use before naming a UGen, a method, an argument or an OSC command you are not certain about; when a snippet failed with "not understood" or a wrong-argument error; when the user asks what a class does or how something works; and whenever you notice you are about to answer a SuperCollider question from general DSP knowledge.
---

# Scouting the docs

SuperCollider is a large language with a small vocabulary of *obvious* names and
a large one of non-obvious ones. `SinOsc` is what you expect; `Decay2`,
`LeakDC`, `DetectSilence`, `LocalIn` and `RandSeed` are not. And a UGen's
argument order is not guessable: `RLPF.ar(in, freq, rq)` and
`BPF.ar(in, freq, rq)` look alike, `MoogFF.ar(in, freq, gain)` does not.

The install ships its own reference — on the machine this was written on, **1146
`.schelp` files** under `HelpSource/`. That is the authority. `sc_help` reads it.

## The four actions

| Action | Use it for |
|---|---|
| `search` | "Is there a UGen for a moving filter?" — ranked sections with excerpts |
| `answer` | "How do I make a reverb?" — the three best sections as evidence |
| `class` | "What are `PlayBuf`'s arguments?" — one page, by name or path |
| `index` / `refresh` | Whether an index exists, and rebuilding it after an install changed |

### Search before you assume

```
sc_help action=search query="resonant low pass filter"
```

That returns `BLowPass` and `BLowPass4` at the top — measured on a real install —
which is the point: you could not have guessed those names, and now you have
them. The result names the section and the file each hit came from, so you can go
and read the whole page once a hit looks right. Search expands a small synonym
table, which is why "guitar" finds `Pluck` and `DwgPluck`, and "drum" finds
`Impulse` and `Decay2`. Search with a **class name or a descriptive phrase not a
question** — see the table at the bottom of this page for why.

### Read the page for its arguments

```
sc_help action=class name=RLPF
```

Argument names are what `sc_nodes` action=`set` needs, and they are what a
`SynthDef` body's `|...|` must match. Reading the page costs one call and removes
the guess entirely.

A class page is reachable by name (`RLPF`) or by path
(`Guides/Server-Guide`, `Reference/Server-Command-Reference`,
`Overviews/UGens`).

### Ask for evidence before writing a long answer

```
sc_help action=answer query="Pbind dur scheduling"
```

It returns quoted sections rather than a synthesis. That is deliberate: you write
the answer, it supplies the ground truth. It runs the same ranker as `search`
with three results, so the same advice applies — a list of names, not a sentence.

## What is in the tree

| Folder | What is there |
|---|---|
| `Classes/` | one page per class — the bulk of it, and the one you want most often |
| `Guides/` | longer tutorials: `Server-Guide`, `ClientVsServer`, `Patterns`, `Tour-of-UGens` |
| `Reference/` | reference material: `Server-Command-Reference` (the OSC dictionary), `SCDoc-Syntax` |
| `Overviews/` | the conceptual map: `UGens`, `Operators`, `Patterns` |
| `Tutorials/` | the book: `Getting-Started`, `Mark Polishook Tutorial` |

`Reference/Server-Command-Reference.schelp` is the file to read when you need an
OSC command by name — `/s_new`, `/n_set`, `/d_load`, `/g_queryTree` — because
inventing one that sounds plausible is a wasted turn.

## What a `.schelp` file looks like

Every page is a run of `key:: body` sections:

```
class:: RLPF
summary:: Resonant low pass filter
categories:: UGens>Filters>Linear

description::
An RLPF is a resonant low pass filter...

classmethods::
method::ar
argument::in
The input signal.
argument::freq
Cutoff frequency in Hertz.

examples::
code::
{ RLPF.ar(Saw.ar(200), 800, 0.1) * 0.1 }.play;
::
```

So `title::` is the page's own name, `class::` the class it documents,
`description::` the prose, `method::` and `argument::` the API, and `examples::`
the runnable part. `link::Classes/SinOsc::` is a cross-reference, and the search
index scores those: a query naming `SinOsc` will surface `FSinOsc` too, because
the pages link to each other.

The `examples::` sections are the best source of working code. When you are
unsure how to use something, search for it and read the example rather than
composing from memory.

## When to reach for it, concretely

| Situation | Call |
|---|---|
| You are about to write `\someKey` in a `Pbind` and you are not sure | `sc_help action=class name=Pbind` |
| A UGen failed with `not understood` | `sc_help action=search query="<the name you used>"` |
| You need the right argument list for a filter | `sc_help action=class name=<ClassName>` |
| You need an OSC address | `sc_help action=class name=Reference/Server-Command-Reference` |
| The user asks "what does X do" | `sc_help action=answer query="X"` |
| Search returns nothing for a real thing | `sc_help action=index`, then `refresh` — the tree may have moved |

Search returns nothing only when the words are wrong, not when the concept is
missing. Try the class name you think it is, then a broader term ("filter",
"envelope", "buffer"), then the `Overviews` page for the area.

**A whole sentence is a bad query.** The ranker scores each token independently
and adds the weights up, with no stemming and no notion of a phrase, so the
words a question is made of — "make", "how", "do", "a", "with" — are scored just
like the class name. Measured on a real install:

| Query | What it finds |
|---|---|
| `SinOsc` | the `SinOsc` page, first |
| `sine oscillator` | `FBSineC`, because both words are in its page |
| `how do I make a sine oscillator` | `SCDocSyntax`, which is about the help format |

So **search for the name, not the question**: `SinOsc`, `RLPF`, `PlayBuf`,
`Env.asr`. If you cannot name it yet, search the *noun* you are sure of
("envelope", "filter", "granular") and read the `Overviews` or `Guides` page that
comes back, which is where the names are listed.
