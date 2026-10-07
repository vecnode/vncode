/**
 * dsh-supercollider — the row, and everything it mounts.
 *
 * This is the host half: one SuperCollider session owned by this plugin, the ten
 * tools the agent calls, the five skills that teach it the language, and the
 * three routes a deliberately small console reads.
 *
 * The split is the point. `lib/engine/` knows nothing about the harness — it
 * takes an environment, a log sink and a home directory, and it speaks OSC to
 * scsynth and a line protocol to sclang. That is why the same engine can be
 * driven by `mcp/stdio.js` for an MCP client and by a script that never sees the
 * harness at all. This file is the cordis glue: it decides WHEN those things
 * happen (lazily), registers them, and disposes them when the row unloads.
 *
 * Nothing here reads a file the caller did not name, nothing runs a shell, and
 * no route accepts a path it does not resolve: see `lib/engine/project.js`.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { installCommand, resolveHome, resolveInstall, resolveHelpRoot, OVERRIDE_VARS } from './engine/install.js'
import { SupercolliderSession } from './engine/session.js'
import { SourceWatcher } from './engine/project.js'
import { buildTools, TOOL_NAMES } from './tools.js'

/** The row's identity. */
export const name = 'dsh-supercollider'
/** The services activation waits for: the HTTP bridge, the tool registry, the skill registry. */
export const inject = ['connection', 'tools']

/** This build's marker. It must equal package.json's version. */
export const PLUGIN_VERSION = '0.1.0-alpha.3'

/** Every route this plugin owns. */
const API_ROOT = '/api/dsh-supercollider'
export const STATE_ROUTE = API_ROOT + '/state'
export const CONSOLE_ROUTE = API_ROOT + '/console'
export const EVAL_ROUTE = API_ROOT + '/eval'

/** How long a console long-poll may hang before it answers with nothing new. */
const MAX_CONSOLE_WAIT_MS = 5_000
/** How many characters of session output one console answer carries. */
const MAX_CONSOLE_CHARS = 64_000

/** The five skills this package ships, as files beside this module. */
const SKILL_FILES = [
  { name: 'supercollider-live-coding', file: '../skills/supercollider-live-coding/SKILL.md' },
  { name: 'supercollider-synthdefs', file: '../skills/supercollider-synthdefs/SKILL.md' },
  { name: 'supercollider-language', file: '../skills/supercollider-language/SKILL.md' },
  { name: 'supercollider-scout-docs', file: '../skills/supercollider-scout-docs/SKILL.md' },
  { name: 'supercollider-projects', file: '../skills/supercollider-projects/SKILL.md' },
]

