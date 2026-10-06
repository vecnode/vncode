/**
 * dsh-supercollider — running one program, carefully.
 *
 * Everything this package executes goes through this module, so the rules are
 * stated once:
 *
 *   - **argv only, never a shell.** `spawn(file, args)` with no `shell: true`,
 *     so a path with a space, a SynthDef body with braces and a `&` in a
 *     filename all arrive as themselves. SuperCollider code is *user code*: a
 *     string interpolated into a command line would be an injection with the
 *     user's own privileges.
 *   - **a deadline, always.** A user's `sclang` snippet can loop forever; a
 *     call that runs past its timeout is killed and reported as killed.
 *   - **bounded output.** `sclang` is chatty and a `SynthDef.asBytes` dump is
 *     megabytes. The capture keeps a head and a tail and says how much it
 *     dropped, so an answer stays an answer.
 *   - **an abortable call.** The agent's own signal kills the child the same way
 *     a timeout does.
 *
 * `windowsHide: true` matters on Windows: without it a console window flashes
 * for every call.
 */

import { spawn } from 'node:child_process'

/** What one call may run for when the caller says nothing. */
export const DEFAULT_TIMEOUT_MS = 60_000
/** The ceiling a caller may ask for. A user snippet may legitimately take a while. */
export const MAX_TIMEOUT_MS = 600_000
/** Characters of combined output kept when the caller says nothing. */
export const DEFAULT_MAX_OUTPUT = 200_000
/** The hard ceiling on kept output, whatever a caller asks for. */
export const MAX_OUTPUT = 2_000_000

const DROPPED_MARK = '\n… [output dropped: '

/**
 * Trim captured text to `cap` characters, keeping the head and the tail.
 *
 * The head is where a program says what it understood; the tail is where it
 * says how it failed. The middle is the part nobody reads.
 *
 * @param text - the captured text.
 * @param cap - the character ceiling.
 * @returns `{ text, dropped }`.
 */
export function trim(text, cap) {
  if (text.length <= cap) return { text, dropped: 0 }
  const head = Math.floor(cap / 2)
  const tail = cap - head
  const dropped = text.length - cap
  return { text: text.slice(0, head) + DROPPED_MARK + dropped + ' characters] …\n' + text.slice(text.length - tail), dropped }
}

/** A caller's timeout, clamped to what this module allows. */
export function clampTimeout(value, fallback = DEFAULT_TIMEOUT_MS) {
  const number = Number.isFinite(value) ? Math.floor(value) : fallback
  if (number <= 0) return fallback
  return Math.min(MAX_TIMEOUT_MS, number)
}

/** A caller's output cap, clamped to what this module allows. */
export function clampOutput(value) {
  const number = Number.isFinite(value) ? Math.floor(value) : DEFAULT_MAX_OUTPUT
  if (number <= 0) return DEFAULT_MAX_OUTPUT
  return Math.min(MAX_OUTPUT, number)
}

/**
 * Run one binary to completion.
 *
 * @param options - `{ file, args, cwd, timeoutMs, maxOutputChars, env, signal,
 *   onOutput, successCodes }`. `onOutput(text, source)` observes every chunk
 *   without replacing the capture, which is how the console follows a session
 *   while it is still running.
 * @returns `{ code, signal, timedOut, aborted, ms, stdout, stderr, output,
 *   dropped, spawnError }`.
 */
