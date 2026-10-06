/**
 * dsh-supercollider — the files this package writes, and where.
 *
 * Everything lives under `$DSH_HOME/dsh-supercollider/`, the pack's rule for
 * plugin state (the same shape `dsh-media` uses). Nothing is written outside it,
 * nothing is written into a conversation workspace unless the caller named a
 * path there, and every directory is created lazily so a profile that never
 * plays a sound creates nothing at all.
 *
 * Layout:
 *
 *     $DSH_HOME/dsh-supercollider/
 *       logs/                 one file per server this plugin spawned
 *       synthdefs/            compiled `.scsyndef` files, keyed by content
 *       tmp/                  the file channel for large answers
 *       session.json          the last known control target (a hint, never truth)
 *
 * The file channel is the important one. A large answer (SynthDef bytes, a long
 * `postln` dump, a node tree) is not pushed through the `sclang` REPL stream —
 * measured, that interleaves with the input echo and truncates. It is written to
 * a file under `tmp/` and the inline answer carries the path, its length and its
 * SHA-256, which also makes it verifiable rather than merely large.
 */

import { createHash, randomBytes } from 'node:crypto'
import fsp from 'node:fs/promises'
import { createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'

import { stateDir } from './install.js'

/** The root for everything this package persists. */
export function storeRoot(home) {
  return stateDir(home)
}

/** Where spawned server logs go. */
export function logDir(home) {
  return path.join(storeRoot(home), 'logs')
}

/** Where compiled SynthDefs go. */
export function synthDefDir(home) {
  return path.join(storeRoot(home), 'synthdefs')
}

/** Where the large-answer file channel goes. */
export function tmpDir(home) {
  return path.join(storeRoot(home), 'tmp')
}

/** Where the last-known control target is remembered. */
export function sessionFile(home) {
  return path.join(storeRoot(home), 'session.json')
}

/**
 * Create the directories a call needs.
 *
 * @param home - `$DSH_HOME`.
 * @param which - which of `logs`, `synthdefs`, `tmp` to ensure.
 * @returns the created paths.
 */
export async function ensureDirs(home, which = ['logs', 'synthdefs', 'tmp']) {
  const wanted = {
    logs: logDir(home),
    synthdefs: synthDefDir(home),
    tmp: tmpDir(home),
  }
  const made = {}
  for (const key of which) {
    const dir = wanted[key]
    if (dir === undefined) continue
    await fsp.mkdir(dir, { recursive: true })
    made[key] = dir
  }
  return made
}

/** A file name that cannot collide and cannot be predicted. */
export function uniqueName(prefix, extension) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return prefix + '-' + stamp + '-' + randomBytes(4).toString('hex') + (extension ?? '')
}

/** The SHA-256 of a file, read as a stream so size does not matter. */
export async function hashFile(file) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

/**
 * A file that grows, with a bounded tail read.
 *
 * Used for a spawned server's stdout/stderr: `scsynth` prints its device
 * selection, its sample rate and every `FAILURE IN SERVER` to one of those two
 * streams, and that text is the actual diagnosis of "no sound".
 */
export class AppendLog {
  /**
   * @param file - the absolute path.
   */
  constructor(file) {
    this.file = file
    this.handle = null
    this.failed = false
  }

  /** Open the file for appending, creating it. A failure disables the log. */
  async open() {
    if (this.handle !== null || this.failed) return this
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true })
      this.handle = await fsp.open(this.file, 'a')
    } catch (err) {
      this.failed = true
    }
    return this
  }

  /** Append a chunk. Never throws: a log is a convenience, not a contract. */
  async append(text) {
    if (this.failed) return
    await this.open()
    if (this.handle === null) return
    try {
      await this.handle.write(String(text))
    } catch (err) {
      this.failed = true
    }
  }

  /** Close the handle. */
  async close() {
    if (this.handle === null) return
    try {
      await this.handle.close()
    } catch (err) {
      /* already closed */
    }
    this.handle = null
  }

  /** The last `lines` lines of the file, or an empty array. */
  async tail(lines = 30) {
    try {
      const stats = await fsp.stat(this.file)
      // Read at most the last 64 KiB: a server log can run to megabytes and the
      // interesting part is always the end.
      const length = Math.min(stats.size, 64 * 1024)
      const start = stats.size - length
      const handle = await fsp.open(this.file, 'r')
      try {
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, start)
        const text = buffer.toString('utf8')
        return text.split('\n').slice(-lines)
      } finally {
        await handle.close()
      }
    } catch (err) {
      return []
    }
  }
}

