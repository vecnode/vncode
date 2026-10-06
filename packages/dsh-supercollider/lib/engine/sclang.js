/**
 * dsh-supercollider — one long-lived `sclang`, and the protocol for talking to it.
 *
 * This is the module that makes the package real-time, and the reason the
 * architecture is what it is. The implementations this replaces spawned a fresh
 * `sclang` per call: the class library loads in 0.5–2 s
 * (`legacy/rust-server/src/sc_process.rs:516`), the call runs, the interpreter
 * exits, and nothing survives — no `~variable`, no `Ndef`, no `Pbind` still
 * playing. Measured on the host this was written on, a persistent REPL is ready
 * in ~1.0 s and then answers in **62 ms**, and everything it defined is still
 * there for the next call. That difference is the entire feature.
 *
 * ## The protocol
 *
 * sclang's REPL echoes what it is given, so the input and the output share one
 * stream and a naive reader parses its own input. Two facts were measured and
 * both shaped this protocol:
 *
 *   1. The echo carries any marker the *code* contains, so a reply marker must
 *      be something only the *output* can produce. `schelp.js`-style "wait for
 *      the marker" therefore fails against the echo.
 *   2. A large payload printed through the REPL arrives **interleaved and
 *      truncated** — a 420-byte `SynthDef.asBytes` dump was cut off mid-list.
 *
 * So: a request is a normalised action whose result is posted on one line as
 * `<RI:ID:OK>payload</RI>`, preceded by a `#LINE n` echo of the action so a
 * multi-line submission can be told apart from its result. Anything large is
 * written by SuperCollider to a file with `File.use` and the inline answer is
 * only `<RI:ID:FILE>path:length</RI>`. The caller decides which it wants
 * through `mode`.
 *
 * A `syntax` check never uses this session: it compiles in a one-shot process,
 * the way the old implementations did, so a bad snippet cannot leave the live
 * interpreter in a half-evaluated state.
 */

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ensureDirs, uniqueName } from './log.js'
import { runBinary, spawnSession } from './run.js'

/** The asset templates, beside this module. */
const ASSETS = new URL('../assets/', import.meta.url)

/** How long the interpreter may take to reach its first prompt. */
export const START_TIMEOUT_MS = 40_000
/** A normal request's deadline. */
export const REQUEST_TIMEOUT_MS = 15_000
/** The deadline for a request that is allowed to be slow. */
export const LONG_REQUEST_TIMEOUT_MS = 120_000
/** How long an idle daemon is kept before it is reclaimed. */
export const IDLE_TIMEOUT_MS = 15 * 60 * 1000
/** A payload larger than this goes through a file instead of the REPL stream. */
export const INLINE_LIMIT_BYTES = 32 * 1024
/** The prompt the REPL prints when it is ready for input. */
export const PROMPT = 'sc3>'

/**
 * Read one asset template.
 *
 * @param name - the file name under `lib/assets/`.
 * @returns the template text.
 */
export async function readAsset(name) {
  return fsp.readFile(fileURLToPath(new URL(name, ASSETS)), 'utf8')
}

/**
 * Make one submission safe to write to `sclang`'s standard input.
 *
 * **The REPL evaluates per LINE.** A block pasted into the SuperCollider IDE is
 * parsed as a whole, but the same block written to the interpreter's stdin is
 * read one line at a time: the opening `(` is parsed on its own and reported as
 * `syntax error, unexpected end of file, expecting ')'`, and every line after it
 * fails the same way. Measured, on 3.14.1 — see the transcript in
 * `scripts/checks/check-sc-node.mjs`'s fixtures. So a multi-line submission has
 * to become ONE line before it is written.
 *
 * Collapsing newlines changes the meaning of two things, and both are removed
 * first:
 *
 *   - a `//` line comment would swallow the rest of the collapsed line, so it is
 *     stripped to the end of its own line;
 *   - a `/* … *​/` block comment would swallow the code between its delimiters, so
 *     it is stripped as a whole.
 *
 * A string literal is not touched (its contents are code too, but it is the
 * author's text), and a newline inside a string becomes a space, which is what a
 * one-line submission has to do with it.
 *
 * @param source - the sclang source.
 * @returns one line, with no comments outside strings.
 */