export function runBinary(options) {
  const file = options.file
  const args = Array.isArray(options.args) ? options.args.map((value) => String(value)) : []
  const timeoutMs = clampTimeout(options.timeoutMs)
  const maxOutputChars = clampOutput(options.maxOutputChars)
  const started = Date.now()

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: options.env ? { ...process.env, ...options.env } : process.env,
      })
    } catch (err) {
      resolve(result({ code: null, spawnError: messageOf(err), started }))
      return
    }

    let stdout = ''
    let stderr = ''
    let dropped = 0
    let settled = false
    let timedOut = false
    let aborted = false
    let timer = null

    const kill = () => {
      try {
        // SIGKILL, not SIGTERM: sclang traps SIGTERM to unwind, and a deadline
        // that waits for a graceful shutdown is not a deadline.
        child.kill('SIGKILL')
      } catch (err) {
        /* the child is already gone */
      }
    }

    const finish = (code, signal, spawnError) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (options.signal && typeof options.signal.removeEventListener === 'function') {
        options.signal.removeEventListener('abort', onAbort)
      }
      const combined = stderr.length > 0 && stdout.length > 0 ? stderr + '\n' + stdout : stderr + stdout
      const kept = trim(combined, maxOutputChars)
      resolve(
        result({
          code: typeof code === 'number' ? code : null,
          signal: signal ?? null,
          timedOut,
          aborted,
          stdout: trim(stdout, maxOutputChars).text,
          stderr: trim(stderr, maxOutputChars).text,
          output: kept.text,
          dropped: dropped + kept.dropped,
          spawnError: spawnError ?? null,
          ms: Date.now() - started,
        }),
      )
    }

    const onAbort = () => {
      aborted = true
      kill()
    }

    const capture = (which) => (chunk) => {
      const text = String(chunk)
      if (which === 'out') stdout += text
      else stderr += text
      if (typeof options.onOutput === 'function') {
        try {
          options.onOutput(text, which)
        } catch (err) {
          /* an observer must never break the run it is watching */
        }
      }
      // Stop the capture itself from holding a gigabyte to produce a 200k
      // answer: a SynthDef dump through a REPL can be tens of megabytes.
      if (stdout.length + stderr.length > maxOutputChars * 4) {
        const out = trim(stdout, maxOutputChars * 2)
        const err = trim(stderr, maxOutputChars * 2)
        dropped += out.dropped + err.dropped
        stdout = out.text
        stderr = err.text
      }
    }

    child.stdout.on('data', capture('out'))
    child.stderr.on('data', capture('err'))
    child.on('error', (err) => finish(null, null, messageOf(err)))
    child.on('close', (code, signal) => finish(code, signal, null))

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        kill()
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    }
    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else if (typeof options.signal.addEventListener === 'function') options.signal.addEventListener('abort', onAbort)
    }
  })
}

/** The result shape, so a spawn failure and a completed run look the same. */
function result(fields) {
  return {
    code: fields.code ?? null,
    signal: fields.signal ?? null,
    timedOut: fields.timedOut ?? false,
    aborted: fields.aborted ?? false,
    ms: fields.ms ?? 0,
    stdout: fields.stdout ?? '',
    stderr: fields.stderr ?? '',
    output: fields.output ?? '',
    dropped: fields.dropped ?? 0,
    spawnError: fields.spawnError ?? null,
  }
}

/** One error's message, whatever was thrown. */
export function messageOf(err) {
  return err && err.message ? String(err.message) : String(err)
}

/**
 * Run a program and give back only its combined output, for the small fact
 * lookups this package makes for itself. A failure is data, never a throw.
 *
 * @param options - the same shape `runBinary` takes, plus `successCodes`.
 * @returns `{ ok, code, output, ms }`.
 */
export async function runQuiet(options) {
  const successCodes = Array.isArray(options.successCodes) ? options.successCodes : [0]
  const outcome = await runBinary(options)
  return {
    ok: outcome.code !== null && successCodes.includes(outcome.code),
    code: outcome.code,
    output: outcome.output,
    ms: outcome.ms,
    timedOut: outcome.timedOut,
  }
}

/**
 * A long-lived child process with piped stdio.
 *
 * `runBinary` is for a program that finishes; this is for the one that does not
 * — the persistent `sclang` session, which is the whole reason this package can
 * be real-time. The caller owns the returned object and is responsible for
 * `kill()`; every path in the plugin that spawns one also registers a dispose.
 *
 * @param options - `{ file, args, cwd, env, name }`.
 * @returns `{ child, name, write, onLine, kill, alive, exited }`.
 */
export function spawnSession(options) {
  const child = spawn(options.file, options.args ?? [], {
    cwd: options.cwd,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: options.env ? { ...process.env, ...options.env } : process.env,
  })
  const name = options.name ?? 'session'
  let closed = false
  const exitListeners = []
  child.on('close', (code, signal) => {
    closed = true
    for (const listener of exitListeners.splice(0)) {
      try {
        listener(code, signal)
      } catch (err) {
        /* an observer must never break the session it watches */
      }
    }
  })
  child.on('error', () => {
    closed = true
  })
  return {
    child,
    name,
    pid: child.pid ?? null,
    /** Write one line to the child's stdin, with the platform's newline. */
    write(text) {
      if (closed || child.stdin === null || child.stdin.destroyed) return false
      try {
        child.stdin.write(String(text))
        return true
      } catch (err) {
        return false
      }
    },
    /** Register an exit observer. */
    onExit(listener) {
      if (closed) {
        listener(null, null)
        return () => {}
      }
      exitListeners.push(listener)
      return () => {
        const index = exitListeners.indexOf(listener)
        if (index >= 0) exitListeners.splice(index, 1)
      }
    },
    /** Whether the child is still running. */
    get alive() {
      return !closed && child.exitCode === null && child.signalCode === null
    },
    /** Whether the child has exited or could not start. */
    get exited() {
      return closed
    },
    /** Kill it. SIGKILL, for the reason above. */
    kill() {
      try {
        child.kill('SIGKILL')
      } catch (err) {
        /* already gone */
      }
    },
  }
}