/** One error's message, whatever was thrown. */
function messageOf(err) {
  return err && err.message ? String(err.message) : String(err)
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
/**
 * Split one skill document into its frontmatter and its body.
 *
 * A deliberately small parser: the frontmatter these skills use is `name`,
 * `description` and `whenToUse`, one per line, which is what every other package
 * in this pack parses the same way. A document without frontmatter still works —
 * it is registered under its file name with an empty description.
 *
 * @param text - the file's contents.
 * @returns `{ meta, content }`.
 */
export function parseSkillFile(text) {
  const normalized = String(text).replace(/\r\n?/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized)
  if (!match) return { meta: {}, content: normalized.trim() }
  const meta = {}
  for (const line of match[1].split('\n')) {
    const entry = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (!entry) continue
    let value = entry[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    meta[entry[1]] = value
  }
  return { meta, content: normalized.slice(match[0].length).trim() }
}

/** One skill's own header, parsed out of its file. */
export function readSkill(entry) {
  const file = fileURLToPath(new URL(entry.file, import.meta.url))
  const { meta, content } = parseSkillFile(readFileSync(file, 'utf8'))
  return { file, meta, content }
}

/**
 * Register the bundled skills.
 *
 * The registry is resolved lazily — its absence skips the skills and never the
 * tools — and a missing file is a warning rather than a failure, because the
 * installers also copy these files into `$DSH_HOME/skills`, so a host without
 * the registry still gets them from the filesystem provider.
 *
 * @param ctx - the cordis context.
 * @param log - `{ warn, info }`.
 * @returns the number of skills registered.
 */
export function registerSkills(ctx, log) {
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (!skills || typeof skills.register !== 'function') {
    log.warn('skill registry unavailable - the five bundled skills were not registered')
    return 0
  }
  let count = 0
  for (const entry of SKILL_FILES) {
    try {
      const { file, meta, content } = readSkill(entry)
      if (content.length === 0) {
        log.warn('skill file is empty: ' + entry.file)
        continue
      }
      const skillName = typeof meta.name === 'string' && meta.name.length > 0 ? meta.name : entry.name
      ctx.effect(
        () =>
          skills.register({
            name: skillName,
            description: typeof meta.description === 'string' ? meta.description : '',
            whenToUse: typeof meta.whenToUse === 'string' ? meta.whenToUse : undefined,
            content,
            provider: 'dsh-supercollider',
            // `source` is required by the registry's own definition validator
            // (it throws `source must be a string` without one) and `path` is
            // what makes the entry file-backed, so a skills browser can show and
            // edit the document the model was actually given.
            source: 'bundled',
            path: file,
            resourceBase: { kind: 'directory', path: path.dirname(file) },
          }),
        'dsh-supercollider: skill ' + skillName,
      )
      count += 1
    } catch (err) {
      log.warn('could not register skill ' + entry.name + ': ' + messageOf(err))
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// The console: one cursor over the session's output
// ---------------------------------------------------------------------------
/**
 * The console's state: a transcript cursor plus the watchers that tell it a file
 * changed.
 *
 * The pack has no SSE and no browser WebSocket anywhere, so this is a
 * long-poll: the client asks with the cursor it has, and the answer either
 * carries what is new or waits a few seconds for something to arrive. The
 * `waitFor` shape is what `dsh-canvas` uses for its render queue.
 */
export class ConsoleState {
  /**
   * @param deps - `{ session, watcher, log }`.
   */
  constructor(deps) {
    this.session = deps.session
    this.watcher = deps.watcher
    this.log = deps.log
    /** Waiters: `{ settle }` — each resolves when there is something new. */
    this.waiters = new Set()
    /** Files seen changed since the last answer. */
    this.changed = new Set()
    /** Whether output is being captured from the interpreter. */
    this.attached = false
  }

  /** Start following the session's output. Idempotent. */
  attach() {
    if (this.attached) return
    this.attached = true
    this.session.sclang.onOutput(() => this.poke())
    this.watcher.onChange?.((file) => {
      this.changed.add(file)
      this.poke()
    })
  }

  /** Wake every waiter: there is something to report. */
  poke() {
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter)
      waiter()
    }
  }

  /**
   * Wait for something new, or for the deadline.
   *
   * @param waitMs - how long to wait (clamped).
   * @returns true when something arrived, false on the timeout.
   */
  async waitFor(waitMs) {
    if (this.changed.size > 0) return true
    const ms = Math.max(0, Math.min(MAX_CONSOLE_WAIT_MS, waitMs))
    if (ms === 0) return false
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.waiters.delete(finish)
        resolve(true)
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.waiters.delete(finish)
        resolve(false)
      }, ms)
      if (typeof timer.unref === 'function') timer.unref()
      this.waiters.add(finish)
    })
  }

  /**
   * One answer: what the session printed since `cursor`, and which files changed.
   *
   * @param cursor - the client's cursor, from the previous answer.
   * @param waitMs - how long to wait for something new.
   * @returns the console view.
   */
  async read(cursor, waitMs) {
    this.attach()
    const before = Number.isFinite(cursor) ? cursor : 0
    const waited = await this.waitFor(waitMs)
    const slice = this.session.sclang.since(before)
    const text = slice.text.length > MAX_CONSOLE_CHARS ? slice.text.slice(-MAX_CONSOLE_CHARS) : slice.text
    const changed = [...this.changed]
    this.changed.clear()
    return {
      waited,
      cursor: slice.cursor,
      text,
      truncated: slice.text.length > text.length,
      changed,
      warm: this.session.sclang.alive,
      port: this.session.sclang.boundPort,
    }
  }

  /** The snapshot the console's header shows. */
  async status() {
    const snapshot = await this.session.snapshot({})
    const server = snapshot.servers.find((entry) => entry.oscReachable) ?? snapshot.servers[0] ?? null
    const metrics = server === null || !server.oscReachable ? null : (await this.session.scsynth.status({ port: server.respondingPort })).metrics
    return {
      version: PLUGIN_VERSION,
      install: {
        dir: snapshot.install.dir,
        version: snapshot.install.version,
        sclang: snapshot.install.sclang.file,
        scsynth: snapshot.install.scsynth.file,
      },
      docsRoot: resolveHelpRoot({ env: this.session.env, install: snapshot.install }).root,
      servers: snapshot.servers.map((entry) => ({
        pid: entry.pid,
        role: entry.role,
        port: entry.respondingPort,
        reachable: entry.oscReachable,
        rssMiB: entry.rssBytes === null ? null : Math.round(entry.rssBytes / (1024 * 1024)),
      })),
      metrics,
      session: {
        interpreter: this.session.sclang.alive ? 'warm' : 'cold',
        boundPort: this.session.sclang.boundPort,
        trackedPid: this.session.trackedPid,
      },
      watched: this.watcher.list?.() ?? [],
      tools: TOOL_NAMES,
      skills: SKILL_FILES.map((entry) => entry.name),
      routes: [STATE_ROUTE, CONSOLE_ROUTE, EVAL_ROUTE],
    }
  }

  /** Drop every waiter. */
  dispose() {
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter)
      waiter()
    }
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
/** A JSON response. */
function json(status, value) {
  return new Response(JSON.stringify(value, null, 2) + '\n', {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Read a JSON request body, refusing anything that is not an object. */
async function readJsonBody(request) {
  let text = ''
  try {
    text = await request.text()
  } catch (err) {
    return { ok: false, error: 'could not read the request body: ' + messageOf(err) }
  }
  if (text.trim() === '') return { ok: true, value: {} }
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'the request body must be a JSON object' }
    }
    return { ok: true, value: parsed }
  } catch (err) {
    return { ok: false, error: 'the request body is not valid JSON: ' + messageOf(err) }
  }
}

