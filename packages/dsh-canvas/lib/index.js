/**
 * dsh-canvas — host half.
 *
 * One row owns the whole capability:
 *
 *   - **Nine tools** on `ctx.tools`: `canvas_new` (a starter composition from a
 *     preset + archetype), `canvas_write`, `canvas_patch` (JSON-pointer edits, so
 *     the model never re-emits a design to move one element), `canvas_read`,
 *     `canvas_publish` (conversation -> library), `canvas_delete`, `canvas_render`
 *     (ask the BROWSER to paint it and report back a PNG the model can read with
 *     `read_image`), `canvas_export` (PNG/JPG/SVG at 1x or 2x, to the Desktop or
 *     into the conversation folder) and `canvas_assets` (import a workspace image
 *     or a pasted one into the content-addressed asset store).
 *   - **Two skills** (`canvas-design`, `social-banners`) registered on
 *     `ctx.skills` from this package's own `skills/` folder, and copied into
 *     `$DSH_HOME/skills` by both installers so a person can read or edit them.
 *   - **The state**: one JSON file per conversation plus one harness-wide library
 *     (`./store.js`) and a content-addressed asset store.
 *   - **The routes** under `/api/dsh-canvas/*` that the browser half reads. The
 *     registry takes EXACT paths with GET/HEAD/POST only, which is why every font
 *     file is its own registration and why every write is a POST.
 *
 * ## The loop (and why `canvas_render` blocks)
 *
 * The model is the designer, so it has to SEE what it made. The host cannot paint
 * - a design is laid out with real font metrics, which only a browser has - so a
 * render is a REQUEST the browser answers:
 *
 *     canvas_render -> enqueue {document, revision, scale} -> the page long-polls
 *       -> lays out, paints to a canvas, posts back PNG + metrics + lints
 *       -> the host writes the PNG under $DSH_HOME/dsh-canvas/renders/
 *       -> the tool returns the path, and the model reads it with `read_image`
 *
 * The request carries the DOCUMENT, not just an id: a render must be of the
 * revision that was asked for, and re-fetching state in the browser would be a
 * race against the next write.
 */
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ENGINE_VERSION, LIMITS, applyPatches, clone, normalizeDocument } from './engine.js'
import { PRESETS, exportProblems, presetById } from './presets.js'
import { FONT_ROUTE_PREFIX, fontFileFor, fontStatus, fontTable } from './fonts.js'
import { ARCHETYPES, archetypeById } from './archetypes/index.js'
import { applyStyle, styleById, styleGallery, styleIds, styleTable } from './styles/index.js'
import { EXAMPLE_LIST, exampleById, exampleGallery, exampleIds, exampleLines } from './examples/index.js'
import { SETS, deriveFor, deriveSet, setById, setGallery } from './sets.js'
import { AssetStore, CanvasStore, ID_PATTERN, SCOPES, MAX_ASSET_BYTES, MAX_DOCUMENT_BYTES, renderPath, resolveHome, summarize, verificationOf } from './store.js'
import { desktopDirectory, humanBytes, resolveNewInside, sanitizeName, writeCreateExclusive } from './export.js'
import { hostRenderStatus, renderOnHost } from './host-render.js'

export const name = 'dsh-canvas'

/** Services the row waits for: the tool registry and the HTTP bridge. */
export const inject = ['connection', 'tools']

/** Keep in sync with the client's hard-coded route constants. */
const API_ROOT = '/api/dsh-canvas'
const HEALTH_ROUTE = API_ROOT + '/health'
const STATE_ROUTE = API_ROOT + '/state'
const DOCUMENT_ROUTE = API_ROOT + '/document'
const DELETE_ROUTE = API_ROOT + '/delete'
const PUBLISH_ROUTE = API_ROOT + '/publish'
const ASSET_ROUTE = API_ROOT + '/asset'
const WORKSPACE_ASSET_ROUTE = API_ROOT + '/workspace-asset'
const QUEUE_ROUTE = API_ROOT + '/render-queue'
const REPORT_ROUTE = API_ROOT + '/render-report'
const ENGINE_ROUTE = API_ROOT + '/vendor/engine.js'
/**
 * The Konva painter (see lib/konva-paint.js): the module that replays the engine's draw ops
 * into real Konva nodes. It is served on its own route for exactly the reason the engine is -
 * it has zero static imports and the browser imports it from a blob URL - and a check can
 * fetch it and drive it directly, which is how the two painters are compared pixel for pixel.
 */
const KONVA_PAINT_ROUTE = API_ROOT + '/vendor/konva-paint.js'
/**
 * The vendored Konva surface (see vendor/konva/build.mjs): the browser build of the
 * interaction layer, and the ONE route it needs. It is a separate route from the
 * engine because the two are rebuilt independently and neither can be assumed: the
 * tab paints and exports without Konva (the engine is the only painter) and only
 * loses its transform handles if the interaction layer is missing - so a missing
 * artifact is a named 503 on this route alone rather than a dead tab.
 */
const KONVA_JS_ROUTE = API_ROOT + '/vendor/konva.js'

/** How long a tool waits for the browser before it gives up and says why. */
const REPORT_TIMEOUT_MS = 20_000
const EXPORT_TIMEOUT_MS = 60_000
/** How long one long-poll may hang before it answers "nothing yet". */
const MAX_POLL_MS = 25_000
/** A request older than this is dead and is dropped rather than answered late. */
const REQUEST_TTL_MS = 120_000
/** The largest render the REPORT path asks for (the export path is larger). */
const REPORT_FEED_SCALE = 0.25
const REPORT_MAX_SIDE = 2048
/** The largest JSON body a route accepts: an export at 2x can be a big PNG. */
const MAX_BODY_BYTES = 64 * 1024 * 1024
/** One design's export may not exceed the largest preset ceiling with headroom. */
const MAX_EXPORT_BYTES = 48 * 1024 * 1024

const SKILL_FILES = [
  { name: 'canvas-design', file: '../skills/canvas-design/SKILL.md' },
  { name: 'social-banners', file: '../skills/social-banners/SKILL.md' },
]

/** Every tool name, in the order the conversation cards register. */
export const TOOL_NAMES = ['canvas_new', 'canvas_write', 'canvas_patch', 'canvas_read', 'canvas_style', 'canvas_set', 'canvas_publish', 'canvas_delete', 'canvas_render', 'canvas_export', 'canvas_assets']
// The unattended renderer is part of the row's interface, not an implementation
// detail: a check, the health route and a person all need to ask this machine whether
// a render can happen with no page open.
export { hostRenderStatus } from './host-render.js'

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/** A JSON response. */
function json(status, body, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(extraHeaders ?? {}) },
  })
}

/** A typed failure body. */
function fail(status, code, message, extra) {
  return json(status, { ok: false, error: { code, message, ...(extra ?? {}) } })
}

/** One typed route error. */
function httpError(status, code, message, cause) {
  const err = new Error(message)
  err.status = status
  err.code = code
  if (cause) err.cause = cause
  return err
}

/** Map a thrown route/stores error to its response. */
function errorToResponse(err) {
  if (err && typeof err.status === 'number') return fail(err.status, err.code ?? 'ERROR', String(err.message ?? 'request failed'))
  if (err && typeof err.code === 'string' && /^[A-Z][A-Z_]+$/.test(err.code)) return fail(400, err.code, String(err.message ?? 'request failed'))
  return fail(500, 'INTERNAL', err && err.message ? String(err.message) : 'unexpected failure')
}

/** Read a JSON request body with a hard cap. */
async function readJsonBody(request, maxBytes = 1024 * 1024) {
  const text = await request.text()
  if (text.length > maxBytes) throw httpError(413, 'BODY_TOO_LARGE', 'the request body is larger than this route accepts')
  if (text.length === 0) return {}
  try {
    return JSON.parse(text)
  } catch (err) {
    throw httpError(400, 'BAD_JSON', 'the request body is not JSON')
  }
}

/** A message from anything thrown. */
function message(err) {
  return err && err.message ? String(err.message) : String(err)
}

// ---------------------------------------------------------------------------
// The render queue
// ---------------------------------------------------------------------------

/**
 * Requests the browser answers. One queue for the whole harness: a page answers
 * for whichever session is asking, and a request carries everything the render
 * needs (the document included), so the answer cannot be about a stale revision.
 */
export class RenderQueue {
  constructor() {
    /** session id -> pending request */
    this.pending = new Map()
    /** requestId -> { resolve, timer } */
    this.waiters = new Map()
    /** session id -> a resolver waiting for the next request */
    this.pollers = new Map()
    this.sequence = 0
  }

  /** Drop requests older than the TTL and settle their waiters with a failure. */
  sweep() {
    const now = Date.now()
    for (const [sessionId, request] of [...this.pending.entries()]) {
      if (now - request.at <= REQUEST_TTL_MS) continue
      this.pending.delete(sessionId)
      const waiter = this.waiters.get(request.requestId)
      if (waiter) {
        this.waiters.delete(request.requestId)
        clearTimeout(waiter.timer)
        waiter.resolve({ ok: false, error: 'the request expired before any page answered it' })
      }
    }
  }

  /**
   * Queue one request and wait for the browser's answer.
   *
   * @param sessionId - the conversation the design belongs to.
   * @param request - `{ id, scope, revision, document, preset, purpose, scale, format, target, name }`.
   * @param timeoutMs - how long to wait.
   * @returns the answer payload, or `{ ok: false, error }`.
   */
  request(sessionId, request, timeoutMs) {
    this.sweep()
    const requestId = 'r' + (this.sequence += 1) + '-' + Date.now().toString(36)
    const entry = { ...request, requestId, sessionId, at: Date.now() }
    // One pending request per session: a second render replaces the first, whose
    // waiter is told why rather than silently hanging.
    const previous = this.pending.get(sessionId)
    if (previous) {
      const waiter = this.waiters.get(previous.requestId)
      if (waiter) {
        this.waiters.delete(previous.requestId)
        clearTimeout(waiter.timer)
        waiter.resolve({ ok: false, error: 'a newer render request replaced this one' })
      }
    }
    this.pending.set(sessionId, entry)
    for (const [key, poller] of [...this.pollers.entries()]) {
      if (poller(entry) === true) this.pollers.delete(key)
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId)
        if (this.pending.get(sessionId) && this.pending.get(sessionId).requestId === requestId) this.pending.delete(sessionId)
        resolve({
          ok: false,
          error:
            'no page answered the render within ' + Math.round(timeoutMs / 1000) + 's. A canvas render happens in the browser: open the dsh web page (the Canvas tab does not need to be in front) and try again.',
        })
      }, timeoutMs)
      this.waiters.set(requestId, { resolve, timer })
    })
  }

  /**
   * The next pending request for a session, waiting up to `waitMs` for one.
   * @returns the request, or null.
   */
  next(sessionId, waitMs) {
    this.sweep()
    const pending = this.pending.get(sessionId)
    if (pending) return Promise.resolve(pending)
    return this.waitFor(waitMs, (request) => request.sessionId === sessionId)
  }

  /**
   * The next pending request for ANY conversation.
   *
   * This is what makes the renderer a PAGE-level service rather than a tab one:
   * the browser half polls for any session, so a render asked for in one
   * conversation is answered even while a different conversation (or a different
   * tab) is on screen. The page is the user's own authenticated browser, and the
   * request names the session it belongs to, so nothing has to be guessed.
   */
  nextAny(waitMs) {
    this.sweep()
    const first = this.pending.values().next()
    if (!first.done) return Promise.resolve(first.value)
    return this.waitFor(waitMs, () => true)
  }

  /** Wait for a request matching a predicate, up to `waitMs`; null on timeout. */
  waitFor(waitMs, predicate) {
    const capped = Math.max(0, Math.min(Number.isFinite(waitMs) ? waitMs : 0, MAX_POLL_MS))
    if (capped === 0) return Promise.resolve(null)
    const key = 'any-' + (this.sequence += 1)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pollers.delete(key)
        resolve(null)
      }, capped)
      this.pollers.set(key, (request) => {
        if (!predicate(request)) return false
        clearTimeout(timer)
        this.pollers.delete(key)
        resolve(request)
        return true
      })
    })
  }

  /** A browser answered: settle the waiter. */
  settle(requestId, payload) {
    const waiter = this.waiters.get(String(requestId ?? ''))
    if (!waiter) return false
    this.waiters.delete(String(requestId))
    clearTimeout(waiter.timer)
    for (const [sessionId, request] of [...this.pending.entries()]) {
      if (request.requestId === requestId) this.pending.delete(sessionId)
    }
    waiter.resolve(payload)
    return true
  }

  /** One status line for the health route. */
  status() {
    return { pending: this.pending.size, waiting: this.waiters.size, polling: this.pollers.size }
  }
}