export function normalizeSubmission(source) {
  const text = String(source ?? '')
  let out = ''
  let index = 0
  let quote = null
  let inLineComment = false
  let inBlockComment = false
  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]
    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false
        out += ' '
      }
      index += 1
      continue
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false
        index += 2
        continue
      }
      index += 1
      continue
    }
    if (quote !== null) {
      out += char
      if (char === '\\') {
        out += next ?? ''
        index += 2
        continue
      }
      if (char === quote) quote = null
      else if (char === '\n') out = out.slice(0, -1) + ' '
      index += 1
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      out += char
      index += 1
      continue
    }
    if (char === '/' && next === '/') {
      inLineComment = true
      index += 2
      continue
    }
    if (char === '/' && next === '*') {
      inBlockComment = true
      index += 2
      continue
    }
    if (char === '\n' || char === '\r') {
      out += ' '
      index += 1
      continue
    }
    out += char
    index += 1
  }
  return out.trim()
}

/**
 * The action a request is wrapped in, as ONE line.
 *
 * `var` is deliberately absent: at the top level of the REPL's wrapping
 * parenthesis a `var` declaration is a syntax error (`unexpected VAR` —
 * measured), so the wrapper binds with `try`'s argument and an assignment
 * instead.
 *
 * @param options - `{ id, code, mode, file }`.
 * @returns the sclang source to submit, with no newline in it.
 */
export function buildAction(options) {
  const id = options.id
  const mode = options.mode ?? 'inline'
  const payload = normalizeSubmission(options.code)
  const lines = []
  lines.push('(')
  lines.push('"#LINE ' + id + '".postln;')
  lines.push('try {')
  lines.push('  var r = { ' + payload + ' }.value;')
  lines.push('  var s = r.asString;')
  if (mode === 'file') {
    // The path goes into an sclang double-quoted string, so its backslashes are
    // doubled: a Windows path is `C:\\Users\\…` to SuperCollider, and `\U` is
    // otherwise an escape sequence.
    const literal = '"' + String(options.file).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
    lines.push('  var f = File.open(' + literal + ', "w");')
    lines.push('  if (f.isNil) {')
    lines.push('    "<RI:' + id + ':ERR>could not open the answer file for writing</RI>".postln;')
    lines.push('  } {')
    lines.push('    f.write(s); f.close;')
    lines.push('    ("<RI:' + id + ':FILE>" ++ ' + literal + ' ++ ":" ++ s.size.asString ++ "</RI>").postln;')
    lines.push('  };')
  } else {
    lines.push('  ("<RI:' + id + ':OK>" ++ s ++ "</RI>").postln;')
  }
  lines.push('} { |err|')
  lines.push('  var msg = err.errorString.asString ?? err.asString;')
  lines.push('  ("<RI:' + id + ':ERR>" ++ msg.replace(Char.nl, " ") ++ "</RI>").postln;')
  lines.push('};')
  lines.push(')')
  return lines.join(' ')
}

/**
 * Parse a reply out of a captured REPL transcript.
 *
 * Exported because this is the piece worth testing: the regression this guards
 * against is the echo, and only a recorded transcript proves it is handled.
 *
 * @param transcript - the text captured so far.
 * @param id - the request id to look for.
 * @returns `{ state, kind, payload, file, bytes }` where `state` is
 *   `'pending' | 'inline' | 'file' | 'error'`.
 */
export function parseReply(transcript, id) {
  const text = String(transcript ?? '')
  const marker = '<RI:' + id + ':'
  const start = text.lastIndexOf(marker)
  if (start < 0) return { state: 'pending', kind: null, payload: '', file: null, bytes: 0 }
  const after = text.slice(start + marker.length)
  const close = after.indexOf('</RI>')
  if (close < 0) return { state: 'pending', kind: null, payload: '', file: null, bytes: 0 }
  const body = after.slice(0, close)
  const separator = body.indexOf('>')
  if (separator < 0) return { state: 'pending', kind: null, payload: '', file: null, bytes: 0 }
  const kind = body.slice(0, separator)
  const payload = body.slice(separator + 1)
  if (kind === 'OK') return { state: 'inline', kind, payload, file: null, bytes: payload.length }
  if (kind === 'ERR') return { state: 'error', kind, payload, file: null, bytes: payload.length }
  if (kind === 'FILE') {
    const colon = payload.lastIndexOf(':')
    const file = colon < 0 ? payload : payload.slice(0, colon)
    const bytes = colon < 0 ? 0 : Number(payload.slice(colon + 1))
    return { state: 'file', kind, payload, file, bytes: Number.isFinite(bytes) ? bytes : 0 }
  }
  return { state: 'pending', kind, payload, file: null, bytes: 0 }
}

