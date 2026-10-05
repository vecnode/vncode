/**
 * dsh-writing — Node half.
 *
 * A page document lives in this plugin's own store (`$DSH_HOME/dsh-writing`,
 * `lib/store.js`) and a `.docx` is an EXPORT of it, so the host half owns five
 * authenticated `connection.fetch` routes under `/api/dsh-writing/*`:
 *
 *   GET  /api/dsh-writing/state      the conversation's documents + the library
 *   GET  /api/dsh-writing/document   one document, blocks included
 *   POST /api/dsh-writing/document   create or save one document
 *   POST /api/dsh-writing/delete     remove one document
 *   POST /api/dsh-writing/publish    copy one document into the shared library
 *   POST /api/dsh-writing/import     read a workspace .docx/.md/.txt into the store
 *   POST /api/dsh-writing/export     write .docx/.md/.txt into the workspace (or Desktop)
 *
 * WHY AN EXPORT IS THE INTERESTING ONE. The harness already ships a LibreOffice
 * (`@deepseek-ai/libreoffice-kit`, behind `@deepseek-ai/dsh-office-to-pdf`) and
 * the shipped document preview already renders a `docx` by converting it to PDF
 * and painting that. So this package does not render anything: "Proof" exports
 * the document as a real `.docx` into the conversation folder and hands that
 * address to the shipped preview, which is core's own LibreOffice path. The tab
 * composes the file; core shows what LibreOffice makes of it. That is also why
 * the export route is the one the schema of this package cares most about - it
 * is the boundary the whole design is built on.
 *
 * The session id is what the browser tab already carries; the workspace root is
 * resolved HERE, from the live session header when the session is running and from
 * session persistence when it is cold - the same two-step lookup
 * `@deepseek-ai/dsh-api-workspace-files` uses (`lib/index.js` of `dsh-editor`
 * carries the same helper for the same reason). The client never names a root.
 *
 * AND THE MODEL CAN WRITE ONE. Three tools (`lib/tools.js`) drive the same store
 * the tab reads - `writing_list`, `writing_read`, `writing_write` - so a document
 * the agent composes is a document the person can edit, proof and export, not a
 * Markdown file they have to import. This package also ships the pack's one
 * METHOD skill (`skills/research/`): how a literature review is run, sourced and
 * cited, because the artifact a review produces is the artifact this tab makes.
 * Both are registered before the connection check below, so a profile whose
 * connection is unavailable still gets them.
 */
import { promises as fsp } from 'node:fs'
import { existsSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAX_BLOCKS,
  MAX_DOCUMENT_BYTES,
  MAX_TITLE_CHARS,
  blocksFromMarkdown,
  blocksFromText,
  documentMarkdown,
  documentText,
} from './model.js'
import { docxFileName, readDocx, writeDocx } from './ooxml.js'
import { createSheetDocument, readSheetFile, sheetText, writeSheetFile } from './sheet.js'
import { listFonts } from './fonts.js'
import { MAX_CONVERSATION_BYTES, MAX_DOCUMENTS, WritingStore, resolveHome } from './store.js'
import { buildTools } from './tools.js'

export const name = 'dsh-writing'

/**
 * `tools` is required and not merely wanted: registering the three writing tools
 * is part of activating this row, and a profile without the registry should say so
 * rather than silently half-activate. `connection` carries the browser routes and
 * is checked defensively below (a profile can load this row without a web carrier,
 * and then the tab is simply absent while the tools still work).
 */
export const inject = ['connection', 'tools']

/** Keep in sync with the client's hard-coded route constants. */
const API_ROOT = '/api/dsh-writing'
const STATE_ROUTE = API_ROOT + '/state'
const DOCUMENT_ROUTE = API_ROOT + '/document'
const DELETE_ROUTE = API_ROOT + '/delete'
const PUBLISH_ROUTE = API_ROOT + '/publish'
const IMPORT_ROUTE = API_ROOT + '/import'
const EXPORT_ROUTE = API_ROOT + '/export'
const CREATE_FILE_ROUTE = API_ROOT + '/create-file'
const SAVE_FILE_ROUTE = API_ROOT + '/save-file'
const OPEN_FILE_ROUTE = API_ROOT + '/open-file'
const OUTLINE_ROUTE = API_ROOT + '/outline'
const FONTS_ROUTE = API_ROOT + '/fonts'
/**
 * The page breaker, served to the BROWSER.
 *
 * `lib/page.js` decides which blocks land on which page, it needs a block height
 * only the browser can measure, and it has no imports at all - so it is shipped
 * over this route and imported from a blob URL by the tab (the shape `dsh-canvas`
 * uses for its engine). One implementation, driven by the checks on the host and
 * by the tab in the page.
 *
 * The TAB no longer imports it - the editor is the vendored Editor.js surface now,
 * and a block list has no page in it - but the route stays: the splitter is a public
 * part of this package, `check-writing-node.mjs` drives it, and a page view that
 * comes back would need no host change at all.
 */
const PAGE_ROUTE = API_ROOT + '/page.js'
/**
 * The vendored Editor.js surface, served to the BROWSER - one exact route per file
 * (`/vendor/editorjs/editorjs.umd.js`, `…/header.umd.js`, …), because they are
 * classic scripts a `<script>` element loads and each one leaves a global behind.
 *
 * The bytes come from `lib/vendor/editorjs/`, which is built and hashed by
 * `packages/dsh-writing/vendor/editorjs/build.mjs`; the ETag is the sha256 recorded
 * there, so a changed artifact is a changed URL and an unchanged one costs a 304.
 */
const EDITOR_ROUTE = API_ROOT + '/vendor/editorjs/'

/** Text imports above this many bytes are refused instead of buffered. */
const MAX_IMPORT_BYTES = 8 * 1024 * 1024
/** How many `-2`, `-3`, … names an export will try before giving up. */
const MAX_EXPORT_ATTEMPTS = 50
/** The library's own store key (its file is fixed, so the key only labels it). */
const LIBRARY_KEY = 'library'
/**
 * The skills this bundle ships, by the id each one is addressed by.
 *
 * The `research` skill is the pack's ONE method skill: every other skill teaches a
 * tool (`canvas-design` teaches `canvas_*`, `pdf-analysis` teaches `pdf_*`), and
 * this one teaches a practice - how a literature review is scoped, searched,
 * verified, synthesized and cited. It ships with THIS package because the artifact
 * a review produces is the artifact this tab makes, and because the review's last
 * step is a `writing_write` call.
 */
const SKILL_FILES = [{ name: 'research', file: '../skills/research/SKILL.md' }]

/** Respond with a JSON body and a status code. */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Typed failure → HTTP response. */
function fail(status, code, message, extra) {
  return json(status, { ok: false, error: { code, message, ...(extra ?? {}) } })
}

