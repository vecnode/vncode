/**
 * dsh-supercollider — the live session everything else shares.
 *
 * One object owns the four things a tool call needs to agree about:
 *
 *   - **the install** — where `sclang`, `scsynth` and the help tree are, resolved
 *     once per snapshot so two answers in one turn cannot name different paths;
 *   - **the process picture** — `collectSnapshot()` from `procs.js`;
 *   - **the audio server** — an `Scsynth` handle that owns the socket and knows
 *     which servers this session spawned;
 *   - **the interpreter** — one `SclangSession`, kept warm between calls.
 *
 * The session also carries the two pieces of *state* the old implementations
 * kept in module globals (`GLOBAL_SUPERCOLIDER_APP_PID`, `LOADED_MCP_TONE_PORTS`
 * in `legacy/mcp_py/sc_process.py:33-40`): the pid of the server this session
 * started, and the SynthDefs it has already loaded on which port. Both are
 * hints, never truth — a hint is re-verified before it is used.
 *
 * Everything here is lazy. A plugin that is never asked to make a sound starts
 * no process, reads no documentation file and writes nothing to disk.
 */

import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { DocsIndex } from './docs.js'
import { resolveInstall, resolveHelpRoot, sclangVersion } from './install.js'
import { ensureDirs, readJson, synthDefDir, writeJson, pruneChannelFiles } from './log.js'
import { chooseServer, collectSnapshot, DEFAULT_PORTS } from './procs.js'
import { checkSyntax, INLINE_LIMIT_BYTES, normalizeSubmission, SclangSession } from './sclang.js'
import { DEFAULT_PORT, Scsynth } from './scsynth.js'

/** How long a compiled SynthDef stays in the session cache. */
const SYNTHDEF_CACHE_FILE = 'synthdefs.json'

/** Wait, without holding the event loop open. */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * The session.
 */
export class SupercolliderSession {
  /**
   * @param deps - `{ home, env, log }`.
   */
  constructor(deps) {
    this.home = deps.home
    this.env = deps.env ?? process.env
    this.log = deps.log ?? { warn() {}, info() {}, debug() {} }
    /** The resolved install, refreshed by `snapshot()`. */
    this.install = null
    /** The audio server handle. */
    this.scsynth = new Scsynth({ home: this.home, env: this.env, log: this.log })
    /** The interpreter. */
    this.sclang = new SclangSession({ home: this.home, env: this.env, install: null, log: this.log })
    /** The docs index. */
    this.docs = new DocsIndex({ env: this.env, install: null, log: this.log })
    /** The pid of the server this session started, if any. */
    this.trackedPid = null
    /** Which SynthDefs are loaded, per port: `Map<port, Set<name>>`. */
    this.loaded = new Map()
    /** The SynthDef cache, keyed by content digest. */
    this.synthDefCache = null
    /** The last snapshot, with a short validity window. */
    this.cachedSnapshot = null
    this.cachedSnapshotAt = 0
  }

  /** Resolve the install and hand it to the parts that need it. */
  refreshInstall() {
    this.install = resolveInstall({ env: this.env })
    this.sclang.install = this.install
    this.docs.install = this.install
    return this.install
  }

  /**
   * The process picture, cached for a second so one turn's tool calls share it.
   *
   * @param options - `{ force, signal }`.
   * @returns the snapshot from `collectSnapshot`, plus the resolved install.
   */
  async snapshot(options = {}) {
    const fresh = options.force === true || this.cachedSnapshot === null || Date.now() - this.cachedSnapshotAt > 1_000
    if (!fresh) return { ...this.cachedSnapshot, install: this.install }
    const install = this.refreshInstall()
    const snapshot = await collectSnapshot({ log: this.log, signal: options.signal })
    this.cachedSnapshot = snapshot
    this.cachedSnapshotAt = Date.now()
    return { ...snapshot, install }
  }

  /** Invalidate the cached snapshot, after anything this session changed. */
  invalidate() {
    this.cachedSnapshot = null
    this.cachedSnapshotAt = 0
  }

