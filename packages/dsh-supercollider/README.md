# dsh-supercollider (alpha.1)

**SuperCollider the agent can actually play: eleven tools that make, MEASURE and
rewrite sound, sixteen instruments to start from, and five skills that teach it the
language.**

SuperCollider is a language, a server and a reference, and an agent that only
knows about DSP gets all three subtly wrong. This package gives it the three
things that matter: **one live `sclang` session** that keeps its state between
calls, **raw OSC control** of the audio server, and **the installed `.schelp`
reference** to read before it guesses — plus the loop that closes the gap between
"a node is playing" and "it sounds like a gong".

It is one row (`supercollider`) with eleven tools, five skills, sixteen example
instruments, three host routes and one small console tab. Everything below the
tools is in `lib/engine/`, which knows nothing about the harness — that is what
lets `mcp/stdio.js` drive the same engine for a client that has no harness at all.

## What it adds

- **One long-lived interpreter.** `sc_exec` runs sclang in a session that stays
  alive: a `~variable`, an `Ndef`, a playing `Pbind` are all still there on the
  next call, so a piece is *built up* rather than re-created. A fresh `sclang`
  per call costs 0.5–2 s of class-library load **every time** and forgets
  everything; this one is ready in about a second and then answers in ~62 ms.
  Measured, on the machine this was written on: **62 ms** and **63 ms** for two
  consecutive evaluations.
- **Raw OSC to `scsynth`, by hand.** `/status`, `/d_load`, `/s_new`, `/n_set`,
  `/n_free`, `/g_freeAll`, `/g_queryTree`, `/quit`, with a real decoder for
  `/status.reply` (`,` + `iiiiiffdd`: sample rate, CPU, node and def counts) and
  for the `f`/`d`/`i`/`s`/`b` types generally. The encoder is verified against
  the exact bytes the old implementations sent (`/status` is
  `2F 73 74 61 74 75 73 00` + `2C 00 00 00`).
- **A server this package owns, and only what it owns.** It boots `scsynth` with
  `-u <port>` and nothing else, reads the spawned server's own log (which is
  where the audio device and every `FAILURE IN SERVER` are printed), and never
  kills a server it did not start. A port is believed only after it answered
  `/status` — never because a command line mentioned it.
- **Eleven tools by intent, not by mechanism.** `sc_status`, `sc_help`, `sc_check`,
  `sc_exec`, `sc_play`, `sc_capture`, `sc_project`, `sc_load`, `sc_synthdef`,
  `sc_nodes`, `sc_server`. The old surface had six near-synonyms for "what is
  running". `sc_capture` is the one that closes the loop: it plays a def, records
  the def's own output, and answers with peak, RMS, clipping, tonality and the
  strongest partials — because "a node exists" and "it sounds like a gong" are
  different claims, and only the second one matters.
- **Five skills** (`skills/<name>/SKILL.md`), registered at runtime *and* copied
  into `$DSH_HOME/skills` by both installers: `supercollider-live-coding`,
  `supercollider-synthdefs`, `supercollider-language`, `supercollider-scout-docs`,
  `supercollider-projects`. Every fenced `supercollider` example in them is
  compiled against the machine's own class library by
  `scripts/checks/check-sc-examples.mjs` — **42 examples, compiled, plus one that
  is asserted NOT to compile.**
- **The installed reference, indexed.** 1146 `.schelp` files on the machine this
  was written on. The ranker is the ported one, weights unchanged: content +4,
  title +6, source path +3, section +2, cross-reference +5, a flat +2 for an
  examples section and +1 for a `list::` section. It is built on first search, not
  at boot.
- **A console tab, and no more than that** — the session's text since a cursor,
  one input line, a Stop, and a server readout. No scope, no node-tree canvas, no
  SynthDef browser, no editor: `.scd` files are claimed so they open in the
  **shipped editor**, and the agent works on them through `sc_project` /
  `sc_load`. Edit there, send, hear it here.