/** An error carrying the HTTP status the route should answer with. */
function httpError(status, code, message, cause) {
  const err = new Error(message)
  err.status = status
  err.code = code
  if (cause) err.cause = cause
  return err
}

/**
 * The workspace root of one session: the live session header while the session is
 * running, otherwise the stored header from session persistence.
 *
 * @param ctx - the plugin context (services are re-read per request).
 * @param sessionId - the session the tab belongs to.
 * @returns {Promise<string>} the session's cwd.
 */
async function sessionRoot(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw httpError(400, 'BAD_REQUEST', 'A session id is required.')
  }
  const get = typeof ctx.get === 'function' ? (serviceName) => ctx.get(serviceName) : () => undefined
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
    /* fall through to the typed failure below */
  }
  throw httpError(409, 'NO_WORKSPACE', 'The workspace folder for this conversation is not available.')
}

/** Resolve a workspace-relative path and verify by realpath that it stays inside. */
async function resolveInside(cwd, rel) {  if (typeof cwd !== 'string' || cwd.length === 0) throw httpError(400, 'BAD_REQUEST', 'A workspace folder is required.')
  if (typeof rel !== 'string' || rel.length === 0) throw httpError(400, 'BAD_REQUEST', 'A path is required.')
  const normalized = rel.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw httpError(400, 'BAD_REQUEST', 'The path must be relative to the conversation folder.')
  }
  let rootReal
  try {
    rootReal = await fsp.realpath(path.resolve(cwd))
  } catch (err) {
    throw httpError(400, 'NO_FOLDER', 'The conversation folder does not exist on disk.', err)
  }
  const fileAbs = path.resolve(rootReal, normalized)
  const rootPrefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep
  if (fileAbs !== rootReal && !fileAbs.startsWith(rootPrefix)) {
    throw httpError(403, 'OUTSIDE_WORKSPACE', 'The path escapes the conversation folder.')
  }
  let fileReal
  try {
    fileReal = await fsp.realpath(fileAbs)
  } catch (err) {
    if (err && err.code === 'ENOENT') throw httpError(404, 'NOT_FOUND', 'The file does not exist in the conversation folder.', err)
    throw httpError(500, 'IO_ERROR', 'Could not resolve the file on disk.', err)
  }
  return fileReal
}

/**
 * The absolute path one `origin` names: a workspace-relative file, or a file this
 * package itself created on the Desktop.
 *
 * The two are different because their CONTAINMENT is different, and the check is
 * what makes "write back to the file this document came from" safe: a relative
 * origin is resolved INSIDE the workspace (the rule `resolveInside` states), and an
 * absolute one is only accepted when its OWN FOLDER is the Desktop this host would
 * export to. Nothing else outside the workspace is reachable, and a document that
 * names some other absolute path is a typed refusal rather than a write.
 *
 * @param ctx - cordis context.
 * @param sessionId - the session the tab belongs to.
 * @param origin - the stored `origin.path`.
 * @returns the absolute path.
 */
async function originFile(ctx, sessionId, origin) {
  const value = typeof origin === 'string' ? origin : ''
  if (value.length === 0) return null
  const normalized = value.replaceAll('\\', '/')
  if (!normalized.startsWith('/') && !/^[A-Za-z]:/.test(normalized)) {
    return await resolveInside(await sessionRoot(ctx, sessionId), value)
  }
  const desktop = await desktopDir()
  const target = path.resolve(value)
  if (path.dirname(target) !== path.resolve(desktop)) {
    throw httpError(403, 'OUTSIDE_WORKSPACE', 'This document is linked to a file outside the conversation folder and the Desktop.')
  }
  try {
    return await fsp.realpath(target)
  } catch (err) {
    if (err && err.code === 'ENOENT') return target
    throw httpError(500, 'IO_ERROR', 'Could not resolve the file on disk.', err)
  }
}

/**
 * What to tell somebody whose file is in a format this codec cannot read.
 *
 * The two families get their own sentence on purpose: "save it as .docx" is the
 * right advice for a `.doc`, and useless for an `.xls` - and a refusal that does
 * not name the way out is the kind of message that wastes an afternoon.
 *
 * @param extension - the file's lower-cased extension.
 * @param verb - `'import'` or `'open'`, for the last word.
 * @returns the sentence to append to the refusal.
 */
function conversionHint(extension, verb) {
  if (extension === '.doc' || extension === '.odt' || extension === '.rtf') {
    return ' Open it in LibreOffice or Word and save it as .docx, then ' + verb + ' that.'
  }
  if (extension === '.xls' || extension === '.ods') {
    return ' Open it in LibreOffice or Excel and save it as .xlsx, then ' + verb + ' that.'
  }
  return ' This tab reads .docx, .xlsx, .md and .txt.'
}

/** A coarse but reliable text probe: strict UTF-8 and no NUL bytes. */function decodeText(buffer) {
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch (err) {
    throw httpError(415, 'NOT_TEXT', 'This file is not UTF-8 text.', err)
  }
  if (text.indexOf('\u0000') >= 0) throw httpError(415, 'NOT_TEXT', 'This file looks binary.')
  return text
}

/**
 * The two stores this plugin owns: one per conversation, one shared.
 *
 * The root is `$DSH_HOME/dsh-writing` and NOTHING else: this row declares no
 * config, and a cordis context REFUSES `ctx.config` unless the row asks for it
 * ("cannot get property \"config\" without inject"). That refusal is exactly the
 * bug a check that imports this module against a stub context cannot see - a
 * stub answers happily - so the fix is to not reach for a config at all, and the
 * fonts read `DSH_WRITING_FONT_DIRS` from the environment for the same reason.
 */
let storeCache = null
function stores() {
  const root = path.join(resolveHome(), 'dsh-writing')
  if (!storeCache || storeCache.root !== root) {
    storeCache = {
      root,
      conversation: new WritingStore({ root }),
      library: new WritingStore({ root, fixedFile: 'library.json' }),
    }
  }
  return storeCache
}

/** The store one request names: the conversation's, or the shared library. */
function storeFor(ctx, scope) {
  const both = stores()
  return scope === 'library' ? { store: both.library, key: LIBRARY_KEY, scope: 'library' } : { store: both.conversation, key: null, scope: 'conversation' }
}

/** One document's summary plus its content, as the client tabs read it. */
function documentPayload(entry) {
  const isSheet = entry.kind === 'sheet'
  return {
    id: entry.id,
    kind: isSheet ? 'sheet' : 'page',
    scope: entry.scope,
    title: entry.title,
    page: isSheet ? null : entry.page,
    font: isSheet ? null : entry.font ?? '',
    fontSize: isSheet ? null : entry.fontSize,
    sheets: isSheet ? entry.sheets : null,
    blocks: isSheet ? null : entry.blocks,
    revision: entry.revision,
    by: entry.by,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    origin: entry.origin ?? null,
    bytes: entry.summary.bytes,
    words: entry.summary.words,
    characters: entry.summary.characters,
    filled: entry.summary.filled,
    widthMm: entry.summary.widthMm,
    heightMm: entry.summary.heightMm,
  }
}

