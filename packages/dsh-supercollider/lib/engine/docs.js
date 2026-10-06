/**
 * dsh-supercollider — the local `.schelp` documentation, indexed.
 *
 * SuperCollider ships its own reference as `.schelp` files: 1146 of them plus a
 * handful of html and md in the 3.14.1 tree measured while writing this. They
 * are the only authority on what a class does, and an agent that guesses at
 * SuperCollider from general knowledge gets `SinOsc` wrong in ways that compile
 * and sound wrong. So this is the search.
 *
 * The algorithm is a port, on purpose and in detail — see `legacy/rust-server/src/sc_docs.rs`
 * and `legacy/mcp_py/sc_docs.py`. It is a weighted substring sum with no IDF and
 * no length normalisation:
 *
 *     per query token:   content +4   title +6   source path +3
 *                        section +2   cross-reference +5
 *     per chunk:         +2 when the section name contains "example"
 *                        +1 when the section is exactly "list"
 *
 * Chunks are `\n\n`-separated groups up to 900 characters (1200 for an examples
 * section), a chunk shorter than 40 characters is dropped (20 in an examples
 * section), and equal scores keep their order — the files are walked sorted, so
 * a tie is deterministic.
 *
 * Keeping the formula is the point: it is derived from how the help files are
 * actually written (a class's own page scores on its title, a `LIST::` section
 * scores on its cross-references), and a "better" ranker would have to be
 * re-tuned against the corpus. What is NOT kept is the per-file read strategy:
 * the Rust build reads every file synchronously into one index at boot. Here the
 * index is built on first use and cached, because a tool call that never asks
 * about docs should not pay for 1146 file reads.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { resolveHelpRoot } from './install.js'
import { readText } from './log.js'

/** The extensions that are part of the help tree. */
export const DOC_EXTENSIONS = new Set(['schelp', 'html', 'htm', 'md', 'txt'])

/** The synonym table. An exact query token match adds the listed tokens. */
export const QUERY_SYNONYMS = [
  ['guitar', ['pluck', 'dwgpluck', 'karplus', 'string', 'physical', 'model']],
  ['synthesizer', ['synthdef', 'ugen', 'synth']],
  ['synthesiser', ['synthdef', 'ugen', 'synth']],
  ['envelope', ['env', 'envgen', 'doneaction']],
  ['sample', ['playbuf', 'bufnum', 'buffer']],
  ['midi', ['midiin', 'noteon', 'midifunc']],
  ['sequencer', ['pattern', 'pevent', 'pbind']],
  ['drum', ['perc', 'trig', 'impulse', 'decay2']],
]

/** How many results a search returns when the caller says nothing. */
export const DEFAULT_MAX_RESULTS = 5
/** The ceiling on results, whatever a caller asks for. */
export const MAX_RESULTS = 12
/** A search excerpt's length. */
export const SEARCH_EXCERPT = 420
/** An answer excerpt's length. */
export const ANSWER_EXCERPT = 260
/** The maximum characters in one chunk, and the larger budget examples get. */
const MAX_CHARS = 900
const MAX_CHARS_EXAMPLES = 1200

/** Collapse every run of whitespace to one space and trim. */
export function normalizeWs(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** Remove every `<…>` tag. Enough for a help html file and nothing more. */
export function stripHtmlTags(text) {
  return String(text ?? '').replace(/<[^>]+>/g, '')
}

/** The file name without its extension. */
export function titleFromPath(file) {
  const base = path.basename(String(file ?? ''))
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? base || 'untitled' : base.slice(0, dot)
}

/** Whether a path is part of the help tree. */
export function isDocFile(file) {
  const extension = path.extname(String(file ?? '')).slice(1).toLowerCase()
  return DOC_EXTENSIONS.has(extension)
}

/** Whether a path is a `.schelp` file. */
export function isSchelp(file) {
  return path.extname(String(file ?? '')).slice(1).toLowerCase() === 'schelp'
}

/**
 * One `.schelp` header line: `key:: rest`, where the key is a bare identifier.
 *
 * @param line - the line.
 * @returns `{ key, rest }` or null.
 */
export function parseSchelpHeaderLine(line) {
  const trimmed = String(line ?? '').replace(/^\s+/, '')
  const index = trimmed.indexOf('::')
  if (index < 0) return null
  const key = trimmed.slice(0, index).trim()
  if (key === '') return null
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null
  return { key: key.toLowerCase(), rest: trimmed.slice(index + 2).replace(/^\s+/, '') }
}

/**
 * Split a `.schelp` body into `(section, body)` pairs, preserving code blocks.
 *
 * The first section is `preamble` and is dropped when it is empty, which is the
 * normal case: a help file starts with `class::` or `title::`.
 *
 * @param raw - the file's text.
 * @returns an array of `{ key, body }`.
 */
export function splitSchelpSections(raw) {
  const sections = []
  let currentKey = 'preamble'
  let currentBody = ''
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const header = parseSchelpHeaderLine(line)
    if (header !== null) {
      if (!(currentBody.trim() === '' && currentKey === 'preamble')) {
        sections.push({ key: currentKey, body: currentBody })
      }
      currentKey = header.key
      currentBody = header.rest === '' ? '' : header.rest + '\n'
      continue
    }
    currentBody += line + '\n'
  }
  sections.push({ key: currentKey, body: currentBody })
  return sections
}

