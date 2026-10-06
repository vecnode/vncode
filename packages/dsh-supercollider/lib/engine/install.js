/**
 * dsh-supercollider — where SuperCollider is on this machine.
 *
 * The implementations this replaces were Windows-only by construction:
 * `where.exe`, `Program Files`, `*.exe` suffixes, and a comment that said so
 * (`rust-server/src/sc_process.rs:6`). Their docs path could therefore never
 * resolve on Linux or macOS even though the candidate list mentioned
 * `share/SuperCollider/HelpSource`. This package claims to support all three
 * platforms, so the discovery here is written three times over rather than
 * ported once.
 *
 * The order of business, highest priority first — each step is a *candidate*,
 * and a candidate is only accepted when the binaries are actually there:
 *
 *   1. `DSH_SC_SCLANG` / `DSH_SC_SCSYNTH` — an explicit path wins, always. A
 *      deployment that pins one build uses these and nothing else.
 *   2. the executable's own directory and its parent — if a running `scsynth`
 *      was found by the process scan, its own folder is authoritative.
 *   3. `PATH` — the machine's own install, used as it is.
 *   4. the platform's standard install locations, including the *versioned*
 *      directory names a real install uses. On the machine this was written on
 *      the install is `C:\Program Files\SuperCollider-3.14.1`, and there is no
 *      unversioned `SuperCollider` folder at all, so a fixed-name lookup finds
 *      nothing.
 *
 * Nothing here guesses a version from a filename that might be a Quark, and
 * nothing here executes a binary to decide whether it exists.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { runQuiet } from './run.js'

/** The executables a SuperCollider install has, per platform. */
export function binariesFor(platform = process.platform) {
  const suffix = platform === 'win32' ? '.exe' : ''
  return {
    sclang: 'sclang' + suffix,
    scsynth: 'scsynth' + suffix,
    supernova: 'supernova' + suffix,
    scide: 'scide' + suffix,
  }
}

/** `$DSH_HOME` (or `~/.dsh`) — the same resolution every package in this pack performs. */
export function resolveHome(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : ''
  return configured !== '' ? path.resolve(configured) : path.join(os.homedir(), '.dsh')
}

/** Where this package keeps everything it writes. */
export function stateDir(home = resolveHome(process.env)) {
  return path.join(home, 'dsh-supercollider')
}

/** The first `N.N[.N…]` in a string, or null. */
export function versionFromText(text) {
  const match = /\d+\.\d+(?:\.\d+)*/.exec(String(text ?? ''))
  return match === null ? null : match[0]
}

/**
 * Directories to look inside, per platform, excluding the versioned scan.
 *
 * @param options - `{ platform, env }`.
 * @returns an array of absolute paths, in the order they should be tried.
 */
export function installRoots(options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const roots = []
  const add = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return
    const resolved = path.resolve(value.trim())
    if (!roots.includes(resolved)) roots.push(resolved)
  }

  if (platform === 'win32') {
    add(env.ProgramFiles)
    add(env['ProgramFiles(x86)'])
    add(env.ProgramW6432)
    add('C:\\Program Files')
    add('C:\\Program Files (x86)')
    add('C:\\SuperCollider')
    add(path.join(os.homedir(), 'AppData', 'Local', 'Programs'))
  } else if (platform === 'darwin') {
    add('/Applications')
    add('/Applications/SuperCollider')
    add('/usr/local')
    add('/opt/homebrew')
    add('/opt/local')
    add('/Library/Application Support/SuperCollider')
    add(path.join(os.homedir(), 'Applications'))
  } else {
    add('/usr')
    add('/usr/local')
    add('/opt')
    add('/opt/SuperCollider')
    add('/snap/supercollider/current')
    add(path.join(os.homedir(), '.local'))
  }
  return roots
}

/**
 * Every directory that could hold the binaries: the roots themselves, their
 * `bin/`, and every immediate child of a root whose name mentions
 * SuperCollider (which is how `SuperCollider-3.14.1` is found).
 *
 * @param options - `{ platform, env }`.
 * @returns an array of absolute paths, deduplicated, roots first.
 */