// ---------------------------------------------------------------------------
// Row state
// ---------------------------------------------------------------------------

/** Everything one mounted row owns. */
function createRow(ctx) {
  const home = resolveHome()
  const log = {
    debug: (text) => ctx.logger?.debug?.(text),
    info: (text) => ctx.logger?.info?.(text),
    warn: (text) => ctx.logger?.warn?.(text),
  }
  const stores = new Map()
  const queue = new RenderQueue()
  const assets = new AssetStore({ home, log })

  /** The store of one scope key: a conversation id, or the library's one key. */
  const storeFor = (scopeKey) =>
    scopeKey === 'library'
      ? getOrCreate(stores, 'library', () => new CanvasStore({ home, scope: 'library', log }))
      : getOrCreate(stores, 'conversation:' + scopeKey, () => new CanvasStore({ home, scope: 'conversation', sessionId: scopeKey, log }))

  return { home, log, stores, queue, assets, storeFor }
}

/** A Map value, created on demand. */
function getOrCreate(map, key, create) {
  if (!map.has(key)) map.set(key, create())
  return map.get(key)
}

/** The session id of one tool run. */
function sessionOf(exec) {
  const session = exec && exec.agent && exec.agent.session
  const id = session && session.id
  if (typeof id !== 'string' || id === '') throw new Error('the canvas tools require an owning agent session')
  return id
}

/** The store key a scope stands for. */
function keyFor(sessionId, scope) {
  return scope === 'library' ? 'library' : sessionId
}

/** The scope name a store key stands for. */
function scopeOf(scopeKey) {
  return scopeKey === 'library' ? 'library' : 'conversation'
}

/** The address a design is citable at (used in text and by the tab). */
function addressOf(scopeKey, id) {
  return scopeKey === 'library' ? 'dsh-resource://canvas/library/' + id : 'dsh-resource://canvas/session/' + scopeKey + '/' + id
}

/**
 * Where one id lives: the scope the caller named, or - with none named - the
 * LIBRARY first and then this conversation, exactly like `dsh-diagrams`, because
 * "read launch-banner" has to mean the shared design when both exist.
 */
function locate(row, sessionId, id, scope) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw httpError(400, 'BAD_ID', 'the id ' + JSON.stringify(id ?? null) + ' must match ' + ID_PATTERN)
  }
  if (scope === 'library') {
    const entry = row.storeFor('library').get(id)
    return entry ? { scopeKey: 'library', entry } : null
  }
  if (scope === 'conversation') {
    const entry = row.storeFor(sessionId).get(id)
    return entry ? { scopeKey: sessionId, entry } : null
  }
  const shared = row.storeFor('library').get(id)
  if (shared) return { scopeKey: 'library', entry: shared }
  const own = row.storeFor(sessionId).get(id)
  return own ? { scopeKey: sessionId, entry: own } : null
}

/** Validate a document for a session: presets, fonts, and the asset names it references. */
function validateDocument(row, input) {
  const result = normalizeDocument(input, { presets: PRESETS, fonts: fontTable(), styles: styleTable() })
  const problems = result.problems.slice()
  if (result.document) {
    const known = row.assets.table()
    const unknown = referencedAssets(result.document).filter((src) => !Object.prototype.hasOwnProperty.call(known, src) && !looksLikeWorkspacePath(src))
    for (const src of unknown) {
      problems.push({
        path: 'layers',
        code: 'MISSING_ASSET',
        message: 'the image "' + src + '" is neither a stored asset nor a workspace-relative path. Import it first with canvas_assets { op: "import", path: "…" } (or paste it into the Canvas tab).',
      })
    }
  }
  return { document: problems.length === 0 ? result.document : null, problems, preset: result.preset }
}

/** Every `src` an image node names. */
function referencedAssets(document) {
  const out = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.kind === 'image' && typeof node.src === 'string') out.push(node.src)
    for (const child of node.children ?? []) walk(child)
  }
  for (const layer of document.layers ?? []) walk(layer)
  return [...new Set(out)]
}

/**
 * Whether a `src` reads as a workspace-relative path rather than an asset name.
 * The client resolves it through the harness's own workspace-files remote, which
 * enforces the containment rules on the host side.
 */
function looksLikeWorkspacePath(src) {
  if (typeof src !== 'string' || src.length === 0) return false
  if (src.startsWith('/') || /^[A-Za-z]:/.test(src)) return false
  return src.includes('/') || /\.(png|jpe?g|gif|webp|avif|bmp|svg|tiff?)$/i.test(src)
}

/** A starter document for a preset: real composition, obvious placeholders. */
function starterDocument(preset, title) {
  const margin = preset.margin ?? 64
  const width = preset.width
  const height = preset.height
  const landscape = width >= height
  return {
    title: title ?? preset.label,
    preset: preset.id,
    tokens: {
      color: { ink: '#F8FAFC', muted: '#94A3B8', accent: '#4D6BFE', surface: '#0B0E14' },
      font: { display: 'Space Grotesk', text: 'Inter', mono: 'system' },
      scale: {
        display: Math.max(36, Math.round(Math.min(width, height * 1.6) * 0.11)),
        title: Math.max(26, Math.round(Math.min(width, height * 1.6) * 0.06)),
        body: Math.max(18, Math.round(Math.min(width, height * 1.6) * 0.034)),
        caption: Math.max(13, Math.round(Math.min(width, height * 1.6) * 0.023)),
      },
      space: 8,
      radius: { card: 20, pill: 999, chip: 8 },
    },
    layers: [
      { kind: 'art', style: 'mesh', colors: ['accent', 'surface', 'ink'], seed: 7, opacity: 0.55 },
      {
        kind: 'frame',
        x: margin,
        y: margin,
        w: landscape ? Math.round(width * 0.56) : width - margin * 2,
        h: height - margin * 2,
        direction: 'column',
        gap: 24,
        justify: 'center',
        align: 'start',
        children: [
          { kind: 'text', text: 'Your product', style: 'caption', color: 'accent', transform: 'upper', letterSpacing: 2 },
          { kind: 'text', w: 'fill', text: title ?? 'A one-line promise that earns the click', style: 'display', color: 'ink', maxLines: 3 },
          { kind: 'text', w: 'fill', text: 'One sentence of support, and nothing else.', style: 'body', color: 'muted', maxLines: 2 },
        ],
      },
    ],
  }
}

/**
 * The document a NEW design starts from: an archetype's composition, or the
 * generated starter for a preset.
 *
 * One function for both callers - the `canvas_new` tool and the tab's "+ New"
 * button - so the two paths cannot produce different documents for the same
 * request, which is the same discipline the validator enforces everywhere else.
 *
 * @param request - `{ preset, archetype?, title? }`.
 * @returns `{ document }` or `{ error: { code, message } }`.
 */
export function documentFor(request) {
  // AN EXAMPLE FIRST: it names its own preset, archetype and style, so it is the one
  // entry point that needs none of them - the whole point of a gallery row is that the
  // choice has already been made well.
  if (typeof request.example === 'string' && request.example.length > 0) {
    const example = exampleById(request.example)
    if (!example) {
      return { error: { code: 'UNKNOWN_EXAMPLE', message: 'unknown example ' + JSON.stringify(request.example) + '; the gallery carries:\n' + exampleLines() } }
    }
    const document = clone(example.document)
    if (typeof request.title === 'string' && request.title.length > 0) document.title = request.title
    // A style named BESIDE an example switches its look; without one it keeps the look
    // it was built with, which is recorded on the document, so re-applying is a no-op.
    return withStyle(document, request.style ?? null)
  }
  const preset = presetById(request.preset)
  if (!preset) {
    return { error: { code: 'UNKNOWN_PRESET', message: 'unknown preset ' + JSON.stringify(request.preset) + '; known presets:\n' + presetLines() } }
  }
  if (request.archetype) {
    const archetype = archetypeById(request.archetype)
    if (!archetype) {
      return { error: { code: 'UNKNOWN_ARCHETYPE', message: 'unknown archetype ' + JSON.stringify(request.archetype) + '; known archetypes:\n' + archetypeLines() } }
    }
    if (!archetype.presets.includes(preset.id)) {
      return {
        error: {
          code: 'ARCHETYPE_PRESET',
          message:
            'the archetype "' + archetype.id + '" is composed for ' + archetype.presets.join(', ') + ' - not for ' + preset.id +
            '. Ask for one of those presets, or start from another archetype, or write the document yourself with canvas_write.',
        },
      }
    }
    const built = clone(archetype.document)
    built.preset = preset.id
    built.title = typeof request.title === 'string' && request.title.length > 0 ? request.title : archetype.title
    return withStyle(built, request.style)
  }
  return withStyle(starterDocument(preset, typeof request.title === 'string' ? request.title : undefined), request.style)
}

/**
 * Apply a style to a freshly built document, or refuse by name.
 *
 * One function for every caller - `canvas_new`, the tab's "+ New", and a plain
 * `canvas_write` that names a style - so a design built three ways from the same
 * request cannot come out looking different.
 *
 * @param document - the composition, before the look.
 * @param styleId - a style id, or nothing.
 * @returns `{ document, notes, style }` or `{ error }`.
 */
export function withStyle(document, styleId) {
  if (typeof styleId !== 'string' || styleId.length === 0) return { document }
  const style = styleById(styleId)
  if (!style) {
    return { error: { code: 'UNKNOWN_STYLE', message: 'unknown style ' + JSON.stringify(styleId) + '; the library carries:\n' + styleLines() } }
  }
  const applied = applyStyle(document, style, { styles: styleTable() })
  return { document: applied.document, notes: applied.notes, style: style.id }
}

/** The style library as text, for a tool answer or a refusal. */
function styleLines() {
  return styleGallery()
    .map((entry) => '  - ' + entry.id + '  ' + entry.name + '  (' + entry.swatch.display + ')  ' + entry.intent)
    .join('\n')
}

/** The house gallery as text, for the index a model reads first. */
function exampleLinesForIndex() {
  return exampleLines()
}

/** The sets as text: what each one derives, and to which sizes. */
function setLines() {
  return setGallery()
    .map((entry) => '  - ' + entry.id + '  ' + entry.title + '  ' + entry.source + ' -> ' + entry.targets.join(', ') + '  (' + entry.sizes.join(', ') + ')')
    .join('\n')
}

/**
 * The pictures a document names, as data URLs, for the unattended renderer.
 *
 * The tab gets its bitmaps from its own routes; a render with no page open has to be
 * handed the bytes, or an image-led design would come out with a hole in it. Only the
 * assets the document actually references are read, and a name that is not in the
 * store is simply absent - which the MISSING_ASSET lint then reports by name.
 */
async function assetPayload(row, document) {
  const wanted = new Set()
  const walk = (node) => {
    if (node && node.kind === 'image' && typeof node.src === 'string') wanted.add(node.src)
    for (const child of (node && node.children) ?? []) walk(child)
  }
  for (const layer of document.layers ?? []) walk(layer)
  const out = {}
  for (const name of wanted) {
    const file = row.assets.path(name)
    if (!file) continue
    try {
      const bytes = await fsp.readFile(file)
      const extension = path.extname(file).toLowerCase()
      const mime = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.gif' ? 'image/gif' : extension === '.webp' ? 'image/webp' : 'image/png'
      out[name] = 'data:' + mime + ';base64,' + bytes.toString('base64')
    } catch (err) {
      row.log?.warn?.('[dsh-canvas] could not read the asset ' + name + ': ' + (err && err.message ? err.message : err))
    }
  }
  return out
}

/**
 * Render a design ON THE HOST, with no app page involved.
 *
 * Same outputs as the tab's render report - the full picture, the 25% feed thumbnail,
 * the metrics and the lints - written to the same paths, so nothing downstream can
 * tell which painter answered. This is what makes `canvas_render` and `canvas_export`
 * work with the app closed, and it is used as the FALLBACK: when a page is open it
 * does the work, because a person watching the render happen is worth more than a
 * fast answer.
 */