/** The last `lines` lines of one file, or an empty array. */
export async function tailFile(file, lines = 30) {
  if (typeof file !== 'string' || !existsSync(file)) return []
  const log = new AppendLog(file)
  return log.tail(lines)
}

/** A file's size, or null. */
export function sizeOf(file) {
  try {
    return statSync(file).size
  } catch (err) {
    return null
  }
}

/**
 * Write one large answer to the file channel and describe it.
 *
 * @param home - `$DSH_HOME`.
 * @param options - `{ name, data, extension }`.
 * @returns `{ path, bytes, sha256 }`.
 */
export async function writeChannelFile(home, options) {
  await ensureDirs(home, ['tmp'])
  const file = path.join(tmpDir(home), uniqueName(options.name ?? 'answer', options.extension ?? '.bin'))
  const data = Buffer.isBuffer(options.data) ? options.data : Buffer.from(String(options.data), 'utf8')
  await fsp.writeFile(file, data)
  return { path: file, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }
}

/**
 * Read one channel file back, verifying the digest it was announced with.
 *
 * @param file - the path the inline answer carried.
 * @param expectedSha - the digest it carried, or an empty string to skip the check.
 * @param maxBytes - a ceiling, so a caller cannot ask this package to read a film.
 * @returns `{ ok, data, bytes, error }`.
 */
export async function readChannelFile(file, expectedSha = '', maxBytes = 8 * 1024 * 1024) {
  try {
    const stats = await fsp.stat(file)
    if (stats.size > maxBytes) {
      return { ok: false, data: null, bytes: stats.size, error: 'the file is larger than this call will read (' + stats.size + ' bytes)' }
    }
    const data = await fsp.readFile(file)
    if (typeof expectedSha === 'string' && expectedSha !== '') {
      const actual = createHash('sha256').update(data).digest('hex')
      if (actual !== expectedSha) {
        return { ok: false, data: null, bytes: data.length, error: 'the file does not match the digest it was announced with' }
      }
    }
    return { ok: true, data, bytes: data.length, error: null }
  } catch (err) {
    return { ok: false, data: null, bytes: 0, error: err && err.message ? String(err.message) : String(err) }
  }
}

/**
 * Remove stale channel files.
 *
 * The file channel is a hand-off, not a store: an answer nobody read back is
 * garbage, and a session that runs for days would otherwise fill the directory
 * with SynthDef dumps.
 *
 * @param home - `$DSH_HOME`.
 * @param maxAgeMs - how long a file may sit unread. Default: one hour.
 * @returns the number removed.
 */
export async function pruneChannelFiles(home, maxAgeMs = 60 * 60 * 1000) {
  const dir = tmpDir(home)
  let names = []
  try {
    names = await fsp.readdir(dir)
  } catch (err) {
    return 0
  }
  const cutoff = Date.now() - maxAgeMs
  let removed = 0
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      const stats = await fsp.stat(file)
      if (stats.mtimeMs < cutoff) {
        await fsp.rm(file, { force: true })
        removed += 1
      }
    } catch (err) {
      /* it vanished between the listing and the stat */
    }
  }
  return removed
}

/** Write JSON atomically: a partial file must never be read as a whole one. */
export async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const partial = file + '.' + randomBytes(4).toString('hex') + '.partial'
  await fsp.writeFile(partial, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await fsp.rename(partial, file)
}

/** Read JSON, or null when the file is missing or not JSON. */
export async function readJson(file) {
  try {
    const text = await fsp.readFile(file, 'utf8')
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch (err) {
    return null
  }
}

/**
 * Read a documentation or source file as text, falling back to latin-1.
 *
 * `.schelp` files are UTF-8 in every release, but a user extension is whatever
 * its author saved, and a single bad byte must not lose the whole file — the
 * Python implementation of this fallback is `mcp_py/sc_docs.py:229-230`.
 *
 * @param file - the path.
 * @returns `{ ok, text, error }`.
 */
export async function readText(file) {
  let buffer
  try {
    buffer = await fsp.readFile(file)
  } catch (err) {
    return { ok: false, text: '', error: err && err.message ? String(err.message) : String(err) }
  }
  // Node replaces an invalid UTF-8 sequence with U+FFFD rather than throwing, so
  // a user extension saved as latin-1 loses only the accented characters — far
  // better than losing the file, which is what a strict decode would do.
  return { ok: true, text: buffer.toString('utf8'), error: null }
}
