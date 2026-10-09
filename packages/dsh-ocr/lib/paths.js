/**
 * dsh-ocr — which file a call is allowed to read, and why.
 *
 * The same stated policy dsh-media, dsh-pdf and dsh-editor apply, duplicated
 * here because a bundle may not reach into another bundle's files:
 *
 *   - a SESSION-RELATIVE path is resolved inside that conversation's workspace,
 *     and both the workspace and the target go through `realpath`, so a symlink
 *     pointing out of the workspace is refused rather than followed;
 *   - an ABSOLUTE path is read as given (through `realpath`, so the path that
 *     comes back is the real one) - that is the door a chat attachment under
 *     `$DSH_HOME/attachments/v1/files/...` and a screenshot in Downloads come
 *     through, and it is deliberate: "read this scan" is a question about a file
 *     wherever the person happens to keep it;
 *   - either way the target must be a REGULAR file.
 *
 * The workspace lookup is the same two-step one the other rows perform - the
 * live session header first, then session persistence.
 */
import { existsSync, statSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** A refusal a tool can print: a code, and a sentence a reader can act on. */
export class OcrError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'OcrError'
    this.code = code
  }
}

/** The workspace root of one session. */
export async function sessionRoot(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new OcrError('BAD_REQUEST', 'A session id is required.')
  }
  const get = typeof ctx.get === 'function' ? (name) => ctx.get(name) : () => undefined
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
  throw new OcrError('NO_WORKSPACE', 'The workspace folder for this conversation is not available.')
}

/** Whether a path is absolute in either spelling Windows and POSIX accept. */
export function isAbsolutePath(value) {
  return value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[/\\]/.test(value)
}

/** The lower-cased extension of a path ('' for none and for dotfiles). */
export function extensionOf(file) {
  const name = String(file ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * Resolve one requested path to a readable regular file under the policy above.
 *
 * @param ctx - the plugin context, for the workspace lookup.
 * @param request - `{ session, path }`.
 * @returns `{ file, scope, relative, size }`.
 */
export async function resolveTarget(ctx, request) {
  const value = typeof request.path === 'string' ? request.path.trim() : ''
  if (value === '') throw new OcrError('BAD_REQUEST', 'A file path is required.')
  if (value.includes('\u0000')) throw new OcrError('BAD_REQUEST', 'That path is not a path.')
  const normalized = value.replace(/\\/g, '/')
  let target
  let scope
  let rootReal = null
  if (isAbsolutePath(value)) {
    try {
      target = await fsp.realpath(path.resolve(value))
    } catch (err) {
      throw new OcrError('NOT_FOUND', 'No such file: ' + value)
    }
    scope = 'absolute'
  } else {
    const root = await sessionRoot(ctx, request.session)
    try {
      rootReal = await fsp.realpath(path.resolve(root))
    } catch (err) {
      throw new OcrError('NO_WORKSPACE', 'The workspace folder for this conversation is not readable.')
    }
    const candidate = path.resolve(rootReal, ...normalized.split('/').filter((segment) => segment !== '' && segment !== '.'))
    try {
      target = await fsp.realpath(candidate)
    } catch (err) {
      throw new OcrError('NOT_FOUND', 'No such file in this workspace: ' + value)
    }
    const inside = target === rootReal || target.startsWith(rootReal + path.sep)
    if (!inside) throw new OcrError('OUTSIDE_WORKSPACE', 'That path points outside the conversation workspace: ' + value)
    scope = 'workspace'
  }
  let stats
  try {
    stats = await fsp.stat(target)
  } catch (err) {
    throw new OcrError('NOT_FOUND', 'No such file: ' + target)
  }
  if (!stats.isFile()) throw new OcrError('NOT_A_FILE', 'That is not a regular file: ' + target)
  const relative = scope === 'workspace' && rootReal !== null ? target.slice(rootReal.length + 1).replace(/\\/g, '/') : null
  return { file: target, scope, relative, size: stats.size }
}

/** Whether a file exists and is a regular file (no throw, for the tools). */
export function isFile(file) {
  try {
    return existsSync(file) && statSync(file).isFile()
  } catch (err) {
    return false
  }
}