async function renderUnattended(row, sessionId, scopeKey, entry, options = {}) {
  const scale = options.scale === 2 ? 2 : 1
  const preset = entry.preset ? presetById(entry.preset) : null
  const result = await renderOnHost({
    document: entry.document,
    preset,
    scale,
    assets: await assetPayload(row, entry.document),
    timeoutMs: options.timeoutMs ?? 90000,
  })
  if (!result.ok) return { ok: false, error: result.error, by: 'host' }
  const file = renderPath(row.home, sessionId, entry.id, entry.revision, scale)
  const feedFile = renderPath(row.home, sessionId, entry.id, entry.revision, REPORT_FEED_SCALE)
  // The same create-exclusive writer the tab's report goes through, with `overwrite`
  // because a revision is a picture: re-rendering it replaces its own file.
  await writeCreateExclusive({ directory: path.dirname(file), baseName: path.basename(file, '.png'), ext: 'png', bytes: result.png, overwrite: true })
  if (result.feed) {
    await writeCreateExclusive({ directory: path.dirname(feedFile), baseName: path.basename(feedFile, '.png'), ext: 'png', bytes: result.feed, overwrite: true })
  }
  return {
    ok: true,
    by: 'host',
    path: file,
    feedPath: result.feed ? feedFile : null,
    feedScale: REPORT_FEED_SCALE,
    width: result.width,
    height: result.height,
    scale: result.scale,
    lints: result.lints ?? [],
    metrics: result.metrics ?? null,
    browser: result.browser,
    ms: result.ms,
  }
}

/** The browser-visible summary of one design, with its document. */function viewOf(scopeKey, entry) {
  const summary = summarize(entry, scopeOf(scopeKey))
  const verification = summary.verification
  const view = {
    id: entry.id,
    title: summary.title,
    scope: scopeOf(scopeKey),
    state: verification.state,
    revision: summary.revision,
    tab: addressOf(scopeKey, entry.id),
    warnings: summary.warnings,
    errors: summary.errors,
  }
  if (summary.preset) view.preset = summary.preset
  if (verification.path) view.path = verification.path
  if (typeof verification.width === 'number') view.width = verification.width
  if (typeof verification.height === 'number') view.height = verification.height
  if (verification.error) view.error = verification.error
  return view
}

/** The `presentationMeta` schema every canvas tool shares. */
const VIEW_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    scope: { type: 'string' },
    preset: { type: 'string' },
    state: { type: 'string' },
    revision: { type: 'integer' },
    tab: { type: 'string' },
    path: { type: 'string' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    warnings: { type: 'integer' },
    errors: { type: 'integer' },
    error: { type: 'string' },
  },
  required: ['id', 'title', 'scope', 'state', 'revision', 'tab'],
}

/** A problem list schema. */
const PROBLEMS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: { path: { type: 'string' }, code: { type: 'string' }, message: { type: 'string' } },
    required: ['code', 'message'],
  },
}

/** A lint list schema. */
const LINTS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: { code: { type: 'string' }, level: { type: 'string' }, path: { type: 'string' }, message: { type: 'string' } },
    required: ['code', 'level', 'message'],
  },
}

/** The id argument. */
const ID_SCHEMA = { type: 'string', description: 'The design id (lowercase letters, digits and dashes).' }
/** The scope argument. */
const SCOPE_SCHEMA = { type: 'string', enum: [...SCOPES], description: 'Where the design lives: this conversation (default) or the harness-wide library.' }

/** The problem list as lines of text. */
function problemLines(problems) {
  return problems.map((entry) => '  - ' + (entry.path ? entry.path + ': ' : '') + entry.message).join('\n')
}

/** The lint list as lines of text, capped. The CODE travels with each line: the
 * skills teach what to do about `LOW_CONTRAST` or `SAFE_AREA` by name. */