/** One file name segment: no separators, no control characters, bounded. */
function safeName(value, fallback, extension) {
  const base = String(value ?? '')
    .replaceAll('\\', '/')
    .split('/')
    .pop()
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .trim()
    .slice(0, 80)
  const stem = base.replace(new RegExp(extension.replace('.', '\\.') + '$', 'i'), '')
  return (stem.length > 0 ? stem : fallback).slice(0, 64) + extension
}

/**
 * Write bytes as a NEW file, trying `name`, `name-2`, `name-3`, … so exporting
 * twice does not overwrite the first file and does not fail either.
 *
 * @param dir - the directory to write into.
 * @param name - the preferred file name (already safe).
 * @param data - the bytes.
 * @returns the absolute path written.
 */
async function writeFresh(dir, name, data) {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  for (let attempt = 1; attempt <= MAX_EXPORT_ATTEMPTS; attempt += 1) {
    const candidate = path.join(dir, attempt === 1 ? name : stem + '-' + attempt + extension)
    try {
      await fsp.writeFile(candidate, data, { flag: 'wx' })
      return candidate
    } catch (err) {
      if (err && err.code === 'EEXIST') continue
      throw httpError(500, 'IO_ERROR', 'Could not write ' + candidate + ' on disk.', err)
    }
  }
  throw httpError(409, 'EXISTS', 'Could not find a free file name in ' + dir + ' after ' + MAX_EXPORT_ATTEMPTS + ' attempts.')
}

/** The Desktop when it exists, else the home folder: where an export goes on request. */
async function desktopDir() {
  const home = os.homedir()
  const desktop = path.join(home, 'Desktop')
  try {
    const stats = await fsp.stat(desktop)
    if (stats.isDirectory()) return desktop
  } catch (err) {
    /* no Desktop: the home folder is the honest fallback */
  }
  return home
}

/** GET /api/dsh-writing/state — every document of one conversation, plus the library. */
async function handleState(ctx, request) {
  try {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('session') || ''
    if (sessionId.length === 0) return fail(400, 'BAD_REQUEST', 'A session id is required.')
    const conversation = stores().conversation.list(sessionId)
    const library = stores().library.list(LIBRARY_KEY)
    const payload = {
      ok: true,
      session: sessionId,
      documents: conversation.documents,
      library: library.documents,
      limits: {
        documents: MAX_DOCUMENTS,
        documentBytes: MAX_DOCUMENT_BYTES,
        conversationBytes: MAX_CONVERSATION_BYTES,
        blocks: MAX_BLOCKS,
        titleChars: MAX_TITLE_CHARS,
      },
    }
    return request.method === 'HEAD' ? new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } }) : json(200, payload)
  } catch (err) {
    return errorResponse(err)
  }
}

/** GET/HEAD/POST /api/dsh-writing/document — read one document, or save one. */
async function handleDocument(ctx, request) {
  try {
    if (request.method === 'GET' || request.method === 'HEAD') {
      const url = new URL(request.url)
      const sessionId = url.searchParams.get('session') || ''
      const id = url.searchParams.get('id') || ''
      const scope = url.searchParams.get('scope') === 'library' ? 'library' : 'conversation'
      if (scope === 'library') {
        const entry = stores().library.get(LIBRARY_KEY, id)
        if (!entry) return fail(404, 'NOT_FOUND', 'No library document "' + id + '".')
        return json(200, { ok: true, document: documentPayload(entry) })
      }
      if (sessionId.length === 0) return fail(400, 'BAD_REQUEST', 'A session id is required.')
      const entry = stores().conversation.get(sessionId, id)
      if (!entry) return fail(404, 'NOT_FOUND', 'No document "' + id + '" in this conversation.')
      return json(200, { ok: true, document: documentPayload(entry) })
    }

    let payload
    try {
      payload = await request.json()
    } catch (err) {
      return fail(400, 'BAD_REQUEST', 'Expected a JSON body.')
    }
    const scope = payload.scope === 'library' ? 'library' : 'conversation'
    const { store, key } = storeFor(ctx, scope)
    const scopeKey = scope === 'library' ? key : typeof payload.session === 'string' ? payload.session : ''
    if (!scopeKey) return fail(400, 'BAD_REQUEST', 'A session id is required.')
    const entry = store.write(scopeKey, {
      id: typeof payload.id === 'string' ? payload.id : undefined,
      kind: payload.kind === 'sheet' ? 'sheet' : undefined,
      title: typeof payload.title === 'string' ? payload.title : undefined,
      page: payload.page,
      font: payload.font,
      fontSize: payload.fontSize,
      sheets: payload.sheets,
      blocks: payload.blocks,
      by: payload.by,
      note: payload.note,
      origin: payload.origin,
      expectedRevision: payload.expectedRevision,
    })
    return json(200, { ok: true, document: documentPayload(store.get(scopeKey, entry.id)) })
  } catch (err) {
    if (err && err.code === 'CONFLICT') {
      return json(409, { ok: false, error: { code: 'CONFLICT', message: err.message } })
    }
    return errorResponse(err)
  }
}

/** POST /api/dsh-writing/delete — remove one document. */
async function handleDelete(ctx, request) {
  try {
    const payload = await request.json().catch(() => null)
    if (!payload) return fail(400, 'BAD_REQUEST', 'Expected a JSON body.')
    const { store, key } = storeFor(ctx, payload.scope === 'library' ? 'library' : 'conversation')
    const scopeKey = payload.scope === 'library' ? key : typeof payload.session === 'string' ? payload.session : ''
    if (!scopeKey) return fail(400, 'BAD_REQUEST', 'A session id is required.')
    const removed = store.remove(scopeKey, String(payload.id ?? ''))
    if (!removed) return fail(404, 'NOT_FOUND', 'No such document.')
    return json(200, { ok: true, id: payload.id })
  } catch (err) {
    return errorResponse(err)
  }
}

/** POST /api/dsh-writing/publish — copy one conversation document into the library. */
async function handlePublish(ctx, request) {
  try {
    const payload = await request.json().catch(() => null)
    if (!payload) return fail(400, 'BAD_REQUEST', 'Expected a JSON body.')
    const sessionId = typeof payload.session === 'string' ? payload.session : ''
    if (!sessionId) return fail(400, 'BAD_REQUEST', 'A session id is required.')
    const both = stores()
    const entry = both.library.copyInto(both.conversation, sessionId, String(payload.id ?? ''), { by: payload.by, note: 'published' })
    return json(200, { ok: true, document: { id: entry.id, title: entry.title, scope: 'library', revision: entry.revision } })
  } catch (err) {
    return errorResponse(err)
  }
}

