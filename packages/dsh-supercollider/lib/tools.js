/**
 * dsh-supercollider — the ten tools the agent actually calls.
 *
 * The shape of the surface is a decision, not an accident. The implementations
 * this replaces exposed 18 (Rust) and 10 (Python) tools with a great deal of
 * overlap: `get_servers`, `get_server_status`, `ping_supercollider`,
 * `discover_supercollider`, `list_server_candidates` and
 * `detect_supercollider_install` all answer some part of "what SuperCollider is
 * here and what is running", and a model choosing among six near-synonyms spends
 * its attention on the choice rather than on the music. So the surface is
 * organised by INTENT:
 *
 *   - `sc_status`   — what exists and what is running (one tool, not six)
 *   - `sc_help`     — the local documentation (search, evidence, fetch)
 *   - `sc_check`    — compile-check without running
 *   - `sc_exec`     — run code in the session that stays alive
 *   - `sc_play`     — a known-good tone, the "is sound working at all" answer
 *   - `sc_project`  — read/list/write `.scd` files
 *   - `sc_load`     — send a `.scd` that is on disk into the live session
 *   - `sc_synthdef` — compile, list, load and free SynthDefs
 *   - `sc_nodes`    — the running audio graph: tree, set, free, free all
 *   - `sc_server`   — boot, quit, reboot, diagnose
 *
 * Every tool returns a lossless-JSON value validated against the schema it
 * declares, because the harness's registry enforces that (`output.schema`), and
 * every tool resolves the install and the target the same way, so two answers in
 * one turn cannot disagree.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { clip, docsIndexStatus, formatAnswer, formatSearch } from './engine/docs.js'
import { resolveHelpRoot } from './engine/install.js'
import { readText, tailFile } from './engine/log.js'
import { readSource, writeSource, listSources } from './engine/project.js'
import { listExamples, findExample } from './engine/examples.js'
import { DEFAULT_PORT } from './engine/scsynth.js'
import { analyse } from './engine/analysis.js'

/** The most results a docs search will return. */
export const DOC_SEARCH_MAX = 12

/**
 * The directory a relative path resolves against.
 *
 * The harness runs each conversation's tools with the conversation workspace as
 * the working directory, and there is no second place to ask — so this reads it
 * there, and `DSH_SC_PROJECT_ROOT` exists for a deployment that wants a fixed
 * one (a dedicated `~/sc` folder, say) instead.
 *
 * @param env - the environment.
 * @returns the absolute root.
 */
export function projectRoot(env = process.env) {
  const configured = typeof env.DSH_SC_PROJECT_ROOT === 'string' ? env.DSH_SC_PROJECT_ROOT.trim() : ''
  return configured === '' ? process.cwd() : configured
}

/** The value every tool's `view` conforms to. The conversation card draws this. */
const VIEW_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    tool: { type: 'string' },
    file: { type: 'string' },
    port: { type: 'number' },
    pid: { type: 'number' },
    ms: { type: 'number' },
    summary: { type: 'string' },
    text: { type: 'string' },
  },
  required: ['ok'],
}

/**
 * Build the tools against one live session.
 *
 * @param deps - `{ session, env, watcher, home, log }`. `watcher` is optional:
 *   without one the file tools still work, and only the console's "a file you
 *   were shown changed on disk" notification is lost.
 * @returns the tool definitions to register.
 */