function lintLines(lints, limit = 12) {
  const shown = lints.slice(0, limit)
  const lines = shown.map((entry) => '  - [' + entry.level + '] ' + entry.code + ': ' + entry.message)
  if (lints.length > shown.length) lines.push('  … and ' + (lints.length - shown.length) + ' more')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * The nine tool definitions.
 * @param row - the row state from {@link createRow}.
 * @param ctx - the cordis context (the workspace lookup needs it).
 * @returns the tool definitions in registration order.
 */
export function buildTools(row, ctx) {
  /** A card's shared pending presentation. */
  const callView = (args, verb) => ({
    card: 'generic',
    title: verb + ' design' + (args && args.id ? ' "' + args.id + '"' : args && args.preset ? ' (' + args.preset + ')' : ''),
    kind: 'other',
  })
  /** A card's shared completed presentation. */
  const resultView = (_args, result) => ({ card: 'generic', title: 'Canvas ' + (result.view ? result.view.state : ''), content: result.text })

  /** Resolve one design or throw a typed failure. */
  const requireDesign = (sessionId, id, scope) => {
    const found = locate(row, sessionId, id, scope)
    if (!found) {
      throw httpError(404, 'NOT_FOUND', 'no design "' + id + '" in ' + (scope === 'library' ? 'the library' : scope === 'conversation' ? 'this conversation' : 'the library or this conversation'))
    }
    return found
  }

  /**
   * Store one design, turning a store refusal (a cap, a budget, a bad id) into a
   * SENTENCE the model can act on rather than a thrown error: these are the
   * ordinary limits of the surface, not failures of the call.
   *
   * @returns `{ entry }` or `{ text }`.
   */
  const putDesign = (store, options) => {
    try {
      return { entry: store.put(options) }
    } catch (err) {
      return { text: 'Could not store the design: ' + message(err) }
    }
  }

  // -------------------------------------------------------------------------
  // canvas_new
  // -------------------------------------------------------------------------
  const newDesign = {
    name: 'canvas_new',
    description: [
      'Start a design: a complete starter document for a destination PRESET, optionally from an ARCHETYPE (a proven composition kept in this package).',
      'Prefer this over writing JSON from scratch - an archetype already has a hierarchy, a margin rhythm and a token set, and you then fill in the words and the palette.',
      'The preset fixes the pixel canvas and the safe areas (github-social 1280x640, linkedin-personal-banner 1584x396, poster-a3 3508x4961, ...). The starter is intentionally generic: patch it.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['preset'],
      properties: {
        preset: { type: 'string', description: 'The destination preset id (see canvas_read for the table).' },
        archetype: { type: 'string', description: 'An archetype id whose composition to start from; canvas_read lists them.' },
        style: { type: 'string', description: 'A style id from the look library (editorial, brutalist, neon, ...); canvas_read lists them.' },
        example: { type: 'string', description: 'A house example id: a proven preset + archetype + style combination to start from instead of a blank canvas; canvas_read lists them.' },
        title: { type: 'string', description: 'A short human title; the tab chip and the design list show it.' },
        id: ID_SCHEMA,
        scope: SCOPE_SCHEMA,
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, view: VIEW_SCHEMA }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => (value.view && value.view.id ? value.view : {}),
    },
    presentCall: (args) => callView(args, 'New'),
    presentResult: resultView,
    execute(args, exec) {
      const sessionId = sessionOf(exec)
      const scopeKey = keyFor(sessionId, args.scope)
      const preset = presetById(args.preset)
      if (!preset) {
        return { text: 'Unknown preset ' + JSON.stringify(args.preset) + '. Known presets:\n' + presetLines() }
      }
      const built = documentFor({ preset: args.preset, archetype: args.archetype, title: args.title, style: args.style, example: args.example })
      if (built.error) return { text: built.error.message }
      const verdict = validateDocument(row, built.document)
      if (!verdict.document) {
        return { text: 'The starter document did not validate (this is a bug in the starter, not in your call):\n' + problemLines(verdict.problems) }
      }
      const store = row.storeFor(scopeKey)
      const id = typeof args.id === 'string' && args.id.length > 0 ? args.id : store.freeId(verdict.document.title ?? preset.id)
      const stored = putDesign(store, { id, title: verdict.document.title ?? preset.label, preset: preset.id, document: verdict.document, by: 'model' })
      if (!stored.entry) return { text: stored.text }
      const entry = stored.entry
      const lines = [
        'Created "' + entry.id + '" (' + preset.label + ', ' + preset.width + '\u00d7' + preset.height + ') as revision ' + entry.revision + '.',
        'It is a starter, not a design: patch the words, the palette and the composition, then render it.',
        'Render with canvas_render { id: "' + entry.id + '" } and read the PNG it names with read_image before you call it finished.',
        'Tab address: ' + addressOf(scopeKey, entry.id),
      ]
      return { text: lines.join('\n'), view: viewOf(scopeKey, entry) }
    },
  }

  // -------------------------------------------------------------------------
  // canvas_write
  // -------------------------------------------------------------------------
  const write = {
    name: 'canvas_write',
    description: [
      'Create or replace a design document. Every write is VALIDATED before it is stored, and a refusal comes back with the path and the code of every problem, so a broken design never reaches the tab.',
      'The document is the whole design: canvas (or preset), tokens, and layers. Write it once with this tool, then use canvas_patch for edits.',
      'Prefer canvas_new for a first draft: it starts from a real composition instead of a blank page.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['document'],
      properties: {
        document: { type: 'object', description: 'The complete design document.' },
        id: ID_SCHEMA,
        title: { type: 'string', description: 'A short human title.' },
        scope: SCOPE_SCHEMA,
        note: { type: 'string', description: 'One line on what changed, kept in the design history.' },
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, view: VIEW_SCHEMA, problems: PROBLEMS_SCHEMA }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => (value.view && value.view.id ? value.view : {}),
    },
    presentCall: (args) => callView(args, 'Write'),
    presentResult: resultView,
    execute(args, exec) {
      const sessionId = sessionOf(exec)
      const scopeKey = keyFor(sessionId, args.scope)
      const verdict = validateDocument(row, args.document)
      if (!verdict.document) {
        return { text: 'The design did NOT validate. Fix these and write again:\n' + problemLines(verdict.problems), problems: verdict.problems }
      }
      const store = row.storeFor(scopeKey)
      const id = typeof args.id === 'string' && args.id.length > 0 ? args.id : store.freeId(args.title ?? verdict.document.title ?? 'design')
      const stored = putDesign(store, {
        id,
        title: typeof args.title === 'string' && args.title.length > 0 ? args.title : verdict.document.title,
        preset: verdict.document.preset,
        document: verdict.document,
        by: 'model',
        note: args.note,
      })
      if (!stored.entry) return { text: stored.text }
      const entry = stored.entry
      const verification = verificationOf(entry)
      const lines = [
        'Wrote "' + entry.id + '" as revision ' + entry.revision + ' (' + (entry.preset ?? 'no preset') + ').',
        verification.state === 'stale' || verification.state === 'pending'
          ? 'The stored picture is not of this revision yet - render it with canvas_render { id: "' + entry.id + '" } and read the PNG it names with read_image.'
          : 'The last render matches this revision.',
        'Tab address: ' + addressOf(scopeKey, entry.id),
      ]
      return { text: lines.join('\n'), view: viewOf(scopeKey, entry) }
    },
  }

  // -------------------------------------------------------------------------
  // canvas_patch
  // -------------------------------------------------------------------------
  const patch = {
    name: 'canvas_patch',
    description: [
      'Edit ONE existing design with pointer-style operations, then validate the whole document again: { op: "set" | "remove" | "insert", at: "layers.0.children.1", value }.',
      'Use this instead of re-emitting a document: moving one element or fixing one word should not cost a whole design.',
      '`at` is a dot path of object keys and array indexes (`layers`, `layers.2.children.0`, `tokens.color.accent`); `insert` needs an array target and an index (or "-" to append); every operation is applied in order and the FIRST bad one is reported with its code (NO_TARGET, NO_VALUE, BAD_TARGET, BAD_PATH).',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'ops'],
      properties: {
        id: ID_SCHEMA,
        ops: {
          type: 'array',
          description: 'Up to 64 operations, applied in order.',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['set', 'remove', 'insert'] },
              at: { type: 'string' },
              // Any lossless JSON value. The harness's enforced schema subset has
              // no type arrays, and its unconstrained-JSON form is the
              // annotation-only schema - which is what `value` has always meant
              // to the patcher (`set` a scalar, an object or a whole subtree).
              value: {},
            },
            required: ['op', 'at'],
          },
        },
        scope: SCOPE_SCHEMA,
        note: { type: 'string', description: 'One line on what changed, kept in the design history.' },
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, view: VIEW_SCHEMA, problems: PROBLEMS_SCHEMA }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => (value.view && value.view.id ? value.view : {}),
    },
    presentCall: (args) => callView(args, 'Patch'),
    presentResult: resultView,
    execute(args, exec) {
      const sessionId = sessionOf(exec)
      const found = requireDesign(sessionId, args.id, args.scope)
      const patched = applyPatches(found.entry.document, args.ops)
      if (patched.problems.length > 0) {
        return { text: 'The patch did NOT apply. Nothing was changed:\n' + problemLines(patched.problems), problems: patched.problems }
      }
      const verdict = validateDocument(row, patched.document)
      if (!verdict.document) {
        return { text: 'The patch applied, but the result does NOT validate. Nothing was changed:\n' + problemLines(verdict.problems), problems: verdict.problems }
      }
      const store = row.storeFor(found.scopeKey)
      const stored = putDesign(store, {
        id: found.entry.id,
        title: found.entry.title,
        preset: verdict.document.preset,
        document: verdict.document,
        by: 'model',
        note: args.note,
      })
      if (!stored.entry) return { text: stored.text }
      const entry = stored.entry
      const lines = [
        'Patched "' + entry.id + '" to revision ' + entry.revision + '.',
        'Render it again (canvas_render { id: "' + entry.id + '" }) and look at the PNG before deciding it is better - a patch that validates can still be a worse design.',
        'Tab address: ' + addressOf(found.scopeKey, entry.id),
      ]
      return { text: lines.join('\n'), view: viewOf(found.scopeKey, entry) }
    },
  }

  // -------------------------------------------------------------------------
  // canvas_style
  // -------------------------------------------------------------------------
  const restyle = {
    name: 'canvas_style',
    description: [
      'Apply a LOOK from the style library to an existing design: the palette, the type behaviour, the shape language, the surface and the art treatment.',
      'Geometry is untouched - a style never moves or resizes anything, which is what makes this safe: the composition stays exactly as it is and the design comes out looking like another genre.',
      'The document records the style it carries (`style`), and the scale factor is applied as a DELTA against the previous one, so applying the same style twice changes nothing and switching back restores the original type sizes exactly.',
      'A style cannot do what the language cannot express (there is no blur, so "glass" is translucency plus a hairline plus a soft shadow); the library says so in the style\'s own intent and rules.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'style'],
      properties: {
        id: ID_SCHEMA,
        style: { type: 'string', description: 'The style id to apply; canvas_read lists the library.' },
        scope: SCOPE_SCHEMA,
        note: { type: 'string', description: 'One line on what changed, kept in the design history.' },
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, view: VIEW_SCHEMA, problems: PROBLEMS_SCHEMA }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => (value.view && value.view.id ? value.view : {}),
    },
    presentCall: (args) => callView(args, 'Style'),
    presentResult: resultView,
    execute(args, exec) {
      const sessionId = sessionOf(exec)
      const style = styleById(args.style)
      if (!style) {
        return { text: 'Unknown style ' + JSON.stringify(args.style) + '. The library carries:\n' + styleLines() }
      }
      const found = requireDesign(sessionId, args.id, args.scope)
      const applied = applyStyle(found.entry.document, style, { styles: styleTable() })
      const verdict = validateDocument(row, applied.document)
      if (!verdict.document) {
        return { text: 'The styled design did NOT validate (nothing was changed):\n' + problemLines(verdict.problems), problems: verdict.problems }
      }
      const stored = putDesign(row.storeFor(found.scopeKey), {
        id: found.entry.id,
        title: found.entry.title,
        preset: verdict.document.preset,
        document: verdict.document,
        by: 'model',
        note: args.note,
      })
      if (!stored.entry) return { text: stored.text }
      const lines = [
        'Applied the "' + style.name + '" style to "' + stored.entry.id + '" (revision ' + stored.entry.revision + ').',
        style.intent,
        'What changed: ' + (applied.notes.length > 0 ? applied.notes.join('; ') : 'the palette only') + '.',
        'Geometry was not touched. Render it and look before styling again - a new look is a new judgement.',
        'Tab address: ' + addressOf(found.scopeKey, stored.entry.id),
      ]
      if (style.rules) {
        lines.push('The style\u2019s own rules: ' + style.rules.do.slice(0, 2).join(' '))
        lines.push('Do not: ' + style.rules.dont.slice(0, 2).join(' '))
      }
      return { text: lines.join('\n'), view: viewOf(found.scopeKey, stored.entry) }
    },
  }

  // -------------------------------------------------------------------------
  // canvas_set
  // -------------------------------------------------------------------------
  const designSet = {
    name: 'canvas_set',
    description: [
      'Derive ONE design to the several sizes a launch actually needs - the repository card, the square post, the link preview - and optionally write every file in one call.',
      'A set is a source preset and a list of destinations. Each derived design is the source with EVERY number multiplied by the width ratio (positions, sizes, radii, padding, gaps, borders, letter spacing, shadows and the type scale), full-bleed layers widened to the new canvas, and the composition centred in a taller one. So the family cannot drift: one headline, one palette, one composition, at three sizes.',
      'It does NOT re-compose. A derived design is the same design with more room; if a destination needs a different ARRANGEMENT, that is a different archetype and a different design. The lints on each derived design say what the new destination wants adjusted (a margin, an edge, a keep-out area) - read them and fix the family, not just one card.',
      'Each derived design is stored as a design of its own (id + the destination), so it can be rendered, patched and exported like any other.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: ID_SCHEMA,
        set: { type: 'string', description: 'A set id: launch, social or repository; canvas_read lists them with their destinations.' },
        targets: { type: 'array', items: { type: 'string' }, description: 'Explicit destination preset ids instead of a set.' },
        export: { type: 'boolean', description: 'Write every derived file in one call (uses the host renderer, so no app page is needed).' },
        target: { type: 'string', enum: ['desktop', 'workspace'], description: 'Where the files go when exporting (default desktop).' },
        scale: { type: 'number', enum: [1, 2], description: 'Export scale (2 for an @2x file).' },
        scope: SCOPE_SCHEMA,
        note: { type: 'string', description: 'One line on what changed, kept in each design\u2019s history.' },
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, problems: PROBLEMS_SCHEMA }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: () => ({}),
    },
    presentCall: (args) => callView(args, 'Set'),
    presentResult: resultView,
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const found = requireDesign(sessionId, args.id, args.scope)
      const targets = Array.isArray(args.targets) && args.targets.length > 0 ? args.targets : null
      if (!targets && typeof args.set !== 'string') {
        return { text: 'Name a set or a list of destinations. The sets are:\n' + setLines() }
      }
      if (targets) {
        for (const id of targets) {
          if (!presetById(id)) return { text: 'Unknown destination ' + JSON.stringify(id) + '. The presets are:\n' + presetLines() }
        }
      }
      const chosen = targets ?? setById(args.set).targets
      const lines = []
      const written = []
      for (const target of chosen) {
        const derived = deriveFor(found.entry.document, target)
        if (derived.error) return { text: 'Could not derive for ' + target + ': ' + derived.error.message }
        const verdict = validateDocument(row, derived.document)
        if (!verdict.document) return { text: 'The derived design for ' + target + ' did NOT validate (nothing was stored):\n' + problemLines(verdict.problems) }
        const preset = presetById(target)
        const stored = putDesign(row.storeFor(found.scopeKey), {
          id: found.entry.id + '-' + target,
          title: (found.entry.title ?? found.entry.id) + ' \u00b7 ' + preset.label,
          preset: target,
          document: verdict.document,
          by: 'model',
          note: args.note ?? ('derived from ' + found.entry.id),
        })
        if (!stored.entry) return { text: stored.text }
        lines.push(
          '- ' + stored.entry.id + '  ' + preset.width + '\u00d7' + preset.height + '  revision ' + stored.entry.revision +
            (derived.notes.length > 0 ? '  (' + derived.notes[0] + ')' : ''),
        )
        // There is no local linting here on purpose: a lint needs a LAYOUT, a layout
        // needs real text metrics, and this host has none - it is the browser that
        // measures. The lints for a derived design therefore arrive with its render.
        if (args.export === true) {
          const status = hostRenderStatus()
          if (!status.available) {
            lines.push('    NOT written: ' + status.reason)
            continue
          }
          const rendered = await renderOnHost({
            document: stored.entry.document,
            preset,
            scale: args.scale === 2 ? 2 : 1,
            assets: await assetPayload(row, stored.entry.document),
            timeoutMs: 90000,
          })
          if (!rendered.ok) {
            lines.push('    export FAILED: ' + rendered.error)
            continue
          }
          const directory = args.target === 'workspace' ? sessionRoot(sessionId) : desktopDirectory()
          if (!directory) {
            lines.push('    no folder to write into on this host')
            continue
          }
          const suffix = args.scale === 2 ? '@2x' : ''
          const file = await writeCreateExclusive({ directory, baseName: sanitizeName(stored.entry.id) + suffix, ext: 'png', bytes: rendered.png })
          written.push(file.path)
          lines.push('    wrote ' + file.path + ' (' + humanBytes(file.bytes) + ', ' + rendered.width + '\u00d7' + rendered.height + ')')
          const flags = (rendered.lints ?? []).filter((lint) => lint.level !== 'info')
          if (flags.length > 0) lines.push('    this destination wants: ' + flags.map((lint) => lint.code).join(', '))
        }
      }
      const head = [
        'Derived "' + found.entry.id + '" into ' + chosen.length + ' size(s)' + (args.set ? ' (the ' + args.set + ' set)' : '') + '.',
        'One design, several destinations: the composition is scaled, the words and the palette are the same.',
      ]
      if (written.length > 0) head.push(written.length + ' file(s) written.')
      head.push('Tab addresses: ' + (found.scopeKey ? '' : ''))
      return { text: head.join('\n') + '\n' + lines.join('\n') }
    },
  }

  // -------------------------------------------------------------------------
  // canvas_read
  // -------------------------------------------------------------------------
  const read = {
    name: 'canvas_read',
    description: [
      'Read one design back (its canonical document, the browser\'s last verdict, and the measurements and lints that came with it), or - with no id - the index: every design in this conversation, the library, the preset table, the archetypes and the limits.',
      'The document handed back is the CANONICAL form (tokens resolved, defaults filled), and it is exactly what canvas_patch addresses and how `at` paths are numbered.',
      'detail "summary" returns the index entry without the document; "document" (the default when an id is given) returns the whole thing.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: ID_SCHEMA,
        scope: SCOPE_SCHEMA,
        detail: { type: 'string', enum: ['summary', 'document'], description: 'How much of the design to return.' },
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, view: VIEW_SCHEMA }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => (value.view && value.view.id ? value.view : {}),
    },
    presentCall: (args) => callView(args, 'Read'),
    presentResult: resultView,
    execute(args, exec) {
      const sessionId = sessionOf(exec)
      if (typeof args.id !== 'string' || args.id.length === 0) {
        return { text: indexText(row, sessionId) }
      }
      const found = requireDesign(sessionId, args.id, args.scope)
      const detail = args.detail === 'summary' ? 'summary' : 'document'
      const summary = summarize(found.entry, scopeOf(found.scopeKey))
      const lines = [
        'Design "' + summary.id + '" (' + summary.title + ') - ' + (summary.preset ?? 'no preset') + ', revision ' + summary.revision + '.',
        'Render verdict: ' + verdictLine(summary.verification),
      ]
      if (summary.metrics) lines.push('Measurements: ' + metricsLine(summary.metrics))
      if (summary.lints.length > 0) {
        lines.push('Lints from the last render (' + summary.warnings + ' warn, ' + summary.errors + ' error):')
        lines.push(lintLines(summary.lints))
      } else {
        lines.push('No lints were reported by the last render.')
      }
      lines.push('Tab address: ' + addressOf(found.scopeKey, found.entry.id))
      if (detail === 'document') {
        lines.push('')
        lines.push('Document (canonical):')
        lines.push('```json')
        lines.push(JSON.stringify(found.entry.document, null, 2))
        lines.push('```')
      } else {
        lines.push('Pass detail "document" for the canonical document.')
      }
      return { text: lines.join('\n'), view: viewOf(found.scopeKey, found.entry) }
    },
  }

  // -------------------------------------------------------------------------
  // canvas_publish
  // -------------------------------------------------------------------------
  const publish = {
    name: 'canvas_publish',
    description: [
      'Copy one design from this conversation into the harness-wide LIBRARY, where every conversation can read it and its id can be cited later.',
      'The library copy gets its own revision counter and is independent from then on; publishing twice replaces the library copy with the current state.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: ID_SCHEMA, note: { type: 'string', description: 'One line on why it is being published.' } },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, view: VIEW_SCHEMA }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => (value.view && value.view.id ? value.view : {}),
    },
    presentCall: (args) => callView(args, 'Publish'),
    presentResult: resultView,
    execute(args, exec) {
      const sessionId = sessionOf(exec)
      const found = requireDesign(sessionId, args.id, 'conversation')
      const library = row.storeFor('library')
      const stored = putDesign(library, {
        id: found.entry.id,
        title: found.entry.title,
        preset: found.entry.preset,
        document: found.entry.document,
        by: 'model',
        note: args.note ?? 'published from a conversation',
      })
      if (!stored.entry) return { text: stored.text }
      const entry = stored.entry
      return {
        text: 'Published "' + entry.id + '" to the library (revision ' + entry.revision + '). It is now readable from any conversation by id.\nAddress: ' + addressOf('library', entry.id),
        view: viewOf('library', entry),
      }
    },
  }

  // -------------------------------------------------------------------------
  // canvas_delete
  // -------------------------------------------------------------------------
  const remove = {
    name: 'canvas_delete',
    description: 'Delete one design. Without `scope` the LIBRARY is checked first, exactly like canvas_read and canvas_patch.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: ID_SCHEMA, scope: SCOPE_SCHEMA },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, deleted: { type: 'boolean' } }, required: ['text', 'deleted'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    presentCall: (args) => callView(args, 'Delete'),
    presentResult: resultView,
    execute(args, exec) {
      const sessionId = sessionOf(exec)
      const found = locate(row, sessionId, args.id, args.scope)
      if (!found) return { text: 'No design "' + args.id + '" to delete.', deleted: false }
      row.storeFor(found.scopeKey).remove(found.entry.id)
      return { text: 'Deleted "' + found.entry.id + '" from ' + (found.scopeKey === 'library' ? 'the library' : 'this conversation') + '.', deleted: true }
    },
  }

  // -------------------------------------------------------------------------
  // canvas_render
  // -------------------------------------------------------------------------
  const render = {
    name: 'canvas_render',
    description: [
      'Ask the BROWSER to lay the design out and paint it, then get back a PNG you can READ with read_image, plus the measurements and the lints that go with it.',
      'This is how a design is judged: a document that validates is not a picture. Read the returned path with read_image, and look at the feed-size thumbnail too - that is roughly how the design appears in a feed.',
      'The render happens in the dsh web page (the Canvas tab does not need to be in front, but the page must be open). If no page answers within 20 seconds the call says so; nothing is lost - render again when the page is back.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: ID_SCHEMA,
        scope: SCOPE_SCHEMA,
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' }, view: VIEW_SCHEMA, lints: LINTS_SCHEMA, path: { type: 'string' }, feedPath: { type: 'string' } },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => (value.view && value.view.id ? value.view : {}),
    },
    presentCall: (args) => callView(args, 'Render'),
    presentResult: resultView,
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const found = requireDesign(sessionId, args.id, args.scope)
      const preset = found.entry.preset ? presetById(found.entry.preset) : null
      const maxSide = preset ? Math.max(preset.width, preset.height, 1) : 1280
      const scale = maxSide > REPORT_MAX_SIDE ? REPORT_MAX_SIDE / maxSide : 1
      const queued = await row.queue.request(
        sessionId,
        {
          id: found.entry.id,
          scope: scopeOf(found.scopeKey),
          revision: found.entry.revision,
          document: found.entry.document,
          preset: found.entry.preset ?? null,
          purpose: 'report',
          scale: Math.round(scale * 1000) / 1000,
        },
        REPORT_TIMEOUT_MS,
      )
      // NO PAGE AT ALL? The host paints it instead. The fallback is for SILENCE, not
      // for a failure: when a page is open and its render fails, that failure is the
      // truth about the design and is reported as one - only nobody-answered means
      // there was no painter, and then a headless Chromium on this machine becomes the
      // painter. Same engine, same faces, same paint call.
      const silent = !queued.ok && typeof queued.error === 'string' && queued.error.startsWith('no page answered the render')
      const answer = silent && hostRenderStatus().available ? await renderUnattended(row, sessionId, found.scopeKey, found.entry, { scale: 1 }) : queued
      if (!answer.ok) {
        row.storeFor(found.scopeKey).recordRender(found.entry.id, { revision: found.entry.revision, ok: false, error: String(answer.error ?? 'the render failed') })
        const failed = row.storeFor(found.scopeKey).get(found.entry.id)
        return { text: 'The render FAILED: ' + String(answer.error ?? 'unknown error'), ...(failed ? { view: viewOf(found.scopeKey, failed) } : {}) }
      }
      const entry = row.storeFor(found.scopeKey).get(found.entry.id)
      if (!entry) return { text: 'The design vanished while it was rendering.' }
      const lines = [
        'Rendered "' + entry.id + '" revision ' + entry.revision + ' at ' + answer.width + '\u00d7' + answer.height + ' (scale ' + answer.scale + ').',
        'Full render: ' + answer.path,
      ]
      if (answer.feedPath) lines.push('Feed-size thumbnail (' + Math.round((answer.feedScale ?? 0.25) * 100) + '% - this is roughly a feed): ' + answer.feedPath)
      lines.push('Open the FULL render with read_image on the path above, and judge legibility on the thumbnail.')
      if (Array.isArray(answer.lints) && answer.lints.length > 0) {
        lines.push('The report flags ' + answer.lints.length + ' thing(s):')
        lines.push(lintLines(answer.lints))
      } else {
        lines.push('No lints were reported.')
      }
      if (answer.metrics) lines.push('Measurements: ' + metricsLine(answer.metrics))
      return { text: lines.join('\n'), view: viewOf(found.scopeKey, entry), lints: entry.lints ?? [], path: answer.path, ...(answer.feedPath ? { feedPath: answer.feedPath } : {}) }
    },
  }

  // -------------------------------------------------------------------------
  // canvas_export
  // -------------------------------------------------------------------------
  const exportTool = {
    name: 'canvas_export',
    description: [
      'Write the design to a real file: PNG or JPG (the browser rasterizes at 1x or 2x) or SVG (vector, with the bundled fonts embedded so it renders the same anywhere).',
      'It lands on the DESKTOP of the machine running the harness by default, or inside the conversation folder with target "workspace" (useful for a README header that belongs in the repository).',
      'The preset decides the format and the byte ceiling: exporting a GitHub social preview as 900x300 is refused by name instead of quietly producing a file the destination will reject.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: ID_SCHEMA,
        scope: SCOPE_SCHEMA,
        format: { type: 'string', enum: ['png', 'jpg', 'svg'], description: 'png (default), jpg for a photograph, svg for vector.' },
        scale: { type: 'number', enum: [1, 2], description: '1x (the preset size) or 2x (the same composition at twice the pixels) where the preset recommends it.' },
        target: { type: 'string', enum: ['desktop', 'workspace'], description: 'Where to write the file.' },
        name: { type: 'string', description: 'The file name without extension (defaults to the design id).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' }, view: VIEW_SCHEMA, path: { type: 'string' }, bytes: { type: 'integer' }, problems: PROBLEMS_SCHEMA },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => (value.view && value.view.id ? value.view : {}),
    },
    presentCall: (args) => callView(args, 'Export'),
    presentResult: resultView,
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const found = requireDesign(sessionId, args.id, args.scope)
      const preset = found.entry.preset ? presetById(found.entry.preset) : null
      const format = ['png', 'jpg', 'svg'].includes(args.format) ? args.format : 'png'
      const scale = args.scale === 2 ? 2 : 1
      const target = args.target === 'workspace' ? 'workspace' : 'desktop'
      const rules = exportProblems(preset, format, undefined)
      if (!rules.ok) {
        return { text: 'This design cannot be exported as ' + format + ':\n' + problemLines(rules.problems.map((entry) => ({ code: entry.code, message: entry.message }))), problems: rules.problems.map((entry) => ({ code: entry.code, message: entry.message })) }
      }
      if (scale === 2 && preset && preset.scale2x !== true) {
        // Not a refusal: a 2x export of a preset that is already shown at full
        // size is simply twice the file for no benefit, and the model is told so.
        // (The export still happens.)
      }
      const name = sanitizeName(args.name ?? found.entry.title ?? found.entry.id) || found.entry.id
      const answer = await row.queue.request(
        sessionId,
        {
          id: found.entry.id,
          scope: scopeOf(found.scopeKey),
          revision: found.entry.revision,
          document: found.entry.document,
          preset: found.entry.preset ?? null,
          purpose: 'export',
          format,
          scale,
          target,
          name,
        },
        EXPORT_TIMEOUT_MS,
      )
      if (!answer.ok) {
        // NO PAGE OPEN? The host writes the file. png, jpg and svg are all encoded by
        // the same engine in the headless browser; anything the host cannot do is
        // answered in a sentence that says which machine must be awake.
        const status = hostRenderStatus()
        if (!status.available) return { text: 'The export FAILED: ' + String(answer.error ?? 'unknown error') }
        const rendered = await renderOnHost({
          document: found.entry.document,
          preset,
          scale: scale === 2 ? 2 : 1,
          format,
          assets: await assetPayload(row, found.entry.document),
          timeoutMs: 90000,
        })
        if (!rendered.ok) return { text: 'The export FAILED: ' + String(rendered.error) }
        const directory = target === 'workspace' ? sessionRoot(sessionId) : desktopDirectory()
        if (!directory) return { text: 'There is no folder to write into on this host.' }
        const extension = rendered.format === 'svg' ? 'svg' : rendered.format === 'jpg' ? 'jpg' : 'png'
        const stem = sanitizeName(name ?? found.entry.id)
        const suffix = scale === 2 && extension !== 'svg' ? '@2x' : ''
        const written = await writeCreateExclusive({ directory, baseName: stem + suffix, ext: extension, bytes: rendered.svg ?? rendered.png })
        const file = written.path
        const bytes = written.bytes ?? (rendered.svg ?? rendered.png).length
        const lines = ['Wrote ' + file + ' (' + humanBytes(bytes) + ', ' + rendered.width + '\u00d7' + rendered.height + ', painted on the host - no app page was needed).']
        if (preset) {
          if (bytes > preset.maxBytes) lines.push('NOTE: that file is larger than ' + preset.label + '\u2019s ' + humanBytes(preset.maxBytes) + ' ceiling - export a JPG or a smaller scale.')
          lines.push('Where it goes: ' + preset.destination.where)
        }
        return { text: lines.join('\n'), path: file, bytes }
      }
      const sizeLine = 'Wrote ' + answer.path + ' (' + humanBytes(answer.bytes ?? 0) + (answer.width ? ', ' + answer.width + '\u00d7' + answer.height : '') + ').'
      const lines = [sizeLine]
      if (answer.oversize) lines.push('NOTE: that file is larger than ' + (preset ? preset.label + '\u2019s ' + humanBytes(preset.maxBytes) + ' ceiling' : 'the ceiling') + ' - export a JPG or a smaller scale.')
      if (preset) {
        lines.push('Where it goes: ' + preset.destination.where)
        for (const step of preset.destination.steps) lines.push('  - ' + step)
      }
      return {
        text: lines.join('\n'),
        path: answer.path,
        ...(typeof answer.bytes === 'number' ? { bytes: answer.bytes } : {}),
        ...(preset && answer.bytes > preset.maxBytes ? { problems: [{ code: 'TOO_LARGE', message: 'the file exceeds ' + preset.label + '\u2019s ceiling' }] } : {}),
      }
    },
  }

  // -------------------------------------------------------------------------
  // canvas_assets
  // -------------------------------------------------------------------------
  const assets = {
    name: 'canvas_assets',
    description: [
      'The images a design may use. Images are never fetched from the network: a design references either a stored asset or a workspace-relative path, and both resolve on the host side with the harness\'s own containment rules.',
      'op "list" shows the stored assets and their pixel sizes. op "import" copies an image into the store from a workspace-relative path (a screenshot, a logo, a diagram export) or from base64 data (a paste), and answers the name to use as `src`. op "remove" deletes one.',
      'A stored asset has no directory in its name, so it reads as the same picture everywhere; a workspace path with a slash resolves through the conversation folder at render time.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['op'],
      properties: {
        op: { type: 'string', enum: ['list', 'import', 'remove'] },
        path: { type: 'string', description: 'For import: a path relative to the conversation folder.' },
        data: { type: 'string', description: 'For import: base64 image bytes (a paste), optionally as a data URL.' },
        name: { type: 'string', description: 'For remove: the asset name to delete.' },
        label: { type: 'string', description: 'For import: a human label for the list.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          assets: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, bytes: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' } },
              required: ['name', 'bytes'],
            },
          },
        },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    presentCall: (args) => callView(args, 'Assets'),
    presentResult: resultView,
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      if (args.op === 'list') {
        const list = row.assets.list()
        const lines = list.length === 0 ? ['No stored assets yet. Import one with canvas_assets { op: "import", path: "docs/shot.png" }.'] : list.map((entry) => '  - ' + entry.name + '  ' + (entry.width ?? '?') + '\u00d7' + (entry.height ?? '?') + '  ' + humanBytes(entry.bytes))
        return { text: 'Stored assets (' + list.length + '):\n' + lines.join('\n'), assets: list.map((entry) => ({ name: entry.name, bytes: entry.bytes, ...(entry.width ? { width: entry.width } : {}), ...(entry.height ? { height: entry.height } : {}) })) }
      }
      if (args.op === 'remove') {
        const removed = row.assets.remove(args.name)
        return { text: removed ? 'Removed asset ' + args.name + '.' : 'No asset named ' + JSON.stringify(args.name ?? null) + '.' }
      }
      // import
      try {
        let bytes = null
        let label = typeof args.label === 'string' ? args.label : null
        if (typeof args.data === 'string' && args.data.length > 0) {
          const base64 = args.data.replace(/^data:[^,]*,/, '')
          bytes = Buffer.from(base64, 'base64')
        } else if (typeof args.path === 'string' && args.path.length > 0) {
          const cwd = await sessionRoot(ctx, sessionId)
          const target = await resolveInsideExisting(cwd, args.path)
          bytes = await fsp.readFile(target)
          if (label === null) label = args.path
        } else {
          return { text: 'Import needs either `path` (relative to the conversation folder) or `data` (base64).' }
        }
        const record = row.assets.add({ bytes, label })
        return {
          text:
            'Imported ' + record.name + ' (' + record.width + '\u00d7' + record.height + ', ' + humanBytes(record.bytes) + ')' +
            (record.deduplicated ? ' - the same bytes were already stored, so nothing was copied twice.' : '.') +
            '\nUse it as an image node: { "kind": "image", "src": "' + record.name + '", "w": ' + Math.min(record.width, 640) + ', "h": ' + Math.round(Math.min(record.width, 640) * (record.height / record.width)) + ' }',
        }
      } catch (err) {
        // A refused path or a non-image is a sentence the model can act on, not a
        // thrown error: the caps and the containment rules are ordinary limits.
        return { text: 'Could not import that image: ' + message(err) }
      }
    },
  }

  return [newDesign, write, patch, read, restyle, designSet, publish, remove, render, exportTool, assets]
}