/**
 * POST /api/dsh-writing/import — read one workspace file into the store.
 *
 * `.docx` is read by this package's own codec (and its loss report is returned
 * with the document, so the tab can say what it could not represent); `.md` and
 * `.txt` are read as text. Anything else is refused BY NAME with the way out,
 * because the two formats people will try - `.doc` and `.odt` - are exactly the
 * ones this codec does not read, and "unsupported" without "save it as .docx
 * first" is the kind of message that wastes an afternoon.
 */
async function handleImport(ctx, request) {
  try {
    const payload = await request.json().catch(() => null)
    if (!payload) return fail(400, 'BAD_REQUEST', 'Expected a JSON body.')
    const sessionId = typeof payload.session === 'string' ? payload.session : ''
    const rel = typeof payload.path === 'string' ? payload.path : ''
    if (!sessionId || !rel) return fail(400, 'BAD_REQUEST', 'A session id and a path are required.')
    const cwd = await sessionRoot(ctx, sessionId)
    const target = await resolveInside(cwd, rel)
    const stats = await fsp.stat(target)
    if (!stats.isFile()) return fail(400, 'NOT_FILE', 'The path is not a regular file.')
    const extension = path.extname(target).toLowerCase()
    if (!['.docx', '.xlsx', '.md', '.markdown', '.txt'].includes(extension)) {
      return fail(415, 'UNSUPPORTED', 'This tab cannot read ' + (extension || 'a file with no extension') + '.' + conversionHint(extension, 'import'))
    }
    if (stats.size > MAX_IMPORT_BYTES) {
      return fail(413, 'TOO_LARGE', 'The file is larger than ' + Math.round(MAX_IMPORT_BYTES / 1024 / 1024) + ' MiB and was not imported.')
    }
    const bytes = await fsp.readFile(target)
    let document
    let loss = []
    let meta = null
    let kind = 'page'
    if (extension === '.xlsx') {
      const read = readSheetFile(bytes)
      document = read.document
      loss = read.loss
      meta = read.meta
      kind = 'sheet'
    } else if (extension === '.docx') {
      const read = readDocx(bytes)
      document = read.document
      loss = read.loss
      meta = read.meta
    } else if (extension === '.txt') {
      document = { title: path.basename(target, extension), page: null, blocks: blocksFromText(decodeText(bytes)) }
    } else {
      document = { title: path.basename(target, extension), page: null, blocks: blocksFromMarkdown(decodeText(bytes)) }
    }
    const entry = stores().conversation.write(sessionId, {
      id: typeof payload.id === 'string' ? payload.id : undefined,
      kind,
      title: typeof payload.title === 'string' && payload.title.length > 0 ? payload.title : document.title || path.basename(target),
      page: document.page,
      font: document.font,
      fontSize: document.fontSize,
      sheets: document.sheets,
      blocks: document.blocks,
      by: payload.by,
      note: 'imported from ' + rel,
      origin: { path: rel, mtimeMs: stats.mtimeMs, size: stats.size, importedAt: new Date().toISOString() },
    })
    return json(200, { ok: true, document: documentPayload(stores().conversation.get(sessionId, entry.id)), loss, meta })
  } catch (err) {
    if (err && typeof err.code === 'string' && ['NOT_A_ZIP', 'NO_DOCUMENT_PART', 'BAD_XML', 'BAD_ARCHIVE', 'ZIP64', 'BAD_CRC'].includes(err.code)) {
      return fail(415, err.code, err.message)
    }
    return errorResponse(err)
  }
}

/**
 * POST /api/dsh-writing/export — write one document as a file.
 *
 * The `.docx` written here is the artifact the whole design rests on: it is what
 * the shipped office preview converts with the harness's own LibreOffice, and it
 * is what `check-writing-node.mjs` hands to LibreOffice to prove the codec.
 */
async function handleExport(ctx, request) {
  try {
    const payload = await request.json().catch(() => null)
    if (!payload) return fail(400, 'BAD_REQUEST', 'Expected a JSON body.')
    const sessionId = typeof payload.session === 'string' ? payload.session : ''
    if (!sessionId) return fail(400, 'BAD_REQUEST', 'A session id is required.')
    const entry = stores().conversation.get(sessionId, String(payload.id ?? ''))
    if (!entry) return fail(404, 'NOT_FOUND', 'No such document in this conversation.')
    const requested = payload.format === 'md' ? 'md' : payload.format === 'txt' ? 'txt' : payload.format === 'xlsx' ? 'xlsx' : payload.format === 'docx' ? 'docx' : null
    // The document's own kind picks the default: a workbook exported as a Word
    // document would be a file nobody asked for.
    const format = requested ?? (entry.kind === 'sheet' ? 'xlsx' : 'docx')
    const extension = format === 'md' ? '.md' : format === 'txt' ? '.txt' : format === 'xlsx' ? '.xlsx' : '.docx'
    const data =
      format === 'md'
        ? Buffer.from(entry.kind === 'sheet' ? sheetText(entry) : documentMarkdown(entry), 'utf8')
        : format === 'txt'
          ? Buffer.from((entry.kind === 'sheet' ? sheetText(entry) : documentText(entry) + '\n'), 'utf8')
          : format === 'xlsx'
            ? writeSheetFile(entry, { title: entry.title })
            : writeDocx(entry, { title: entry.title })
    const fallback = format === 'docx' ? docxFileName(entry.title).replace(/\.docx$/, '') : entry.title
    const name = safeName(typeof payload.name === 'string' && payload.name.length > 0 ? payload.name : fallback, 'document', extension)
    const toDesktop = payload.target === 'desktop'
    const dir = toDesktop ? await desktopDir() : await fsp.realpath(path.resolve(await sessionRoot(ctx, sessionId)))
    const written = await writeFresh(dir, name, data)
    const base = path.basename(written)
    // PROOF NEEDS A PATH THE PREVIEW CAN READ. Core's document preview is handed a
    // WORKSPACE address (`dsh-resource://file/session/…`), so a `.docx` that was
    // exported to the Desktop cannot be previewed where it landed. When the caller
    // asks for a proof, the same bytes are ALSO written into the conversation folder
    // (over the same name, so a second proof does not litter `-2`, `-3` copies) and
    // THAT is the address handed back for rendering. The workspace copy is the
    // disposable one: LibreOffice is what shows the person what the file made.
    let previewPath = toDesktop ? null : base
    if (toDesktop && payload.proof === true && format === 'docx') {
      const cwd = await fsp.realpath(path.resolve(await sessionRoot(ctx, sessionId)))
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
      const proofName = safeName(base.replace(/\.docx$/i, '') + '-proof-' + stamp, 'proof', '.docx')
      const proofFile = path.join(cwd, proofName)
      await fsp.writeFile(proofFile, data)
      previewPath = proofName
    }
    return json(200, {
      ok: true,
      format,
      name: base,
      path: previewPath ?? written,
      previewPath,
      absolute: written,
      dir,
      bytes: data.byteLength,
    })
  } catch (err) {
    return errorResponse(err)
  }
}