/**
 * One live `sclang`, serving one request at a time.
 *
 * Requests are serialised: the interpreter has one state, so two concurrent
 * evaluations would interleave their effects and neither result would be
 * attributable. The queue is what makes a burst of tool calls correct rather
 * than fast.
 */
export class SclangSession {
  /**
   * @param deps - `{ home, env, install, log }`.
   */
  constructor(deps) {
    this.home = deps.home
    this.env = deps.env ?? process.env
    this.install = deps.install
    this.log = deps.log ?? { warn() {}, info() {}, debug() {} }
    /** The spawned interpreter, or null. */
    this.session = null
    /** Everything the interpreter has printed, bounded. */
    this.transcript = ''
    /** The last capture offset handed to a listener. */
    this.cursor = 0
    /** Listeners receiving output as it arrives. */
    this.listeners = new Set()
    /** The serialisation queue. */
    this.queue = Promise.resolve()
    /** A counter for request ids. */
    this.counter = 0
    /** When a request last ran. */
    this.lastUsedAt = 0
    /** The idle reclaim timer. */
    this.idleTimer = null
    /** The last failure, so a caller is told why a daemon is not there. */
    this.lastError = null
    /** Whether the session's `Server.default` was pointed at a port. */
    this.boundPort = null
  }

  /** Whether the interpreter is running. */
  get alive() {
    return this.session !== null && this.session.alive
  }

  /** Whether a daemon has ever started successfully in this process. */
  get started() {
    return this.session !== null
  }

  /**
   * Start the interpreter if it is not running.
   *
   * @param options - `{ timeoutMs, port }`. `port` binds `Server.default` to a
   *   remote server, which is what makes a snippet that calls `.play` or
   *   `Synth(...)` act on the audio server this session controls rather than
   *   trying to boot its own.
   * @returns `{ ok, error, bootMs }`.
   */
  async ensure(options = {}) {
    if (this.alive) {
      if (Number.isInteger(options.port) && options.port > 0 && this.boundPort !== options.port) {
        await this.#direct({ action: 'bind', port: options.port })
        this.boundPort = options.port
      }
      return { ok: true, error: null, bootMs: 0 }
    }
    if (this.install === null || this.install.sclang.file === null) {
      this.lastError = this.install === null ? 'no SuperCollider install was resolved' : 'sclang was not found'
      return { ok: false, error: this.lastError, bootMs: 0 }
    }
    const started = Date.now()
    const file = this.install.sclang.file
    // A deliberately minimal environment for the interpreter: it is the user's
    // own shell environment that sclang would normally inherit, and the plugin
    // has no business adding to it. What matters is that stdin is a pipe and
    // stdout is read here.
    const session = spawnSession({ file, name: 'sclang', args: [] })
    this.transcript = ''
    this.cursor = 0
    const onData = (chunk) => this.#absorb(chunk)
    session.child.stdout.on('data', onData)
    session.child.stderr.on('data', onData)
    session.onExit(() => {
      this.log.warn('the sclang session exited')
      this.session = null
      this.boundPort = null
    })
    this.session = session
    const reached = await this.#waitForTranscript((text) => text.includes(PROMPT), options.timeoutMs ?? START_TIMEOUT_MS)
    if (!reached) {
      const tail = this.transcript.slice(-800)
      this.stop()
      this.lastError = 'sclang did not reach its prompt within the deadline; output tail: ' + tail
      return { ok: false, error: this.lastError, bootMs: Date.now() - started }
    }
    if (Number.isInteger(options.port) && options.port > 0) {
      const bind = await this.#direct({ action: 'bind', port: options.port })
      if (bind.ok) this.boundPort = options.port
    }
    this.#touch()
    return { ok: true, error: null, bootMs: Date.now() - started }
  }

