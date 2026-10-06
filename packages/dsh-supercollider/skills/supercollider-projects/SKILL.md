---
name: supercollider-projects
description: Work with SuperCollider projects as files - the shape of a .scd piece, how to read and write one with sc_project, how to send the file that is on disk into the live session with sc_load, what state belongs in the session and what belongs in the file, and how to package a piece the SuperCollider way (a folder with its .scd, its SynthDefs, and a Quark-style layout) instead of inventing a format.
whenToUse: Use when the user names a .scd file or a folder of them, asks to save, load, open or organise a piece, wants a project they can come back to, mentions a Quark or an extension, or when work should survive past the current session.
---

# SuperCollider projects

SuperCollider has no project file and no build system. What it has is a
convention, and it has held for twenty years:

> **A piece is a folder with a `.scd` file in it, and everything the piece needs
> is either in that file or in `Extensions/` next to it.**

That is the whole format. Respecting it means the user can open the folder in the
SuperCollider IDE, in Emacs, or in the editor vncode ships, and everything works.

## `.scd` files

A `.scd` is a plain text file of sclang. Three shapes are idiomatic:

**A score — the whole piece runs top to bottom.**
```supercollider
(
s.waitForBoot {
	var root = 55;
	SynthDef(\drone, { |freq = 55, amp = 0.1| LFTri.ar(freq) * amp * EnvGen.kr(Env.asr(0.5, 1, 1), gate: 1, doneAction: 2) }).add;
	s.sync;
	~voice = Synth(\drone, [freq: root]);
	30.wait;
	~voice.set(\gate, 0);
};
)
```

**A live-coding session — definitions at the top, edits made from the keyboard.**
```supercollider
(
s.waitForBoot {
	Ndef(\drone, { |freq = 55, amp = 0.1| LFTri.ar(freq) * amp }).play;
	Ndef(\air, { HPF.ar(PinkNoise.ar(0.02), 1200) }).play;
};
)
```

**A library — reusable definitions, no sound on load.**
```supercollider
(
SynthDef(\blip, { |freq = 440, amp = 0.2, decay = 0.25|
	var env = EnvGen.kr(Env.perc(0.004, decay), doneAction: 2);
	Out.ar(0, Pan2.ar(SinOsc.ar(freq) * env * amp, 0));
}).add;

SynthDef(\pad, { |freq = 110, amp = 0.08, gate = 1, cutoff = 900|
	var env = EnvGen.kr(Env.asr(0.4, 1, 0.8), gate, doneAction: 2);
	Out.ar(0, RLPF.ar(LFSaw.ar([freq, freq * 1.004]), cutoff, 0.4) * env * amp);
}).add;
)
```

Rules of thumb that keep a `.scd` usable:

- **Wrap the whole file in one outer block** `( ... )`. It makes the file one
  submission, which is what `sc_load` and the IDE both want.
- **`s.waitForBoot { ... }`** when the file needs the server to exist. Without it,
  `.add` on a `SynthDef` races the server's boot.
- **`s.sync`** after `.add` before the first `Synth(...)`: `.add` is asynchronous,
  and a node created before the def arrives fails with "SynthDef not found".
- **Give the piece a variable it can be stopped from**: `~voice`, `~piece`, an
  `Ndef` name. A file whose only handle is a node id is a file you cannot stop.
- **Amplitudes modest** (0.05–0.2 per voice).

## Working with files through the tools

| Want | Call |
|---|---|
| What is in this folder | `sc_project` action=`list`, dir `.` |
| Read one | `sc_project` action=`read`, file `piece.scd` |
| Create or replace one | `sc_project` action=`write`, file `piece.scd`, code `(...)` |
| Run the file that is on disk | `sc_load` file `piece.scd` |
| Run it with a different deadline | `sc_load` file `piece.scd`, timeoutMs `120000` |

`sc_project` action=`write` **refuses to replace an existing file** unless you pass
`overwrite: true`. That is deliberate: a piece the user wrote by hand should not
disappear because an agent decided to "save" it. When you want to change a file,
read it first, understand what is there, then write with `overwrite: true` — or
better, write a new file and say what it is.

A relative path resolves against the conversation workspace, and the resolved
absolute path is reported back, so there is never any doubt about which file was
touched. `sc_load` reads from disk at the moment of the call, so it is always the
file the user is looking at — including edits they made since you last read it.
That is the point of the tool: **edit in your editor, load, hear it**.

## What belongs in the session, and what belongs in the file

The session is a live interpreter; the file is the durable artifact. They are not
the same, and confusing them loses work.

| Belongs in the file | Belongs in the session |
|---|---|
| `SynthDef` definitions | The running nodes those defs made |
| The `Ndef` / `Pdef` **definitions** | The current `Ndef(\x).set(...)` values |
| The structure of the piece | The improvisation inside it |
| Anything the user would want tomorrow | Anything you would want in ten seconds |

So: a parameter you are exploring goes in `sc_exec` or `sc_nodes`; a parameter
that *is* the piece goes in the file. When an exploration settles, write it back.

Save **definitions**, not state. A file that contains
`~voice.set(\freq, 41.2)` is a file that only makes sense after the file before
it ran. Put that value in the def's default, or in a `~variable` the file sets at
the top.

## Packaging a piece

Two levels, and picking the right one is most of the decision:

**A piece — one folder, one file, its defs.**
```
my-piece/
  piece.scd          the piece: defs at the top, the score below
  README.md          what it is and how to run it
  samples/           any buffers it loads
```

**A Quark — a reusable library, the SuperCollider package format.**
```
MyQuarks/
  quarks/
    my-quarks/       or the classes alone, at the top of the folder
      Classes/       one .sc per class, the file named after the class
      HelpSource/    one .schelp per class, the file named after the class
      README.md
      .quark         a one-line file: MyQuarks: "description"
```

A Quark has hard naming rules, because the class library builds it:

- **One class per file, and the file is named exactly after the class**
  (`Classes/BlipVoice.sc` contains `BlipVoice`). Two classes in one file, or a
  file name that does not match, is the most common reason a Quark "does not
  exist".
- **`HelpSource/` mirrors `Classes/`**, one `.schelp` per class, named the same.
- **The folder name is the Quark name**, and `.quark` (or `quarks/<name>/`) is
  where SuperCollider looks. Install it by adding the *parent* folder to
  `Quarks.quarkDir`-adjacent search paths, or by symlinking into
  `~/Library/Application Support/SuperCollider/Extensions` on macOS,
  `%LOCALAPPDATA%\SuperCollider\Extensions` on Windows, or
  `~/.local/share/SuperCollider/Extensions` on Linux.

Do not invent a project format on top of this. If the user has four pieces in one
folder, that folder is the project; a `.scd` per piece is the organisation, and
`.sc` classes plus a `HelpSource` beside them is the upgrade path when something
is worth re-using.

## Before you say a piece is finished

1. **It stops.** Every sustained voice has a `gate`, and the file ends by
   releasing it (`~voice.set(\gate, 0)`) or frees it (`Ndef(\x).stop`). A piece
   that cannot be stopped is not finished.
2. **It does not raise its own volume.** Check the per-voice amplitudes; ten
   voices at 0.2 is clipping.
3. **Its defs load in order.** `s.waitForBoot` around the defs, `s.sync` after
   them, before the first `Synth(...)`.
4. **It says how to stop it.** Either in the file (a final `Ndef.clear;`) or in
   the README — the user should not have to reload the file to stop the sound.
5. **It is readable.** A piece someone opens in six months should explain itself
   in comments at the top: what it is, what to run, how to stop.