/**
 * POST /api/dsh-writing/create-file — make a REAL file in the conversation
 * folder and open it as a document.
 *
 * This is what "New" means when somebody wants a file rather than a page kept
 * inside this plugin: nothing is pretended. The bytes go to disk FIRST (through
 * `writeFresh`, so an existing name is never replaced), and the document stored
 * afterwards is *linked* to that path through `origin`, which is what turns every
 * later save into a write back to the file.
 */
async function handleCreateFile(ctx, request) {
  try {
    const payload = await request.json().catch(() => null)
    if (!payload) return fail(400, 'BAD_REQUEST', 'Expected a JSON body.')
    const sessionId = typeof payload.session === 'string' ? payload.session : ''
    if (!sessionId) return fail(400, 'BAD_REQUEST', 'A session id is required.')
    const format = payload.format === 'xlsx' ? 'xlsx' : payload.format === 'md' ? 'md' : payload.format === 'txt' ? 'txt' : 'docx'
    const extension = format === 'xlsx' ? '.xlsx' : format === 'md' ? '.md' : format === 'txt' ? '.txt' : '.docx'
    const title = String(payload.title ?? payload.name ?? 'Untitled').trim().slice(0, MAX_TITLE_CHARS) || 'Untitled'
    const data =
      format === 'xlsx'
        ? writeSheetFile(createSheetDocument(title), { title })
        : format === 'md'
          ? Buffer.from('# ' + title + '\n\n', 'utf8')
          : format === 'txt'
            ? Buffer.from('', 'utf8')
            : writeDocx({ title, blocks: [{ type: 'paragraph', runs: [{ text: '', marks: [] }] }] }, { title })
    const cwd = await fsp.realpath(path.resolve(await sessionRoot(ctx, sessionId)))
    // A DOCUMENT is written where the person will look for it - the Desktop - and
    // the store keeps the document linked to THAT file, so every later Save writes
    // the file they can open in Word. A workbook is the exception on purpose: its
    // grid lives in the right bar and reads the file through a workspace address.
    const onDesktop = payload.target === 'desktop' && format !== 'xlsx'
    const dir = onDesktop ? await desktopDir() : cwd
    const name = safeName(typeof payload.name === 'string' && payload.name.length > 0 ? payload.name : title, 'document', extension)
    const written = await writeFresh(dir, name, data)
    const base = path.basename(written)
    const stats = await fsp.stat(written)
    const origin = { path: onDesktop ? written : base, mtimeMs: stats.mtimeMs, size: stats.size, importedAt: new Date().toISOString() }
    // The stored document is written by READING BACK what just landed on disk:
    // the tab then shows the file, not a hopeful copy of what it meant to write.
    let created = null
    if (format === 'xlsx') {
      const read = readSheetFile(data)
      created = stores().conversation.write(sessionId, {
        kind: 'sheet',
        title,
        sheets: read.document.sheets,
        by: payload.by,
        note: 'created ' + base,
        origin,
      })
    } else {
      const blocks =
        format === 'docx'
          ? readDocx(data).document.blocks
          : format === 'md'
            ? blocksFromMarkdown('# ' + title + '\n\n')
            : [{ type: 'paragraph', runs: [{ text: '', marks: [] }] }]
      created = stores().conversation.write(sessionId, {
        title,
        blocks,
        page: format === 'docx' ? readDocx(data).document.page : null,
        by: payload.by,
        note: 'created ' + base,
        origin,
      })
    }
    return json(200, {
      ok: true,
      format,
      name: base,
      path: onDesktop ? written : base,
      absolute: written,
      dir,
      bytes: data.byteLength,
      document: documentPayload(stores().conversation.get(sessionId, created.id)),
    })
  } catch (err) {
    return errorResponse(err)
  }
}

/**
 * POST /api/dsh-writing/save-file — write one document back to the file it came
 * from.
 *
 * The file is what the person will open in Word or LibreOffice, so this is the
 * route that must not lose work: the write is atomic (temp file then rename), and
 * the caller echoes the `mtimeMs`/`size` it last saw, so a file that changed
 * underneath the tab answers 409 with the current stat instead of being
 * overwritten. `force` is the deliberate "keep mine".
 */
async function handleSaveFile(ctx, request) {
  try {
    const payload = await request.json().catch(() => null)
    if (!payload) return fail(400, 'BAD_REQUEST', 'Expected a JSON body.')
    const sessionId = typeof payload.session === 'string' ? payload.session : ''
    if (!sessionId) return fail(400, 'BAD_REQUEST', 'A session id is required.')
    const store = stores().conversation
    const entry = store.get(sessionId, String(payload.id ?? ''))
    if (!entry) return fail(404, 'NOT_FOUND', 'No such document in this conversation.')
    const relative = entry.origin && typeof entry.origin.path === 'string' ? entry.origin.path : ''
    if (relative.length === 0) {
      return fail(409, 'NOT_FILE_BACKED', 'This document is not linked to a file; use Export to write one.')
    }
    // A workspace-relative origin or a Desktop one: `originFile` owns that rule.
    const target = await originFile(ctx, sessionId, relative)
    let before = null
    try {
      before = await fsp.stat(target)
    } catch (err) {
      throw httpError(404, 'NOT_FOUND', 'The file is gone from disk.', err)
    }
    if (payload.force !== true && entry.origin && Number.isFinite(entry.origin.mtimeMs)) {
      const expected = payload.expected && Number.isFinite(payload.expected.mtimeMs) ? payload.expected : entry.origin
      const sameMtime = Math.abs(before.mtimeMs - expected.mtimeMs) < 1
      const sameSize = expected.size === undefined || before.size === expected.size
      if (!sameMtime || !sameSize) {
        return json(409, {
          ok: false,
          error: {
            code: 'CHANGED_ON_DISK',
            message: 'The file changed on disk since it was opened.',
            current: { mtimeMs: before.mtimeMs, size: before.size },
          },
        })
      }
    }
    const extension = path.extname(target).toLowerCase()
    const data =
      entry.kind === 'sheet'
        ? writeSheetFile(entry, { title: entry.title })
        : extension === '.md'
          ? Buffer.from(documentMarkdown(entry), 'utf8')
          : extension === '.txt'
            ? Buffer.from(documentText(entry) + '\n', 'utf8')
            : writeDocx(entry, { title: entry.title })
    const tmp = target + '.dsh-writing-' + process.pid + '-' + Date.now() + '.tmp'
    try {
      await fsp.writeFile(tmp, data, { flag: 'wx' })
      await fsp.rename(tmp, target)
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
      throw httpError(500, 'IO_ERROR', 'Could not write the file on disk.', err)
    }
    const after = await fsp.stat(target)
    store.setOrigin(sessionId, entry.id, { path: relative, mtimeMs: after.mtimeMs, size: after.size, importedAt: entry.origin ? entry.origin.importedAt : null })
    return json(200, { ok: true, name: path.basename(target), path: relative, absolute: target, bytes: data.byteLength, mtimeMs: after.mtimeMs, size: after.size })
  } catch (err) {
    return errorResponse(err)
  }
}