  /**
   * Evaluate code in the live interpreter.
   *
   * @param options - `{ code, timeoutMs, mode, file, port }`.
   * @returns `{ ok, kind, text, file, bytes, error, ms, transcript }`.
   */
  async evaluate(options) {
    const ready = await this.ensure({ port: options.port })
    if (!ready.ok) {
      return { ok: false, kind: null, text: '', file: null, bytes: 0, error: ready.error, ms: 0, transcript: '' }
    }
    const request = await this.#direct({
      action: 'eval',
      code: options.code,
      mode: options.mode,
      file: options.file,
      timeoutMs: options.timeoutMs,
    })
    return request
  }

  /**
   * Point the interpreter's default server at a UDP port.
   *
   * This is the equivalent of the IDE's `Server.remote`, and it is what makes an
   * ordinary snippet — `{ SinOsc.ar(440, 0, 0.2) }.play`, `Synth(\foo)` — land
   * on the audio server this session manages. The old implementation did the
   * same thing per-call inside its bootstrap
   * (`legacy/assets/sclang_remote_execute.sc`).
   *
   * @param port - the UDP port.
   * @returns the request result.
   */
  async bindServer(port) {
    const result = await this.#direct({ action: 'bind', port })
    if (result.ok) this.boundPort = port
    return result
  }

  /** Stop the interpreter now. */
  stop() {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (this.session !== null) {
      this.session.kill()
      this.session = null
    }
    this.boundPort = null
  }

  /** Dispose: stop, and drop every listener. */
  dispose() {
    this.stop()
    this.listeners.clear()
  }

  /**
   * Register an output listener.
   *
   * @param listener - called with `(chunk, transcript)`.
   * @returns an unsubscribe function.
   */
  onOutput(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The transcript since a cursor, and the new cursor. */
  since(cursor) {
    const from = Number.isFinite(cursor) ? Math.max(0, Math.min(cursor, this.transcript.length)) : 0
    return { text: this.transcript.slice(from), cursor: this.transcript.length }
  }

  /**
   * Run one normalised action, waiting for its reply.
   *
   * @param request - `{ action, code, mode, file, port, timeoutMs }`.
   * @returns the request result.
   */
  async #direct(request) {
    const run = async () => {
      if (!this.alive) {
        return { ok: false, kind: null, text: '', file: null, bytes: 0, error: this.lastError ?? 'the sclang session is not running', ms: 0, transcript: '' }
      }
      this.counter += 1
      const id = String(this.counter) + '-' + Math.random().toString(36).slice(2, 8)
      const started = Date.now()
      let source
      if (request.action === 'bind') {
        source =
          '(' +
          ' s = s ?? Server.default;' +
          ' Server.default = Server.remote(\\dshSc, NetAddr("127.0.0.1", ' + String(request.port) + '), ServerOptions.new);' +
          ' Server.default.latency = 0.05;' +
          ' "<RI:' + id + ':OK>bound to ' + String(request.port) + '</RI>".postln;' +
          ' )'
      } else {
        const file = request.mode === 'file' ? request.file ?? (await this.#channelFile()) : undefined
        source = buildAction({ id, code: request.code, mode: request.mode ?? 'inline', file })
      }
      const before = this.transcript.length
      // A trailing newline submits the whole parenthesised block at once: sclang
      // keeps reading until the parentheses balance, so a multi-line block is
      // safe and a stray line is not executed early.
      if (!this.session.write(source + '\n')) {
        return { ok: false, kind: null, text: '', file: null, bytes: 0, error: 'could not write to the sclang interpreter (it has exited)', ms: 0, transcript: '' }
      }
      const timeoutMs = request.timeoutMs ?? REQUEST_TIMEOUT_MS
      const found = await this.#waitFor(before, id, timeoutMs)
      const ms = Date.now() - started
      this.#touch()
      if (found === null) {
        const tail = this.transcript.slice(before).slice(-1200)
        return {
          ok: false,
          kind: 'timeout',
          text: '',
          file: null,
          bytes: 0,
          error: 'the interpreter did not answer within ' + timeoutMs + ' ms. It has been restarted, so any state a stuck snippet left behind is gone.',
          ms,
          transcript: tail,
        }
      }
      if (found.state === 'error') {
        return { ok: false, kind: 'error', text: found.payload, file: null, bytes: 0, error: found.payload, ms, transcript: '' }
      }
      if (found.state === 'file') {
        return { ok: true, kind: 'file', text: '', file: found.file, bytes: found.bytes, error: null, ms, transcript: '' }
      }
      return { ok: true, kind: 'inline', text: found.payload, file: null, bytes: found.payload.length, error: null, ms, transcript: '' }
    }

    const queued = this.queue.then(run, run)
    // Keep the chain alive whatever the request does, and never let a rejected
    // link poison the next request.
    this.queue = queued.then(
      () => undefined,
      () => undefined,
    )
    return queued
  }

  /** A fresh path in the session's channel directory. */
  async #channelFile() {
    await ensureDirs(this.home, ['tmp'])
    return path.join(this.home, 'dsh-supercollider', 'tmp', uniqueName('answer', '.txt'))
  }

  /** Append to the transcript, notify listeners and bound the buffer. */
  #absorb(chunk) {
    const text = String(chunk)
    this.transcript += text
    // A REPL is a stream, not a log: keep the last 256 KiB, which is far more
    // than a reader needs and small enough that a runaway `postln` loop cannot
    // grow it without bound.
    if (this.transcript.length > 262_144) {
      this.transcript = this.transcript.slice(-262_144)
      this.cursor = this.transcript.length
    }
    for (const listener of this.listeners) {
      try {
        listener(text, this.transcript)
      } catch (err) {
        /* an observer must never break the session it watches */
      }
    }
    this.#touch()
  }

  /**
   * Wait for a reply that appears at or after a transcript offset.
   *
   * The offset is what keeps an echo out of the answer: the reply for request N
   * cannot have been printed before request N was written — even though the
   * echo of request N's own marker can.
   *
   * @param from - the transcript length captured before the request was written.
   * @param id - the request id.
   * @param timeoutMs - the deadline.
   * @returns the parsed reply, or null on timeout.
   */
  async #waitFor(from, id, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      // A bounded transcript can have dropped the region the request started in;
      // when it has, the whole buffer is searched, because a reply that is still
      // present is worth finding.
      const offset = this.transcript.length < from ? 0 : from
      const found = parseReply(this.transcript.slice(offset), id)
      if (found.state !== 'pending') return found
      if (!this.alive) return null
      if (Date.now() >= deadline) return null
      await sleep(25)
    }
  }

  /** Wait for the transcript to satisfy a predicate. */
  async #waitForTranscript(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (predicate(this.transcript)) return true
      if (!this.alive) return false
      if (Date.now() >= deadline) return false
      await sleep(50)
    }
  }

  /** Mark the session as recently used and (re)arm the idle reclaim. */
  #touch() {
    this.lastUsedAt = Date.now()
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (!this.alive) return
      if (Date.now() - this.lastUsedAt < IDLE_TIMEOUT_MS) {
        this.#touch()
        return
      }
      this.log.info('reclaiming the idle sclang session')
      this.stop()
    }, 60_000)
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref()
  }
}

