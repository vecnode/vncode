/**
 * dsh-supercollider — the audio server: spawn it, ask it things, control it.
 *
 * This is the half of the engine that talks OSC to `scsynth` (or `supernova`)
 * directly, without `sclang` in the middle. It exists for three reasons the old
 * implementations proved:
 *
 *   1. **Determinism.** `mcp_py/sc_process.py:1433` boots the server by spawning
 *      the binary with `-u <port>` and nothing else, and so does this. Letting
 *      `sclang` boot it means the server's lifetime is tied to a temporary
 *      interpreter, which is exactly what "the server stopped when my snippet
 *      ended" looks like.
 *   2. **Diagnosis.** A spawned server's stdout and stderr carry the device it
 *      chose, its sample rate and every `FAILURE IN SERVER`. Owning the process
 *      is what makes `sc_server diagnose` able to answer "the server is up but
 *      there is no sound".
 *   3. **No `sclang` requirement.** `/status`, `/quit`, `/d_load` and `/s_new`
 *      work on a machine with only `scsynth` installed.
 *
 * What this module will NOT do: kill a server it did not spawn. The plugin
 * tracks its own PIDs; `sc_stop` frees nodes on whatever server is answering,
 * and `/quit` is only ever sent when the caller asks for it by name.
 */

import { spawn } from 'node:child_process'
import path from 'node:path'

import { AppendLog, ensureDirs, uniqueName } from './log.js'
import { probeStatus, OscSocket } from './osc-socket.js'
import { statusMetrics } from './osc.js'

/** The port scsynth reads from when nobody says otherwise. */
export const DEFAULT_PORT = 57110

/** How often the boot loop asks whether the server is up. */
export const BOOT_POLL_MS = 200
/** How long a boot may take before it is reported as failed. */
export const BOOT_TIMEOUT_MS = 25_000
/** How long a `/quit` may take to take effect. */
export const QUIT_TIMEOUT_MS = 15_000
/** How long `/status` waits for its reply. */
export const STATUS_TIMEOUT_MS = 500
/** How long `/quit` waits for its `/done` acknowledgement. */
export const QUIT_ACK_MS = 1_000

/**
 * The argv a spawned server gets.
 *
 * Deliberately minimal, and deliberately without the memory flags: passing
 * `-m 0:0` makes scsynth die with `Exception in World_New: FAILURE IN SERVER:
 * HashTable allocation failed: out of memory!` — measured on 3.14.1 — so the
 * only flags this builds are the ones a caller asked for.
 *
 * @param options - `{ port, supernova, device, inputDevice, sampleRate,
 *   blockSize, numOutputs, numInputs, maxNodes, maxSynthDefs, verbosity, loadDefs, ugenPlugins }`.
 * @returns an array of arguments.
 */
export function serverArgs(options = {}) {
  const args = ['-u', String(options.port ?? DEFAULT_PORT)]
  const push = (flag, value) => {
    if (value === undefined || value === null || value === '') return
    args.push(flag, String(value))
  }
  push('-a', options.numOutputs ?? options.outputs)
  push('-i', options.numInputs ?? options.inputs)
  if (options.supernova === true || options.supernova === 'true') {
    // supernova is a drop-in for scsynth but takes the same core flags; -D is
    // its device string in the SuperCollider convention "out:in".
  }
  push('-H', options.device)
  push('-I', options.inputDevice)
  push('-S', options.sampleRate ?? options.sr)
  push('-Z', options.blockSize)
  push('-n', options.maxNodes)
  push('-d', options.maxSynthDefs)
  push('-l', options.maxLogins)
  push('-v', options.verbosity)
  if (options.loadDefs === false) args.push('-N')
  for (const plugin of options.ugenPlugins ?? []) push('-U', plugin)
  return args
}

/**
 * The audio server this session can control.
 *
 * One UDP socket per handle, opened lazily and closed by `dispose()`. The
 * handle remembers the servers **it** spawned so nothing else is ever killed
 * by accident, and writes each spawned server's output to one append-only log
 * under `$DSH_HOME/dsh-supercollider/logs/`.
 */