/**
 * POST /api/dsh-writing/open-file — the entry point for a FILE address.
 *
 * The right bar hands this plugin the address of a file being opened, and this
 * route answers with the document to edit: an existing document already linked to
 * that path, or a freshly imported one. Importing rather than editing in place is
 * the whole reason a `.docx` opened from Files, and a page created by
 * "New", behave identically from here on.
 */
async function handleOpenFile(ctx, request) {
  try {
    const payload = await request.json().catch(() => null)
    if (!payload) return fail(400, 'BAD_REQUEST', 'Expected a JSON body.')
    const sessionId = typeof payload.session === 'string' ? payload.session : ''
    const relative = typeof payload.path === 'string' ? payload.path : ''
    if (!sessionId || !relative) return fail(400, 'BAD_REQUEST', 'A session id and a path are required.')
    const store = stores().conversation
    const normalized = relative.replaceAll('\\', '/')
    const list = store.list(sessionId).documents
    const existing = list.find((item) => item.origin && item.origin.path === normalized)
    if (existing && payload.reload !== true) {
      return json(200, { ok: true, reused: true, document: documentPayload(store.get(sessionId, existing.id)) })
    }
    // Not linked yet (or a deliberate reload): read the file through the same
    // path the import route uses, and store the result as a linked document. A
    // Desktop path (a document this package created) is resolved by `originFile`.
    const target = await originFile(ctx, sessionId, relative)
    const stats = await fsp.stat(target)
    if (!stats.isFile()) return fail(400, 'NOT_FILE', 'The path is not a regular file.')
    const extension = path.extname(target).toLowerCase()
    if (!['.docx', '.xlsx', '.md', '.markdown', '.txt'].includes(extension)) {
      return fail(415, 'UNSUPPORTED', 'This tab cannot read ' + (extension || 'a file with no extension') + '.' + conversionHint(extension, 'open'))
    }
    if (stats.size > MAX_IMPORT_BYTES) {
      return fail(413, 'TOO_LARGE', 'The file is larger than ' + Math.round(MAX_IMPORT_BYTES / 1024 / 1024) + ' MiB and was not opened.')
    }
    const bytes = await fsp.readFile(target)
    let document = null
    let loss = []
    let kind = 'page'
    if (extension === '.xlsx') {
      const read = readSheetFile(bytes)
      document = read.document
      loss = read.loss
      kind = 'sheet'
    } else if (extension === '.docx') {
      const read = readDocx(bytes)
      document = read.document
      loss = read.loss
    } else if (extension === '.txt') {
      document = { title: path.basename(target, extension), page: null, blocks: blocksFromText(decodeText(bytes)) }
    } else {
      document = { title: path.basename(target, extension), page: null, blocks: blocksFromMarkdown(decodeText(bytes)) }
    }
    const entry = store.write(sessionId, {
      id: existing ? existing.id : typeof payload.id === 'string' ? payload.id : undefined,
      kind,
      title: document.title && document.title !== 'Untitled' ? document.title : path.basename(target, extension),
      page: document.page,
      font: document.font,
      fontSize: document.fontSize,
      sheets: document.sheets,
      blocks: document.blocks,
      by: payload.by,
      note: existing ? 'reloaded from ' + normalized : 'opened ' + normalized,
      origin: { path: normalized, mtimeMs: stats.mtimeMs, size: stats.size, importedAt: new Date().toISOString() },
    })
    return json(200, { ok: true, reused: false, loss, document: documentPayload(store.get(sessionId, entry.id)) })
  } catch (err) {
    if (err && typeof err.code === 'string' && ['NOT_A_ZIP', 'NO_DOCUMENT_PART', 'BAD_XML', 'BAD_ARCHIVE', 'ZIP64', 'BAD_CRC'].includes(err.code)) {
      return fail(415, err.code, err.message)
    }
    return errorResponse(err)
  }
}

/**
 * GET /api/dsh-writing/outline — the headings of one document.
 *
 * The navigator is a separate surface from the editor (it is a right-bar tab as
 * well as a panel), so it reads the outline of a document by id rather than
 * reaching into the editor's state: level, text and the BLOCK INDEX, because the
 * index is what the editor needs to scroll to a heading.
 */
async function handleOutline(ctx, request) {
  try {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('session') || ''
    const id = url.searchParams.get('id') || ''
    if (sessionId.length === 0 || id.length === 0) return fail(400, 'BAD_REQUEST', 'A session id and a document id are required.')
    const entry = stores().conversation.get(sessionId, id)
    if (!entry) return fail(404, 'NOT_FOUND', 'No document "' + id + '" in this conversation.')
    const headings = []
    let words = 0
    if (entry.kind === 'sheet') {
      // A workbook's navigator is its SHEETS: the thing you move between in a
      // spreadsheet is a sheet, and the pane that lists headings lists these for
      // a workbook rather than showing an empty box.
      entry.sheets.forEach((sheet, index) => {
        const text = sheet.rows.reduce((total, row) => total + row.filter((cell) => cell !== null).length, 0)
        words += text
        headings.push({ index, level: 1, text: sheet.name })
      })
    } else {
      entry.blocks.forEach((block, index) => {
        if (block.type !== 'pageBreak') {
          const text = block.runs.map((run) => run.text).join('')
          words += text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length
        }
        if (block.type !== 'heading') return
        headings.push({ index, level: block.level ?? 1, text: block.runs.map((run) => run.text).join('').slice(0, 200) })
      })
    }
    return json(200, {
      ok: true,
      id: entry.id,
      kind: entry.kind === 'sheet' ? 'sheet' : 'page',
      title: entry.title,
      revision: entry.revision,
      origin: entry.origin ?? null,
      blocks: entry.summary.blocks,
      words,
      headings,
    })
  } catch (err) {
    return errorResponse(err)
  }
}

/**
 * GET /api/dsh-writing/fonts — every font family this machine has.
 *
 * The list is the MACHINE's, not a vendored set: the browser runs on the same
 * host as the harness, so a family named here is a family the page can actually
 * paint and the `.docx` can actually name. It is cached for a minute because
 * scanning the system font directories costs real milliseconds, and `refresh=1`
 * exists for the person who just installed a font.
 */