/**
 * The workspace root of one session: the live session header while the session is
 * running, otherwise the stored header from session persistence - the same lookup
 * `@deepseek-ai/dsh-api-workspace-files` performs for its own reads, and
 * `dsh-editor` uses for its saves.
 */
async function sessionRoot(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw httpError(400, 'BAD_REQUEST', 'a session id is required')
  const get = ctx && typeof ctx.get === 'function' ? (service) => ctx.get(service) : () => undefined
  try {
    const sessions = get('sessions')
    const live = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
    const header = live && live.header
    if (header && typeof header.cwd === 'string' && header.cwd.length > 0) return header.cwd
  } catch (err) {
    /* fall through to persistence */
  }
  try {
    const persistence = get('sessionPersistence')
    if (persistence && typeof persistence.stat === 'function') {
      const snapshot = await persistence.stat(sessionId)
      const header = snapshot && snapshot.header
      if (header && typeof header.cwd === 'string' && header.cwd.length > 0) return header.cwd
    }
  } catch (err) {
    /* fall through */
  }
  throw httpError(409, 'NO_WORKSPACE', 'the workspace folder for this conversation is not available')
}

/** Resolve a path that must already exist inside the workspace (realpath checked). */
async function resolveInsideExisting(cwd, rel) {
  const normalized = String(rel).replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) throw httpError(400, 'BAD_REQUEST', 'the path must be relative to the conversation folder')
  if (normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw httpError(400, 'BAD_REQUEST', 'the path cannot contain empty, "." or ".." segments')
  }
  const rootReal = await fsp.realpath(path.resolve(cwd)).catch(() => {
    throw httpError(400, 'NO_FOLDER', 'the conversation folder does not exist on disk')
  })
  const fileReal = await fsp.realpath(path.resolve(rootReal, normalized)).catch((err) => {
    if (err && err.code === 'ENOENT') throw httpError(404, 'NOT_FOUND', 'no file ' + normalized + ' in the conversation folder')
    throw httpError(500, 'IO_ERROR', 'could not resolve ' + normalized)
  })
  const rootPrefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep
  if (fileReal !== rootReal && !fileReal.startsWith(rootPrefix)) throw httpError(403, 'OUTSIDE_WORKSPACE', 'that path escapes the conversation folder')
  return fileReal
}