export function buildTools(deps) {
  const session = deps.session
  const log = deps.log ?? { warn() {}, info() {} }
  const watcher = deps.watcher ?? null

  /**
   * Watch one file, if watching is available.
   *
   * A file that cannot be watched is not a failure of the call that named it:
   * the tools still read and write it, and only the change notification is
   * missing.
   */
  const watch = (file) => {
    if (watcher === null || typeof file !== 'string' || file === '') return
    try {
      watcher.add(file)
    } catch (err) {
      /* not a failure of this call */
    }
  }

  /** The common output declaration: prose plus a card. */
  const output = {
    schema: {
      type: 'object',
      properties: { text: { type: 'string' }, view: VIEW_SCHEMA },
      required: ['text', 'view'],
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
    presentationMeta: (_args, value) => value.view,
  }

  /** Wrap one tool body, so a throw becomes an answer rather than a failure. */
  const run = async (name, args, exec, body) => {
    const started = Date.now()
    try {
      const answer = await body(args, exec)
      return {
        text: answer.text,
        view: { ok: answer.ok !== false, tool: name, ms: answer.ms ?? Date.now() - started, ...(answer.view ?? {}) },
      }
    } catch (err) {
      const message = err && err.message ? String(err.message) : String(err)
      log.warn(name + ' failed: ' + message)
      return { text: name + ' failed: ' + message, view: { ok: false, tool: name, ms: Date.now() - started, summary: message } }
    }
  }

  // -------------------------------------------------------------------------
  // sc_status — install, processes, ports, session, docs
  // -------------------------------------------------------------------------
  const status = {
    name: 'sc_status',
    description: [
      'What SuperCollider exists on this machine and what is running right now: the install directory and the exact sclang / scsynth / supernova / scide paths, every scsynth, sclang and scide process with its command line, which UDP ports actually answered a live OSC /status, the docs index state, and whether this session has an interpreter warm.',
      'Call it first in a session, and again whenever a call behaves as though a server is missing. It is the one place the truth lives: an audio server is only reported as reachable when it answered OSC, never because a command line mentioned a port.',
      'Set `probe: true` to force a fresh process scan and a fresh set of OSC probes even if one ran in the last second.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        probe: { type: 'boolean', description: 'Force a fresh process scan and OSC probe rather than reusing the snapshot taken in the last second.' },
        pid: { type: 'number', description: 'Report on this server pid specifically.' },
      },
    },
    output,
    presentCall: () => ({ card: 'generic', title: 'SuperCollider status', kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'SuperCollider status', content: result.text }),
    async execute(args, exec) {
      return run('sc_status', args, exec, async () => {
        const snapshot = await session.snapshot({ force: args.probe === true, signal: exec?.signal })
        const install = snapshot.install
        const version = await session.version()
        const helpRoot = session.helpRoot()
        const docsStatus = {
          root: helpRoot.root,
          files: helpRoot.root === null ? 0 : undefined,
        }
        const selected = Number.isInteger(args.pid)
          ? snapshot.servers.find((entry) => entry.pid === args.pid) ?? null
          : snapshot.servers[0] ?? null

        const lines = []
        lines.push('SuperCollider on this machine')
        lines.push('- platform=' + snapshot.platform + ' processes_read=' + (snapshot.ok ? 'yes' : 'no (' + snapshot.error + ')'))
        if (install.dir === null) {
          lines.push('- install=NONE FOUND')
          lines.push('  Looked in: ' + install.candidates.slice(0, 6).join(', ') + (install.candidates.length > 6 ? ' …' : ''))
          lines.push('  Install it with: ' + (snapshot.platform === 'win32' ? 'winget install SuperCollider.SuperCollider' : snapshot.platform === 'darwin' ? 'brew install --cask supercollider' : "your distribution's supercollider package"))
          lines.push('  Or point DSH_SC_SCLANG and DSH_SC_SCSYNTH at binaries you already have.')
        } else {
          lines.push('- install_dir=' + install.dir)
          lines.push('  version=' + (version.version ?? install.version ?? '<unknown>'))
          lines.push('  sclang=' + (install.sclang.file ?? '<missing>') + ' (' + install.sclang.source + ')')
          lines.push('  scsynth=' + (install.scsynth.file ?? '<missing>') + ' (' + install.scsynth.source + ')')
          lines.push('  supernova=' + (install.supernova.file ?? '<missing>') + ' (' + install.supernova.source + ')')
          lines.push('  scide=' + (install.scide.file ?? '<missing>') + ' (' + install.scide.source + ')')
        }
        lines.push('- docs_root=' + (helpRoot.root ?? '<not found>') + (helpRoot.root === null ? ' (sc_help has nothing to search)' : ''))
        lines.push('- tools: 10 (sc_status, sc_help, sc_check, sc_exec, sc_play, sc_project, sc_load, sc_synthdef, sc_nodes, sc_server)')

        if (snapshot.servers.length === 0) {
          lines.push('- audio_servers=none running')
        } else {
          lines.push('- audio_servers=' + snapshot.servers.length)
          for (const server of snapshot.servers) {
            lines.push(
              '  pid=' + server.pid +
              ' role=' + server.role +
              ' osc_reachable=' + server.oscReachable +
              ' responding_port=' + (server.respondingPort ?? '<none>') +
              ' candidate_ports=[' + server.candidatePorts.join(',') + ']' +
              ' rss_mib=' + (server.rssBytes === null ? '<unavailable>' : (server.rssBytes / (1024 * 1024)).toFixed(1)),
            )
            lines.push('    exe=' + (server.exePath ?? '<unknown>'))
            lines.push('    cmdline=' + (server.cmdline || '<empty>'))
          }
        }
        if (snapshot.languages.length > 0) {
          lines.push('- sclang_processes=' + snapshot.languages.map((entry) => entry.pid).join(','))
        }
        if (snapshot.ides.length > 0) {
          lines.push('- scide_processes=' + snapshot.ides.map((entry) => entry.pid).join(','))
        }
        lines.push(
          '- probed_ports: ' +
            (Object.keys(snapshot.ports).length === 0
              ? 'none'
              : Object.entries(snapshot.ports).map(([port, up]) => port + '=' + (up ? 'up' : 'down')).join(' ')),
        )
        lines.push('- session: interpreter=' + (session.sclang.alive ? 'warm' : 'not started') + ' bound_port=' + (session.sclang.boundPort ?? '<none>') + ' tracked_pid=' + (session.trackedPid ?? '<none>'))
        lines.push('- docs_index=' + (docsStatus.root === null ? 'no root' : 'root resolved, built_on_first_search'))

        if (selected !== null) {
          const metrics = selected.oscReachable ? await session.scsynth.status({ port: selected.respondingPort }) : null
          if (metrics !== null && metrics.up) {
            lines.push(
              '- selected_server pid=' + selected.pid +
                ' sr=' + (metrics.metrics.nominalSampleRate ?? '<unknown>') +
                ' actual_sr=' + (metrics.metrics.actualSampleRate === null ? '<unknown>' : Math.round(metrics.metrics.actualSampleRate)) +
                ' synths=' + (metrics.metrics.synthCount ?? '<unknown>') +
                ' groups=' + (metrics.metrics.groupCount ?? '<unknown>') +
                ' synthdefs=' + (metrics.metrics.synthDefCount ?? '<unknown>') +
                ' avg_cpu=' + (metrics.metrics.avgCpu === null ? '<unknown>' : (metrics.metrics.avgCpu * 100).toFixed(1) + '%') +
                ' peak_cpu=' + (metrics.metrics.peakCpu === null ? '<unknown>' : (metrics.metrics.peakCpu * 100).toFixed(1) + '%'),
            )
          }
        }
        return {
          ok: true,
          text: lines.join('\n'),
          ms: snapshot.durationMs,
          view: {
            port: selected?.respondingPort ?? undefined,
            pid: selected?.pid ?? undefined,
            summary:
              install.dir === null
                ? 'no SuperCollider found'
                : (snapshot.servers.length === 0
                    ? 'SuperCollider ' + (version.version ?? '') + ' installed, no audio server running'
                    : 'SuperCollider ' + (version.version ?? '') + ', ' + snapshot.servers.length + ' server(s)'),
          },
        }
      })
    },
  }

  // -------------------------------------------------------------------------
  // sc_help — the local documentation
  // -------------------------------------------------------------------------
  const help = {
    name: 'sc_help',
    description: [
      'Search the SuperCollider help that is installed on this machine (the `.schelp` reference — over a thousand files) and read it. This is the authority on what a class or a method actually does: SuperCollider is old, large and full of near-misses, so a guess from general knowledge about DSP is a guess about *this* language.',
      '`search` returns ranked sections with an excerpt and the file each came from. `answer` returns the three best sections as evidence for a question — it does not synthesise, it quotes, so you can read the truth and write the sentence yourself. `class` reads one class or topic page by name (a title like `SinOsc`, or a path like `Guides/Server-Guide`). `index` reports whether an index exists and how many files it covers; `refresh` rebuilds it after an install changed.',
      'Use it before writing code that names a UGen, a method or an argument you are not certain about, and whenever a snippet fails with "doesNotUnderstand" or a wrong-argument error.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['search', 'answer', 'class', 'index', 'refresh'], description: 'What to do.' },
        query: { type: 'string', description: 'For `search` and `answer`: the words to look for, e.g. "sine oscillator frequency".' },
        name: { type: 'string', description: 'For `class`: the help page to read — a class name like "SinOsc", or a path like "Guides/Server-Guide" or "Reference/Server-Command-Reference".' },
        maxResults: { type: 'number', description: 'For `search`: how many sections to return (default 5, maximum 12).' },
        maxChars: { type: 'number', description: 'For `class`: how much of the page to return (default 4000, maximum 20000).' },
      },
    },
    output,
    presentCall: (args) => ({ card: 'generic', title: 'SuperCollider docs: ' + String(args?.action ?? 'search'), kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'SuperCollider docs', content: result.text }),
    async execute(args, exec) {
      return run('sc_help', args, exec, async () => {
        if (args.action === 'index') {
          const state = await docsIndexStatus(session.docs)
          const lines = ['SuperCollider docs index status']
          lines.push('- help_root_resolved=' + (state.root ?? '<not found>'))
          lines.push('- doc_files_on_disk=' + state.filesOnDisk)
          lines.push('- index_loaded=' + state.loaded)
          if (state.loaded) {
            lines.push('- files_indexed=' + state.filesIndexed + ' chunks=' + state.chunks + ' built_at=' + state.builtAt)
            if (state.stale) lines.push('- note: the help tree on disk is not the one the index was built from; run refresh')
          }
          lines.push('- query_synonyms_active=true (' + state.synonyms + ' groups)')
          return { ok: true, text: lines.join('\n'), view: { summary: state.loaded ? state.filesIndexed + ' files indexed' : 'not built' } }
        }
        if (args.action === 'refresh') {
          session.docs.invalidate()
          const built = await session.docs.ensure({ force: true })
          if (!built.ok) return { ok: false, text: 'Could not build the docs index: ' + built.error, view: { summary: 'index unavailable' } }
          return {
            ok: true,
            text: 'Docs index refreshed.\n- help_root=' + built.index.root + '\n- files_indexed=' + built.index.filesIndexed + '\n- chunks=' + built.index.chunks.length + '\n- build_ms=' + built.index.buildMs,
            view: { summary: built.index.filesIndexed + ' files, ' + built.index.chunks.length + ' chunks' },
          }
        }
        if (args.action === 'class') {
          const wanted = String(args.name ?? '').trim()
          if (wanted === '') return { ok: false, text: '`name` is required for action=class — a class name like SinOsc, or a path like Guides/Server-Guide.', view: { summary: 'no page named' } }
          const root = resolveHelpRoot({ env: session.env, install: session.install ?? session.refreshInstall() })
          if (root.root === null) {
            return { ok: false, text: 'No SuperCollider help tree was found, so there is nothing to read. Looked for Help/HelpSource under: ' + root.candidates.slice(0, 5).join(', '), view: { summary: 'no help tree' } }
          }
          const candidates = []
          const slug = wanted.replace(/\.schelp$/, '')
          candidates.push(path.join(root.root, slug + '.schelp'))
          candidates.push(path.join(root.root, 'Classes', slug + '.schelp'))
          candidates.push(path.join(root.root, 'Guides', slug + '.schelp'))
          candidates.push(path.join(root.root, 'Reference', slug + '.schelp'))
          candidates.push(path.join(root.root, 'Overviews', slug + '.schelp'))
          candidates.push(path.join(root.root, slug))
          let file = null
          for (const candidate of candidates) {
            try {
              const stat = await fsp.stat(candidate)
              if (stat.isFile()) {
                file = candidate
                break
              }
            } catch (err) {
              /* keep looking */
            }
          }
          if (file === null) {
            // The page may be discoverable by search even when the name is not a
            // path: report the closest hits rather than only the miss.
            const near = await session.docs.search({ query: wanted, maxResults: 3 })
            const hint = near.ok && near.results.length > 0 ? '\nClosest indexed sections:\n' + near.results.map((hit) => '  ' + hit.title + ' [' + hit.section + '] ' + hit.sourcePath).join('\n') : ''
            return { ok: false, text: 'No help page named "' + wanted + '" under ' + root.root + '.' + hint, view: { summary: 'no such page' } }
          }
          const read = await readText(file)
          if (!read.ok) return { ok: false, text: 'Could not read ' + file + ': ' + read.error, view: { file, summary: 'unreadable' } }
          const limit = Math.max(500, Math.min(20_000, Number.isFinite(args.maxChars) ? args.maxChars : 4_000))
          const body = read.text.length > limit ? read.text.slice(0, limit) + '\n… [truncated at ' + limit + ' characters; the file is ' + read.text.length + ']' : read.text
          return {
            ok: true,
            text: file + '\n\n' + body,
            view: { file, summary: path.basename(file) },
          }
        }
        const query = String(args.query ?? '').trim()
        if (query === '') return { ok: false, text: '`query` is required for action=' + args.action + '.', view: { summary: 'no query' } }
        if (args.action === 'answer') {
          const answer = await session.docs.answer({ question: query, count: 3 })
          if (!answer.ok) return { ok: false, text: answer.error, view: { summary: 'docs unavailable' } }
          return { ok: true, text: formatAnswer(answer), view: { summary: answer.results.length + ' evidence section(s)' } }
        }
        const maxResults = Number.isFinite(args.maxResults) ? args.maxResults : 5
        const searched = await session.docs.search({ query, maxResults })
        if (!searched.ok) return { ok: false, text: searched.error, view: { summary: 'docs unavailable' } }
        return { ok: true, text: formatSearch(searched), view: { summary: searched.results.length + ' result(s)' } }
      })
    },
  }

  // -------------------------------------------------------------------------
  // sc_check — compile without running
  // -------------------------------------------------------------------------
  const check = {
    name: 'sc_check',
    description: [
      'Compile-check sclang code without running it and without making a sound. It runs in its own short-lived interpreter, so a bad snippet cannot disturb the live session.',
      'Use it before `sc_exec` on anything longer than a line or two, and after you have written or edited a `.scd` file, so a syntax error is reported as a syntax error rather than as a confusing runtime failure.',
      'It costs roughly half a second to two seconds: that is the SuperCollider class library loading, exactly as it would for any sclang process.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['code'],
      properties: {
        code: { type: 'string', description: 'The sclang source to compile-check. It is not executed.' },
        file: { type: 'string', description: 'Optional: check this file instead of the inline `code` (a path relative to the conversation workspace, or absolute).' },
      },
    },
    output,
    presentCall: (args) => ({ card: 'generic', title: 'Check sclang' + (args?.file ? ' ' + args.file : ''), kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'sclang check', content: result.text }),
    async execute(args, exec) {
      return run('sc_check', args, exec, async () => {
        let code = String(args.code ?? '')
        if (typeof args.file === 'string' && args.file.trim() !== '') {
          const read = await readSource({ file: args.file, root: projectRoot(deps.env) })
          if (!read.ok) return { ok: false, text: read.error, view: { file: read.file ?? '', summary: 'could not read that file' } }
          watch(read.file)
          code = read.text
        }
        if (code.trim() === '') return { ok: false, text: 'Nothing to check: pass `code`, or a `file` that has some.', view: { summary: 'empty' } }
        const result = await session.check({ code, signal: exec?.signal })
        if (result.ok) {
          return {
            ok: true,
            text: 'sclang syntax: OK\n- the code compiled cleanly and was NOT executed\n- note: loading the class library costs roughly 0.5-2s per check',
            ms: result.ms,
            view: { summary: 'compiles' },
          }
        }
        const tail = String(result.output ?? '').trim()
        return {
          ok: false,
          text: 'sclang syntax: ERROR\n- ' + result.error + '\n' + (tail === '' ? '' : '\n--- sclang said ---\n' + tail.split('\n').slice(-25).join('\n')),
          ms: result.ms,
          view: { summary: 'syntax error' },
        }
      })
    },
  }

  // -------------------------------------------------------------------------
  // sc_exec — run code in the live session
  // -------------------------------------------------------------------------
  const execTool = {
    name: 'sc_exec',
    description: [
      'Run sclang code in a session that STAYS ALIVE between calls. This is the real-time core of the plugin: everything you define — a `~variable`, a `SynthDef`, an `Ndef`, a `Pbind` that is playing — is still there on the next call, so you build a piece up rather than re-creating it each time. A first call costs about a second while the interpreter and the class library load; every call after that answers in tens of milliseconds.',
      'The interpreter\'s default server is pointed at the live audio server, so an ordinary snippet works as written: `{ SinOsc.ar(440, 0, 0.2) }.play`, `Synth(\\tone, [freq: 220])`, `Ndef(\\drone, { LFTri.ar(55) * 0.1 }).play`.',
      'Code that runs longer than the deadline means it is stuck; the interpreter is then restarted and the answer says so, because a half-evaluated interpreter is not something to keep using.',
      'A large answer (a big collection printed with `.postln`, a long string) is written to a file and the answer carries the path and its SHA-256 — read it with the file tools rather than expecting it inline.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['code'],
      properties: {
        code: { type: 'string', description: 'sclang code to evaluate. The last expression\'s value is returned, e.g. "{ SinOsc.ar(440, 0, 0.2) }.play" or "(1 + 1).postln".' },
        timeoutMs: { type: 'number', description: 'Kill the request after this many milliseconds (default 15000, maximum 120000). A timed-out request restarts the interpreter.' },
        port: { type: 'number', description: 'Point the default server at this UDP port instead of the auto-detected one.' },
      },
    },
    output,
    presentCall: (args) => ({ card: 'generic', title: 'sclang: ' + firstLine(args?.code), kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'sclang', content: result.text }),
    async execute(args, exec) {
      return run('sc_exec', args, exec, async () => {
        const code = String(args.code ?? '')
        if (code.trim() === '') return { ok: false, text: 'Nothing to run: pass some code.', view: { summary: 'empty' } }
        const result = await session.evaluate({ code, timeoutMs: args.timeoutMs, port: args.port })
        if (!result.ok) {
          const lines = ['sc_exec failed: ' + result.error]
          if (result.port !== null) lines.push('- server_port=' + result.port)
          if (result.text) lines.push('\n--- the interpreter said ---\n' + result.text)
          if (result.daemonRestarted) lines.push('\nThe interpreter was restarted, so anything the stuck code defined is gone. Check for a loop (`.wait` on the main thread deadlocks headless sclang; `while(true)` never yields).')
          return { ok: false, text: lines.join('\n'), ms: result.ms, view: { port: result.port ?? undefined, summary: shortReason(result.error) } }
        }
        const lines = ['sc_exec: OK (' + result.ms + ' ms)']
        if (result.port !== null) lines.push('- server_port=' + result.port + (result.server === null ? '' : ' pid=' + result.server.pid))
        if (result.kind === 'file') {
          lines.push('- the answer was too large to return inline; it is in a file:')
          lines.push('  ' + result.file)
          lines.push('  bytes=' + result.bytes)
          lines.push('  read it with the file tools (it is plain text)')
        } else {
          lines.push('- result=' + (result.text === '' ? '<no value printed>' : clip(result.text, 2_000)))
        }
        if (session.sclang.boundPort !== null) lines.push('- note: the session\'s default server is 127.0.0.1:' + session.sclang.boundPort)
        return { ok: true, text: lines.join('\n'), ms: result.ms, view: { port: result.port ?? undefined, file: result.file ?? '', summary: clip(result.text, 80) || 'ran' } }
      })
    },
  }

  // -------------------------------------------------------------------------
  // sc_play — a known-good tone
  // -------------------------------------------------------------------------
  const play = {
    name: 'sc_play',
    description: [
      'Play a short, deterministic sine tone and report exactly what the server did — the "is sound working at all" test.',
      'It is deliberately not an art tool: it compiles a known SynthDef, sends it, creates one node, asks the server how many synth nodes exist, and then frees it. If there is no sound on the machine, this is where you find that out, and the answer tells you which part failed: no server, no device, a SynthDef that would not load, or a node that was never created.',
      'Call it before a long piece when you have any doubt about the audio path, and after `sc_server` with action=diagnose when that says the server is up but you still hear nothing.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        freq_hz: { type: 'number', description: 'Frequency in Hz (default 440).' },
        amp: { type: 'number', description: 'Amplitude 0..1 (default 0.15). Keep it modest: this goes to the user\'s real speakers.' },
        duration_s: { type: 'number', description: 'How long the tone lasts in seconds (default 1).' },
        node_id: { type: 'number', description: 'Node id to use (default 1000, which the tone is also freed from).' },
      },
    },
    output,
    presentCall: (args) => ({ card: 'generic', title: 'Test tone ' + String(args?.freq_hz ?? 440) + ' Hz', kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Test tone', content: result.text }),
    async execute(args, exec) {
      return run('sc_play', args, exec, async () => {
        const freq = Number.isFinite(args.freq_hz) ? Number(args.freq_hz) : 440
        const amp = Number.isFinite(args.amp) ? Number(args.amp) : 0.15
        const duration = Number.isFinite(args.duration_s) ? Number(args.duration_s) : 1
        if (!(freq > 0)) return { ok: false, text: 'freq_hz must be greater than 0.', view: { summary: 'bad frequency' } }
        if (!(amp > 0 && amp <= 1)) return { ok: false, text: 'amp must be greater than 0 and at most 1.', view: { summary: 'bad amplitude' } }
        if (!(duration > 0)) return { ok: false, text: 'duration_s must be greater than 0.', view: { summary: 'bad duration' } }

        const ensured = await session.ensureServer({})
        if (!ensured.ok) {
          return {
            ok: false,
            text:
              'No audio server is available, so nothing could be played.\n- ' + ensured.error +
              '\n- call sc_server with action=boot to start one, or sc_status to see what is installed.',
            view: { port: ensured.port ?? undefined, summary: 'no audio server' },
          }
        }
        const port = ensured.port
        const name = 'dsh_sc_probe'
        const nodeId = Number.isInteger(args.node_id) ? args.node_id : 1000
        const def = 'SynthDef(\\' + name + ', { |freq = 440, amp = 0.15| Out.ar(0, SinOsc.ar(freq, 0, amp) * EnvGen.kr(Env.perc(0.01, ' + (duration * 0.6).toFixed(3) + '), doneAction: 2)) })'
        const compiled = await session.compileSynthDef({ name, source: def })
        if (!compiled.ok) {
          return {
            ok: false,
            text: 'The test tone\'s SynthDef would not compile: ' + compiled.error + (compiled.detail ? '\n' + compiled.detail : ''),
            view: { port, summary: 'SynthDef failed' },
          }
        }
        const loaded = await session.loadSynthDef({ name, file: compiled.file, port, force: true })
        if (!loaded.ok) {
          return { ok: false, text: 'Could not send the SynthDef to the server on port ' + port + ': ' + loaded.error, view: { port, summary: 'send failed' } }
        }
        const before = await session.scsynth.status({ port })
        const created = await session.scsynth.newSynth({ name, nodeId, params: { freq, amp } })
        if (!created.ok) {
          return { ok: false, text: 'The SynthDef loaded but /s_new failed: ' + created.error, view: { port, summary: 's_new failed' } }
        }
        // Give the server a moment to actually build the node before asking it,
        // and retry once: /d_load completion timing varies on a slow first boot.
        let during = null
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await delay(120)
          during = await session.scsynth.status({ port })
          if (during.metrics?.synthCount !== null && during.metrics?.synthCount > 0) break
        }
        await delay(Math.min(3_000, duration * 1_000))
        // Free only what was actually there: a tone whose envelope already ended
        // and freed its own node makes `/n_free` fail with `Node not found`,
        // which is not an error the user should be shown.
        const stillThere = (during?.metrics?.synthCount ?? 0) > 0
        const freed = stillThere ? await session.scsynth.freeNode({ port, node: nodeId }) : { ok: true, error: null }
        await delay(120)
        const after = await session.scsynth.status({ port })

        const created2 = during?.metrics?.synthCount ?? null
        const lines = []
        const worked = created2 !== null && created2 > 0
        lines.push('sc_play: ' + (worked ? 'OK' : 'NO SOUND CONFIRMED') + ' — ' + freq + ' Hz, amp ' + amp + ', ' + duration + 's')
        lines.push('- server_port=' + port + ' pid=' + (ensured.pid ?? '<unknown>') + (ensured.booted ? ' (booted by this call)' : ensured.reused ? ' (already running)' : ''))
        lines.push('- synthdef=' + name + ' compiled=' + compiled.bytes + ' bytes, sent to the server')
        lines.push('- synth_nodes before=' + (before.metrics?.synthCount ?? '<unknown>') + ' during=' + (created2 ?? '<unknown>') + ' after=' + (after.metrics?.synthCount ?? '<unknown>'))
        lines.push('- freed=' + (freed.ok ? 'yes' : 'no (' + freed.error + ')'))
        if (!worked) {
          lines.push('')
          lines.push('The SynthDef loaded and the server accepted the node, but the synth count never rose. That is usually the audio device rather than the language: run sc_server with action=diagnose to see the device scsynth selected and the tail of its log.')
        }
        return {
          ok: worked,
          text: lines.join('\n'),
          view: { port, pid: ensured.pid ?? undefined, summary: worked ? 'tone played on port ' + port : 'no node was created' },
        }
      })
    },
  }

  // -------------------------------------------------------------------------
  // sc_project — the .scd files
  // -------------------------------------------------------------------------
  const project = {
    name: 'sc_project',
    description: [
      'Work with `.scd` SuperCollider files on disk — how SuperCollider is actually used. `list` finds the source files under a directory, `read` returns one, `write` creates or replaces one atomically, and `send` evaluates a file that is on disk in the live session (the edit-here / hear-it loop).',
      '`examples` lists the playable instruments this package ships (a modal gong, an FM bell, a plucked string, drum voices, drones, granular and feedback textures, a bitcrusher, a theremin) and, with `file` or an index, reads one and sends it straight into the live session — each file ends by defining a `~helper` you can trigger. START FROM THESE instead of writing an instrument from nothing: they are known to sound like what they say, and each one explains the single DSP idea it is built on.',
      'A relative path resolves against the conversation workspace; an absolute path is allowed and is reported back resolved. Only SuperCollider source extensions are accepted (`.scd`, `.sc`, `.schelp`, `.scsyndef`).',
      '`write` will not replace an existing file unless you pass `overwrite: true`, so an agent cannot silently discard a file the user wrote by hand.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'write', 'send', 'examples'], description: 'What to do.' },
        file: { type: 'string', description: 'The `.scd` file. Relative paths resolve against the conversation workspace. For `examples`, an example name, slug or number (e.g. "3", "03-fm-bell") to read and send; with no `file` the whole catalogue is listed.' },
        code: { type: 'string', description: 'For `write`: the source text to write.' },
        dir: { type: 'string', description: 'For `list`: the directory to search (default the workspace).' },
        depth: { type: 'number', description: 'For `list`: how deep to recurse (default 3, maximum 6).' },
        overwrite: { type: 'boolean', description: 'For `write`: allow replacing an existing file.' },
      },
    },
    output,
    presentCall: (args) => ({ card: 'generic', title: 'sc_project ' + String(args?.action ?? '') + ' ' + String(args?.file ?? args?.dir ?? ''), kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'SuperCollider project', content: result.text }),
    async execute(args, exec) {
      return run('sc_project', args, exec, async () => {
        if (args.action === 'examples') {
          // No `file`: the catalogue, which is the list of things worth hearing.
          if (args.file === undefined || String(args.file).trim() === '') {
            const { dir, examples } = listExamples()
            if (examples.length === 0) {
              return { ok: false, text: 'No examples are installed beside this package (' + dir + ' is missing or empty).', view: { summary: 'no examples' } }
            }
            const lines = ['Playable examples shipped with this package (' + examples.length + '), in ' + dir, '']
            for (const entry of examples) {
              lines.push('  ' + entry.file)
              lines.push('      ' + entry.summary)
              if (entry.synthDef !== null) {
                lines.push('      SynthDef \\' + entry.synthDef + (entry.helper === null ? '' : '   helper ' + entry.helper))
              }
            }
            lines.push('')
            lines.push('Read and send one with: sc_project action=examples file="3"   (or the file name, or part of it).')
            lines.push('Each file loads its instrument AND defines a `~helper`; trigger it with sc_exec, e.g. ~fmBell.value(440).')
            return { ok: true, text: lines.join('\n'), view: { summary: examples.length + ' example(s)' } }
          }
          // One example: read it, define it in the live session, and say how to play it.
          const found = findExample(args.file)
          if (found === null) {
            const { examples } = listExamples()
            return {
              ok: false,
              text:
                'No example matches "' + String(args.file) + '". Available: ' +
                examples.map((entry) => entry.slug).join(', ') +
                '. Pass a number or part of a name, or call action=examples with no `file` for the catalogue.',
              view: { summary: 'no such example' },
            }
          }
          const result = await session.evaluate({ code: found.text, timeoutMs: 60_000 })
          if (!result.ok) {
            return {
              ok: false,
              text: 'Loading the example ' + found.file + ' failed: ' + result.error + (result.text ? '\n\n--- the interpreter said ---\n' + result.text : ''),
              view: { file: found.file, summary: 'example failed' },
            }
          }
          const lines = [
            'Loaded ' + found.file + ' — ' + found.summary,
            '- SynthDef \\' + (found.synthDef ?? '<unknown>') + ' is now on the server' +
              (found.helper === null ? '' : ', and ' + found.helper + ' is defined in the live session'),
            '',
            'Play it with sc_exec, for example:',
            '  ' + found.helper + '.value(...)',
            '',
            'Measure it with sc_capture to see what it actually sounds like before describing it. The file:',
            '',
            found.text,
          ]
          return { ok: true, text: lines.join('\n'), ms: result.ms, view: { file: found.file, port: result.port ?? undefined, summary: 'example loaded' } }
        }
        if (args.action === 'list') {
          const listed = await listSources({ dir: args.dir ?? '.', root: projectRoot(deps.env), depth: args.depth })
          if (!listed.ok) return { ok: false, text: listed.error, view: { summary: 'cannot list' } }
          // Listing a directory is how the console learns which files to follow:
          // a change to one of them is what the console route reports.
          for (const entry of listed.files) watch(entry.file)
          const lines = ['SuperCollider source files under ' + listed.dir + ' (' + listed.files.length + ')']
          for (const entry of listed.files) {
            lines.push('  ' + entry.relative + '  ' + entry.bytes + ' bytes  ' + new Date(entry.mtimeMs).toISOString())
          }
          if (listed.files.length === 0) lines.push('  (none — a .scd here would be a new piece)')
          return { ok: true, text: lines.join('\n'), view: { file: listed.dir ?? '', summary: listed.files.length + ' file(s)' } }
        }
        if (args.action === 'read') {
          const read = await readSource({ file: args.file, root: projectRoot(deps.env) })
          if (!read.ok) return { ok: false, text: read.error, view: { file: read.file ?? '', summary: 'cannot read' } }
          watch(read.file)
          return {
            ok: true,
            text: read.file + ' (' + read.bytes + ' bytes)\n\n' + read.text,
            view: { file: read.file, summary: read.bytes + ' bytes' },
          }
        }
        if (args.action === 'write') {
          const written = await writeSource({ file: args.file, root: projectRoot(deps.env), text: args.code, overwrite: args.overwrite })
          watch(written.file)
          if (!written.ok) return { ok: false, text: written.error, view: { file: written.file ?? '', summary: 'not written' } }
          return {
            ok: true,
            text: (written.created ? 'created ' : 'replaced ') + written.file + ' (' + written.bytes + ' bytes)',
            view: { file: written.file, summary: written.created ? 'created' : 'replaced' },
          }
        }
        // send
        const read = await readSource({ file: args.file, root: projectRoot(deps.env) })
        if (!read.ok) return { ok: false, text: read.error, view: { file: read.file ?? '', summary: 'cannot read' } }
          watch(read.file)
        if (read.text.trim() === '') return { ok: false, text: read.file + ' is empty.', view: { file: read.file, summary: 'empty' } }
        const result = await session.evaluate({ code: read.text, timeoutMs: 60_000 })
        if (!result.ok) {
          return {
            ok: false,
            text: 'Sending ' + read.file + ' failed: ' + result.error + (result.text ? '\n\n--- the interpreter said ---\n' + result.text : ''),
            view: { file: read.file, port: result.port ?? undefined, summary: 'send failed' },
          }
        }
        return {
          ok: true,
          text:
            'Sent ' + read.file + ' to the live session (' + result.ms + ' ms, port ' + (result.port ?? '<none>') + ').\n' +
            '- the file was read from disk, evaluated as one block, and every `~variable` / `Ndef` / `Pbind` it defined is still running\n' +
            '- result=' + (result.text === '' ? '<no value printed>' : clip(result.text, 800)),
          ms: result.ms,
          view: { file: read.file, port: result.port ?? undefined, summary: 'sent' },
        }
      })
    },
  }

  // -------------------------------------------------------------------------
  // sc_load — a file into the session (the short form of sc_project send)
  // -------------------------------------------------------------------------
  const load = {
    name: 'sc_load',
    description: [
      'Evaluate a `.scd` file that is on disk in the live session — the short form of `sc_project` with action=send, and the tool to reach for when the user says "load my piece" or "run this file".',
      'The file is read from disk at the moment of the call, so it is the file the user is looking at, and everything it defines stays live afterwards. Nothing is written back: this never modifies the file.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['file'],
      properties: {
        file: { type: 'string', description: 'The `.scd` (or `.sc`) file to evaluate. Relative paths resolve against the conversation workspace.' },
        timeoutMs: { type: 'number', description: 'Deadline in milliseconds (default 60000, maximum 120000).' },
      },
    },
    output,
    presentCall: (args) => ({ card: 'generic', title: 'Load ' + String(args?.file ?? ''), kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Loaded', content: result.text }),
    async execute(args, exec) {
      return run('sc_load', args, exec, async () => {
        const read = await readSource({ file: args.file, root: projectRoot(deps.env) })
        if (!read.ok) return { ok: false, text: read.error, view: { file: read.file ?? '', summary: 'cannot read' } }
          watch(read.file)
        const result = await session.evaluate({ code: read.text, timeoutMs: args.timeoutMs ?? 60_000 })
        if (!result.ok) {
          return {
            ok: false,
            text: 'Loading ' + read.file + ' failed: ' + result.error + (result.text ? '\n\n--- the interpreter said ---\n' + result.text : ''),
            view: { file: read.file, port: result.port ?? undefined, summary: 'load failed' },
          }
        }
        return {
          ok: true,
          text: read.file + ' loaded in ' + result.ms + ' ms (port ' + (result.port ?? '<none>') + ').\n- result=' + (result.text === '' ? '<no value printed>' : clip(result.text, 800)),
          ms: result.ms,
          view: { file: read.file, port: result.port ?? undefined, summary: 'loaded' },
        }
      })
    },
  }

  // -------------------------------------------------------------------------
  // sc_synthdef — compile / list / load / free
  // -------------------------------------------------------------------------
  const synthdef = {
    name: 'sc_synthdef',
    description: [
      'Manage SynthDefs — the unit of sound design in SuperCollider. `define` compiles a `SynthDef(...)` source into its `.scsyndef` bytes and sends it to the running server; `list` shows what this session has compiled and what is loaded where; `source` returns the source of a compiled def so it can be edited; `free` removes one from the server.',
      'Defining a def by hand in `sc_exec` also works, but this tool is the one that survives a reboot: it caches the compiled bytes under `$DSH_HOME/dsh-supercollider/synthdefs/`, keyed by the source\'s SHA-256, so re-loading after `sc_server` action=reboot costs nothing. It also keeps track of which defs a given server port has, because a SynthDef is loaded per server and `/s_new` fails with "SynthDef not found" when it is not.',
      'Give `name` and `body`: the body is the part inside `SynthDef(\\name, { ... })`, so `|freq = 440| Out.ar(0, SinOsc.ar(freq) * 0.1)` is a complete body.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['define', 'list', 'load', 'source', 'free'], description: 'What to do.' },
        name: { type: 'string', description: 'The SynthDef name (for every action except `list`).' },
        body: { type: 'string', description: 'For `define`: the function body inside SynthDef(\\\\name, { ... }).' },
        source: { type: 'string', description: 'For `define`: a complete `SynthDef(\\\\name, {...})` expression instead of `name` + `body`.' },
        port: { type: 'number', description: 'A server port to load onto, or to free from. Default: the detected server.' },
      },
    },
    output,
    presentCall: (args) => ({ card: 'generic', title: 'SynthDef ' + String(args?.action ?? '') + ' ' + String(args?.name ?? ''), kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'SynthDefs', content: result.text }),
    async execute(args, exec) {
      return run('sc_synthdef', args, exec, async () => {
        if (args.action === 'list') {
          const cached = await session.listSynthDefs()
          const lines = ['SynthDefs this session has compiled (' + cached.length + ')']
          for (const entry of cached) {
            lines.push('  ' + entry.name + '  ' + entry.bytes + ' bytes  ' + entry.file + '  (' + entry.at + ')')
          }
          if (cached.length === 0) lines.push('  (none yet — sc_synthdef define compiles one)')
          lines.push('')
          lines.push('Loaded per server port:')
          if (session.loaded.size === 0) lines.push('  (none reported loaded; loading happens on define or load)')
          for (const [port, names] of session.loaded) lines.push('  port ' + port + ': ' + [...names].join(', '))
          return { ok: true, text: lines.join('\n'), view: { summary: cached.length + ' compiled' } }
        }

        const name = String(args.name ?? '').trim()
        if (name === '') return { ok: false, text: '`name` is required for action=' + args.action + '.', view: { summary: 'no name' } }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          return { ok: false, text: 'A SynthDef name must be a valid identifier (letters, digits and _, not starting with a digit): "' + name + '" is not.', view: { summary: 'bad name' } }
        }

        if (args.action === 'source') {
          const cached = (await session.listSynthDefs()).find((entry) => entry.name === name) ?? null
          if (cached === null) return { ok: false, text: 'No compiled SynthDef named ' + name + '. Sc_synthdef list shows what there is.', view: { summary: 'not found' } }
          return { ok: true, text: cached.source, view: { file: cached.file, summary: name } }
        }

        if (args.action === 'free') {
          const target = await session.target({ port: args.port })
          if (!target.ok) return { ok: false, text: target.error, view: { summary: 'no server' } }
          // scsynth has no "remove one SynthDef"; /d_free exists in SuperCollider
          // as a server-side command, and unloading is by name.
          const sent = await session.scsynth.send({ port: target.port, address: '/d_free', args: [name] })
          if (!sent.ok) return { ok: false, text: 'Could not free ' + name + ' on port ' + target.port + ': ' + sent.error, view: { port: target.port, summary: 'free failed' } }
          const names = session.loaded.get(target.port)
          if (names !== undefined) names.delete(name)
          return { ok: true, text: 'Sent /d_free for ' + name + ' to port ' + target.port + '. Running synths that already use it keep playing until they end or are freed.', view: { port: target.port, summary: name + ' freed' } }
        }

        // define (and load, which is define without recompiling when cached)
        let source
        if (typeof args.source === 'string' && args.source.trim() !== '') {
          source = args.source.trim()
        } else if (typeof args.body === 'string' && args.body.trim() !== '') {
          source = 'SynthDef(\\' + name + ', { ' + args.body.trim() + ' })'
        } else {
          return {
            ok: false,
            text: 'Give either `source` (a complete SynthDef(\\\\name, {...}) expression) or `body` (the function body inside it).',
            view: { summary: 'nothing to compile' },
          }
        }
        const compiled = await session.compileSynthDef({ name, source })
        if (!compiled.ok) {
          return {
            ok: false,
            text: 'Could not compile ' + name + ': ' + compiled.error + (compiled.detail ? '\n\n--- the interpreter said ---\n' + compiled.detail : ''),
            view: { summary: 'compile failed' },
          }
        }
        await session.rememberSynthDef({ name, source, file: compiled.file, bytes: compiled.bytes, digest: name + ':' + compiled.bytes })

        const target = await session.target({ port: args.port })
        if (!target.ok) {
          return {
            ok: true,
            text:
              name + ' compiled (' + compiled.bytes + ' bytes) into ' + compiled.file + '.\n' +
              'It was NOT sent to a server: ' + target.error + '\n' +
              'Call sc_server with action=boot, then sc_synthdef with action=load.',
            view: { file: compiled.file, summary: 'compiled, not loaded' },
          }
        }
        const loaded = await session.loadSynthDef({ name, file: compiled.file, port: target.port, force: true })
        if (!loaded.ok) {
          return { ok: false, text: 'Compiled ' + name + ', but could not send it to port ' + target.port + ': ' + loaded.error, view: { file: compiled.file, port: target.port, summary: 'send failed' } }
        }
        const verifiedLine = loaded.verified
          ? '- the server confirmed a new SynthDef is resident'
          : '- WARNING: ' + loaded.note
        return {
          ok: true,
          text:
            'SynthDef ' + name + ' defined and loaded.\n' +
            '- bytes=' + compiled.bytes + ' file=' + compiled.file + '\n' +
            '- server_port=' + target.port + ' pid=' + (target.server?.pid ?? '<unknown>') + '\n' +
            verifiedLine + '\n' +
            '- create a node with sc_nodes action=new name=' + name + ', or from sclang with Synth(\\' + name + ')',
          ms: compiled.ms,
          view: { file: compiled.file, port: target.port, summary: name + ' loaded' },
        }
      })
    },
  }

  // -------------------------------------------------------------------------
  // sc_nodes — the running graph
  // -------------------------------------------------------------------------
  const nodes = {
    name: 'sc_nodes',
    description: [
      'The running audio graph. `tree` prints what the server is actually playing (the server\'s own `/g_queryTree`), `set` changes controls on a running node, `free` stops one node, `free_all` stops everything in a group, and `new` creates a node from a SynthDef that is already loaded.',
      'This is the live-performance surface: `set` is how you change a filter cutoff or a frequency while a piece is playing, without redefining anything and without stopping the sound. Node ids come from `tree` — or from the `node_id` you passed to `sc_play`.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['tree', 'set', 'free', 'free_all', 'new'], description: 'What to do.' },
        node: { type: 'number', description: 'The node id: required for `set` and `free`; the group for `free_all` and the target for `new` (default 0, the root group).' },
        name: { type: 'string', description: 'For `new`: the name of a SynthDef that is loaded on the target server.' },
        params: { type: 'object', description: 'Control names to values, e.g. {"freq": 220, "amp": 0.1}. Numbers only: scsynth controls are floats.' },
        node_id: { type: 'number', description: 'For `new`: the id to give the new node (-1 asks the server to choose).' },
        port: { type: 'number', description: 'Target server UDP port. Default: the detected server.' },
      },
    },
    output,
    presentCall: (args) => ({ card: 'generic', title: 'sc_nodes ' + String(args?.action ?? 'tree'), kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Audio graph', content: result.text }),
    async execute(args, exec) {
      return run('sc_nodes', args, exec, async () => {
        const target = await session.target({ port: args.port })
        if (!target.ok) {
          return { ok: false, text: 'No audio server is available: ' + target.error + '\n- call sc_server with action=boot.', view: { summary: 'no server' } }
        }
        const port = target.port
        const params = normaliseParams(args.params)
        if (params.error !== null) return { ok: false, text: params.error, view: { port, summary: 'bad params' } }

        if (args.action === 'tree') {
          const tree = await session.scsynth.queryTree({ port, group: Number.isInteger(args.node) ? args.node : 0 })
          const lines = ['Node tree of the server on port ' + port + ' (pid ' + target.server.pid + ')']
          if (!tree.ok) {
            lines.push('- the server did not answer /g_queryTree')
            lines.push('  That usually means an old scsynth, or that the reply was empty. The running synth count from /status is the fallback:')
            const status = await session.scsynth.status({ port })
            lines.push('  synths=' + (status.metrics?.synthCount ?? '<unknown>') + ' groups=' + (status.metrics?.groupCount ?? '<unknown>'))
            return { ok: false, text: lines.join('\n'), view: { port, summary: 'no tree' } }
          }
          const rendered = renderQueryTree(tree.raw)
          lines.push('- replies=' + tree.replies+ ' raw_values=' + tree.raw.length)
          lines.push('')
          lines.push(rendered === '' ? '(the server reported no nodes)' : rendered)
          return { ok: true, text: lines.join('\n'), view: { port, summary: 'tree (' + tree.raw.length + ' values)' } }
        }

        if (args.action === 'set') {
          if (!Number.isInteger(args.node)) return { ok: false, text: '`node` (the node id) is required for action=set.', view: { port, summary: 'no node' } }
          if (params.values === null) return { ok: false, text: '`params` is required for action=set, e.g. {"freq": 220}.', view: { port, summary: 'no params' } }
          const sent = await session.scsynth.setNode({ port, node: args.node, params: params.values })
          if (!sent.ok) return { ok: false, text: 'Could not set controls on node ' + args.node + ': ' + sent.error, view: { port, summary: 'set failed' } }
          return {
            ok: true,
            text: 'Set ' + Object.entries(params.values).map(([key, value]) => key + '=' + value).join(' ') + ' on node ' + args.node + ' (port ' + port + ').',
            view: { port, summary: 'set on ' + args.node },
          }
        }

        if (args.action === 'free') {
          if (!Number.isInteger(args.node)) return { ok: false, text: '`node` (the node id) is required for action=free. Use free_all for everything.', view: { port, summary: 'no node' } }
          const sent = await session.scsynth.freeNode({ port, node: args.node })
          if (!sent.ok) return { ok: false, text: 'Could not free node ' + args.node + ': ' + sent.error, view: { port, summary: 'free failed' } }
          return { ok: true, text: 'Freed node ' + args.node + ' on port ' + port + '.', view: { port, summary: 'freed ' + args.node } }
        }

        if (args.action === 'free_all') {
          const group = Number.isInteger(args.node) ? args.node : 0
          const sent = await session.scsynth.freeAll({ port, group })
          if (!sent.ok) return { ok: false, text: 'Could not free the group: ' + sent.error, view: { port, summary: 'free_all failed' } }
          // The SynthDef table is untouched, so the loaded-set cache stays valid.
          return {
            ok: true,
            text: 'Sent /g_freeAll to group ' + group + ' on port ' + port + '. Every synth in it is gone; the SynthDefs are still loaded, so they can be recreated.',
            view: { port, summary: 'cleared' },
          }
        }

        // new
        const name = String(args.name ?? '').trim()
        if (name === '') return { ok: false, text: '`name` (a loaded SynthDef) is required for action=new. sc_synthdef list shows what this session compiled.', view: { port, summary: 'no name' } }
        const nodeId = Number.isInteger(args.node_id) ? args.node_id : -1
        const created = await session.scsynth.newSynth({ port, name, nodeId, target: Number.isInteger(args.node) ? args.node : 0, params: params.values ?? {} })
        if (!created.ok) {
          return {
            ok: false,
            text:
              'Could not create a node from ' + name + ': ' + created.error + '\n' +
              'A "/s_new" that the server rejects with "SynthDef not found" means the def is not loaded on THIS server: sc_synthdef action=load.',
            view: { port, summary: 's_new failed' },
          }
        }
        return { ok: true, text: 'Created ' + name + ' as node ' + nodeId + ' on port ' + port + '.', view: { port, summary: name + ' started' } }
      })
    },
  }

  // -------------------------------------------------------------------------
  // sc_server — boot / quit / reboot / diagnose
  // -------------------------------------------------------------------------
  const server = {
    name: 'sc_server',
    description: [
      'Control the audio server itself. `boot` starts one (reusing a server that is already running — it will never start a second one on the same machine while one is answering); `quit` asks the server to exit; `reboot` quits and starts it again, which clears every node and every loaded SynthDef; `diagnose` answers "the server is up but I hear nothing".',
      'Diagnose is the one to reach for when audio is the problem: it reports the server this session targets, the OSC reachability, the decoded `/status.reply` (sample rate, CPU, node counts), and the tail of the spawned server\'s own log — which is where scsynth prints the audio device it chose and every `FAILURE IN SERVER`.',
      'Quitting is the only way to stop a server this plugin started; a server someone else started is left alone unless you quit it explicitly.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['boot', 'quit', 'reboot', 'diagnose'], description: 'What to do.' },
        port: { type: 'number', description: 'UDP port (default 57110).' },
        supernova: { type: 'boolean', description: 'For boot/reboot: use supernova instead of scsynth when it is installed.' },
        sampleRate: { type: 'number', description: 'For boot: force a sample rate, e.g. 48000.' },
        device: { type: 'string', description: 'For boot: the output device name scsynth should open.' },
        outputs: { type: 'number', description: 'For boot: the number of output channels.' },
        tailLines: { type: 'number', description: 'For diagnose: how many lines of the server log to show (default 30, maximum 200).' },
      },
    },
    output,
    presentCall: (args) => ({ card: 'generic', title: 'sc_server ' + String(args?.action ?? 'diagnose'), kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Audio server', content: result.text }),
    async execute(args, exec) {
      return run('sc_server', args, exec, async () => {
        const port = Number.isInteger(args.port) ? args.port : DEFAULT_PORT

        if (args.action === 'boot') {
          const ensured = await session.ensureServer({ port, supernova: args.supernova, sampleRate: args.sampleRate, device: args.device, outputs: args.outputs })
          if (!ensured.ok) {
            return {
              ok: false,
              text:
                'Could not bring an audio server up on port ' + port + ': ' + ensured.error + '\n' +
                (ensured.tail ? '\n--- the server said ---\n' + ensured.tail.join('\n') : ''),
              view: { port, summary: 'boot failed' },
            }
          }
          const lines = []
          lines.push('Audio server ' + (ensured.booted ? 'booted' : 'already reachable') + ' on port ' + port + ' (pid ' + ensured.pid + ')')
          if (ensured.metrics) {
            lines.push('- sample_rate=' + (ensured.metrics.nominalSampleRate ?? '<unknown>') + ' synths=' + (ensured.metrics.synthCount ?? 0) + ' synthdefs=' + (ensured.metrics.synthDefCount ?? 0))
          }
          if (ensured.booted) lines.push('- log=' + ensured.logFile + ' (sc_synthdef a def, or sc_play a tone, to hear it)')
          if (args.supernova === true) lines.push('- requested supernova; if it was not installed, scsynth was used')
          return { ok: true, text: lines.join('\n'), ms: ensured.ms, view: { port, pid: ensured.pid ?? undefined, summary: ensured.booted ? 'booted' : 'reused' } }
        }

        if (args.action === 'quit') {
          const target = await session.target({ port })
          if (!target.ok) return { ok: false, text: 'Nothing to quit: ' + target.error, view: { port, summary: 'not running' } }
          const result = await session.scsynth.quit({ port, pid: target.server.pid })
          session.forgetLoaded(port)
          session.invalidate()
          if (!result.exited) {
            return {
              ok: false,
              text: 'Sent /quit to port ' + port + ' but the server still answered /status after ' + result.waitedMs + ' ms. It may be exiting slowly; check sc_status.',
              view: { port, pid: target.server.pid, summary: 'still up' },
            }
          }
          return {
            ok: true,
            text: 'Server on port ' + port + ' (pid ' + target.server.pid + ') acknowledged /quit and exited in ' + result.waitedMs + ' ms.',
            view: { port, pid: target.server.pid, summary: 'quit' },
          }
        }

        if (args.action === 'reboot') {
          const target = await session.target({ port })
          const previous = target.ok ? target.server.pid : null
          if (target.ok) {
            await session.scsynth.quit({ port, pid: target.server.pid })
            session.forgetLoaded(port)
          }
          const ensured = await session.ensureServer({ port, supernova: args.supernova, sampleRate: args.sampleRate, device: args.device, outputs: args.outputs })
          session.invalidate()
          if (!ensured.ok) {
            return { ok: false, text: 'Reboot failed after stopping pid ' + previous + ': ' + ensured.error, view: { port, pid: previous ?? undefined, summary: 'reboot failed' } }
          }
          return {
            ok: true,
            text:
              'Rebooted the server on port ' + port + '.\n' +
              '- previous_pid=' + (previous ?? '<none>') + ' new_pid=' + ensured.pid + '\n' +
              '- every node and every loaded SynthDef was cleared with it: re-load defs with sc_synthdef before sc_nodes action=new',
            view: { port, pid: ensured.pid ?? undefined, summary: 'rebooted' },
          }
        }

        // diagnose
        const target = await session.target({ port })
        const lines = ['SuperCollider audio diagnosis']
        const install = session.install ?? session.refreshInstall()
        lines.push('- install_dir=' + (install.dir ?? '<not found>'))
        lines.push('- sclang=' + (install.sclang.file ?? '<missing>'))
        lines.push('- scsynth=' + (install.scsynth.file ?? '<missing>') + ' supernova=' + (install.supernova.file ?? '<missing>'))
        lines.push('- interpreter=' + (session.sclang.alive ? 'warm' : 'not started') + ' bound_port=' + (session.sclang.boundPort ?? '<none>'))
        if (!target.ok) {
          lines.push('- target: NONE — ' + target.reason)
          for (const entry of target.snapshot.servers) {
            lines.push('  pid=' + entry.pid + ' role=' + entry.role + ' osc_reachable=' + entry.oscReachable + ' ports=[' + entry.candidatePorts.join(',') + ']')
          }
          lines.push('')
          lines.push('There is no reachable audio server, so nothing can sound. Bring one up with sc_server action=boot.')
          return { ok: false, text: lines.join('\n'), view: { summary: 'no server' } }
        }
        lines.push('- target_pid=' + target.server.pid + ' target_port=' + target.port + ' (' + target.reason + ')')
        lines.push('- exe=' + (target.server.exePath ?? '<unknown>'))
        lines.push('- cmdline=' + (target.server.cmdline || '<empty>'))
        const status = await session.scsynth.status({ port: target.port })
        if (status.up) {
          const metrics = status.metrics
          lines.push('- /status.reply in ' + status.ms + ' ms:')
          lines.push('  nominal_sr=' + (metrics.nominalSampleRate ?? '<unknown>') + ' actual_sr=' + (metrics.actualSampleRate === null ? '<unknown>' : Math.round(metrics.actualSampleRate * 100) / 100))
          lines.push('  synths=' + (metrics.synthCount ?? '<unknown>') + ' groups=' + (metrics.groupCount ?? '<unknown>') + ' synthdefs=' + (metrics.synthDefCount ?? '<unknown>'))
          lines.push('  avg_cpu=' + (metrics.avgCpu === null ? '<unknown>' : (metrics.avgCpu * 100).toFixed(1) + '%') + ' peak_cpu=' + (metrics.peakCpu === null ? '<unknown>' : (metrics.peakCpu * 100).toFixed(1) + '%'))
        } else {
          lines.push('- the server did NOT answer /status on port ' + target.port + ' during this call')
        }
        // The log of a server this session spawned is the useful part: scsynth
        // prints the device it opened and every FAILURE IN SERVER there.
        let logFile = null
        for (const entry of session.scsynth.spawned.values()) {
          if (entry.port === target.port) logFile = entry.log
        }
        if (logFile === null) {
          lines.push('- server_log=<none: this session did not start that server, so it has no log to read>')
        } else {
          const tailLines = Math.max(1, Math.min(200, Number.isFinite(args.tailLines) ? args.tailLines : 30))
          const tail = await tailFile(logFile, tailLines)
          lines.push('- server_log=' + logFile + ' (last ' + tail.length + ' lines)')
          for (const line of tail) lines.push('    ' + line.replace(/\s+$/, ''))
        }
        lines.push('')
        lines.push('If /status answers and the device line above shows a real device but you hear nothing: check the system output device and volume, then run sc_play to confirm the path end to end.')
        return { ok: true, text: lines.join('\n'), view: { port: target.port, pid: target.server.pid, summary: 'server up on ' + target.port } }
      })
    },
  }

  // -------------------------------------------------------------------------
  // sc_capture — measure what the server actually played
  // -------------------------------------------------------------------------
  const capture = {
    name: 'sc_capture',
    description: [
      'Play a sound and MEASURE what came out, so you can tell a tone from noise without asking anyone. This is the tool to reach for after building any instrument: it compiles a SynthDef from `source`, plays it, records the audio output for `seconds`, reads the samples back and reports peak, RMS, clipping, the spectral centroid and the strongest partials.',
      'Example: `source`: "SynthDef(\\\\bell, { |freq = 440, amp = 0.2| Out.ar(0, Klank.ar(`[[freq, freq * 2.7], nil, [3, 1.5]], Impulse.ar(0, 0, 0.02)) * amp * EnvGen.kr(Env.perc(0.002, 4), doneAction: 2)) })", `params`: {"freq": 220}, `seconds`: 3.',
      'Read the answer like this: `verdict` says whether it is tonal or noise; `peak` at or above 1.0 means the server clipped it, which is the single most common reason a modal model sounds like noise instead of a bell; `rms` near zero means it was silent; `partials` lists the strongest frequencies, so a model designed to ring at 62 Hz can be checked against what it really did. You can also test an existing SynthDef by name instead of passing `source`.',
      'Use it before reporting a sound as finished, and whenever a user says what you played sounds wrong — it turns "sounds like noise" into a number you can act on.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string', description: 'A complete SynthDef expression, e.g. "SynthDef(\\\\name, { ... })". It must reach Out.ar(0, ...). Either this or `name` is required.' },
        name: { type: 'string', description: 'An existing SynthDef name to play instead of compiling one from `source`.' },
        params: { type: 'object', description: 'Control values for the node, e.g. {"freq": 220}. Numbers only.' },
        seconds: { type: 'number', description: 'How long to record, in seconds (default 3, maximum 20). This is wall-clock time the tool waits, so keep it just long enough to hear the attack and some of the decay.' },
        amp: { type: 'number', description: 'Amplitude control to set, if the def has one (default: leave the def default).' },
        debug: { type: 'boolean', description: 'Include the node tree captured during recording, for diagnosing a measurement that reports silence.' },
      },
    },
    output,
    presentCall: (args) => ({ card: 'generic', title: 'Measure ' + String(args?.name ?? 'sound'), kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Measurement', content: result.text }),
    async execute(args, exec) {
      return run('sc_capture', args, exec, async () => {
        const seconds = Number.isFinite(args.seconds) ? Math.min(20, Math.max(0.25, Number(args.seconds))) : 3
        const hasSource = typeof args.source === 'string' && args.source.trim() !== ''
        const hasName = typeof args.name === 'string' && args.name.trim() !== ''
        if (!hasSource && !hasName) {
          return { ok: false, text: 'Nothing to measure: pass `source` (a SynthDef expression) or `name` (an already-loaded SynthDef).', view: { summary: 'nothing to play' } }
        }
        // The def's own name is the only one that matters: `/s_new` has to name a
        // def the server actually has, so inventing one here (a unique name per
        // call, say) creates a node that fails with "SynthDef not found" while
        // every step reports success. The name is read out of the source instead.
        const declared = hasSource ? declaredSynthDefName(String(args.source)) : null
        if (hasSource && declared === null) {
          return {
            ok: false,
            text: 'Could not read a SynthDef name out of `source`. It must be a complete SynthDef expression, e.g. `SynthDef(\\\\name, { |out = 0| Out.ar(out, ...) })`.',
            view: { summary: 'no SynthDef name' },
          }
        }
        // Measuring a def that is already on the server needs its SOURCE — the
        // measurement works by rewriting the def's own `Out.ar`, and a name alone
        // does not carry the code. The bundled example instruments are the common
        // case (`sc_project action=examples file=1` loads one, then this measures
        // it), and their source ships with the package, so it is read from there
        // rather than making the caller paste it back in.
        let source = hasSource ? String(args.source) : ''
        let sourceFrom = null
        if (!hasSource && hasName) {
          const wanted = String(args.name)
          // Only look in the library when the name is one of its SynthDefs, so a
          // matching name can never pick up an unrelated example's code.
          const match = listExamples().examples.find((entry) => entry.synthDef === wanted)
          if (match !== undefined) {
            source = String(match.text)
            sourceFrom = match.file
          }
        }
        const measurable = source !== '' && declaredSynthDefName(source) !== null
        const sourceName = measurable ? declaredSynthDefName(source) : null
        const controls = normaliseParams(args.params)
        if (controls.error !== null) return { ok: false, text: controls.error, view: { summary: 'bad params' } }

        const ensured = await session.ensureServer({})
        if (!ensured.ok) {
          return {
            ok: false,
            text: 'No audio server is available, so nothing could be measured.\n- ' + ensured.error + '\n- call sc_server with action=boot first.',
            view: { summary: 'no audio server' },
          }
        }
        const port = ensured.port
        const status = await session.scsynth.status({ port })
        const sampleRate = Math.round(status.metrics?.actualSampleRate ?? status.metrics?.nominalSampleRate ?? 48_000) || 48_000
        const channels = 2
        const frames = Math.ceil(seconds * sampleRate)
        // The name to report, and the name the source actually declares — which is
        // the only one `/s_new` can use.
        const name = sourceName ?? String(args.name ?? 'measured')

        const monitored = measuredName(name)

        // The tap, not a bus. The source is rewritten so its OWN `Out.ar` output is
        // recorded inside the node that makes it — see `tapSynthDefSource` for the
        // measurement that forced this design (a recorder on a private bus captured
        // exact zeros while the same buffer written from inside the node captured
        // the signal).
        const tapped = measurable ? tapSynthDefSource(source, monitored) : null

        const lines = []
        lines.push('- SynthDef under test: ' + name)

        if (!measurable) {
          // A def that is on the server with no source anywhere cannot be tapped,
          // and a bus read would report silence for a sound that is playing. So
          // this says what it cannot do rather than inventing a wrong number.
          return {
            ok: false,
            text:
              'Cannot measure "' + name + '": the measurement records the def\'s own output, which means rewriting its `Out.ar`, and no source is available for that name.\n' +
              '- pass the SynthDef expression as `source`, or\n' +
              '- if it is one of the bundled instruments, use its SynthDef name (they are read from `examples/`), or\n' +
              '- check the name against `sc_nodes action=tree` and `sc_synthdef action=list`.',
            view: { port, summary: 'no source to measure' },
          }
        }
        {
          const compiled = await session.compileSynthDef({ name: monitored, source: tapped })
          if (!compiled.ok) {
            return {
              ok: false,
              text:
                'The instrumented copy of that SynthDef would not compile, so there is nothing to measure.\n- ' + compiled.error +
                (compiled.detail ? '\n\n--- the interpreter said ---\n' + compiled.detail : '') +
                (args.debug === true ? '\n\n--- instrumented source ---\n' + tapped : ''),
              view: { summary: 'compile failed' },
            }
          }
          const loaded = await session.loadSynthDef({ name: monitored, source: tapped, file: compiled.file, port })
          if (!loaded.ok) return { ok: false, text: 'The instrumented SynthDef compiled but the server would not take it: ' + loaded.error, view: { port, summary: 'load failed' } }
          lines.push('- instrumented as ' + monitored + ' (' + compiled.bytes + ' bytes, compiled and loaded' + (sourceFrom === null ? '' : ', source read from ' + sourceFrom) + ')')
          if (args.debug === true) lines.push('- debug: instrumented source = ' + tapped)
        }

        const bufnum = 90_001
        if (!(await session.scsynth.bufferAlloc({ port, bufnum, frames, channels })).ok) {
          return { ok: false, text: 'could not allocate a capture buffer', view: { summary: 'no buffer' } }
        }
        let recorded = null
        try {
          await session.scsynth.newSynth({
            port,
            name: monitored,
            nodeId: 120_000,
            target: 0,
            addAction: 0,
            params: { ...(controls.values ?? {}), out: 0, recBuf: bufnum, recSeconds: seconds },
          })
          // `/s_new` is fire-and-forget: it succeeds even when the server refuses
          // the node ("SynthDef not found"), which is exactly how a broken
          // measurement once looked like a working one. The node count is the
          // honest check.
          await delay(150)
          const live = await session.scsynth.status({ port })
          const running = live.metrics?.synthCount ?? null
          if (args.debug === true) {
            const tree = await session.scsynth.queryTree({ port, group: 0, flags: 1 })
            lines.push('- debug: synthCount=' + running + ' tree=' + JSON.stringify(tree.raw))
          }
          if (running !== null && running < 1) {
            return {
              ok: false,
              text:
                'the server refused the node, so nothing was playing: it reports ' + running + ' running node(s) just after the sound was created. ' +
                'The SynthDef is probably not resident. Run sc_server action=diagnose to read the server log, which names the reason.',
              view: { port, summary: 'server refused the node' },
            }
          }
          // The tap records for exactly `seconds`, then frees its own node.
          await delay(Math.ceil(seconds * 1000) + 400)
          recorded = await session.scsynth.bufferGetn({ port, bufnum, start: 0, count: frames * channels, timeoutMs: 500 })
        } finally {
          await session.scsynth.freeNode({ port, node: 120_000 }).catch(() => {})
          await session.scsynth.bufferFree({ port, bufnum }).catch(() => {})
        }

        if (recorded === null || !recorded.ok) {
          return { ok: false, text: 'the sound played but the recording could not be read back: ' + (recorded?.error ?? 'no reply'), view: { port, summary: 'capture failed' } }
        }
        const result = analyse(recorded.values, { channels, sampleRate })
        lines.push('- recorded ' + result.seconds.toFixed(2) + ' s at ' + sampleRate + ' Hz, ' + result.channels + ' channels, captured from the def\'s own output')
        lines.push('')
        for (const channel of result.perChannel) {
          lines.push(
            'channel ' + channel.channel + ': peak ' + channel.peak.toFixed(4) +
            '  rms ' + channel.rms.toFixed(5) +
            (Number.isFinite(channel.dbfs) ? ' (' + channel.dbfs.toFixed(1) + ' dBFS)' : '') +
            '  crest ' + channel.crest.toFixed(1) +
            '  dc ' + channel.dc.toFixed(5),
          )
        }
        lines.push('- tonality: ' + result.tone)
        lines.push('- spectral centroid: ' + (result.worst.centroidHz === null ? 'n/a' : Math.round(result.worst.centroidHz) + ' Hz'))
        if (result.worst.peaks !== undefined && result.worst.peaks.length > 0) {
          lines.push('- strongest partials: ' + result.worst.peaks.map((peak) => peak.hz + ' Hz (' + peak.relative.toFixed(2) + ')').join(', '))
        }
        lines.push('')
        if (result.clipping) {
          lines.push('FAIL: the output is CLIPPING (' + result.worst.clipped + ' samples at full scale, ' + (result.worst.clippedRatio * 100).toFixed(2) + '%). The server hard-clips above 1.0, and clipped modal synthesis is heard as noise. Lower the def\'s output gain (or the `amp` you pass) until peak is below about 0.8.')
        } else if (result.quiet) {
          lines.push('FAIL: this is effectively SILENT (rms ' + result.worst.rms.toFixed(6) + '). Check that the def reaches Out.ar(0, ...), that its envelope is not closing immediately, and that `params` set an amplitude above zero.')
        } else if (/noise|broadband/.test(result.tone)) {
          lines.push('WARN: the spectrum is broadband, not tonal. For a struck or plucked model that usually means the excitation is too loud or too noisy relative to the resonators, the resonator ring times are too short, or something is clipping. If the sound was MEANT to be noise, ignore this.')
        } else {
          lines.push('OK: a tonal result with headroom. peak ' + result.worst.peak.toFixed(3) + ' leaves ' + (20 * Math.log10(Math.max(1e-6, 1 / Math.max(1e-6, result.worst.peak)))).toFixed(1) + ' dB before full scale.')
        }
        const ok = !result.clipping && !result.quiet
        return {
          ok,
          text: lines.join('\n'),
          view: {
            port,
            summary: result.clipping ? 'clipping' : result.quiet ? 'silent' : result.tone,
            peak: Math.round(result.worst.peak * 1000) / 1000,
            rms: Math.round(result.worst.rms * 100_000) / 100_000,
          },
        }
      })
    },
  }

  return [status, help, check, execTool, play, capture, project, load, synthdef, nodes, server]
}

/** The tool names, in the order they are registered. */
export const TOOL_NAMES = ['sc_status', 'sc_help', 'sc_check', 'sc_exec', 'sc_play', 'sc_capture', 'sc_project', 'sc_load', 'sc_synthdef', 'sc_nodes', 'sc_server']

/**
 * Every character of `text` that is inside a comment blanked to a space.
 *
 * ## Why this is not a nicety
 *
 * sclang has TWO string delimiters, `"` and `'`, and `'x'` is a single-character
 * string. Prose in a comment therefore contains string delimiters: a comment that
 * says "a gong's modes are not harmonic" opens an apostrophe string that never
 * closes, and any scanner walking the source for balanced parentheses then runs to
 * the end of the file and gives up. Measured: that one apostrophe made the tap
 * below refuse an example whose parentheses were perfectly balanced, and the error
 * it produced was "could not rewrite that SynthDef", which points at the wrong
 * thing entirely.
 *
 * Blanking rather than deleting keeps every offset and line number identical, so a
 * caller can locate things here and slice the real text from the original.
 *
 * @param text - sclang source.
 * @returns the same text with comment content replaced by spaces.
 */
function blankComments(text) {
  const source = String(text ?? '')
  const out = source.split('')
  let index = 0
  let quote = null
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (quote !== null) {
      if (char === '\\') index += 2
      else {
        if (char === quote) quote = null
        index += 1
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      index += 1
      continue
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        out[index] = ' '
        index += 1
      }
      continue
    }
    if (char === '/' && next === '*') {
      out[index] = ' '
      out[index + 1] = ' '
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] !== '\n') out[index] = ' '
        index += 1
      }
      if (index < source.length) {
        out[index] = ' '
        out[index + 1] = ' '
        index += 2
      }
      continue
    }
    index += 1
  }
  return out.join('')
}