let fontCache = null
async function handleFonts(request) {
  try {
    const url = new URL(request.url)
    const refresh = url.searchParams.get('refresh') === '1'
    const now = Date.now()
    if (!refresh && fontCache && now - fontCache.at < FONT_CACHE_MS) {
      return json(200, { ok: true, cached: true, ...fontCache.body })
    }
    const listed = listFonts({})
    const body = {
      families: listed.families,
      count: listed.families.length,
      parsed: listed.parsed,
      failed: listed.failed,
      skipped: listed.skipped,
      truncated: listed.truncated,
      dirs: listed.dirs,
    }
    fontCache = { at: now, body }
    return json(200, { ok: true, cached: false, ...body })
  } catch (err) {
    return errorResponse(err)
  }
}

/** How long the machine's font list is reused before it is scanned again. */
const FONT_CACHE_MS = 60_000

/** One error's message, whatever was thrown. */
function message(err) {
  return err && err.message ? String(err.message) : String(err)
}

/**
 * A thrown error → its HTTP response.
 *
 * The store and the codecs throw TYPED codes rather than HTTP errors (a store is
 * not only called by a route, and a codec should not know what HTTP is), so the
 * translation lives here, once, in a table. Without it every one of those
 * refusals read as a 500 - asking for a document that is not there answered
 * "internal error", which is both untrue and unactionable, and the route sweep in
 * `check-writing-node.mjs` is what caught it.
 *
 * @param err - the error a handler caught.
 * @returns the JSON response.
 */
function errorResponse(err) {
  const code = (err && err.code) || 'IO_ERROR'
  const table = {
    NOT_FOUND: 404,
    NO_WORKSPACE: 409,
    CHANGED_ON_DISK: 409,
    CONFLICT: 409,
    EXISTS: 409,
    NOT_FILE_BACKED: 409,
    LIMIT: 409,
    BUDGET: 409,
    BAD_ID: 400,
    BAD_KIND: 400,
    BAD_REQUEST: 400,
    BAD_PATCH: 400,
    NO_MATCH: 400,
    AMBIGUOUS: 400,
    NOT_TEXT: 415,
    UNSUPPORTED: 415,
    NOT_A_ZIP: 415,
    NO_DOCUMENT_PART: 415,
    NO_WORKBOOK_PART: 415,
    NO_SHEETS: 415,
    BAD_XML: 415,
    BAD_ARCHIVE: 415,
    BAD_CRC: 415,
    BAD_DEFLATE: 415,
    BAD_METHOD: 415,
    BAD_SIZE: 415,
    BAD_NAME: 415,
    ENCRYPTED: 415,
    ZIP64: 415,
    TOO_LARGE: 413,
  }
  const status = typeof err?.status === 'number' ? err.status : table[code] ?? 500
  const message = (err && err.message) || String(err)
  return fail(status, code, message)
}

/**
 * GET /api/dsh-writing/page.js — the page breaker, to the browser.
 *
 * Read once and re-validated per request with a `stat`, because the file is
 * source that a `git pull` (or an edit) can change under a running harness: the
 * URL is stable and the ETag is a hash of the bytes, so a change costs one
 * 200 and no change costs a 304. A missing file keeps the last good copy.
 */
let pageState = null
async function handlePage(request) {
  try {
    const file = fileURLToPath(new URL('./page.js', import.meta.url))
    const missing = () => httpError(500, 'PAGE_MISSING', 'The page breaker module is missing from this package.')
    let stamp
    try {
      const stats = await fsp.stat(file)
      stamp = String(stats.size) + '@' + String(stats.mtimeMs)
    } catch (err) {
      if (pageState) return jsResponse(pageState, request)
      throw missing()
    }
    if (!pageState || pageState.stamp !== stamp) {
      let bytes
      try {
        bytes = await fsp.readFile(file)
      } catch (err) {
        if (pageState) return jsResponse(pageState, request)
        throw missing()
      }
      const { createHash } = await import('node:crypto')
      pageState = { bytes, stamp, etag: '"' + createHash('sha1').update(bytes).digest('hex') + '"' }
    }
    return jsResponse(pageState, request)
  } catch (err) {
    return errorResponse(err)
  }
}

/** One JavaScript answer, with ETag revalidation and HEAD support. */
function jsResponse(state, request) {
  const headers = { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', etag: state.etag }
  if (request && request.headers && request.headers.get('if-none-match') === state.etag) {
    return new Response(null, { status: 304, headers })
  }
  if (request && request.method === 'HEAD') return new Response(null, { status: 200, headers })
  return new Response(state.bytes, { status: 200, headers })
}

/**
 * The vendored Editor.js files this route serves, in the order the browser loads
 * them, and the global each one leaves behind.
 *
 * The list is HERE rather than only in the client because the route has to answer
 * for exactly these names: an allowlist of six is why a request for anything else
 * is a 404 instead of a file read, and the `global` recorded in VERSION.json is what
 * says which file is the core (the one whose absence is a dead tab rather than a
 * missing tool).
 */
const EDITOR_FILES = ['editorjs.umd.js', 'paragraph.umd.js', 'header.umd.js', 'editorjs-list.umd.js', 'quote.umd.js', 'code.umd.js']

/** The vendored Editor.js record (`lib/vendor/editorjs/VERSION.json`), or null. */
function editorRecord() {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL('./vendor/editorjs/VERSION.json', import.meta.url)), 'utf8'))
  } catch (err) {
    return null
  }
}

/**
 * One vendored Editor.js file, by name.
 *
 * The ETag is the sha256 the record carries, so a rebuild that changes the artifact
 * changes the ETag with no hashing on the request path, and a request for a name
 * outside the allowlist is a typed 404 rather than a path into the package.
 *
 * @param name - the file name from the route.
 * @param request - the GET/HEAD request.
 * @returns the response.
 */
async function handleEditorFile(name, request) {
  try {
    if (!EDITOR_FILES.includes(name)) throw httpError(404, 'NOT_FOUND', 'no such vendored Editor.js file')
    const file = fileURLToPath(new URL('./vendor/editorjs/' + name, import.meta.url))
    if (!existsSync(file)) {
      throw httpError(503, 'VENDOR_MISSING', 'the vendored Editor.js surface is not in this checkout - build it with `node packages/dsh-writing/vendor/editorjs/build.mjs`')
    }
    const info = statSync(file)
    const record = editorRecord()
    const recorded = record && record.files ? record.files[name] : null
    const etag = recorded && typeof recorded.sha256 === 'string'
      ? '"' + recorded.sha256.slice(0, 32) + '"'
      : '"' + String(info.size) + '-' + String(Math.round(info.mtimeMs)) + '"'
    if (request && request.headers && request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } })
    const headers = { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', etag, 'content-length': String(info.size) }
    if (request && request.method === 'HEAD') return new Response(null, { status: 200, headers })
    return new Response(readFileSync(file), { status: 200, headers })
  } catch (err) {
    return errorResponse(err)
  }
}

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
 * Register the bundled skills.
 *
 * A profile without a skill registry still gets them from `$DSH_HOME/skills` (both
 * installers copy the folders there), so this warns rather than failing - and the
 * `path` the registration carries is what makes the entry FILE-BACKED, so the
 * skills browser can show the document the model was given and a person can edit
 * it in place.
 *
 * @param ctx - the cordis context.
 * @param log - `{ warn }`.
 * @returns how many skills were registered.
 */