/** The preset table as text. */
function presetLines() {
  return Object.values(PRESETS)
    .map((preset) => '  - ' + preset.id + '  ' + preset.width + '\u00d7' + preset.height + '  ' + preset.label + '  (' + preset.formats.join('/') + ')')
    .join('\n')
}

/** The archetype table as text. */
function archetypeLines() {
  return ARCHETYPES.map((entry) => '  - ' + entry.id + '  ' + entry.title + '  [' + entry.presets.join(', ') + ']  ' + entry.description).join('\n')
}

/** One verdict line. */
function verdictLine(verification) {
  if (verification.state === 'drawn') return 'drawn (revision ' + verification.reported + ')' + (verification.path ? ' - ' + verification.path : '')
  if (verification.state === 'failed') return 'FAILED for revision ' + verification.reported + ': ' + (verification.error ?? 'no reason given')
  if (verification.state === 'stale') return 'stale (the last picture was of revision ' + (verification.reported ?? 'an older one') + ', not ' + verification.revision + ')'
  return 'pending (nothing has rendered this design yet)'
}

/** One measurements line. */
function metricsLine(metrics) {
  const parts = []
  if (typeof metrics.ops === 'number') parts.push(metrics.ops + ' draw ops')
  if (typeof metrics.boxes === 'number') parts.push(metrics.boxes + ' nodes')
  if (typeof metrics.textNodes === 'number') parts.push(metrics.textNodes + ' text nodes')
  if (typeof metrics.smallestType === 'number') parts.push('smallest type ' + metrics.smallestType + 'px')
  if (typeof metrics.lines === 'number') parts.push(metrics.lines + ' lines')
  if (Array.isArray(metrics.families) && metrics.families.length > 0) parts.push('families ' + metrics.families.join(', '))
  if (typeof metrics.ms === 'number') parts.push(Math.round(metrics.ms) + 'ms')
  return parts.length > 0 ? parts.join(', ') : 'none reported'
}