- **An MCP face for clients that are not the harness** (`mcp/stdio.js`, or
  `npm run mcp`). It is a hand-written JSON-RPC 2.0 server (initialize /
  tools/list / tools/call) over the same engine, because the pack ships no npm
  dependencies and an MCP tool server is a protocol small enough to write.

## How it plugs in

| Piece | Value |
|---|---|
| row | `supercollider`, with a browser half |
| routes | three exact paths, `GET`/`HEAD`/`POST` only |
| tools | 11 |
| skills | 5 |
| examples | 16 playable instruments (`examples/`, reachable through `sc_project action=examples`) |
| touches | no core row disabled, no fork, no npm dependency, no vendored engine, no bundled binary |

| Route | What it answers |
|---|---|
| `GET /api/dsh-supercollider/state` | install, version, every server process, the decoded `/status`, the session's state, the watched files, the tool and skill lists |
| `GET /api/dsh-supercollider/console?cursor=&wait=` | the session's output since a cursor — a long-poll of at most 5 s, because this pack has no SSE and no browser WebSocket anywhere |
| `POST /api/dsh-supercollider/eval` | one line of sclang into **the same session the agent uses** |

The session is shared: the console and the agent drive one interpreter, which is
what makes "type it here, ask the agent about it there" work at all.

## Requirements

- **SuperCollider 3.13 or newer** (`sclang`, `scsynth`), installed the normal
  way. Nothing else — no Python, no Rust, no MCP server, no npm package.
- **Node.js 22 or newer** (the harness's own requirement).
- The install is found on `PATH`, at the platform's standard locations (including
  the *versioned* folders a real install uses, like
  `C:\Program Files\SuperCollider-3.14.1`), or through `DSH_SC_SCLANG` /
  `DSH_SC_SCSYNTH`. With none, every tool says what it looked for and how to
  install it (`winget install SuperCollider.SuperCollider`,
  `brew install --cask supercollider`, or the distribution package).

## Limits

- **No binary is shipped.** SuperCollider is ~50 MB and installer-specific; this
  package finds yours or tells you how to get one. A pinned provisioner in the
  `dsh-media` style is possible later and is not here.
- **One interpreter, one audio server.** Two conversations share them, because
  an audio device is a single global resource. `sc_status` names the owner and
  `sc_stop`-equivalent actions are global; that is documented rather than hidden.
- **Per-process disk I/O and RSS-from-a-library are not available.** On Windows
  the process table comes from `Get-CimInstance Win32_Process`, which has no
  I/O counters; the tools say the field is unavailable instead of printing a
  zero. RSS and CPU come from CIM there and from `ps` elsewhere, and the tool
  text names the source.
- **Audio-device enumeration is dropped** (the Python server did it through
  `winreg` and `ctypes`/winmm). `sc_server action=diagnose` reads what `scsynth`
  itself printed about the device instead.
- **A large answer goes through a file.** Printing a 420-byte
  `SynthDef.asBytes` through the REPL was measured to arrive interleaved with the
  input echo and truncated, so anything over 32 KiB is written to
  `$DSH_HOME/dsh-supercollider/tmp/` and the inline answer carries the path, its
  length and its SHA-256.
- **No SSH, no remote servers.** Everything is loopback OSC and local processes.

## Verify

The checks live **inside this package** (`checks/`), so they travel with it: the
vncode copy runs them as `npm run check` in `packages/dsh-supercollider/`, and a
clone of that repository needs no scripts of its own.

```
npm run check                 # all three, in order
npm run check:node            # the engine, offline; the live half skips loudly
npm run check:wiring          # the package's contract, without the harness
npm run check:examples        # every skill example, compiled
```

All three skip a section loudly and exit 0 when the machine has no
SuperCollider, and none is ever weakened to make a change pass.

## Install

With the vncode pack: `scripts\install.bat` (Windows) or `./scripts/install.sh`
(macOS / Linux) in **that** repository, which discovers this package under
`packages/`.

On its own:

```
scripts\install.ps1 -Force        # Windows
./scripts/install.sh --force      # macOS / Linux
```

Then restart the harness and hard-refresh the browser. Nothing has to be
installed first: the requirements are SuperCollider and Node.
