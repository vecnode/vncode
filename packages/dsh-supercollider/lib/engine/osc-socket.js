/**
 * dsh-supercollider — one OSC socket, with the timeouts Node does not give you.
 *
 * Node's `dgram` has no receive timeout and no notion of a reply: `send()` is
 * fire-and-forget and a datagram either arrives or it does not. `rust-server`
 * got a reply deadline from `UdpSocket::set_read_timeout` and Python from
 * `socket.settimeout` (`sc_process.py:253-261`); here it is a timer per request,
 * and every one of them is cleared on close so a pending request can never keep
 * the process alive.
 *
 * The socket binds an ephemeral loopback port **once** and routes every reply to
 * whoever is waiting for that address. That is what makes one socket enough for
 * the whole engine: a `/status` probe, a `/s_new`, and a `/done` that belongs to
 * a request sent a second ago all arrive on the same port, and the reply for a
 * request is matched by address *and* by whatever shape the caller expects.
 */

import dgram from 'node:dgram'

import { decodeMessage, encodeMessage } from './osc.js'

/** The loopback address every message here is sent to and received from. */
export const LOOPBACK = '127.0.0.1'

/** How long a `/status`-style probe waits for its reply by default. */
export const DEFAULT_REPLY_TIMEOUT_MS = 400

/**
 * One bound UDP socket that speaks OSC.
 *
 * Not a singleton: scsynth and a future second server are separate sockets, and
 * a caller that only wants a one-shot probe should be able to make one and let
 * it go.
 */
export class OscSocket {
  /**
   * @param options - `{ log }`, where `log` is `{ warn, debug }`.
   */
  constructor(options = {}) {
    this.log = options.log ?? { warn() {}, debug() {} }
    /** The bound dgram socket, or null before `open()` / after `close()`. */
    this.socket = null
    /** The local port once bound, else 0. */
    this.port = 0
    /** Every waiter currently registered: `{ match, resolve, timer }`. */
    this.waiters = []
    /** Datagrams that matched no waiter, kept for the console's own view. */
    this.unmatched = []
    this.closed = false
  }