/**
 * Add the tokens a `link::` target contributes: every path segment and the stem.
 *
 * @param target - the `link::…::` body.
 * @param into - the accumulating Set.
 */
export function collectLinkTokens(target, into) {
  const trimmed = String(target ?? '').trim()
  if (trimmed === '') return
  for (const part of trimmed.split(/[/\\]/)) {
    const token = part.trim().toLowerCase()
    if (token.length >= 2) into.add(token)
  }
  const stem = trimmed.split(/[/\\]/).pop()?.trim() ?? ''
  if (stem.length >= 2) into.add(stem.toLowerCase())
}

/**
 * Every lowercase cross-reference token in a `.schelp` body: the `link::…::`
 * paths and the comma-separated `related::` line below them.
 *
 * @param raw - the body.
 * @returns a space-joined sorted token string.
 */
export function collectSchelpCrossRefTokens(raw) {
  const acc = new Set()
  let rest = String(raw ?? '')
  for (;;) {
    const start = rest.indexOf('link::')
    if (start < 0) break
    rest = rest.slice(start + 6)
    const end = rest.indexOf('::')
    if (end < 0) break
    collectLinkTokens(rest.slice(0, end), acc)
    rest = rest.slice(end + 2)
  }
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const trimmed = line.replace(/^\s+/, '')
    if (!trimmed.startsWith('related::')) continue
    for (const part of trimmed.slice('related::'.length).split(',')) {
      collectLinkTokens(part.trim().replace(/\.schelp$/, ''), acc)
    }
  }
  return [...acc].sort().join(' ')
}

/** Turn `link::Classes/SinOsc::` into `SinOsc`. */
export function expandHelpLinksInline(line) {
  let out = ''
  let rest = String(line ?? '')
  for (;;) {
    const start = rest.indexOf('link::')
    if (start < 0) {
      out += rest
      return out
    }
    out += rest.slice(0, start)
    rest = rest.slice(start + 6)
    const end = rest.indexOf('::')
    if (end < 0) {
      out += 'link::' + rest
      return out
    }
    const target = rest.slice(0, end).trim()
    rest = rest.slice(end + 2)
    const stem = target.split(/[/\\]/).pop()?.trim() ?? ''
    if (stem !== '') out += stem + ' '
    else if (target !== '') out += target + ' '
  }
}

/** In a `LIST::` section, an item starts with `##`. */
export function stripSchelpListItemPrefix(line) {
  const trimmed = String(line ?? '').replace(/^\s+/, '')
  return trimmed.startsWith('##') ? trimmed.slice(2).replace(/^\s+/, '') : line
}

/** Replace every inline `code::x::` with `x`. */
export function stripInlineCodeMarkers(text) {
  let value = String(text ?? '')
  for (;;) {
    const start = value.indexOf('code::')
    if (start < 0) return value
    const afterStart = start + 6
    const end = value.indexOf('::', afterStart)
    if (end < 0) return value
    const inner = value.slice(afterStart, end).trim()
    value = value.slice(0, start) + inner + value.slice(end + 2)
  }
}

/**
 * Flatten a `.schelp` body to indexable prose: code blocks kept verbatim,
 * `##` list markers dropped, help links replaced by their stem, inline code
 * unwrapped, then whitespace collapsed.
 *
 * @param text - the body.
 * @returns the indexable text.
 */
export function stripSchelpMarkupForIndex(text) {
  let out = ''
  let inCode = false
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === 'code::') {
      inCode = true
      out += '\n'
      continue
    }
    if (inCode && trimmed === '::') {
      inCode = false
      out += '\n'
      continue
    }
    if (inCode) {
      out += line + '\n'
      continue
    }
    const prose = stripSchelpListItemPrefix(line)
    out += stripInlineCodeMarkers(expandHelpLinksInline(prose)) + '\n'
  }
  return normalizeWs(out)
}