  /**
   * Which server a call should act on, with the reason it was chosen.
   *
   * @param request - `{ pid, port, force }`.
   * @returns `{ ok, server, port, reason, error, snapshot }`.
   */
  async target(request = {}) {
    const snapshot = await this.snapshot({ force: request.force === true })
    const chosen = chooseServer(snapshot, { pid: request.pid, port: request.port, trackedPid: this.trackedPid })
    if (chosen.server === null) {
      return { ok: false, server: null, port: null, reason: chosen.reason, snapshot, error: chosen.reason }
    }
    const port = Number.isInteger(request.port) && request.port > 0
      ? request.port
      : chosen.server.respondingPort ?? (chosen.server.ports ?? [])[0] ?? null
    if (!Number.isInteger(port)) {
      return {
        ok: false,
        server: chosen.server,
        port: null,
        reason: chosen.reason,
        snapshot,
        error:
          'pid ' + chosen.server.pid + ' is running but did not answer /status on any probed port, so its UDP port is unknown. ' +
          'Probed: ' + [...new Set([...(chosen.server.candidatePorts ?? []), ...DEFAULT_PORTS])].join(', ') + '.',
      }
    }
    return { ok: true, server: chosen.server, port, reason: chosen.reason, snapshot, error: null }
  }

  /**
   * Make sure an audio server is running, booting one when there is none.
   *
   * A server someone else started is reused, never restarted: the audio device
   * is a shared resource and a plugin that boots a second `scsynth` on the same
   * device is a plugin that breaks someone else's session.
   *
   * @param options - `{ port, supernova, boot, device, sampleRate, signal }`.
   * @returns `{ ok, port, pid, booted, reused, error, tail, logFile, metrics }`.
   */
  async ensureServer(options = {}) {
    const port = options.port ?? DEFAULT_PORT
    const existing = await this.target({ port, force: true })
    if (existing.ok) {
      return { ok: true, port: existing.port, pid: existing.server.pid, booted: false, reused: true, error: null, metrics: null }
    }
    if (options.boot === false) {
      return { ok: false, port, pid: null, booted: false, reused: false, error: existing.error }
    }
    const install = this.install ?? this.refreshInstall()
    const file = options.supernova === true ? install.supernova.file ?? install.scsynth.file : install.scsynth.file
    if (file === null) {
      return {
        ok: false,
        port,
        pid: null,
        booted: false,
        reused: false,
        error:
          'no scsynth or supernova executable was found' +
          (install.scsynth.source === 'env-missing' ? ' (DSH_SC_SCSYNTH points at ' + install.scsynth.missing + ', which does not exist)' : '') +
          '. Install SuperCollider or set DSH_SC_SCSYNTH.',
      }
    }
    const booted = await this.scsynth.boot({
      file,
      port,
      supernova: options.supernova === true,
      device: options.device,
      sampleRate: options.sampleRate,
      numOutputs: options.outputs,
      numInputs: options.inputs,
    })
    if (booted.ok) {
      this.trackedPid = booted.pid
      this.invalidate()
      return { ok: true, port, pid: booted.pid, booted: true, reused: false, error: null, tail: booted.tail, logFile: booted.log, metrics: booted.status, ms: booted.ms }
    }
    return { ok: false, port, pid: booted.pid ?? null, booted: false, reused: false, error: booted.error, tail: booted.tail, logFile: booted.log, ms: booted.ms }
  }