export class Scsynth {
  /**
   * @param deps - `{ home, env, log }`.
   */
  constructor(deps) {
    this.home = deps.home
    this.env = deps.env ?? process.env
    this.log = deps.log ?? { warn() {}, info() {}, debug() {} }
    /** The OSC socket, lazily created. */
    this.socket = null
    /** Every server this handle spawned, by pid: `{ pid, port, file, log, child, startedAt }`. */
    this.spawned = new Map()
  }

  /** The shared OSC socket, opening it on first use. */
  async socketFor() {
    if (this.socket === null || this.socket.closed) {
      this.socket = new OscSocket({ log: this.log })
      await this.socket.open()
    }
    return this.socket
  }

  /** Whether this handle started the server with that pid. */
  owns(pid) {
    return Number.isInteger(pid) && this.spawned.has(pid)
  }

  /**
   * `/status` on a port.
   *
   * @param options - `{ port, timeoutMs }`.
   * @returns `{ up, metrics, raw, ms }` where `metrics` is null when it is not up.
   */
  async status(options = {}) {
    const port = options.port ?? DEFAULT_PORT
    const started = Date.now()
    const reply = await probeStatus({
      port,
      timeoutMs: options.timeoutMs ?? STATUS_TIMEOUT_MS,
      log: this.log,
    })
    return {
      up: reply !== null,
      port,
      metrics: reply === null ? null : statusMetrics(reply.args),
      raw: reply === null ? null : reply.args,
      ms: Date.now() - started,
    }
  }

  /**
   * Send one message with no expectation of a reply.
   *
   * @param options - `{ port, address, args, host }`.
   * @returns `{ ok, error }` — a send failure is data, not a throw, because a
   *   dead port is the normal case this is used to detect.
   */
  async send(options) {
    try {
      const socket = await this.socketFor()
      await socket.send(options.port ?? DEFAULT_PORT, options.address, options.args ?? [], options.host)
    } catch (err) {
      const message = err && err.message ? String(err.message) : String(err)
      this.log.debug('OSC send to ' + options.address + ' failed: ' + message)
      return { ok: false, error: message }
    }
    return { ok: true, error: null }
  }

  /** Send one message and wait for the first matching reply, or null. */
  async request(options) {
    const socket = await this.socketFor()
    return socket.request({
      port: options.port ?? DEFAULT_PORT,
      address: options.address,
      args: options.args ?? [],
      timeoutMs: options.timeoutMs,
      match: options.match,
      host: options.host,
    })
  }

