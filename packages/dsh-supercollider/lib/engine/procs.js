/**
 * dsh-supercollider — which SuperCollider processes are running, and on which
 * UDP port.
 *
 * `rust-server` got this from `sysinfo` and `mcp_py` from `psutil`; both are
 * library dependencies this pack does not take. So the process table comes from
 * the platform's own tool:
 *
 *   - **win32** — one `Get-CimInstance Win32_Process` call, which is the only
 *     zero-dependency source that gives a process's **command line**, and the
 *     command line is what carries `-u <port>`. (Without CIM, Windows would
 *     have to be told the port rather than infer it.)
 *   - **darwin / linux** — `ps -Ao pid=,rss=,comm=,args=`, which every POSIX
 *     userland has.
 *
 * Two facts the old implementations established and this one keeps:
 *
 *   1. **A port is believed only after it answers.** `-u` in a command line is a
 *      *candidate*; `/status.reply` on that port is the proof. Ascending order
 *      means the convention 57110 outranks 57120.
 *   2. **Roles are case-insensitive substrings** tested in the order
 *      scsynth → supernova → sclang → scide, because `scsynth.exe` contains no
 *      `sclang` but a path can contain both words.
 *
 * What is deliberately NOT here: per-process disk I/O. It has no zero-dependency
 * source on Windows, and printing a zero for it would be a wrong answer rather
 * than a missing one. `sc_status` says the field is unavailable instead.
 */

import path from 'node:path'

import { probeStatus } from './osc-socket.js'
import { runQuiet } from './run.js'
import { isFile } from './install.js'

/** The ports scsynth listens on when nobody says otherwise. */
export const DEFAULT_PORTS = [57110, 57120]

/** How long a `/status` probe waits. */
export const PROBE_TIMEOUT_MS = 250

/** How long the process-table command may take. */
const LIST_TIMEOUT_MS = 20_000

/**
 * The role of one process, from its name, or null when it is not ours.
 *
 * **The name, emphatically not the command line.** The implementations this
 * replaces tested the whole command line for a substring
 * (`legacy/rust-server/src/sc_process.rs:866-876`), which means any process
 * whose *arguments* mention scsynth is classified as scsynth — and on the
 * machine this was written on, that is a real failure: a PowerShell or Node
 * process running a command whose text contains the word `scsynth` (a test, a
 * grep, this plugin's own documentation) was reported as a running audio server.
 * The name and the executable's basename are what a process IS.
 *
 * The order matters because a path can hold more than one of these words:
 * `C:\scsynth-notes\sclang.exe` is sclang, and testing scsynth first would get
 * it wrong. The executable name wins; the full path is the fallback for a name
 * that is a bare command rather than a file.
 *
 * @param name - the process name.
 * @param executable - its executable path, when there is one.
 * @returns `'scsynth' | 'supernova' | 'sclang' | 'scide' | null`.
 */
export function roleOf(name, executable = '') {
  const candidates = [name, executable === null || executable === undefined ? '' : path.basename(String(executable))]
  for (const candidate of candidates) {
    const token = path.basename(String(candidate ?? '')).toLowerCase()
    if (token.startsWith('scsynth')) return 'scsynth'
    if (token.startsWith('supernova')) return 'supernova'
    if (token.startsWith('sclang')) return 'sclang'
    if (token.startsWith('scide')) return 'scide'
  }
  return null
}

/** Whether a role is an audio server rather than the language or the IDE. */
export function isServerRole(role) {
  return role === 'scsynth' || role === 'supernova'
}

/**
 * Every UDP port named on a SuperCollider command line.
 *
 * scsynth accepts `-u <N>` and `--udp-port <N>`; the two joined spellings
 * (`-u57112`, `-u=57112`) show up in the wild and were both handled by the
 * implementations this replaces (`rust-server/src/sc_process.rs:282-313`).
 *
 * @param commandLine - the process's argv as one line, or the argv array.
 * @returns an array of ports, in the order they appear, deduplicated.
 */