export function candidateDirs(options = {}) {
  const platform = options.platform ?? process.platform
  const dirs = []
  const add = (value) => {
    if (typeof value !== 'string' || value === '') return
    const resolved = path.resolve(value)
    if (!dirs.includes(resolved)) dirs.push(resolved)
  }
  for (const root of installRoots({ platform, env: options.env })) {
    add(root)
    add(path.join(root, 'SuperCollider'))
    add(path.join(root, 'SuperCollider', 'bin'))
    add(path.join(root, 'SuperCollider.app', 'Contents', 'Resources'))
    add(path.join(root, 'SuperCollider.app', 'Contents', 'MacOS'))
    add(path.join(root, 'bin'))
    add(path.join(root, 'share', 'SuperCollider'))
    add(path.join(root, 'share', 'supercollider'))
    // The versioned install directory. On Windows the real install is named
    // `SuperCollider-3.14.1`; on macOS the app bundle is `SuperCollider.app`.
    let entries = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch (err) {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (!/supercollider/i.test(entry.name)) continue
      const full = path.join(root, entry.name)
      add(full)
      add(path.join(full, 'bin'))
      add(path.join(full, 'Contents', 'Resources'))
      add(path.join(full, 'Contents', 'MacOS'))
    }
  }
  return dirs
}

/**
 * The directories on `PATH`, in order.
 *
 * @param env - the environment.
 * @returns an array of absolute paths.
 */