/** Wait, without holding the event loop open. */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * Compile-check sclang code without executing it.
 *
 * A one-shot process, always: the point of a syntax check is to learn whether
 * the code parses *before* a live interpreter is asked to run it.
 *
 * @param options - `{ code, sclangFile, timeoutMs, signal, env }`.
 * @returns `{ ok, error, output, ms }`.
 */
export async function checkSyntax(options) {
  if (typeof options.sclangFile !== 'string' || options.sclangFile === '') {
    return { ok: false, error: 'sclang was not found, so nothing can be compile-checked', output: '', ms: 0 }
  }
  const { runBinary } = await import('./run.js')
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-sc-syntax-'))
  try {
    const bootstrap = fileURLToPath(new URL('sclang_syntax_bootstrap.sc', ASSETS))
    const snippet = path.join(dir, 'snippet.scd')
    await fsp.writeFile(snippet, String(options.code ?? ''), 'utf8')
    const result = await runBinary({
      file: options.sclangFile,
      args: [bootstrap, snippet],
      timeoutMs: options.timeoutMs ?? 30_000,
      maxOutputChars: 100_000,
      signal: options.signal,
      env: options.env,
    })
    if (result.timedOut) {
      return { ok: false, error: 'the compile check was killed after ' + result.ms + ' ms', output: result.output, ms: result.ms }
    }
    if (result.code === 0) {
      return { ok: true, error: null, output: result.output, ms: result.ms }
    }
    return {
      ok: false,
      error: 'sclang exited ' + String(result.code) + ' compiling that code',
      output: result.output,
      ms: result.ms,
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