  /**
   * Spawn a server and wait until it answers `/status`.
   *
   * @param options - `{ port, supernova, file, ...serverArgs, log }`.
   * @returns `{ ok, pid, port, file, args, log, status, error, ms }`.
   */
  async boot(options = {}) {
    const port = options.port ?? DEFAULT_PORT
    const file = options.file
    if (typeof file !== 'string' || file === '') {
      return { ok: false, error: 'no scsynth or supernova executable was given to boot', port, pid: null }
    }
    const args = serverArgs({ ...options, port })
    const started = Date.now()
    await ensureDirs(this.home, ['logs'])

    if (options.logFile !== null) {
      const logFile = options.logFile ?? path.join(this.home, 'dsh-supercollider', 'logs', uniqueName('server-' + port, '.log'))
      const append = new AppendLog(logFile)
      await append.open()
      let child
      try {
        child = spawn(file, args, {
          windowsHide: true,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (err) {
        await append.close()
        const message = err && err.message ? String(err.message) : String(err)
        return { ok: false, error: 'could not start ' + file + ': ' + message, port, pid: null, file, args }
      }
      if (child.pid === undefined) {
        await append.close()
        return { ok: false, error: 'could not start ' + file + ' (it exited immediately)', port, pid: null, file, args }
      }
      child.stdout.on('data', (chunk) => append.append(chunk))
      child.stderr.on('data', (chunk) => append.append(chunk))
      child.on('error', (err) => this.log.warn('server ' + String(child.pid) + ' failed: ' + (err && err.message)))
      // Detached so the audio server outlives this process: it is a shared
      // resource with its own lifetime, and a plugin reload must not stop sound.
      child.unref()
      this.spawned.set(child.pid, { pid: child.pid, port, file, args, log: logFile, append, startedAt: started })

      const wait = await this.waitForStatus(port, options.timeoutMs ?? BOOT_TIMEOUT_MS)
      const tail = await append.tail(options.tailLines ?? 20)
      if (!wait.up) {
        return {
          ok: false,
          pid: child.pid,
          port,
          file,
          args,
          log: logFile,
          status: null,
          error: 'the server did not answer /status within ' + wait.waitedMs + ' ms',
          tail,
          ms: Date.now() - started,
        }
      }
      return { ok: true, pid: child.pid, port, file, args, log: logFile, status: wait.metrics, tail, ms: Date.now() - started }
    }
    return { ok: false, error: 'booting without a log is not supported', port, pid: null }
  }

  /**
   * Poll `/status` until it answers or the deadline passes.
   *
   * @param port - the UDP port.
   * @param timeoutMs - how long to keep asking.
   * @returns `{ up, metrics, waitedMs, attempts }`.
   */
  async waitForStatus(port, timeoutMs = BOOT_TIMEOUT_MS) {
    const started = Date.now()
    let attempts = 0
    for (;;) {
      attempts += 1
      const reply = await probeStatus({ port, timeoutMs: 250, log: this.log })
      if (reply !== null) {
        return { up: true, metrics: statusMetrics(reply.args), waitedMs: Date.now() - started, attempts }
      }
      if (Date.now() - started >= timeoutMs) {
        return { up: false, metrics: null, waitedMs: Date.now() - started, attempts }
      }
      await sleep(BOOT_POLL_MS)
    }
  }

  /**
   * Ask a server to quit, then wait for it to disappear.
   *
   * `/quit` is the only correct way to stop scsynth: it is the message the
   * server itself handles, and the implementations this replaces sent it by raw
   * UDP rather than through `sclang` because `Server.remote` has no `quit`
   * (`rust-server/src/sc_process.rs:577-579`).
   *
   * @param options - `{ port, pid, timeoutMs }`.
   * @returns `{ ok, acknowledged, exited, waitedMs }`.
   */
  async quit(options = {}) {
    const port = options.port ?? DEFAULT_PORT
    const socket = await this.socketFor()
    const started = Date.now()
    const acknowledged = await socket.request({
      port,
      address: '/quit',
      timeoutMs: options.ackMs ?? QUIT_ACK_MS,
      match: (message) => message.address === '/done',
    })
    const deadline = options.timeoutMs ?? QUIT_TIMEOUT_MS
    let exited = false
    for (;;) {
      const still = await probeStatus({ port, timeoutMs: 200, log: this.log })
      if (still === null) {
        exited = true
        break
      }
      if (Date.now() - started >= deadline) break
      await sleep(BOOT_POLL_MS)
    }
    if (Number.isInteger(options.pid)) this.spawned.delete(options.pid)
    return { ok: exited, acknowledged: acknowledged !== null, exited, waitedMs: Date.now() - started }
  }

  /**
   * Send a SynthDef to a server from a `.scsyndef` file on disk, and WAIT for it.
   *
   * `/d_load` is a file-path command and it is **asynchronous**: scsynth replies
   * `/done` when the definition is resident. Without that wait, an immediately
   * following `/s_new` fails with `SynthDef not found` — measured, and the
   * implementation this replaces papered over it with a sleep and a few retries
   * (`legacy/mcp_py/sc_process.py:1626-1646`). Waiting for the reply is the
   * honest version of the same fix, and it is why the shared socket matters:
   * the `/done` comes back to whoever sent `/d_load`.
   *
   * @param options - `{ port, file, timeoutMs }`.
   * @returns `{ ok, acknowledged, error }`.
   */
  async loadSynthDef(options) {
    if (typeof options.file !== 'string' || options.file === '') {
      return { ok: false, acknowledged: false, error: 'no .scsyndef path was given' }
    }
    const socket = await this.socketFor()
    const reply = await socket.request({
      port: options.port,
      address: '/d_load',
      args: [options.file],
      timeoutMs: options.timeoutMs ?? 3_000,
      match: (message) => message.address === '/done' || message.address === '/fail',
    })
    if (reply === null) {
      // No acknowledgement. The load may still have happened — the reply is a
      // UDP datagram and one can be lost — so this is reported, not thrown, and
      // the caller decides with its own evidence.
      return { ok: true, acknowledged: false, error: null, note: 'the server did not acknowledge /d_load within the deadline' }
    }
    if (reply.address === '/fail') {
      return { ok: false, acknowledged: true, error: 'the server refused /d_load: ' + String(reply.args?.[0] ?? 'no reason given') }
    }
    return { ok: true, acknowledged: true, error: null }
  }

  /**
   * Send raw SynthDef bytes with `/d_recv`, and wait for the acknowledgement.
   *
   * @param options - `{ port, bytes, timeoutMs }`.
   * @returns `{ ok, acknowledged, error }`.
   */
  async recvSynthDef(options) {
    const bytes = Buffer.isBuffer(options.bytes) ? options.bytes : Buffer.from(options.bytes ?? [])
    if (bytes.length === 0) return { ok: false, acknowledged: false, error: 'no SynthDef bytes were given' }
    const socket = await this.socketFor()
    const reply = await socket.request({
      port: options.port,
      address: '/d_recv',
      args: [bytes],
      timeoutMs: options.timeoutMs ?? 3_000,
      match: (message) => message.address === '/done' || message.address === '/fail',
    })
    if (reply === null) return { ok: true, acknowledged: false, error: null, note: 'the server did not acknowledge /d_recv within the deadline' }
    if (reply.address === '/fail') return { ok: false, acknowledged: true, error: 'the server refused /d_recv: ' + String(reply.args?.[0] ?? 'no reason given') }
    return { ok: true, acknowledged: true, error: null }
  }

  /** Free every node in a group (`/g_freeAll`), the OSC half of a panic. */
  async freeAll(options = {}) {
    return this.send({ port: options.port, address: '/g_freeAll', args: [options.group ?? 0] })
  }

  /**
   * Allocate a server buffer (`/b_alloc`).
   *
   * A buffer is the only memory the engine has in the audio server, and it is
   * what makes a measurement possible at all: the server can write what it is
   * playing into one, and this side can read it back and compute.
   *
   * @param options - `{ port, bufnum, frames, channels, completion }`.
   * @returns `{ ok, error }`.
   */
  async bufferAlloc(options) {
    const args = [options.bufnum, options.frames]
    if (Number.isInteger(options.channels) && options.channels > 0) args.push(options.channels)
    const sent = await this.send({ port: options.port, address: '/b_alloc', args })
    if (!sent.ok) return sent
    // `/b_alloc` is asynchronous; `/sync` is the barrier that proves it landed
    // before a SynthDef is asked to record into it.
    if (options.completion !== false) await this.sync({ port: options.port })
    return { ok: true, error: null }
  }

  /** Free a server buffer (`/b_free`). */
  async bufferFree(options) {
    return this.send({ port: options.port, address: '/b_free', args: [options.bufnum] })
  }

  /**
   * Write floats into a buffer (`/b_setn`), in chunks of 1024 as the OSC spec
   * recommends for `_setn` messages.
   *
   * @param options - `{ port, bufnum, start, values }`.
   * @returns `{ ok, error, chunks }`.
   */
  async bufferSetn(options) {
    const values = Array.from(options.values ?? [])
    const start = options.start ?? 0
    let chunks = 0
    for (let offset = 0; offset < values.length; offset += 1024) {
      const slice = values.slice(offset, offset + 1024)
      const sent = await this.send({
        port: options.port,
        address: '/b_setn',
        args: [options.bufnum, start + offset, slice.length, ...slice],
      })
      if (!sent.ok) return { ok: false, error: sent.error, chunks }
      chunks += 1
    }
    return { ok: true, error: null, chunks }
  }

  /**
   * Read floats out of a buffer (`/b_getn`), in datagram-sized chunks.
   *
   * Two rules from the OSC spec govern this, and getting either wrong loses data
   * silently:
   *
   *   1. A `/b_getn` reply is **one `/b_setn`** message, unless it would exceed
   *      the maximum datagram size, in which case it arrives as several — so a
   *      read collects until the deadline rather than expecting a known count.
   *   2. A *request* for more samples than fit in one reply is not served at all.
   *      Measured against scsynth 3.14.1: asking for 96 000 floats got **no
   *      reply**, while 512 floats round-tripped exactly. A capture of one
   *      second of stereo audio is 96 000 floats, so this is the normal case, not
   *      an edge case.
   *
   * Hence: request in chunks small enough that every reply fits one datagram
   * (8192 floats is 32 KiB of payload, comfortably under the 64 KiB limit), and
   * concatenate.
   *
   * @param options - `{ port, bufnum, start, count, timeoutMs, chunk }`.
   * @returns `{ ok, values, error, replies }`.
   */
  async bufferGetn(options) {
    const count = Math.max(0, Math.floor(options.count ?? 0))
    if (count === 0) return { ok: true, values: [], error: null, replies: 0 }
    const start = options.start ?? 0
    const chunkSize = Math.max(1, Math.min(options.chunk ?? 8192, 16384))
    const socket = await this.socketFor()
    const values = []
    let replies = 0
    for (let offset = 0; offset < count; offset += chunkSize) {
      const size = Math.min(chunkSize, count - offset)
      const collected = await socket.collect({
        port: options.port,
        address: '/b_getn',
        args: [options.bufnum, start + offset, size],
        // A window rather than one reply: the tail of an odd-sized read arrives
        // as its own datagram.
        windowMs: options.timeoutMs ?? 500,
        match: (message) => message.address === '/b_setn' && message.args?.[0] === options.bufnum && message.args?.[1] === start + offset,
      })
      const part = collected.flatMap((message) => message.args.slice(3))
      if (part.length === 0) {
        return {
          ok: false,
          values,
          replies,
          error: 'the server did not answer /b_getn for ' + size + ' samples at offset ' + (start + offset) + ' within the deadline',
        }
      }
      values.push(...part)
      replies += collected.length
    }
    return { ok: true, values: values.slice(0, count), error: null, replies }
  }

  /** The `/sync` barrier: resolved when the server has run everything sent before it. */
  async sync(options = {}) {
    const reply = await this.request({
      port: options.port,
      address: '/sync',
      args: [options.id ?? 0],
      timeoutMs: options.timeoutMs ?? 2_000,
      match: (message) => message.address === '/synced' && (options.id === undefined || message.args?.[0] === options.id),
    })
    return reply !== null
  }

  /** Create a synth node. */
  async newSynth(options) {
    const args = [options.name, options.nodeId ?? -1, options.addAction ?? 0, options.target ?? 0]
    for (const [key, value] of Object.entries(options.params ?? {})) {
      args.push(key, Number(value))
    }
    return this.send({ port: options.port, address: '/s_new', args })
  }

  /** Set controls on a running node. */
  async setNode(options) {
    const args = [options.node]
    for (const [key, value] of Object.entries(options.params ?? {})) {
      args.push(key, Number(value))
    }
    if (args.length < 3) return { ok: false, error: 'a /n_set needs at least one control pair' }
    return this.send({ port: options.port, address: '/n_set', args })
  }

  /** Free one node. */
  async freeNode(options = {}) {
    return this.send({ port: options.port, address: '/n_free', args: [options.node] })
  }

  /**
   * The node tree, as the server's own `/g_queryTree` describes it.
   *
   * The reply is larger than a datagram for a busy server and arrives as
   * several `/g_queryTree.reply` messages, which is why this collects rather
   * than waits for one. The raw numbers are reported alongside a rendered view
   * because a wrong render must not hide the truth.
   *
   * @param options - `{ port, group, flags, windowMs }`.
   * @returns `{ ok, raw, error }`.
   */
  async queryTree(options = {}) {
    const socket = await this.socketFor()
    const collected = await socket.collect({
      port: options.port,
      address: '/g_queryTree',
      args: [options.group ?? 0, options.flags ?? 0],
      windowMs: options.windowMs ?? 400,
      match: (message) => message.address === '/g_queryTree.reply',
    })
    return { ok: collected.length > 0, raw: collected.flatMap((message) => message.args), replies: collected.length }
  }

  /** Close the socket and the logs. Spawned servers keep running. */
  async dispose() {
    for (const entry of this.spawned.values()) {
      if (entry.append !== undefined) await entry.append.close()
    }
    if (this.socket !== null) {
      this.socket.close()
      this.socket = null
    }
  }
}

/** Wait, without holding the event loop open. */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/** Whether one process is still alive, from the OS's own answer. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

/** Delete a file that this package created, ignoring a missing one. */
export async function removeIfPresent(file) {
  if (typeof file !== 'string' || file === '') return
  await fsp.rm(file, { force: true }).catch(() => {})
}