/**
 * Rewrite a `SynthDef(...)` expression so its own `Out.ar` output is TAPPED and
 * recorded into a buffer, without touching the caller's text.
 *
 * ## Why not a bus
 *
 * The obvious way to measure a sound is to record the bus it writes to. That was
 * tried and it does not work reliably: on the development host, a recorder node
 * reading a private bus that another node demonstrably wrote to captured exact
 * zeros, while `RecordBuf.ar` of an oscillator inside the same node captured the
 * signal perfectly. Bus read-back depends on the server's bus wiring and its
 * device, so a measurement built on it reports **SILENT** for a sound that is
 * playing — the worst possible failure for a tool whose whole purpose is to tell
 * the truth about a sound.
 *
 * So the tap is made where the signal is made. The expression is rewritten to
 *
 *     SynthDef(\name, { |out = 0, …, |recBuf = 0, recSeconds = 3|
 *         RecordBuf.ar(Out.ar(out, <the original body>), recBuf, loop: 0);
 *         Line.kr(0, 1, recSeconds, doneAction: 2);
 *         Silent.ar(2) })
 *
 * `Out.ar`'s return value is its input, so recording it records exactly what the
 * def sends to the output, and the def still plays normally. The original text is
 * left alone: only the `Out` calls are wrapped, and `recBuf` 0 means "record
 * nothing", so a def built this way is harmless if it is played directly.
 *
 * @param source - a complete `SynthDef(...)` expression.
 * @param rename - the name to register the instrumented copy under. Looked up
 *   from the source when absent, which is only safe when the source's own name
 *   is a plain identifier; callers that already know the name should pass it.
 * @returns the rewritten expression, or null when it cannot be rewritten.
 */