/** The smallest body worth a chunk, by section. */
export function minChunkLength(section) {
  const lower = String(section ?? '').toLowerCase()
  return lower === 'examples' || lower.includes('example') ? 20 : 40
}

/** The character budget for one chunk, by section. */
export function maxChunkChars(section) {
  const lower = String(section ?? '').toLowerCase()
  return lower === 'examples' || lower.includes('example') ? MAX_CHARS_EXAMPLES : MAX_CHARS
}

/**
 * Split normalized text into chunks of at most `maxChars`, on paragraph
 * boundaries, never splitting a paragraph itself.
 *
 * @param text - the normalized text.
 * @param maxChars - the budget.
 * @returns an array of chunk strings.
 */
export function splitSections(text, maxChars) {
  const sections = []
  let current = ''
  for (const paragraph of String(text ?? '').split('\n\n')) {
    const trimmed = paragraph.trim()
    if (trimmed === '') continue
    if (current.length + trimmed.length + 2 > maxChars && current !== '') {
      sections.push(current.trim())
      current = ''
    }
    current += (current === '' ? '' : '\n\n') + trimmed
  }
  if (current.trim() !== '') sections.push(current.trim())
  return sections
}

/**
 * Push one section's chunks onto the list.
 *
 * @param chunks - the accumulating array.
 * @param entry - `{ sourcePath, title, section, text, crossRefLower }`.
 */
export function pushChunks(chunks, entry) {
  const text = normalizeWs(entry.text)
  const minimum = minChunkLength(entry.section)
  if (text.length < minimum) return
  for (const piece of splitSections(text, maxChunkChars(entry.section))) {
    if (piece.length < minimum) continue
    chunks.push({
      sourcePath: entry.sourcePath,
      title: entry.title,
      section: entry.section,
      content: piece,
      contentLower: piece.toLowerCase(),
      crossRefLower: entry.crossRefLower ?? '',
    })
  }
}

/**
 * Index one file's text into chunks.
 *
 * @param file - the absolute path, used only for the title and extension.
 * @param relative - the path shown to the reader, and the one the ranker scores
 *   on. It is caller-supplied on purpose, so a test can pin a path shape.
 * @param raw - the file's text.
 * @param chunks - the accumulating array.
 */
export function indexFileText(file, relative, raw, chunks) {
  const title = titleFromPath(file)
  if (isSchelp(file)) {
    // The cross-reference tokens are collected from the WHOLE file and carried
    // onto every section's chunks: a `related::` line below `Examples::` is how
    // a class says what to read next, and it belongs to the class, not to the
    // section it happens to sit under.
    const cross = collectSchelpCrossRefTokens(raw)
    for (const section of splitSchelpSections(raw)) {
      const clean = stripSchelpMarkupForIndex(section.body)
      pushChunks(chunks, {
        sourcePath: relative,
        title,
        section: section.key,
        text: clean,
        crossRefLower: cross,
      })
    }
    return
  }
  const extension = path.extname(file).slice(1).toLowerCase()
  const text = extension === 'html' || extension === 'htm' ? stripHtmlTags(raw) : raw
  const normalized = normalizeWs(text)
  if (normalized.length < 40) return
  pushChunks(chunks, { sourcePath: relative, title, section: 'body', text: normalized, crossRefLower: '' })
}

/** Every indexable file under a root, sorted so a tie is deterministic. */
export async function walkDocs(root) {
  const found = []
  const walk = async (dir) => {
    let entries = []
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch (err) {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (entry.isFile() && isDocFile(full)) found.push(full)
    }
  }
  await walk(root)
  found.sort()
  return found
}

/**
 * The tokens a query becomes: lowercase, split on anything that is not a letter,
 * a digit or `_`, keep length ≥ 2, then expand the synonyms, then sort.
 *
 * The sort is not cosmetic: it makes the token order independent of the query,
 * so two phrasings that mean the same thing score identically.
 *
 * @param query - the query text.
 * @returns an array of tokens.
 */
export function tokenize(query) {
  const tokens = new Set()
  for (const raw of String(query ?? '').toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    const token = raw.trim()
    if (token.length >= 2) tokens.add(token)
  }
  for (const [key, extras] of QUERY_SYNONYMS) {
    if (!tokens.has(key)) continue
    for (const extra of extras) tokens.add(extra)
  }
  return [...tokens].sort()
}