/** The index as text: every design, the library, the presets and the archetypes. */
function indexText(row, sessionId) {
  const own = row.storeFor(sessionId).list()
  const library = row.storeFor('library').list()
  const lines = []
  lines.push('Designs in this conversation (' + own.length + '):')
  lines.push(own.length === 0 ? '  (none yet - start one with canvas_new { preset: "github-social" })' : own.map((entry) => '  - ' + entry.id + '  ' + entry.preset + '  rev ' + entry.revision + '  ' + entry.verification.state + '  ' + entry.title).join('\n'))
  lines.push('')
  lines.push('Library (' + library.length + '):')
  lines.push(library.length === 0 ? '  (empty)' : library.map((entry) => '  - ' + entry.id + '  ' + entry.preset + '  rev ' + entry.revision + '  ' + entry.title).join('\n'))
  lines.push('')
  lines.push('Presets:')
  lines.push(presetLines())
  lines.push('')
  lines.push('Examples (a proven preset + archetype + style, with the copy to write - start here):')
  lines.push(exampleLinesForIndex())
  lines.push('')
  lines.push('Sets (one design derived to several destinations, then written in one call):')
  lines.push(setLines())
  lines.push('')
  lines.push('Styles (a look to apply to any composition):')
  lines.push(styleLines())
  lines.push('')
  lines.push('Archetypes (start from one of these):')
  lines.push(archetypeLines())
  lines.push('')
  lines.push('Fonts: ' + fontStatus().note)
  lines.push('Limits: canvas up to ' + LIMITS.maxCanvasSide + 'px a side, ' + LIMITS.maxLayers + ' top-level layers, ' + LIMITS.maxTotalNodes + ' nodes, ' + Math.round(MAX_DOCUMENT_BYTES / 1024) + ' KB a document.')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** Split a `SKILL.md`'s YAML-ish front matter from its content. */
function parseSkillFile(text) {
  const normalized = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized)
  if (!match) return { meta: {}, content: normalized.trim() }
  const meta = {}
  for (const line of match[1].split('\n')) {
    const entry = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (!entry) continue
    meta[entry[1]] = entry[2].replace(/^["']|["']$/g, '').trim()
  }
  return { meta, content: normalized.slice(match[0].length).trim() }
}

/**
 * Register the bundled skills. A profile without a skill registry still gets
 * them from `$DSH_HOME/skills` (both installers copy the folders there), so this
 * warns rather than failing.
 *
 * @param ctx - the cordis context.
 * @param log - `{ warn }`.
 * @returns how many skills were registered.
 */
export function registerSkills(ctx, log) {
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (!skills || typeof skills.register !== 'function') {
    log.warn('skill registry unavailable - the bundled canvas skills were not registered (the installers copy them into $DSH_HOME/skills anyway)')
    return 0
  }
  let count = 0
  for (const entry of SKILL_FILES) {
    try {
      const file = fileURLToPath(new URL(entry.file, import.meta.url))
      const { meta, content } = parseSkillFile(readFileSync(file, 'utf8'))
      if (content.length === 0) {
        log.warn('skill file is empty: ' + file)
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
            provider: 'dsh-canvas',
            // The registration names its source bucket and the file it read:
            // `ctx.skills.get()` (what the `skill` tool calls) validates a STRING
            // `source`, and `path` is what makes the definition file-backed, so a
            // skills browser can show - and a person can edit - the document the
            // model is given. A runtime entry's own rank (250) keeps a preset's
            // `$DSH_HOME/skills` copy winning wherever that provider is mounted.
            source: 'bundled',
            path: file,
            resourceBase: { kind: 'directory', path: path.dirname(file) },
          }),
        'dsh-canvas: skill ' + skillName,
      )
      count += 1
    } catch (err) {
      log.warn('could not register skill ' + entry.name + ': ' + message(err))
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Register every route the browser half reads.
 * @param ctx - the cordis context.
 * @param row - the row state.
 * @returns how many routes were registered.
 */
export function registerRoutes(ctx, row) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
    row.log.warn('the HTTP bridge is unavailable - the Canvas tab cannot read state')
    return 0
  }
  const engineFile = fileURLToPath(new URL('./engine.js', import.meta.url))
  const konvaFile = fileURLToPath(new URL('./vendor/konva/konva.min.js', import.meta.url))
  let engineEtag = null
  let engineStat = null
  /**
   * One route registration.
   *
   * The shape is the registry's own: `{ path, methods, requestBody, fetch }` - NOT
   * `{ path, fetch }`. A missing `methods` array is a boot-time TypeError inside
   * the registry ("Cannot read properties of undefined (reading 'length')"), which
   * is how the contained boot test found this: the row loaded, the harness
   * started, and the canvas routes were simply absent.
   */
  const register = (routePath, methods, handler) => {
    ctx.effect(
      () =>
        connection.fetch.register({
          path: routePath,
          methods,
          requestBody: 'buffered',
          fetch: async (request) => {
            try {
              return await handler(request)
            } catch (err) {
              return errorToResponse(err)
            }
          },
        }),
      'dsh-canvas: route ' + routePath,
    )
  }

  // ---- health ------------------------------------------------------------
  register(HEALTH_ROUTE, ['GET', 'HEAD'], async () => {
    const fonts = fontStatus()
    return json(200, {
      ok: true,
      version: ENGINE_VERSION,
      package: 'dsh-canvas',
      fonts,
      presets: Object.keys(PRESETS),
      styles: styleIds(),
      // Whether a render can happen with NO app page open, and which browser would do
      // it: a fact about this machine, and the reason a tool answer can say where its
      // pixels came from.
      unattended: hostRenderStatus(),
      archetypes: ARCHETYPES.map((entry) => entry.id),
      limits: LIMITS,
      queue: row.queue.status(),
      home: row.home,
    })
  })

  // ---- state -------------------------------------------------------------
  register(STATE_ROUTE, ['GET', 'HEAD'], async (request) => {
    try {
      const url = new URL(request.url)
      const sessionId = url.searchParams.get('session')
      if (!sessionId) throw httpError(400, 'BAD_REQUEST', 'a session id is required')
      const own = row.storeFor(sessionId).list()
      const library = row.storeFor('library').list()
      return json(200, {
        ok: true,
        engineVersion: ENGINE_VERSION,
        engineRoute: ENGINE_ROUTE,
        session: sessionId,
        presets: PRESETS,
        fonts: fontTable(),
        fontStatus: fontStatus(),
        limits: LIMITS,
        archetypes: ARCHETYPES.map((entry) => ({ id: entry.id, title: entry.title, description: entry.description, presets: entry.presets })),
        designs: own,
        styles: styleGallery(),
        examples: exampleGallery(),
        sets: setGallery(),
        library,
        assets: row.assets.table(),
        assetList: row.assets.list(),
        renderPathTemplate: path.join(row.home, 'dsh-canvas', 'renders') + path.sep,
      })
    } catch (err) {
      return errorToResponse(err)
    }
  })

  // ---- document (create / replace / patch, from the drawer or the panel) --
  register(DOCUMENT_ROUTE, ['POST'], async (request) => {
    try {
      if (request.method !== 'POST') throw httpError(405, 'METHOD', 'use POST')
      const body = await readJsonBody(request, 4 * 1024 * 1024)
      const sessionId = typeof body.session === 'string' && body.session.length > 0 ? body.session : null
      if (!sessionId) throw httpError(400, 'BAD_REQUEST', 'a session id is required')
      const scopeKey = keyFor(sessionId, body.scope)
      let candidate = body.document
      if (!candidate && Array.isArray(body.ops) && typeof body.id === 'string') {
        const found = locate(row, sessionId, body.id, body.scope)
        if (!found) throw httpError(404, 'NOT_FOUND', 'no design ' + body.id)
        const patched = applyPatches(found.entry.document, body.ops)
        if (patched.problems.length > 0) return json(400, { ok: false, error: { code: patched.problems[0].code, message: patched.problems[0].message }, problems: patched.problems })
        candidate = patched.document
      }
      if (!candidate && typeof body.example === 'string' && body.example.length > 0) {
        // A gallery row: the preset, archetype and style are already chosen well, so a
        // request only has to name which example.
        const built = documentFor({ example: body.example, title: body.title, style: body.style })
        if (built.error) return json(400, { ok: false, error: { code: built.error.code, message: built.error.message } })
        candidate = built.document
      }
      if (!candidate && typeof body.preset === 'string' && body.preset.length > 0) {
        // The tab's "+ New" asks for the same thing the model's `canvas_new`
        // does: a starter (or an archetype's document) for a destination preset,
        // built here so both paths produce byte-identical documents. A `style`
        // named beside the preset goes through the same `withStyle` transform the
        // tool uses.
        const built = documentFor({ preset: body.preset, archetype: body.archetype, title: body.title, style: body.style })
        if (built.error) return json(400, { ok: false, error: { code: built.error.code, message: built.error.message } })
        candidate = built.document
      }
      if (!candidate && typeof body.style === 'string' && typeof body.id === 'string') {
        // Re-styling an existing design from the panel: the same transform the
        // `canvas_style` tool runs, on the stored canonical document.
        const found = locate(row, sessionId, body.id, body.scope)
        if (!found) throw httpError(404, 'NOT_FOUND', 'no design ' + body.id)
        const style = styleById(body.style)
        if (!style) return json(400, { ok: false, error: { code: 'UNKNOWN_STYLE', message: 'unknown style ' + JSON.stringify(body.style) } })
        candidate = applyStyle(found.entry.document, style, { styles: styleTable() }).document
      }
      if (!candidate) throw httpError(400, 'BAD_REQUEST', 'a document (or an id with ops, or a preset) is required')
      const verdict = normalizeDocument(candidate, { presets: PRESETS, fonts: fontTable(), styles: styleTable() })
      if (!verdict.document) return json(400, { ok: false, error: { code: 'INVALID', message: 'the document did not validate' }, problems: verdict.problems })
      const store = row.storeFor(scopeKey)
      const id = typeof body.id === 'string' && body.id.length > 0 ? body.id : store.freeId(verdict.document.title ?? 'design')
      const entry = store.put({
        id,
        title: typeof body.title === 'string' ? body.title : verdict.document.title,
        preset: verdict.document.preset,
        document: verdict.document,
        by: typeof body.by === 'string' ? body.by : 'person',
        note: typeof body.note === 'string' ? body.note : undefined,
      })
      return json(200, { ok: true, design: summarize(entry, scopeOf(scopeKey)) })
    } catch (err) {
      return errorToResponse(err)
    }
  })

  // ---- delete ------------------------------------------------------------
  register(DELETE_ROUTE, ['POST'], async (request) => {
    try {
      if (request.method !== 'POST') throw httpError(405, 'METHOD', 'use POST')
      const body = await readJsonBody(request, 64 * 1024)
      const sessionId = typeof body.session === 'string' && body.session.length > 0 ? body.session : null
      if (!sessionId) throw httpError(400, 'BAD_REQUEST', 'a session id is required')
      const scopeKey = keyFor(sessionId, body.scope)
      const removed = typeof body.id === 'string' ? row.storeFor(scopeKey).remove(body.id) : false
      return json(200, { ok: true, removed })
    } catch (err) {
      return errorToResponse(err)
    }
  })

  // ---- publish -----------------------------------------------------------
  register(PUBLISH_ROUTE, ['POST'], async (request) => {
    try {
      if (request.method !== 'POST') throw httpError(405, 'METHOD', 'use POST')
      const body = await readJsonBody(request, 64 * 1024)
      const sessionId = typeof body.session === 'string' && body.session.length > 0 ? body.session : null
      if (!sessionId) throw httpError(400, 'BAD_REQUEST', 'a session id is required')
      const found = locate(row, sessionId, body.id, 'conversation')
      if (!found) throw httpError(404, 'NOT_FOUND', 'no design ' + String(body.id ?? '') + ' in this conversation')
      const entry = row.storeFor('library').put({
        id: found.entry.id,
        title: found.entry.title,
        preset: found.entry.preset,
        document: found.entry.document,
        by: 'person',
        note: 'published from a conversation',
      })
      return json(200, { ok: true, design: summarize(entry, 'library') })
    } catch (err) {
      return errorToResponse(err)
    }
  })

  // ---- assets ------------------------------------------------------------
  register(ASSET_ROUTE, ['GET', 'HEAD', 'POST'], async (request) => {
    try {
      const url = new URL(request.url)
      if (request.method === 'GET' || request.method === 'HEAD') {
        const name = url.searchParams.get('name')
        const file = name ? row.assets.path(name) : null
        if (!file) throw httpError(404, 'NOT_FOUND', 'no such asset')
        const info = statSync(file)
        const type = name.endsWith('.png') ? 'image/png' : name.endsWith('.jpg') || name.endsWith('.jpeg') ? 'image/jpeg' : name.endsWith('.gif') ? 'image/gif' : name.endsWith('.webp') ? 'image/webp' : 'application/octet-stream'
        const headers = { 'content-type': type, 'content-length': String(info.size), 'cache-control': 'private, max-age=31536000, immutable' }
        if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
        return new Response(readFileSync(file), { status: 200, headers })
      }
      if (request.method !== 'POST') throw httpError(405, 'METHOD', 'use GET or POST')
      const body = await readJsonBody(request, 24 * 1024 * 1024)
      if (typeof body.data !== 'string' || body.data.length === 0) throw httpError(400, 'BAD_REQUEST', 'a base64 `data` field is required')
      const base64 = body.data.replace(/^data:[^,]*,/, '')
      const bytes = Buffer.from(base64, 'base64')
      const record = row.assets.add({ bytes, ext: typeof body.ext === 'string' ? body.ext : undefined, label: typeof body.label === 'string' ? body.label : null })
      return json(200, { ok: true, asset: { name: record.name, bytes: record.bytes, width: record.width, height: record.height, format: record.format } })
    } catch (err) {
      return errorToResponse(err)
    }
  })

  // ---- the render queue (long poll) --------------------------------------
  register(QUEUE_ROUTE, ['GET', 'HEAD'], async (request) => {
    try {
      if (request.method !== 'GET') throw httpError(405, 'METHOD', 'use GET')
      const url = new URL(request.url)
      const sessionId = url.searchParams.get('session')
      if (!sessionId) throw httpError(400, 'BAD_REQUEST', 'a session id is required (or "*" for any)')
      const wait = Number(url.searchParams.get('wait') ?? '20000')
      // `session=*` is the page-level poller: it answers whatever is pending, and
      // the request itself names the conversation it belongs to.
      const pending = sessionId === '*' ? await row.queue.nextAny(wait) : await row.queue.next(sessionId, wait)
      if (!pending) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
      return json(200, {
        ok: true,
        request: {
          requestId: pending.requestId,
          session: pending.sessionId,
          id: pending.id,
          scope: pending.scope,
          revision: pending.revision,
          document: pending.document,
          preset: pending.preset ?? null,
          purpose: pending.purpose,
          scale: pending.scale ?? 1,
          format: pending.format ?? 'png',
          target: pending.target ?? null,
          name: pending.name ?? null,
        },
      })
    } catch (err) {
      return errorToResponse(err)
    }
  })

  // ---- workspace assets (the tab's own read of a conversation-folder image) --
  register(WORKSPACE_ASSET_ROUTE, ['GET', 'HEAD'], async (request) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') throw httpError(405, 'METHOD', 'use GET')
      const url = new URL(request.url)
      const sessionId = url.searchParams.get('session')
      const relative = url.searchParams.get('path')
      if (!sessionId || !relative) throw httpError(400, 'BAD_REQUEST', 'session and path are required')
      const cwd = await sessionRoot(ctx, sessionId)
      const file = await resolveInsideExisting(cwd, relative)
      const info = statSync(file)
      if (info.size > MAX_ASSET_BYTES) throw httpError(413, 'TOO_LARGE', 'that image is larger than this plugin will read (' + humanBytes(MAX_ASSET_BYTES) + ')')
      const type = /\.png$/i.test(file) ? 'image/png' : /\.jpe?g$/i.test(file) ? 'image/jpeg' : /\.gif$/i.test(file) ? 'image/gif' : /\.webp$/i.test(file) ? 'image/webp' : /\.avif$/i.test(file) ? 'image/avif' : /\.svg$/i.test(file) ? 'image/svg+xml' : 'application/octet-stream'
      const headers = { 'content-type': type, 'content-length': String(info.size), 'cache-control': 'no-store' }
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
      return new Response(readFileSync(file), { status: 200, headers })
    } catch (err) {
      return errorToResponse(err)
    }
  })

  // ---- the browser's answer ----------------------------------------------
  register(REPORT_ROUTE, ['POST'], async (request) => {
    // The body is parsed ONCE and kept, so a failure later can still settle the
    // waiting tool call instead of leaving it to time out. (`request.clone()`
    // after the body was read would throw - the original is already consumed.)
    let body = null
    try {
      if (request.method !== 'POST') throw httpError(405, 'METHOD', 'use POST')
      body = await readJsonBody(request, MAX_BODY_BYTES)
      const sessionId = typeof body.session === 'string' && body.session.length > 0 ? body.session : null
      if (!sessionId) throw httpError(400, 'BAD_REQUEST', 'a session id is required')
      const requestId = typeof body.requestId === 'string' ? body.requestId : null
      const designId = typeof body.id === 'string' ? body.id : null
      const scopeKey = keyFor(sessionId, body.scope)
      const store = row.storeFor(scopeKey)
      const entry = designId ? store.get(designId) : null
      if (body.ok !== true) {
        // A failed render is still a verdict, and it is the one the user sees.
        if (entry) store.recordRender(designId, { revision: body.revision, ok: false, error: typeof body.error === 'string' ? body.error : 'the renderer failed' })
        const answer = { ok: false, error: typeof body.error === 'string' ? body.error : 'the renderer failed' }
        if (requestId) row.queue.settle(requestId, answer)
        return json(200, { ok: true, recorded: false })
      }
      const lints = Array.isArray(body.lints) ? body.lints.slice(0, 64) : []
      const metrics = body.metrics && typeof body.metrics === 'object' ? body.metrics : null
      if (body.purpose === 'export') {
        const bytes = typeof body.png === 'string' ? Buffer.from(body.png.replace(/^data:[^,]*,/, ''), 'base64') : Buffer.from(String(body.svg ?? ''), 'utf8')
        const format = body.format === 'svg' ? 'svg' : body.format === 'jpg' ? 'jpg' : 'png'
        if (bytes.length === 0) throw httpError(400, 'EMPTY_EXPORT', 'the browser sent no bytes to write')
        if (bytes.length > MAX_EXPORT_BYTES) throw httpError(413, 'EXPORT_TOO_LARGE', 'the export is larger than ' + humanBytes(MAX_EXPORT_BYTES))
        const name = sanitizeName(body.name ?? designId ?? 'design') || 'design'
        const target = body.target === 'workspace' ? 'workspace' : 'desktop'
        let written
        if (target === 'workspace') {
          const cwd = await sessionRoot(ctx, sessionId)
          const relative = (body.directory ? String(body.directory) + '/' : '') + name + '.' + format
          const destination = await resolveNewInside(cwd, relative)
          written = await writeCreateExclusive({ directory: path.dirname(destination), baseName: path.basename(destination, '.' + format), ext: format, bytes })
        } else {
          const directory = await desktopDirectory()
          written = await writeCreateExclusive({ directory, baseName: name, ext: format, bytes })
        }
        const preset = entry && entry.preset ? presetById(entry.preset) : null
        const oversize = Boolean(preset && bytes.length > preset.maxBytes)
        if (entry) {
          store.recordRender(designId, {
            revision: body.revision,
            ok: true,
            path: written.path,
            width: typeof body.width === 'number' ? body.width : undefined,
            height: typeof body.height === 'number' ? body.height : undefined,
            lints,
            metrics,
            fonts: Array.isArray(body.fonts) ? body.fonts : undefined,
          })
        }
        const answer = { ok: true, path: written.path, bytes: written.bytes, oversize, ...(typeof body.width === 'number' ? { width: body.width } : {}), ...(typeof body.height === 'number' ? { height: body.height } : {}) }
        if (requestId) row.queue.settle(requestId, answer)
        return json(200, { ok: true, path: written.path, bytes: written.bytes })
      }
      // A report: write the PNG (and the feed thumbnail) where the model can read it.
      const revision = Number.isFinite(body.revision) ? body.revision : entry ? entry.revision : 0
      let writtenPath = null
      if (typeof body.png === 'string' && body.png.length > 0) {
        const bytes = Buffer.from(body.png.replace(/^data:[^,]*,/, ''), 'base64')
        const file = renderPath(row.home, sessionId, designId ?? 'design', revision, typeof body.scale === 'number' ? body.scale : 1)
        // A render is IDEMPOTENT for a revision: the same revision is the same
        // picture, so it overwrites its own file instead of accumulating -2, -3.
        const written = await writeCreateExclusive({ directory: path.dirname(file), baseName: path.basename(file, '.png'), ext: 'png', bytes, overwrite: true })
        writtenPath = written.path
      }
      let feedPath = null
      const feedScale = typeof body.feedScale === 'number' ? body.feedScale : 0.25
      if (typeof body.feed === 'string' && body.feed.length > 0) {
        const bytes = Buffer.from(body.feed.replace(/^data:[^,]*,/, ''), 'base64')
        const file = renderPath(row.home, sessionId, designId ?? 'design', revision, feedScale)
        const written = await writeCreateExclusive({ directory: path.dirname(file), baseName: path.basename(file, '.png'), ext: 'png', bytes, overwrite: true })
        feedPath = written.path
      }
      if (entry) {
        store.recordRender(designId, {
          revision,
          ok: true,
          path: writtenPath ?? undefined,
          width: typeof body.width === 'number' ? body.width : undefined,
          height: typeof body.height === 'number' ? body.height : undefined,
          lints,
          metrics,
          fonts: Array.isArray(body.fonts) ? body.fonts : undefined,
        })
      }
      const answer = {
        ok: true,
        path: writtenPath,
        feedPath,
        feedScale,
        width: typeof body.width === 'number' ? body.width : null,
        height: typeof body.height === 'number' ? body.height : null,
        scale: typeof body.scale === 'number' ? body.scale : 1,
        lints,
        metrics,
      }
      if (requestId) row.queue.settle(requestId, answer)
      return json(200, { ok: true, path: writtenPath, feedPath })
    } catch (err) {
      // A failed WRITE (or a bad body) is settled onto the waiting tool call so
      // it never hangs on a host-side failure.
      if (body && typeof body.requestId === 'string') row.queue.settle(body.requestId, { ok: false, error: message(err) })
      return errorToResponse(err)
    }
  })

  // ---- the engine module -------------------------------------------------
  register(ENGINE_ROUTE, ['GET', 'HEAD'], async (request) => {
    try {
      const info = statSync(engineFile)
      if (engineStat === null || engineStat.size !== info.size || engineStat.mtimeMs !== info.mtimeMs) {
        const text = readFileSync(engineFile)
        engineEtag = '"' + createHash('sha256').update(text).digest('hex').slice(0, 32) + '"'
        engineStat = { size: info.size, mtimeMs: info.mtimeMs }
      }
      if (request.headers.get('if-none-match') === engineEtag) return new Response(null, { status: 304, headers: { etag: engineEtag } })
      const text = readFileSync(engineFile, 'utf8')
      return new Response(text, {
        status: 200,
        headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', etag: engineEtag },
      })
    } catch (err) {
      return errorToResponse(err)
    }
  })

  // ---- the Konva painter module ------------------------------------------
  //
  // The same contract as the engine route above: a plain file, imported by the browser from a
  // blob URL, re-hashed only when its bytes move, and answerable with an ETag.
  const konvaPaintFile = fileURLToPath(new URL('./konva-paint.js', import.meta.url))
  let konvaPaintEtag = null
  let konvaPaintStat = null
  register(KONVA_PAINT_ROUTE, ['GET', 'HEAD'], async (request) => {
    try {
      const info = statSync(konvaPaintFile)
      if (konvaPaintStat === null || konvaPaintStat.size !== info.size || konvaPaintStat.mtimeMs !== info.mtimeMs) {
        const bytes = readFileSync(konvaPaintFile)
        konvaPaintEtag = '"' + createHash('sha256').update(bytes).digest('hex').slice(0, 32) + '"'
        konvaPaintStat = { size: info.size, mtimeMs: info.mtimeMs }
      }
      if (request.headers.get('if-none-match') === konvaPaintEtag) return new Response(null, { status: 304, headers: { etag: konvaPaintEtag } })
      const text = readFileSync(konvaPaintFile, 'utf8')
      return new Response(text, {
        status: 200,
        headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', etag: konvaPaintEtag },
      })
    } catch (err) {
      return errorToResponse(err)
    }
  })

  // ---- the vendored Konva surface ----------------------------------------
  //
  // The tab's INTERACTION layer (hit testing, transform handles, marquee). It is a
  // classic script rather than a module on purpose: the artifact is one UMD file
  // that ends with `globalThis.Konva = ...`, so a `<script>` element is exactly the
  // loader it wants - no blob URL, no import map, no bare specifiers, and it cannot
  // reach into the shell's module table.
  //
  // Unlike the fonts (immutable: a face's bytes never change under its hash), the
  // ETag here is read from VERSION.json and served `no-cache`, because this route
  // can be rebuilt: a stale copy of the interaction layer is a stale editor, and the
  // record already carries the sha256, so answering costs no hashing.
  register(KONVA_JS_ROUTE, ['GET', 'HEAD'], async (request) => {
    try {
      if (!existsSync(konvaFile)) {
        throw httpError(
          503,
          'VENDOR_MISSING',
          'the vendored Konva surface is not in this checkout - build it with `node packages/dsh-canvas/vendor/konva/build.mjs`',
        )
      }
      const info = statSync(konvaFile)
      let etag = '"' + String(info.size) + '-' + String(Math.round(info.mtimeMs)) + '"'
      try {
        const record = JSON.parse(readFileSync(fileURLToPath(new URL('./vendor/konva/VERSION.json', import.meta.url)), 'utf8'))
        const recorded = record.files?.['konva.min.js']
        if (recorded && typeof recorded.sha256 === 'string') etag = '"' + recorded.sha256.slice(0, 32) + '"'
      } catch (err) {
        // A missing or unreadable record is not a reason to refuse the file: the
        // bytes are what the browser needs, and the mtime ETag still revalidates.
      }
      const headers = { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', etag, 'content-length': String(info.size) }
      if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } })
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
      return new Response(readFileSync(konvaFile), { status: 200, headers })
    } catch (err) {
      return errorToResponse(err)
    }
  })

  // ---- the bundled font files (one exact route each) ---------------------
  let fontRoutes = 0
  for (const entry of Object.values(fontTable())) {
    for (const meta of Object.values(entry.weights)) {
      const routePath = FONT_ROUTE_PREFIX + meta.file
      register(routePath, ['GET', 'HEAD'], async (request) => {
        try {
          const name = routePath.slice(FONT_ROUTE_PREFIX.length)
          const file = fontFileFor(name)
          if (!file) throw httpError(404, 'NOT_FOUND', 'no such font file')
          const info = statSync(file)
          const etag = '"' + meta.sha256.slice(0, 32) + '"'
          if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } })
          if (request.method === 'HEAD') {
            return new Response(null, { status: 200, headers: { 'content-type': 'font/woff2', 'content-length': String(info.size), etag, 'cache-control': 'public, max-age=31536000, immutable' } })
          }
          return new Response(readFileSync(file), {
            status: 200,
            headers: { 'content-type': 'font/woff2', 'content-length': String(info.size), etag, 'cache-control': 'public, max-age=31536000, immutable' },
          })
        } catch (err) {
          return errorToResponse(err)
        }
      })
      fontRoutes += 1
    }
  }
  row.log.debug('[dsh-canvas] routes registered (' + (12 + fontRoutes) + ' including ' + fontRoutes + ' font file(s))')
  return 12 + fontRoutes
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