export function tapSynthDefSource(source, rename) {
  const text = String(source ?? '')
  // Comments are blanked before anything is scanned. sclang's `'x'` is a
  // single-character STRING, so prose in a comment ("a gong's modes are not
  // harmonic") opens a string that never closes and every parenthesis walk after
  // it is nonsense. Offsets are preserved, so the body is still sliced out of the
  // original text below.
  const scan = blankComments(text)
  const call = /\bSynthDef\s*\(/.exec(scan)
  if (call === null) return null
  const name = rename === undefined || rename === null ? declaredSynthDefName(text) : String(rename)
  if (name === null || name === '') return null

  // The matching close paren of the SynthDef call, by depth rather than by regex:
  // the body is full of parens and a greedy match would swallow the rest.
  const open = call.index + call[0].length - 1
  let depth = 0
  let close = -1
  let quote = null
  for (let index = open; index < scan.length; index += 1) {
    const char = scan[index]
    if (quote !== null) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) {
        close = index
        break
      }
    }
  }
  if (close < 0) return null

  const inner = text.slice(open + 1, close)
  const innerScan = scan.slice(open + 1, close)
  // `SynthDef(\name, { |args| body })` — keep the name, take the function. The
  // shape is read from the blanked text so a comment cannot look like the name.
  const argument = /^\s*(?:\\(?:[A-Za-z_][A-Za-z0-9_]*)|'[^']*'|"[^"]*")\s*,/.exec(innerScan)
  if (argument === null) return null
  const fn = inner.slice(argument[0].length).trim()
  const fnScan = innerScan.slice(argument[0].length).trim()
  const brace = /^\{\s*(?:\|([^|]*)\|)?/.exec(fnScan)
  if (brace === null) return null

  let body = fn.slice(brace[0].length)
  body = body.replace(/\s*\}\s*$/, '')
  let bodyScan = fnScan.slice(brace[0].length)
  bodyScan = bodyScan.replace(/\s*\}\s*$/, '')
  const closed = closeRecordedOuts(bodyScan, body)
  if (closed === null) return null

  const args = (brace[1] ?? '').trim()
  const withRecorder = (args === '' ? '' : args.replace(/,\s*$/, '') + ', ') + 'recBuf = 0, recSeconds = 3'
  return (
    'SynthDef(\\' + name + ', { |' + withRecorder + '| ' +
    // The original body becomes a FUNCTION, called with the record buffer. That
    // is what allows a `var` to be introduced at all: sclang only accepts one at
    // the top of a function body, and the caller's body may already have its own
    // `var`s that must stay first. `dshOut` is that function's argument, so the
    // caller's text is untouched.
    '{ |dshOut| ' + closed.body + ' }.value(recBuf); ' +
    'Line.kr(0, 1, recSeconds, doneAction: 2); ' +
    'Silent.ar(2) })'
  )
}