export function parseScPorts(commandLine) {
  const tokens = Array.isArray(commandLine)
    ? commandLine.map((value) => String(value))
    : String(commandLine ?? '').split(/\s+/)
  const found = []
  const push = (value) => {
    const port = Number(value)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return
    if (!found.includes(port)) found.push(port)
  }
  for (const [index, token] of tokens.entries()) {
    if (token === '-u' || token === '--udp-port') {
      const next = tokens[index + 1]
      if (next !== undefined) push(String(next).replace(/^["']|["']$/g, ''))
      continue
    }
    const withEquals = /^(?:-u|--udp-port)=(.+)$/.exec(token)
    if (withEquals !== null) {
      push(withEquals[1])
      continue
    }
    const joined = /^-u(\d+)$/.exec(token)
    if (joined !== null) push(joined[1])
  }
  return found
}

/**
 * One `Get-CimInstance Win32_Process` call, parsed.
 *
 * `-NoProfile` keeps the call from loading the user's shell profile; the output
 * is a marker line and one JSON object per process, so a warning CIM prints
 * before the data cannot corrupt the parse.
 *
 * @param options - `{ signal }`.
 * @returns an array of raw rows.
 */
async function listWindowsProcesses(options = {}) {
  const command = [
    '$ErrorActionPreference = "SilentlyContinue";',
    '"SCJSON_BEGIN";',
    'Get-CimInstance Win32_Process |',
    'Select-Object ProcessId,Name,ExecutablePath,CommandLine,WorkingSetSize,CreationDate |',
    'ConvertTo-Json -Compress -Depth 3;',
    '"SCJSON_END"',
  ].join(' ')
  // `powershell.exe`, never `pwsh`: Windows PowerShell 5.1 ships with every
  // Windows 10+ install, and CIM behaves the same on both. A machine without
  // PowerShell 5.1 is not a Windows machine this pack has to run on.
  const result = await runQuiet({
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    timeoutMs: LIST_TIMEOUT_MS,
    maxOutputChars: 4_000_000,
    signal: options.signal,
  })
  const start = result.output.indexOf('SCJSON_BEGIN')
  const end = result.output.lastIndexOf('SCJSON_END')
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('could not read the process table (PowerShell/CIM gave no data)')
  }
  const body = result.output.slice(start + 'SCJSON_BEGIN'.length, end).trim()
  if (body === '') return []
  const parsed = JSON.parse(body)
  return Array.isArray(parsed) ? parsed : [parsed]
}

/**
 * One `ps` call, parsed. `rss` is in kilobytes on every platform measured, and
 * `comm` on macOS is the full executable path while on Linux it is the command
 * name — the caller treats both as "some identifier" and prefers `args`.
 *
 * @param options - `{ signal }`.
 * @returns an array of raw rows.
 */
async function listPosixProcesses(options = {}) {
  const result = await runQuiet({
    file: 'ps',
    args: ['-Ao', 'pid=,rss=,comm=,args='],
    timeoutMs: LIST_TIMEOUT_MS,
    maxOutputChars: 4_000_000,
    signal: options.signal,
  })
  if (result.code !== 0) throw new Error('ps exited ' + String(result.code))
  const rows = []
  for (const line of result.output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line)
    if (match === null) continue
    rows.push({
      ProcessId: Number(match[1]),
      WorkingSetSize: Number(match[2]) * 1024,
      Name: match[3],
      ExecutablePath: match[3].startsWith('/') ? match[3] : null,
      CommandLine: match[4] || match[3],
    })
  }
  return rows
}

/** One normalised process row. */
function normalise(row) {
  const commandLine = typeof row.CommandLine === 'string' ? row.CommandLine : ''
  const name = typeof row.Name === 'string' && row.Name !== '' ? row.Name : commandLine.split(/\s+/)[0] ?? ''
  const executable = typeof row.ExecutablePath === 'string' && row.ExecutablePath !== '' ? row.ExecutablePath : null
  const rssBytes = Number.isFinite(Number(row.WorkingSetSize)) ? Number(row.WorkingSetSize) : null
  return {
    pid: Number(row.ProcessId),
    name,
    // A path that is a name rather than a path (POSIX `comm` on Linux) is not
    // reported as an executable path: a caller that uses it to find siblings
    // would look in the wrong place.
    exePath: executable !== null && isFile(executable) ? executable : null,
    cmdline: commandLine,
    rssBytes,
    ports: parseScPorts(commandLine),
  }
}

/** The same normalising, shared by the snapshot and by the port parser. */
export function selectWanted(rows) {
  const wanted = []
  for (const row of rows) {
    const normalised = normalise(row)
    const role = roleOf(normalised.name, normalised.exePath)
    if (Number.isInteger(normalised.pid) && role !== null) wanted.push({ ...normalised, role })
  }
  wanted.sort((a, b) => a.pid - b.pid)
  return wanted
}

/**
 * Every process on this machine that mentions SuperCollider.
 *
 * @param options - `{ platform, signal, log }`.
 * @returns `{ ok, processes, error }` where `processes` are normalised rows.
 */
export async function listSupercolliderProcesses(options = {}) {
  const platform = options.platform ?? process.platform
  let rows = []
  let error = null
  try {
    rows = platform === 'win32' ? await listWindowsProcesses(options) : await listPosixProcesses(options)
  } catch (err) {
    error = err && err.message ? String(err.message) : String(err)
    return { ok: false, processes: [], error }
  }
  return { ok: true, processes: selectWanted(rows), error }
}

/**
 * The ports worth probing: the well-known pair, plus every port any
 * SuperCollider process named on its command line.
 *
 * @param processes - normalised rows.
 * @returns an ascending array of ports, deduplicated.
 */
export function candidatePorts(processes) {
  const ports = new Set(DEFAULT_PORTS)
  for (const process of processes) {
    for (const port of process.ports ?? []) ports.add(port)
  }
  return [...ports].sort((a, b) => a - b)
}

/**
 * Probe every candidate port once and say which answered.
 *
 * @param ports - the ports.
 * @param options - `{ log, timeoutMs, signal, host }`.
 * @returns `{ results, alive, durationMs }`.
 */
export async function probePorts(ports, options = {}) {
  const started = Date.now()
  const results = {}
  let alive = 0
  for (const port of ports) {
    if (options.signal && options.signal.aborted) break
    const reply = await probeStatus({
      port,
      timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
      log: options.log,
      host: options.host,
    })
    results[port] = reply !== null
    if (reply !== null) alive += 1
  }
  return { results, alive, durationMs: Date.now() - started }
}

/**
 * One consistent picture: the processes, the ports, and what answered.
 *
 * Every tool reads this rather than scanning on its own, so two answers in one
 * turn cannot disagree about which server is up.
 *
 * @param options - `{ platform, signal, log, timeoutMs }`.
 * @returns the snapshot.
 */
export async function collectSnapshot(options = {}) {
  const listed = await listSupercolliderProcesses(options)
  const servers = listed.processes.filter((process) => isServerRole(process.role))
  const languages = listed.processes.filter((process) => process.role === 'sclang')
  const ides = listed.processes.filter((process) => process.role === 'scide')
  const ports = candidatePorts(listed.processes)
  const probed = ports.length === 0 ? { results: {}, alive: 0, durationMs: 0 } : await probePorts(ports, options)

  const withPorts = servers.map((server) => {
    const candidates = [...new Set([...(server.ports ?? []), ...DEFAULT_PORTS])].sort((a, b) => a - b)
    const responding = candidates.find((port) => probed.results[port] === true) ?? null
    return {
      ...server,
      candidatePorts: candidates,
      respondingPort: responding,
      oscReachable: responding !== null,
    }
  })

  return {
    at: new Date().toISOString(),
    platform: options.platform ?? process.platform,
    /** False when the process table itself could not be read. */
    ok: listed.ok,
    error: listed.error,
    servers: withPorts,
    languages,
    ides,
    processes: listed.processes,
    ports: probed.results,
    durationMs: probed.durationMs,
  }
}

/**
 * Pick the server a call should act on.
 *
 * Priority: an explicit port, an explicit pid, the process this session
 * started, the first server that answered `/status`, then the first server
 * at all. A server whose port cannot be proven is only chosen when nothing
 * better exists, and the caller is told which case it got.
 *
 * @param snapshot - from `collectSnapshot`.
 * @param request - `{ port, pid, trackedPid }`.
 * @returns `{ server, reason }` where `server` may be null.
 */
export function chooseServer(snapshot, request = {}) {
  const servers = snapshot.servers ?? []
  if (servers.length === 0) {
    return { server: null, reason: 'no scsynth or supernova process is running' }
  }
  if (Number.isInteger(request.port) && request.port > 0) {
    const match = servers.find((server) => server.respondingPort === request.port)
    if (match !== undefined) return { server: match, reason: 'the requested port answered /status' }
    const owns = servers.find((server) => (server.ports ?? []).includes(request.port))
    if (owns !== undefined) {
      return { server: owns, reason: 'the requested port is named by pid ' + owns.pid + ' but did not answer /status' }
    }
    return { server: null, reason: 'no server is listening on port ' + request.port }
  }
  if (Number.isInteger(request.pid) && request.pid > 0) {
    const match = servers.find((server) => server.pid === request.pid)
    if (match !== undefined) return { server: match, reason: 'the requested pid' }
    return { server: null, reason: 'pid ' + request.pid + ' is not a running scsynth or supernova' }
  }
  if (Number.isInteger(request.trackedPid) && request.trackedPid > 0) {
    const match = servers.find((server) => server.pid === request.trackedPid)
    if (match !== undefined) return { server: match, reason: 'the server this session started' }
  }
  const reachable = servers.find((server) => server.oscReachable)
  if (reachable !== undefined) return { server: reachable, reason: 'the first server that answered /status' }
  return { server: servers[0], reason: 'the first server found, whose port could not be proven' }
}