  /**
   * Evaluate code in the live interpreter, first pointing it at a server.
   *
   * @param options - `{ code, pid, port, timeoutMs, inlineLimit }`.
   * @returns `{ ok, text, file, bytes, port, server, error, ms, daemonRestarted }`.
   */
  async evaluate(options) {
    const target = await this.target({ pid: options.pid, port: options.port })
    const port = target.ok ? target.port : Number.isInteger(options.port) ? options.port : null
    const mode = (options.code ?? '').length > (options.inlineLimit ?? INLINE_LIMIT_BYTES) ? 'file' : 'inline'
    const started = Date.now()
    const wasStarted = this.sclang.started
    const result = await this.sclang.evaluate({ code: options.code, timeoutMs: options.timeoutMs, mode, port })
    if (!result.ok && result.kind === 'timeout') {
      // A stuck snippet leaves the interpreter in an unknown state, and the only
      // honest recovery is a fresh one. Saying so is what stops the next call
      // from silently operating on a broken session.
      const wasAlive = this.sclang.alive
      this.sclang.stop()
      this.log.warn('the sclang session was restarted after a timed-out request')
      return { ...result, port, server: target.server, daemonRestarted: wasAlive && wasStarted, ms: Date.now() - started }
    }
    return {
      ...result,
      port,
      server: target.server,
      daemonRestarted: false,
      ms: Date.now() - started,
    }
  }

  /**
   * Compile-check code in a one-shot interpreter.
   *
   * @param options - `{ code, timeoutMs, signal }`.
   * @returns `{ ok, error, output, ms }`.
   */
  async check(options) {
    const install = this.install ?? this.refreshInstall()
    return checkSyntax({
      code: options.code,
      sclangFile: install.sclang.file,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      env: this.env,
    })
  }

  /**
   * Compile a SynthDef and produce its `.scsyndef` bytes.
   *
   * The bytes do NOT come back through the REPL stream: measured, a 420-byte
   * `asBytes` list printed through the REPL was interleaved with the input echo
   * and truncated. The def is written to a file by SuperCollider itself and the
   * path is what comes back, which is also exactly how SuperCollider moves a
   * def that is too large for one OSC datagram.
   *
   * @param options - `{ name, source, timeoutMs }`.
   * @returns `{ ok, name, file, bytes, error, ms }`.
   */
  async compileSynthDef(options) {
    const install = this.install ?? this.refreshInstall()
    if (install.sclang.file === null) {
      return { ok: false, name: options.name, file: null, bytes: 0, error: 'sclang was not found, so a SynthDef cannot be compiled' }
    }
    const ready = await this.sclang.ensure({})
    if (!ready.ok) return { ok: false, name: options.name, file: null, bytes: 0, error: ready.error }
    await ensureDirs(this.home, ['synthdefs'])
    const digest = createHash('sha256').update(String(options.name) + '\u0000' + String(options.source)).digest('hex').slice(0, 16)
    const file = path.join(synthDefDir(this.home), options.name + '-' + digest + '.scsyndef')
    const code = [
      'var d = ' + String(options.source).trim() + ';',
      'if (d.isNil) { "the SynthDef could not be built (the source evaluated to nil)" } {',
      '  var f = File.open("' + file.replace(/\\/g, '\\\\') + '", "wb");',
      '  if (f.isNil) { "could not open the .scsyndef file for writing" } {',
      '    f.write(d.asBytes); f.close;',
      '    "wrote the .scsyndef"',
      '  }',
      '};',
    ].join(' ')
    const started = Date.now()
    const result = await this.sclang.evaluate({ code, timeoutMs: options.timeoutMs ?? 60_000, mode: 'inline' })
    if (!result.ok) {
      return { ok: false, name: options.name, file: null, bytes: 0, error: result.error, detail: result.text, ms: Date.now() - started }
    }
    let bytes = 0
    try {
      const stat = await fsp.stat(file)
      bytes = stat.size
    } catch (err) {
      return {
        ok: false,
        name: options.name,
        file: null,
        bytes: 0,
        error: 'the SynthDef compiled but no file was written',
        detail: result.text,
        ms: Date.now() - started,
      }
    }
    return { ok: true, name: options.name, file, bytes, error: null, detail: result.text, ms: Date.now() - started }
  }

