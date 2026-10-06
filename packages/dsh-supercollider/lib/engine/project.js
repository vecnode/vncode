/**
 * dsh-supercollider — `.scd` files, because that is how SuperCollider is used.
 *
 * The workflow this package exists for is not a chat window with a REPL in it.
 * It is: you have a `.scd` open in your own editor, you edit it, you send it to
 * the server, you hear it, you edit it again. So the engine has to be able to
 * read the file that is on disk, watch it change, and send it.
 *
 * ## Path policy
 *
 * A relative path resolves against the conversation workspace, which the harness
 * gives the tool layer as its working directory. An absolute path is allowed —
 * a SuperCollider user's `~/sc` folder is a real answer — but it is resolved with
 * `realpath` first so a symlink cannot walk this module somewhere its caller did
 * not name, and the resolved path is what is reported back. There is no allowlist
 * and no sandbox here: this is a local plugin for the person at the keyboard, and
 * pretending otherwise would only produce a worse error message.
 */

import fsp from 'node:fs/promises'
import { watch } from 'node:fs'
import path from 'node:path'

/** The extensions this package will read and write as SuperCollider source. */
export const SOURCE_EXTENSIONS = new Set(['.scd', '.sc', '.schelp', '.scsyndef'])

/**
 * Resolve one path for a call.
 *
 * @param request - `{ file, root }`. `root` defaults to `process.cwd()`, which
 *   the harness sets to the conversation workspace.
 * @returns `{ ok, file, scope, error }` — `scope` is `'workspace'` or `'absolute'`.
 */
export async function resolveSourcePath(request = {}) {
  const raw = typeof request.file === 'string' ? request.file.trim() : ''
  if (raw === '') return { ok: false, file: null, scope: null, error: 'no path was given' }
  const root = path.resolve(request.root ?? process.cwd())
  const scope = path.isAbsolute(raw) ? 'absolute' : 'workspace'
  const candidate = scope === 'absolute' ? path.resolve(raw) : path.resolve(root, raw)
  let resolved = candidate
  try {
    resolved = await fsp.realpath(candidate)
  } catch (err) {
    // A path that does not exist yet is legitimate for a write; `realpath` on
    // its deepest existing parent is the honest resolution.
    resolved = candidate
  }
  const extension = path.extname(resolved).toLowerCase()
  if (extension !== '' && !SOURCE_EXTENSIONS.has(extension)) {
    return {
      ok: false,
      file: resolved,
      scope,
      error:
        'that is a ' + extension + ' file. sc_project reads and writes SuperCollider source (' +
        [...SOURCE_EXTENSIONS].join(', ') + '); use the other tools for anything else.',
    }
  }
  return { ok: true, file: resolved, scope, error: null }
}

/**
 * Read one source file.
 *
 * @param request - `{ file, root, maxBytes }`.
 * @returns `{ ok, file, scope, text, bytes, mtimeMs, error }`.
 */
export async function readSource(request) {
  const resolved = await resolveSourcePath(request)
  if (!resolved.ok) {
    return { ok: false, file: resolved.file, scope: resolved.scope, text: '', bytes: 0, mtimeMs: 0, error: resolved.error }
  }
  const maxBytes = Number.isFinite(request.maxBytes) ? request.maxBytes : 2 * 1024 * 1024
  try {
    const stat = await fsp.stat(resolved.file)
    if (stat.size > maxBytes) {
      return {
        ok: false,
        file: resolved.file,
        scope: resolved.scope,
        text: '',
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        error: 'the file is larger than this call reads (' + stat.size + ' bytes)',
      }
    }
    const text = await fsp.readFile(resolved.file, 'utf8')
    return { ok: true, file: resolved.file, scope: resolved.scope, text, bytes: stat.size, mtimeMs: stat.mtimeMs, error: null }
  } catch (err) {
    const message = err && err.code === 'ENOENT' ? 'no such file: ' + resolved.file : err && err.message ? String(err.message) : String(err)
    return { ok: false, file: resolved.file, scope: resolved.scope, text: '', bytes: 0, mtimeMs: 0, error: message }
  }
}

/**
 * Write one source file, atomically.
 *
 * `ok` answers "did this call do what it was asked", not "is the path usable":
 * a refusal to replace an existing file and a write that failed are both
 * `ok: false` with a reason, so a caller never has to compare `error` to null
 * to find out whether anything happened.
 *
 * @param request - `{ file, root, text, overwrite }`.
 * @returns `{ ok, file, scope, bytes, created, error }`.
 */
export async function writeSource(request) {
  const resolved = await resolveSourcePath(request)
  if (!resolved.ok) return { ok: false, file: resolved.file, scope: resolved.scope, bytes: 0, created: false, error: resolved.error }
  const text = String(request.text ?? '')
  let existed = true
  try {
    await fsp.stat(resolved.file)
  } catch (err) {
    existed = false
  }
  if (existed && request.overwrite === false) {
    return {
      ok: false,
      file: resolved.file,
      scope: resolved.scope,
      bytes: 0,
      created: false,
      error: resolved.file + ' already exists and this call was told not to replace it',
    }
  }
  try {
    await fsp.mkdir(path.dirname(resolved.file), { recursive: true })
    const partial = resolved.file + '.sc.partial'
    await fsp.writeFile(partial, text, 'utf8')
    await fsp.rename(partial, resolved.file)
    return { ok: true, file: resolved.file, scope: resolved.scope, bytes: Buffer.byteLength(text, 'utf8'), created: !existed, error: null }
  } catch (err) {
    return {
      ok: false,
      file: resolved.file,
      scope: resolved.scope,
      bytes: 0,
      created: false,
      error: err && err.message ? String(err.message) : String(err),
    }
  }
}