/** Client-facing services the browser half needs. */
export function apply(ctx) {
  const row = createRow(ctx)
  const skills = registerSkills(ctx, row.log)
  const routes = registerRoutes(ctx, row)
  // `inject: ['connection', 'tools']` puts both on the context in the real
  // runtime; `ctx.get` is used first so a harness that resolves services lazily
  // still works (and so a check can drive this half with either shape).
  const tools = (typeof ctx.get === 'function' ? ctx.get('tools') : undefined) ?? ctx.tools
  if (!tools || typeof tools.register !== 'function') {
    row.log.warn('the tool registry is unavailable - the canvas tools were not registered')
    return
  }
  for (const tool of buildTools(row, ctx)) {
    ctx.effect(() => tools.register(tool), 'dsh-canvas: tool ' + tool.name)
  }
  row.log.info(
    '[dsh-canvas] ready (engine ' + ENGINE_VERSION + ', ' + TOOL_NAMES.length + ' tools, ' + skills + ' skills, ' + routes + ' routes, ' +
      fontStatus().files + ' font files)',
  )
}

/** The pieces a check drives directly. */
export const __internals = {
  createRow,
  buildTools,
  registerRoutes,
  registerSkills,
  sessionRoot,
  starterDocument,
  validateDocument,
  referencedAssets,
  keyFor,
  addressOf,
  RenderQueue,
  parseSkillFile,
}