/**
 * Route every `Out.ar(` in a SynthDef body through a `RecordBuf`, so the exact
 * signal the def emits is what gets measured.
 *
 * ## What does NOT work, measured on scsynth 3.14.1
 *
 * Every one of these compiles and runs, and every one of them captured exact
 * silence while the sound was demonstrably playing:
 *
 *   - `RecordBuf.ar(Out.ar(bus, sig), buf)` — `Out.ar` expands, so `RecordBuf.ar`
 *     is instantiated once per channel and the last wins;
 *   - `.dup`-ing the signal first — captured values of `1e32`, i.e. garbage;
 *   - `Out.ar(bus, sig, recBuf)` — the documented "record to this buffer" third
 *     argument, which recorded nothing at all on this install;
 *   - a second node reading the bus the sound writes to (`In.ar(bus)`), including
 *     a private bus, which read silence.
 *
 * The only form that captured the signal was calling `RecordBuf.ar` **directly on
 * the signal**, in the same node that produces it. That is what this builds:
 *
 *     Out.ar(bus, sig)   becomes   Out.ar(bus, RecordBuf.ar(sig, dshOut, loop: 0))
 *
 * `recBuf = 0` makes `RecordBuf` a pass-through, so the rewritten copy is harmless
 * if it is ever played directly, and the def still plays normally.
 *
 * @param body - the SynthDef function's body.
 * @param original - the same body with its comments intact. Positions are located
 *   in the comment-blanked copy and sliced out of this one, so a comment can never
 *   be mistaken for code while the emitted text keeps everything the author wrote.
 * @returns `{ body }`, or null when an `Out.ar` call cannot be rewritten.
 */