/** The display note naming which synonyms a query triggered. */
export function synonymNote(query) {
  const lowered = String(query ?? '').toLowerCase()
  const parts = []
  for (const [key, extras] of QUERY_SYNONYMS) {
    if (lowered.includes(key)) parts.push(key + '→' + extras.join(','))
  }
  return parts.length === 0 ? 'none' : parts.join('; ')
}

/**
 * Score one chunk against the query tokens.
 *
 * @param queryTokens - from `tokenize`.
 * @param chunk - one indexed chunk.
 * @returns the score.
 */
export function scoreChunk(queryTokens, chunk) {
  let score = 0
  const sectionLower = String(chunk.section ?? '').toLowerCase()
  for (const token of queryTokens) {
    if (chunk.contentLower.includes(token)) score += 4
    if (chunk.title.toLowerCase().includes(token)) score += 6
    if (chunk.sourcePath.toLowerCase().includes(token)) score += 3
    if (sectionLower.includes(token)) score += 2
    if (chunk.crossRefLower !== '' && chunk.crossRefLower.includes(token)) score += 5
  }
  if (sectionLower.includes('example')) score += 2
  if (sectionLower === 'list') score += 1
  return score
}

/** Clip text to `max` characters, marking the cut. */
export function clip(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : value.slice(0, max) + ' ...'
}

/**
 * The documentation index, built once per process and kept in memory.
 *
 * Nothing is written to disk: the corpus is on disk already and re-reading it is
 * cheaper than keeping a copy that can go stale against a SuperCollider the user
 * just updated.
 */
export class DocsIndex {
  /**
   * @param deps - `{ env, platform, install, log }`.
   */
  constructor(deps = {}) {
    this.env = deps.env ?? process.env
    this.platform = deps.platform ?? process.platform
    this.install = deps.install ?? null
    this.log = deps.log ?? { warn() {}, info() {} }
    /** The built index, or null. */
    this.index = null
    /** A build in flight, so two searches share one build. */
    this.building = null
  }

  /** The help root right now, without building anything. */
  helpRoot() {
    return resolveHelpRoot({ env: this.env, platform: this.platform, install: this.install })
  }

  /** How many indexable files are under the root right now. */
  async countFiles() {
    const { root } = this.helpRoot()
    if (root === null) return 0
    const files = await walkDocs(root)
    return files.length
  }

  /**
   * Build the index if it is absent (or `force`d), and return it.
   *
   * @param options - `{ force }`.
   * @returns `{ ok, index, error }`.
   */
  async ensure(options = {}) {
    if (this.index !== null && options.force !== true) return { ok: true, index: this.index, error: null }
    if (this.building !== null && options.force !== true) return this.building
    const task = this.#build()
    this.building = task
    try {
      return await task
    } finally {
      this.building = null
    }
  }

  /** The actual build. */
  async #build() {
    const { root, candidates } = this.helpRoot()
    if (root === null) {
      return {
        ok: false,
        index: null,
        error:
          'no SuperCollider help tree was found. Looked for Help/HelpSource under: ' +
          candidates.slice(0, 6).join(', ') +
          (candidates.length > 6 ? ' …' : ''),
      }
    }
    const started = Date.now()
    const files = await walkDocs(root)
    const chunks = []
    for (const file of files) {
      const read = await readText(file)
      if (!read.ok) continue
      const relative = path.relative(root, file) || path.basename(file)
      indexFileText(file, relative, read.text, chunks)
    }
    this.index = {
      root,
      filesIndexed: files.length,
      chunks,
      builtAt: new Date().toISOString(),
      buildMs: Date.now() - started,
    }
    this.log.info('docs index built: ' + files.length + ' files, ' + chunks.length + ' chunks in ' + this.index.buildMs + ' ms')
    return { ok: true, index: this.index, error: null }
  }

  /** Throw away the index, so the next search rebuilds it. */
  invalidate() {
    this.index = null
  }

  /**
   * Search the index.
   *
   * @param options - `{ query, maxResults }`.
   * @returns `{ ok, error, query, tokens, synonymNote, index, results }` where a
   *   result is `{ rank, score, title, section, sourcePath, excerpt }`.
   */
  async search(options) {
    const query = String(options.query ?? '')
    const built = await this.ensure()
    if (!built.ok) return { ok: false, error: built.error, query, tokens: [], synonymNote: 'none', index: null, results: [] }
    const tokens = tokenize(query)
    const scored = []
    for (const [index, chunk] of built.index.chunks.entries()) {
      const score = scoreChunk(tokens, chunk)
      if (score > 0) scored.push({ score, index, chunk })
    }
    scored.sort((a, b) => (b.score - a.score) || (a.index - b.index))
    const limit = Math.max(1, Math.min(MAX_RESULTS, Math.floor(Number.isFinite(options.maxResults) ? options.maxResults : DEFAULT_MAX_RESULTS)))
    const results = scored.slice(0, limit).map((entry, position) => ({
      rank: position + 1,
      score: entry.score,
      title: entry.chunk.title,
      section: entry.chunk.section,
      sourcePath: entry.chunk.sourcePath,
      excerpt: clip(entry.chunk.content, SEARCH_EXCERPT),
    }))
    return {
      ok: true,
      error: null,
      query,
      tokens,
      synonymNote: synonymNote(query),
      index: { root: built.index.root, filesIndexed: built.index.filesIndexed, chunks: built.index.chunks.length, builtAt: built.index.builtAt },
      results,
    }
  }

  /**
   * The top evidence for a natural-language question.
   *
   * Deliberately not an answer generator: it returns three sections and the
   * caller is told they are ground truth. A model synthesises; this quotes.
   *
   * @param options - `{ question, count }`.
   * @returns as `search`, with `results` clipped for evidence.
   */
  async answer(options) {
    const searched = await this.search({ query: options.question, maxResults: options.count ?? 3 })
    if (!searched.ok) return searched
    return {
      ...searched,
      results: searched.results.map((entry) => ({ ...entry, excerpt: clip(entry.excerpt, ANSWER_EXCERPT) })),
    }
  }
}