  /**
   * Bind an ephemeral loopback port.
   *
   * @returns this socket, for chaining.
   */
  async open() {
    if (this.socket !== null) return this
    if (this.closed) throw new Error('this OSC socket was closed and cannot be reopened; make a new one')
    const socket = dgram.createSocket('udp4')
    this.socket = socket
    socket.on('message', (buffer, from) => this.#onMessage(buffer, from))
    socket.on('error', (err) => {
      this.log.warn('OSC socket error: ' + (err && err.message ? err.message : String(err)))
    })
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        socket.off('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        socket.off('error', onError)
        resolve()
      }
      socket.once('listening', onListening)
      socket.once('error', onError)
      socket.bind(0, LOOPBACK)
    })
    this.port = socket.address().port
    return this
  }

  /**
   * Send one message. Encoding throws before anything reaches the wire, so a
   * caller that passes an unencodable argument gets an exception and not a
   * half-sent datagram.
   *
   * @param port - the destination UDP port.
   * @param address - the OSC address.
   * @param args - the arguments.
   * @param host - the destination host. Default: loopback.
   */
  async send(port, address, args = [], host = LOOPBACK) {
    if (this.socket === null) await this.open()
    const packet = encodeMessage(address, args)
    await new Promise((resolve, reject) => {
      this.socket.send(packet, port, host, (err) => (err ? reject(err) : resolve()))
    })
    return packet
  }

  /**
   * Send one message and wait for a reply.
   *
   * @param options - `{ port, address, args, match, timeoutMs, host }`. `match`
   *   is a predicate over a decoded datagram; the default accepts any message
   *   whose address is `address + '.reply'`, which is the OSC convention scsynth
   *   follows (`/status` → `/status.reply`, `/sync` → `/synced` excepted, which
   *   is why callers pass their own).
   * @returns the matching decoded message, or null on timeout.
   */
  async request(options) {
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.floor(options.timeoutMs))
      : DEFAULT_REPLY_TIMEOUT_MS
    const match =
      typeof options.match === 'function'
        ? options.match
        : (message) => message.address === options.address + '.reply'
    const waited = this.#wait(match, timeoutMs)
    try {
      await this.send(options.port, options.address, options.args ?? [], options.host)
    } catch (err) {
      waited.cancel()
      throw err
    }
    return waited.promise
  }

  /**
   * Send one message and collect every matching reply until the deadline.
   *
   * A `/status` produces exactly one reply, but a `/sync` or a node query can
   * produce several, and a caller that wants all of them should not have to
   * guess a count.
   *
   * @param options - as `request`, plus `windowMs` (the collection window).
   * @returns an array of decoded messages, possibly empty.
   */
  async collect(options) {
    const windowMs = Number.isFinite(options.windowMs)
      ? Math.max(1, Math.floor(options.windowMs))
      : DEFAULT_REPLY_TIMEOUT_MS
    const match = typeof options.match === 'function' ? options.match : () => true
    const found = []
    const registration = this.#register((message) => {
      if (!match(message)) return false
      found.push(message)
      return false
    })
    try {
      await this.send(options.port, options.address, options.args ?? [], options.host)
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, windowMs)
        if (typeof timer.unref === 'function') timer.unref()
      })
    } finally {
      registration.cancel()
    }
    return found
  }

  /** Close the socket and fail every pending request rather than hanging it. */
  close() {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.resolve(null)
    }
    if (this.socket !== null) {
      try {
        this.socket.close()
      } catch (err) {
        /* already closed */
      }
      this.socket = null
    }
    this.port = 0
  }

  /** Register a waiter and start its deadline. */
  #wait(match, timeoutMs) {
    const registration = this.#register(match)
    const timer = setTimeout(() => {
      const index = this.waiters.indexOf(registration.entry)
      if (index >= 0) this.waiters.splice(index, 1)
      registration.entry.resolve(null)
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    registration.entry.timer = timer
    return {
      promise: registration.entry.promise,
      cancel: registration.cancel,
    }
  }

  /**
   * The shared registration shape behind `#wait` and `collect`: one entry in
   * `waiters`, one promise, and a `cancel` that removes it without resolving.
   */
  #register(match) {
    const entry = { match, resolve: null, timer: null, promise: null }
    entry.promise = new Promise((resolve) => {
      entry.resolve = resolve
    })
    this.waiters.push(entry)
    return {
      entry,
      cancel: () => {
        const index = this.waiters.indexOf(entry)
        if (index >= 0) this.waiters.splice(index, 1)
        if (entry.timer !== null) clearTimeout(entry.timer)
      },
    }
  }

  /** Route one datagram to the first waiter that wants it. */
  #onMessage(buffer, from) {
    let message
    try {
      message = decodeMessage(buffer)
    } catch (err) {
      this.log.debug('undecodable OSC datagram from ' + from.address + ': ' + (err && err.message))
      return
    }
    for (const waiter of [...this.waiters]) {
      let wanted = false
      try {
        wanted = waiter.match(message) === true
      } catch (err) {
        wanted = false
      }
      if (!wanted) continue
      const index = this.waiters.indexOf(waiter)
      if (index >= 0) this.waiters.splice(index, 1)
      if (waiter.timer !== null) clearTimeout(waiter.timer)
      waiter.resolve(message)
      return
    }
    // Nothing was waiting. Keep a short bounded tail: the console shows it, and
    // a stray /fail is the single most useful thing to see when a command did
    // not do what the agent expected.
    this.unmatched.push(message)
    if (this.unmatched.length > 64) this.unmatched.splice(0, this.unmatched.length - 64)
  }
}

/**
 * One-shot `/status` probe against a UDP port.
 *
 * This is the reachability test the whole engine trusts: a port is only ever
 * *believed* after it has answered, never because a command line said so.
 *
 * @param options - `{ port, timeoutMs, log, host }`.
 * @returns the decoded `/status.reply`, or null.
 */
export async function probeStatus(options) {
  const socket = new OscSocket({ log: options.log })
  try {
    await socket.open()
    const reply = await socket.request({
      port: options.port,
      address: '/status',
      timeoutMs: options.timeoutMs ?? 250,
      host: options.host,
      match: (message) => message.address === '/status.reply',
    })
    return reply
  } finally {
    socket.close()
  }
}