  /**
   * Send a compiled SynthDef to a server, once per (name, port), and prove it.
   *
   * The proof matters: `/d_load` is asynchronous, so a node created one message
   * later fails with `SynthDef not found` — measured. The server's own
   * `synthDefCount` from `/status` is the evidence, and it is reported, so a load
   * that the server ignored is never called a success.
   *
   * @param options - `{ name, file, port, force }`.
   * @returns `{ ok, loaded, already, verified, error, note }`.
   */
  async loadSynthDef(options) {
    const port = options.port
    if (!Number.isInteger(port)) return { ok: false, loaded: false, already: false, verified: false, error: 'no server port was resolved' }
    const names = this.loaded.get(port) ?? new Set()
    if (!options.force && names.has(options.name)) {
      const status = await this.scsynth.status({ port })
      // A cached "loaded" is only believed when the server still has at least one
      // def. After a reboot the count is 0 and the cache is re-sent.
      if (status.up && (status.metrics?.synthDefCount ?? 0) > 0) {
        return { ok: true, loaded: false, already: true, verified: true, error: null }
      }
      names.delete(options.name)
    }
    const before = (await this.scsynth.status({ port })).metrics?.synthDefCount ?? null
    const sent = await this.scsynth.loadSynthDef({ port, file: options.file })
    if (!sent.ok) return { ok: false, loaded: false, already: false, verified: false, error: sent.error }
    // The acknowledgement is asynchronous even when it arrives promptly, so the
    // def count is allowed to settle rather than read once.
    let after = before
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await sleep(60)
      const status = await this.scsynth.status({ port })
      after = status.metrics?.synthDefCount ?? after
      if (before === null || after === null || after > before) break
    }
    names.add(options.name)
    this.loaded.set(port, names)
    const verified = before === null || after === null ? sent.acknowledged === true : after > before
    return {
      ok: true,
      loaded: true,
      already: false,
      verified,
      error: null,
      note: verified ? null : 'the server did not report a new SynthDef, so it may not be resident: check sc_server action=diagnose',
    }
  }

  /**
   * Forget which SynthDefs are loaded, so the next load sends them again.
   *
   * Called when a server reboots: its def table is empty afterwards, and a cache
   * that does not know that is a cache that reports a SynthDef as loaded while
   * every `/s_new` fails with "SynthDef not found".
   */
  forgetLoaded(port = null) {
    if (port === null) this.loaded.clear()
    else this.loaded.delete(port)
  }

  /**
   * The SynthDef cache: what has been compiled, by content digest.
   *
   * @returns the cache object.
   */
  async cache() {
    if (this.synthDefCache !== null) return this.synthDefCache
    this.synthDefCache = (await readJson(path.join(this.home, 'dsh-supercollider', SYNTHDEF_CACHE_FILE))) ?? { entries: {} }
    return this.synthDefCache
  }

  /** Remember one compiled SynthDef. */
  async rememberSynthDef(entry) {
    const cache = await this.cache()
    cache.entries[entry.digest] = { ...entry, at: new Date().toISOString() }
    await ensureDirs(this.home, [])
    await writeJson(path.join(this.home, 'dsh-supercollider', SYNTHDEF_CACHE_FILE), cache)
  }

  /** Look one up by digest. */
  async recallSynthDef(digest) {
    const cache = await this.cache()
    return cache.entries[digest] ?? null
  }

  /** Every compiled SynthDef this cache knows. */
  async listSynthDefs() {
    const cache = await this.cache()
    return Object.values(cache.entries).sort((a, b) => String(a.name).localeCompare(String(b.name)))
  }

  /** The version of SuperCollider in use, asking `sclang -v` at most once. */
  async version() {
    if (this.versionCache !== undefined) return this.versionCache
    const install = this.install ?? this.refreshInstall()
    this.versionCache = await sclangVersion(install.sclang.file, { timeoutMs: 15_000 })
    return this.versionCache
  }

  /** The help root, without building the index. */
  helpRoot() {
    const install = this.install ?? this.refreshInstall()
    return resolveHelpRoot({ env: this.env, platform: process.platform, install })
  }

  /** Stop everything this session owns. Spawned servers keep running. */
  async dispose() {
    this.sclang.dispose()
    await this.scsynth.dispose()
  }

  /** Housekeeping: drop channel files nobody read. */
  async prune() {
    return pruneChannelFiles(this.home)
  }
}