/**
 * List the SuperCollider source files under a directory.
 *
 * @param request - `{ dir, root, depth }`.
 * @returns `{ ok, dir, files, error }` where a file is `{ file, relative, bytes, mtimeMs }`.
 */
export async function listSources(request = {}) {
  const resolved = await resolveSourcePath({ file: request.dir ?? '.', root: request.root })
  if (!resolved.ok) return { ok: false, dir: null, files: [], error: resolved.error }
  const maxDepth = Number.isFinite(request.depth) ? Math.max(0, Math.min(6, request.depth)) : 3
  const files = []
  const walk = async (dir, depth) => {
    let entries = []
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch (err) {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth) await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
      try {
        const stat = await fsp.stat(full)
        // A path that is genuinely under the directory is shown relative to it.
        // `path.relative` happily escapes upward (`..\..\x`), and a file reached
        // through a symlink comes back as something like
        // `UsersLUISAR~1AppData…` — so anything not under the root is reported
        // as itself, which is honest and still usable.
        const relative = path.relative(resolved.file, full)
        const inside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
        files.push({
          file: full,
          relative: inside ? relative : full,
          bytes: stat.size,
          mtimeMs: stat.mtimeMs,
        })
      } catch (err) {
        /* it vanished between the listing and the stat */
      }
    }
  }
  await walk(resolved.file, 0)
  files.sort((a, b) => a.relative.localeCompare(b.relative))
  return { ok: true, dir: resolved.file, files, error: null }
}

/**
 * A change watcher over a set of source files.
 *
 * `fs.watch` on the files themselves rather than the directory: a watched
 * directory reports every unrelated file a build writes, and this only cares
 * about the files the agent has been asked about. A watcher that cannot be
 * created is reported, not faked — on a platform where `fs.watch` is unreliable
 * the honest answer is "ask me to re-read it" rather than a change event that
 * never arrives.
 */
export class SourceWatcher {
  /**
   * @param options - `{ debounceMs, log }`.
   */
  constructor(options = {}) {
    this.debounceMs = options.debounceMs ?? 250
    this.log = options.log ?? { debug() {}, warn() {} }
    /** The watched files: `Map<absolutePath, { watcher, timer, listeners }>`. */
    this.entries = new Map()
    /** Process-wide change subscribers. */
    this.subscribers = new Set()
  }

  /**
   * Subscribe to every watched file's changes.
   *
   * @param listener - called with the file path.
   * @returns an unsubscribe function.
   */
  onChange(listener) {
    this.subscribers.add(listener)
    return () => this.subscribers.delete(listener)
  }

  /** Tell every subscriber that one file changed. */
  #notify(file) {
    for (const listener of this.subscribers) {
      try {
        listener(file)
      } catch (err) {
        /* an observer must never break the watcher */
      }
    }
    const entry = this.entries.get(file)
    if (entry === undefined) return
    for (const listener of entry.listeners) {
      try {
        listener(file)
      } catch (err) {
        /* an observer must never break the watcher */
      }
    }
  }

  /**
   * Start watching one file.
   *
   * @param file - the absolute path.
   * @returns `{ ok, error }`.
   */
  add(file) {
    if (this.entries.has(file)) return { ok: true, error: null }
    let watcher
    try {
      watcher = watch(file, { persistent: false })
    } catch (err) {
      const message = err && err.message ? String(err.message) : String(err)
      this.log.warn('could not watch ' + file + ': ' + message)
      return { ok: false, error: message }
    }
    const entry = { watcher, timer: null, listeners: new Set() }
    watcher.on('change', () => {
      if (entry.timer !== null) clearTimeout(entry.timer)
      entry.timer = setTimeout(() => {
        entry.timer = null
        this.#notify(file)
      }, this.debounceMs)
      if (typeof entry.timer.unref === 'function') entry.timer.unref()
    })
    watcher.on('error', (err) => this.log.debug('watch error on ' + file + ': ' + (err && err.message)))
    this.entries.set(file, entry)
    return { ok: true, error: null }
  }

  /** Stop watching one file. */
  remove(file) {
    const entry = this.entries.get(file)
    if (entry === undefined) return
    if (entry.timer !== null) clearTimeout(entry.timer)
    try {
      entry.watcher.close()
    } catch (err) {
      /* already closed */
    }
    this.entries.delete(file)
  }

  /** Stop watching everything. */
  close() {
    for (const file of [...this.entries.keys()]) this.remove(file)
  }

  /** Which files are watched. */
  list() {
    return [...this.entries.keys()]
  }
}