/**
 * Register the three routes on the connection's fetch registry.
 *
 * @param deps - `{ ctx, console, session, log }`.
 * @returns a disposer.
 */
export function registerRoutes(deps) {
  const connection = typeof deps.ctx.get === 'function' ? deps.ctx.get('connection') : undefined
  if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
    deps.log.warn('connection service unavailable - the /api/dsh-supercollider/* routes were not registered')
    return () => {}
  }
  const offs = []
  const register = (routePath, methods, handler) => {
    offs.push(
      connection.fetch.register({
        path: routePath,
        methods,
        // REQUIRED: Connection's HTTP bridge picks the streaming branch for a
        // route that leaves this undefined.
        requestBody: 'buffered',
        async fetch(request) {
          try {
            return await handler(request)
          } catch (err) {
            deps.log.warn(routePath + ' failed: ' + messageOf(err))
            return json(500, { ok: false, error: messageOf(err) })
          }
        },
      }),
    )
  }

  register(STATE_ROUTE, ['GET', 'HEAD'], async () => json(200, { ok: true, ...(await deps.console.status()) }))

  /** The console's stream: what the session printed since a cursor. */
  register(CONSOLE_ROUTE, ['GET', 'HEAD'], async (request) => {
    const url = new URL(request.url)
    const cursor = Number(url.searchParams.get('cursor') ?? '0')
    const wait = Number(url.searchParams.get('wait') ?? '0')
    const view = await deps.console.read(cursor, wait)
    return json(200, { ok: true, ...view })
  })

  /** The console's input line. The same session the agent uses. */
  register(EVAL_ROUTE, ['POST'], async (request) => {
    const body = await readJsonBody(request)
    if (!body.ok) return json(400, { ok: false, error: body.error })
    const code = typeof body.value.code === 'string' ? body.value.code : ''
    if (code.trim() === '') return json(400, { ok: false, error: 'no code was given' })
    const result = await deps.session.evaluate({ code, timeoutMs: 30_000 })
    return json(200, {
      ok: result.ok,
      ms: result.ms,
      port: result.port,
      restarted: result.daemonRestarted === true,
      value: result.kind === 'file' ? '<a large answer was written to ' + result.file + '>' : result.text,
      error: result.error,
    })
  })

  return () => {
    for (const off of offs) {
      try {
        if (typeof off === 'function') off()
      } catch (err) {
        /* an unregister that throws must not stop the others */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
/**
 * Activate the row.
 *
 * @param ctx - the cordis context (inject: connection, tools).
 */
export function apply(ctx) {
  const env = process.env
  const log = {
    warn: (text) => ctx.logger?.warn?.('[dsh-supercollider] ' + text),
    info: (text) => ctx.logger?.info?.('[dsh-supercollider] ' + text),
    debug: (text) => ctx.logger?.debug?.('[dsh-supercollider] ' + text),
  }
  const home = resolveHome(env)

  const install = resolveInstall({ env })
  log.info(
    install.dir === null
      ? 'no SuperCollider install found - the tools will say so; install it with: ' + installCommand(process.platform)
      : 'active: SuperCollider ' + (install.version ?? '<unknown version>') + ' at ' + install.dir +
        ' (sclang=' + (install.sclang.file ?? 'missing') + ', scsynth=' + (install.scsynth.file ?? 'missing') + ')',
  )

  const session = new SupercolliderSession({ home, env, log })
  const watcher = new SourceWatcher({ log })

  // The watcher's change callback is a set on the console; `add` is what starts
  // a watch, and nothing is watched until a file tool names one.
  const consoleState = new ConsoleState({ session, watcher, log })

  const skillCount = registerSkills(ctx, log)
  log.info('registered ' + skillCount + ' bundled skill(s)')

  for (const tool of buildTools({ session, env, watcher, log })) {
    ctx.effect(() => ctx.tools.register(tool), 'dsh-supercollider: tool ' + tool.name)
  }
  ctx.effect(() => registerRoutes({ ctx, console: consoleState, session, log }), 'dsh-supercollider: routes')

  // Everything this plugin owns is torn down with the row: the interpreter is
  // killed (it is a child of this process), the socket is closed, and the
  // watchers stop. A spawned AUDIO SERVER is deliberately not killed: it is a
  // shared resource with its own lifetime, and stopping the user's sound because
  // a plugin reloaded would be the wrong default.
  ctx.effect(() => () => {
    consoleState.dispose()
    watcher.close()
    session.dispose().catch((err) => log.warn('dispose failed: ' + messageOf(err)))
  }, 'dsh-supercollider: session')

  // A background sweep of stale channel files, so a long-lived process does not
  // accumulate the large answers nobody read back.
  const sweep = setInterval(() => {
    session.prune().catch(() => {})
  }, 30 * 60 * 1000)
  if (typeof sweep.unref === 'function') sweep.unref()
  ctx.effect(() => () => clearInterval(sweep), 'dsh-supercollider: channel sweep')
}

/** Exported for the tracked checks: the parts of this row worth driving directly. */
export const __internals = {
  parseSkillFile,
  readSkill,
  registerSkills,
  registerRoutes,
  ConsoleState,
  SKILL_FILES,
  TOOL_NAMES,
  OVERRIDE_VARS,
}