function closeRecordedOuts(body, original = body) {
  const out = []
  let index = 0
  const needle = 'Out.ar('
  while (index < body.length) {
    const found = body.indexOf(needle, index)
    if (found < 0) {
      // Everything between and after the tapped calls comes from the ORIGINAL, so
      // the author's comments and formatting survive the rewrite.
      out.push(original.slice(index))
      break
    }
    out.push(original.slice(index, found))
    // Walk forward from just after `Out.ar(` to its matching `)`.
    let depth = 1
    let cursor = found + needle.length
    let quote = null
    while (cursor < body.length) {
      const char = body[cursor]
      if (quote !== null) {
        if (char === '\\') cursor += 1
        else if (char === quote) quote = null
        cursor += 1
        continue
      }
      if (char === '"' || char === "'") {
        quote = char
        cursor += 1
        continue
      }
      if (char === '(') depth += 1
      else if (char === ')') {
        depth -= 1
        if (depth === 0) break
      }
      cursor += 1
    }
    if (depth !== 0) return null
    // Positions come from the blanked copy; the text itself is sliced out of the
    // original so the emitted def keeps the author's own formatting and comments.
    const inside = original.slice(found + needle.length, cursor)
    // Split `bus, signal` at the first top-level comma: the bus expression may
    // itself contain commas inside a call (`Pan2.ar(sig, pan)`), so depth matters.
    //
    // `Out.ar(sig)` — one argument is a legal MONO emission to bus 0, and it has no
    // comma at all. It is also exactly what the feedback example writes, so this
    // has to handle it rather than refuse the def.
    const split = splitTopLevel(inside)
    const bus = split === null ? '0' : split.first
    const signal = split === null ? inside : split.rest
    if (signal.trim() === '') return null
    // The recorded signal is forced to exactly two channels. A mono signal into a
    // two-channel buffer captures silence — measured: `RecordBuf.ar(SinOsc.ar(400)
    // * 0.3, buf)` into a stereo buffer gave peak 0.0000 while the same call with
    // `SinOsc.ar([400, 500])` gave 0.3000. The measurement buffer is always stereo,
    // so the signal is made to match it: one channel is duplicated, more than two
    // are summed, which is what `analyse` expects.
    out.push(
      'Out.ar(' + bus + ', { |dshSig|' +
      ' if(dshSig.numChannels == 1) { RecordBuf.ar(dshSig.dup, dshOut, loop: 0) }' +
      ' { if(dshSig.numChannels == 2) { RecordBuf.ar(dshSig, dshOut, loop: 0) }' +
      ' { RecordBuf.ar(dshSig.sum.dup, dshOut, loop: 0) } } }.value(' + signal + '))',
    )
    index = cursor + 1
  }
  const joined = out.join('')
  const opens = (joined.match(/\(/g) ?? []).length
  const shuts = (joined.match(/\)/g) ?? []).length
  if (opens !== shuts) return null
  // A body that never reaches `Out.ar` produces no sound, so there is nothing to
  // measure. Without this the tap returns a valid-looking def that records
  // silence, and the tool reports SILENT for an instrument that simply has no
  // output — a confusing answer to a question nobody asked.
  if (!joined.includes('RecordBuf.ar(')) return null
  return { body: joined }
}