export function registerSkills(ctx, log) {
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (!skills || typeof skills.register !== 'function') {
    log.warn('skill registry unavailable - the bundled research skill was not registered (the installers copy it into $DSH_HOME/skills anyway)')
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
            provider: 'dsh-writing',
            source: 'bundled',
            path: file,
            resourceBase: { kind: 'directory', path: path.dirname(file) },
          }),
        'dsh-writing: skill ' + skillName,
      )
      count += 1
    } catch (err) {
      log.warn('could not register skill ' + entry.name + ': ' + message(err))
    }
  }
  return count
}

/**
 * Activate the plugin row: the tools, the bundled skill, then the authenticated
 * routes.
 *
 * THE ORDER IS THE POINT. The tools and the skill do not need the connection
 * service, and the route block below returns early without it - so registering
 * them first is what keeps "the agent can write a document" true in a profile whose
 * web carrier is not mounted.
 *
 * @param ctx - cordis context (inject: connection, tools).
 */
export function apply(ctx) {
  const log = {
    warn: (text) => ctx.logger?.warn?.('[dsh-writing] ' + text),
    info: (text) => ctx.logger?.info?.('[dsh-writing] ' + text),
  }

  const skillCount = registerSkills(ctx, log)

  // The registry is resolved DEFENSIVELY for the same reason the connection is
  // below: the tools are registered by this row, and a host whose registry is
  // replaced (or a check driving this half against a stub context) should leave the
  // routes working rather than crash the row.
  const tools = ctx.tools ?? (typeof ctx.get === 'function' ? ctx.get('tools') : undefined)
  let toolCount = 0
  if (tools && typeof tools.register === 'function') {
    for (const tool of buildTools({ stores, log })) {
      ctx.effect(() => tools.register(tool), 'dsh-writing: tool ' + tool.name)
      toolCount += 1
    }
  } else {
    log.warn('tool registry unavailable - the writing tools were not registered')
  }
  log.info('active: ' + toolCount + ' tool(s), ' + skillCount + ' bundled skill(s), store ' + path.join(resolveHome(), 'dsh-writing'))

  const connection = ctx.get ? ctx.get('connection') : undefined
  if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
    log.warn('connection service unavailable - document routes not registered (the tools and the skill above still work)')
    return
  }
  ctx.effect(() => {
    ctx.logger?.debug?.('[dsh-writing] node half active (alpha)')
    // `requestBody: 'buffered'` on every route: Connection's HTTP bridge picks
    // the streaming branch when it is undefined, and building a streaming
    // Request for a bodyless method (GET/HEAD) throws before the handler runs.
    const off = [
      connection.fetch.register({ path: STATE_ROUTE, methods: ['GET', 'HEAD'], requestBody: 'buffered', fetch: (request) => handleState(ctx, request) }),
      connection.fetch.register({ path: DOCUMENT_ROUTE, methods: ['GET', 'HEAD', 'POST'], requestBody: 'buffered', fetch: (request) => handleDocument(ctx, request) }),
      connection.fetch.register({ path: DELETE_ROUTE, methods: ['POST'], requestBody: 'buffered', fetch: (request) => handleDelete(ctx, request) }),
      connection.fetch.register({ path: PUBLISH_ROUTE, methods: ['POST'], requestBody: 'buffered', fetch: (request) => handlePublish(ctx, request) }),
      connection.fetch.register({ path: IMPORT_ROUTE, methods: ['POST'], requestBody: 'buffered', fetch: (request) => handleImport(ctx, request) }),
      connection.fetch.register({ path: EXPORT_ROUTE, methods: ['POST'], requestBody: 'buffered', fetch: (request) => handleExport(ctx, request) }),
      connection.fetch.register({ path: CREATE_FILE_ROUTE, methods: ['POST'], requestBody: 'buffered', fetch: (request) => handleCreateFile(ctx, request) }),
      connection.fetch.register({ path: SAVE_FILE_ROUTE, methods: ['POST'], requestBody: 'buffered', fetch: (request) => handleSaveFile(ctx, request) }),
      connection.fetch.register({ path: OPEN_FILE_ROUTE, methods: ['POST'], requestBody: 'buffered', fetch: (request) => handleOpenFile(ctx, request) }),
      connection.fetch.register({ path: OUTLINE_ROUTE, methods: ['GET', 'HEAD'], requestBody: 'buffered', fetch: (request) => handleOutline(ctx, request) }),
      connection.fetch.register({ path: FONTS_ROUTE, methods: ['GET', 'HEAD'], requestBody: 'buffered', fetch: (request) => handleFonts(request) }),
      connection.fetch.register({ path: PAGE_ROUTE, methods: ['GET', 'HEAD'], requestBody: 'buffered', fetch: (request) => handlePage(request) }),
      // The vendored Editor.js surface: one exact route per file, in the order the
      // browser loads them (the tools need the core global, and the client appends
      // the scripts in this order).
      ...EDITOR_FILES.map((name) =>
        connection.fetch.register({
          path: EDITOR_ROUTE + name,
          methods: ['GET', 'HEAD'],
          requestBody: 'buffered',
          fetch: (request) => handleEditorFile(name, request),
        }),
      ),
    ]
    return () => {
      for (const dispose of off) {
        try {
          dispose()
        } catch (err) {
          /* the row is going away either way */
        }
      }
      ctx.logger?.debug?.('[dsh-writing] node half disposed')
    }
  }, 'dsh-writing: routes')
}

/** The route names and the store, for the checks that drive this half. */
export const __internals = {
  ROUTES: {
    STATE_ROUTE,
    DOCUMENT_ROUTE,
    DELETE_ROUTE,
    PUBLISH_ROUTE,
    IMPORT_ROUTE,
    EXPORT_ROUTE,
    CREATE_FILE_ROUTE,
    SAVE_FILE_ROUTE,
    OPEN_FILE_ROUTE,
    OUTLINE_ROUTE,
    FONTS_ROUTE,
    PAGE_ROUTE,
    EDITOR_ROUTE,
  },
  API_ROOT,
  LIBRARY_KEY,
  EDITOR_FILES,
  EDITOR_FILE_ROUTES: EDITOR_FILES.map((name) => EDITOR_ROUTE + name),
  handleEditorFile,
  stores,
  sessionRoot,
  resolveInside,
  safeName,
  handleState,
  handleDocument,
  handleDelete,
  handlePublish,
  handleImport,
  handleExport,
  buildTools,
  registerSkills,
  SKILL_FILES,
}