/**
 * The index status, without building anything.
 *
 * @param index - a `DocsIndex`.
 * @returns the report.
 */
export async function docsIndexStatus(index) {
  const { root, candidates } = index.helpRoot()
  const onDisk = root === null ? 0 : (await walkDocs(root)).length
  const built = index.index
  return {
    root,
    candidates,
    filesOnDisk: onDisk,
    loaded: built !== null,
    rootOfIndex: built?.root ?? null,
    filesIndexed: built?.filesIndexed ?? 0,
    chunks: built?.chunks.length ?? 0,
    builtAt: built?.builtAt ?? null,
    /** True when the tree moved under the index — an update, or an uninstall. */
    stale: built !== null && root !== built.root,
    synonyms: QUERY_SYNONYMS.length,
  }
}

/**
 * Render a search as the text an agent reads.
 *
 * @param search - the result of `DocsIndex.search`.
 * @returns the report text.
 */
export function formatSearch(search) {
  const lines = []
  lines.push('SuperCollider docs search results for: ' + search.query)
  lines.push('- synonym_hints=' + search.synonymNote)
  if (search.index === null) {
    lines.push('- index: not built')
    return lines.join('\n')
  }
  lines.push(
    '- help_root=' + search.index.root + ' files_indexed=' + search.index.filesIndexed + ' chunks=' + search.index.chunks + ' built_at=' + search.index.builtAt,
  )
  if (search.results.length === 0) {
    lines.push('- No matching docs sections found.')
    lines.push('- Try simpler terms (example: SynthDef, Node, Server, UGen).')
    return lines.join('\n')
  }
  for (const hit of search.results) {
    lines.push('[' + hit.rank + '] score=' + hit.score + ' title=' + hit.title + ' section=' + hit.section + ' source=' + hit.sourcePath)
    lines.push('    ' + hit.excerpt)
  }
  return lines.join('\n')
}

/**
 * Render an answer as the text an agent reads.
 *
 * @param answer - the result of `DocsIndex.answer`.
 * @returns the report text.
 */
export function formatAnswer(answer) {
  const lines = []
  lines.push('Grounded answer from local SuperCollider docs:')
  lines.push('- question=' + answer.query)
  lines.push('- synonym_hints=' + answer.synonymNote)
  if (answer.results.length === 0) {
    lines.push('- No matching docs sections found.')
    lines.push('- Try simpler terms (example: SynthDef, Node, Server, UGen).')
    return lines.join('\n')
  }
  lines.push('Evidence sections:')
  for (const hit of answer.results) {
    lines.push('- [' + hit.rank + '] ' + hit.title + ' [' + hit.section + '] (' + hit.sourcePath + ')')
    lines.push('    ' + hit.excerpt)
  }
  lines.push('')
  lines.push('These excerpts are the local SuperCollider help itself: treat them as the ground truth for this question and prefer them over recollection.')
  return lines.join('\n')
}