/**
 * Split an argument list at its first top-level comma.
 *
 * @param text - the arguments of a call, without the surrounding parens.
 * @returns `{ first, rest }`, or null when there is no top-level comma.
 */
function splitTopLevel(text) {
  let depth = 0
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== null) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') depth -= 1
    else if (char === ',' && depth === 0) {
      return { first: text.slice(0, index).trim(), rest: text.slice(index + 1).trim() }
    }
  }
  return null
}

/** The name the instrumented copy of a measured def is registered under. */
function measuredName(name) {
  const base = String(name ?? 'measured')
  return (base + '_measured').slice(0, 60)
}

/** The first line of a snippet, for a card title. */
function firstLine(code) {
  const text = String(code ?? '').trim().split('\n')[0] ?? ''
  return text.length > 60 ? text.slice(0, 57) + '…' : text
}

/**
 * The name a `SynthDef(...)` expression declares.
 *
 * Read from the source because it is the only name the server will answer to:
 * `SynthDef(\foo, { ... })` registers a def called `foo`, whatever file it was
 * compiled into and whatever the caller hoped to call it. A tool that invents its
 * own node name instead gets `FAILURE IN SERVER /s_new SynthDef not found` while
 * every step in front of it reports success.
 *
 * Accepts the three spellings sclang allows for the name: `\foo`, `'foo'` and
 * `"foo"`.
 *
 * @param source - the SynthDef expression.
 * @returns the name, or null when the source does not declare one.
 */