export function pathDirs(env = process.env) {
  const raw = typeof env.PATH === 'string' ? env.PATH : typeof env.Path === 'string' ? env.Path : ''
  if (raw === '') return []
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/**
 * Find one executable on `PATH`, honouring the platform's suffixes (and, on
 * Windows, the fact that a bare `scsynth.exe` is the only spelling there is).
 *
 * @param name - the executable's base name including its suffix.
 * @param env - the environment.
 * @returns the absolute path, or null.
 */
export function findOnPath(name, env = process.env) {
  for (const dir of pathDirs(env)) {
    const candidate = path.join(dir, name)
    if (isFile(candidate)) return candidate
  }
  return null
}

/** Whether a path is an existing regular file (a symlink to one counts). */
export function isFile(candidate) {
  try {
    return statSync(candidate).isFile()
  } catch (err) {
    return false
  }
}

/** Whether a path is an existing directory. */
export function isDir(candidate) {
  try {
    return statSync(candidate).isDirectory()
  } catch (err) {
    return false
  }
}

/** One resolved executable: where it is and which rule found it. */
function resolved(file, source) {
  return { file, source }
}

/**
 * Resolve the whole install: the two executables an agent needs, plus `scide`
 * and `supernova` when they are there.
 *
 * @param options - `{ env, platform, hints }`. `hints` are extra directories to
 *   try first, which is how a running process's own folder is prioritised.
 * @returns `{ dir, sclang, scsynth, supernova, scide, version, candidates, root }`
 *   where each executable is `{ file, source }` and `file` may be null.
 */
export function resolveInstall(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const names = binariesFor(platform)
  const overrides = {
    sclang: typeof env.DSH_SC_SCLANG === 'string' ? env.DSH_SC_SCLANG.trim() : '',
    scsynth: typeof env.DSH_SC_SCSYNTH === 'string' ? env.DSH_SC_SCSYNTH.trim() : '',
  }

  const ordered = []
  const add = (dir, source) => {
    if (typeof dir !== 'string' || dir === '') return
    const resolvedDir = path.resolve(dir)
    if (!ordered.some((entry) => entry.dir === resolvedDir)) ordered.push({ dir: resolvedDir, source })
  }
  // 1. explicit hints (a running process's own folder) come from the caller and
  //    are already authoritative for the binaries of that process.
  for (const hint of options.hints ?? []) add(hint, 'process')
  // 2. the standard locations.
  for (const dir of candidateDirs({ platform, env })) add(dir, 'standard')
  // 3. PATH.
  for (const dir of pathDirs(env)) add(dir, 'path')

  const find = (key) => {
    const override = overrides[key]
    if (typeof override === 'string' && override !== '') {
      // An override is an absolute path, or a bare executable name to search
      // for on PATH. An empty override is unset, not "the current directory".
      const absolute = path.isAbsolute(override) ? override : findOnPath(override, env)
      if (absolute !== null && isFile(absolute)) return resolved(absolute, 'env')
      return { file: null, source: 'env-missing', missing: override }
    }
    const wanted = names[key]
    for (const entry of ordered) {
      const candidate = path.join(entry.dir, wanted)
      if (isFile(candidate)) return resolved(candidate, entry.source)
    }
    return { file: null, source: 'none' }
  }

  const sclang = find('sclang')
  const scsynth = find('scsynth')
  const supernova = find('supernova')
  const scide = find('scide')
  const anchor = sclang.file ?? scsynth.file ?? supernova.file ?? scide.file
  const dir = anchor === null ? null : path.dirname(anchor)
  const version = versionFromText(dir ?? '') ?? versionFromText(anchor ?? '')

  return {
    platform,
    env,
    dir,
    root: dir,
    sclang,
    scsynth,
    supernova,
    scide,
    version,
    candidates: ordered.map((entry) => entry.dir),
    /** Whether this is enough to run the language at all. */
    hasLanguage: sclang.file !== null,
    /** Whether this is enough to make a sound. */
    hasServer: scsynth.file !== null || supernova.file !== null,
  }
}

/**
 * The version `sclang -v` reports, or null.
 *
 * `sclang -v` prints `sclang 3.14.1 (Built from tag 'Version-3.14.1' [426edf6])`
 * on 3.14.1, so the first version-shaped token is the right one. The call has a
 * deadline because a hung install must not hang a tool.
 *
 * @param sclangFile - the absolute path to `sclang`.
 * @param options - `{ timeoutMs, signal }`.
 * @returns `{ ok, version, line }`.
 */
export async function sclangVersion(sclangFile, options = {}) {
  if (typeof sclangFile !== 'string' || sclangFile === '') {
    return { ok: false, version: null, line: '', error: 'no sclang to ask' }
  }
  const result = await runQuiet({
    file: sclangFile,
    args: ['-v'],
    timeoutMs: options.timeoutMs ?? 15_000,
    maxOutputChars: 4_000,
    signal: options.signal,
  })
  const line = String(result.output).split('\n').find((entry) => entry.trim() !== '') ?? ''
  const version = versionFromText(line)
  return {
    ok: result.code === 0 || version !== null,
    version,
    line: line.trim(),
    error: result.code === 0 || version !== null ? null : 'sclang -v exited ' + String(result.code),
  }
}

/**
 * Where the documentation root is, given a resolved install.
 *
 * The install's own layout wins; the POSIX shared locations are the fallback a
 * package-manager install uses. This returns the first path that EXISTS, so a
 * caller can index it without a second existence check.
 *
 * @param options - `{ env, platform, install }`.
 * @returns `{ root, candidates }` where `root` may be null.
 */
export function resolveHelpRoot(options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const install = options.install ?? resolveInstall({ env, platform })
  const roots = []
  const add = (value) => {
    if (typeof value !== 'string' || value === '') return
    const resolved = path.resolve(value)
    if (!roots.includes(resolved)) roots.push(resolved)
  }

  if (install.dir !== null) {
    const base = path.resolve(install.dir)
    const parents = [base, path.dirname(base)]
    for (const parent of parents) {
      add(path.join(parent, 'HelpSource'))
      add(path.join(parent, 'Help'))
      add(path.join(parent, 'Resources', 'HelpSource'))
      add(path.join(parent, 'Resources', 'Help'))
      add(path.join(parent, 'share', 'SuperCollider', 'HelpSource'))
      add(path.join(parent, 'share', 'SuperCollider', 'Help'))
    }
  }
  for (const entry of pathDirs(env)) {
    const parent = path.dirname(path.resolve(entry))
    add(path.join(parent, 'share', 'SuperCollider', 'HelpSource'))
    add(path.join(parent, 'share', 'supercollider', 'HelpSource'))
  }
  add('/usr/share/SuperCollider/HelpSource')
  add('/usr/local/share/SuperCollider/HelpSource')
  add('/opt/homebrew/share/SuperCollider/HelpSource')
  if (platform === 'darwin') {
    add('/Applications/SuperCollider.app/Contents/Resources/HelpSource')
  }
  const root = roots.find((candidate) => isDir(candidate)) ?? null
  return { root, candidates: roots }
}

/** The environment variables that override discovery, for the sentences that name them. */
export const OVERRIDE_VARS = ['DSH_SC_SCLANG', 'DSH_SC_SCSYNTH', 'DSH_SC_HOME']

/** The package-manager command that installs SuperCollider on this platform. */
export function installCommand(platform = process.platform) {
  if (platform === 'win32') return 'winget install SuperCollider.SuperCollider'
  if (platform === 'darwin') return 'brew install --cask supercollider'
  return 'sudo apt install supercollider  # or your distribution\'s package'
}

/** A file name and whether it exists, for a status report. */
export function existsRow(label, file) {
  return { label, path: file ?? '', exists: typeof file === 'string' && file !== '' && existsSync(file) }
}