export function declaredSynthDefName(source) {
  const text = String(source ?? '')
  const call = /\bSynthDef\s*\(/.exec(text)
  if (call === null) return null
  const rest = text.slice(call.index + call[0].length)
  const argument = /^\s*(?:\\([A-Za-z_][A-Za-z0-9_]*)|'([^']*)'|"([^"]*)")/.exec(rest)
  if (argument === null) return null
  const name = argument[1] ?? argument[2] ?? argument[3] ?? ''
  return name === '' ? null : name
}

/** A one-line reason, for a card summary. */
function shortReason(text) {
  const first = String(text ?? '').split('\n')[0] ?? ''
  return first.length > 80 ? first.slice(0, 77) + '…' : first
}

/** Wait, without holding the event loop open. */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * Validate a control map.
 *
 * scsynth controls are floats. A string or a nested object would be encoded as
 * an OSC string and rejected by the server with a confusing message, so it is
 * refused here with a clear one.
 *
 * @param params - the caller's map.
 * @returns `{ values, error }`.
 */
export function normaliseParams(params) {
  if (params === undefined || params === null) return { values: null, error: null }
  if (typeof params !== 'object' || Array.isArray(params)) {
    return { values: null, error: '`params` must be an object of control names to numbers, e.g. {"freq": 220}.' }
  }
  const values = {}
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { values: null, error: 'Control "' + key + '" must be a finite number: scsynth controls are floats (' + typeof value + ' given).' }
    }
    values[key] = value
  }
  return { values, error: null }
}

/**
 * Render `/g_queryTree.reply` values as the nodes the server reported.
 *
 * The documented format (`HelpSource/Reference/Server-Command-Reference.schelp`,
 * `/g_queryTree`) is:
 *
 *     int      flag (synth control values included?)
 *     int      node id of the requested group
 *     int      number of child nodes of that group
 *     then, per node: id, childCount (-1 = synth, >= 0 = group), and for a synth
 *                     its def name and — when the flag is set and there is room —
 *                     a control count followed by that many pairs
 *
 * Measured against a real 3.14.1 reply carrying one synth:
 *
 *     0 0 1 2000 -1 integProbe
 *
 * Its header says flag 0, group 0, **0 child nodes**, and then a node follows
 * anyway: 1 with a child count of 2000 — which is group 1's size, not a number
 * of children — and synth 2000 \integProbe inside it. The header's count and the
 * nodes that follow disagree in practice, so this renderer walks the nodes and
 * does NOT use the counts as an iteration bound or as a nesting rule. What it
 * prints is what the server listed: the nodes, their kinds and their def names,
 * plus the raw reply, so the reader can see the same evidence.
 *
 * @param values - the flattened reply arguments.
 * @returns the rendered text.
 */
export function renderQueryTree(values) {
  if (!Array.isArray(values) || values.length === 0) return ''
  if (values.length < 4) return '  raw: ' + clip(values.join(' '), 300)

  const flag = values[0]
  const rootId = values[1]
  const rootChildren = values[2]
  const lines = []
  lines.push('group ' + rootId + ' (the requested group), reporting ' + rootChildren + ' child node(s)')
  if (flag === 1) lines.push('  (the reply says synth control values are included)')

  let index = 3
  const nodes = []
  while (index < values.length) {
    const nodeId = values[index]
    const childCount = values[index + 1]
    if (typeof nodeId !== 'number' || typeof childCount !== 'number') break
    index += 2
    if (childCount < 0) {
      const name = values[index]
      index += 1
      const controls = []
      if (flag === 1) {
        const controlCount = values[index]
        index += 1
        for (let pair = 0; typeof controlCount === 'number' && pair < controlCount; pair += 1) {
          if (index + 1 >= values.length) break
          controls.push(String(values[index]) + '=' + String(values[index + 1]))
          index += 2
        }
      }
      nodes.push({ kind: 'synth', id: nodeId, name: String(name ?? '?'), controls, reported: childCount })
      continue
    }
    nodes.push({ kind: 'group', id: nodeId, name: '', controls: [], reported: childCount })
  }

  if (nodes.length === 0) {
    lines.push('  (no nodes follow the header — the group is empty)')
  }
  for (const node of nodes) {
    lines.push(
      '  ' +
        node.kind +
        ' ' +
        node.id +
        (node.kind === 'synth' ? ' \\' + node.name : ' (group)') +
        (node.controls.length > 0 ? '  ' + node.controls.join(' ') : ''),
    )
  }
  lines.push('')
  lines.push('  raw: ' + clip(values.join(' '), 500))
  return lines.join('\n')
}
