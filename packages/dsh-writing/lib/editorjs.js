/**
 * dsh-writing — the bridge between this pack's document model and Editor.js.
 *
 * The Writing tab edits a `doc` in the shape `lib/model.js` owns
 * (`{ page, font, fontSize, blocks: [{ type, level?, ordered?, align?, runs }] }`)
 * and Editor.js edits its own block list (`{ blocks: [{ type, data }] }`). This
 * module is the one place the two are translated, and it is PURE: no DOM, no
 * fetch, no document. The two things that are not pure are injected as `dom` —
 * the client hands in the HTML builders it already owns, and
 * `check-writing-node.mjs` hands in a stub that returns plain text, which is why
 * the whole translation is driven on the host with no browser.
 *
 * WHAT SURVIVES THE ROUND TRIP, and what is reported instead of being dropped:
 *
 *   paragraph  -> paragraph   text, and the six inline marks through the HTML
 *   heading    -> header      level 1..6
 *   listItem+  -> list        `ordered` from the list style, `level` from nesting
 *   quote      -> quote       the text; a caption is folded in as a second line
 *   code       -> code        the characters, verbatim
 *   pageBreak  -> delimiter   the break is VISIBLE and is counted as a loss,
 *                             because this model is the one with a page in it
 *
 * A block type this model does not know (a tool added later) becomes a paragraph
 * with a counted loss, never a block that vanished: a block that vanishes is text
 * somebody wrote and lost.
 *
 * Run-level font and size are NOT Editor.js's business (its tools carry text), so
 * they are counted as losses when the model holds any - the same honest report the
 * `.docx` importer already gives for content this tab cannot hold.
 */
import { MAX_BLOCKS, mergeLoss, normalizeRuns } from './model.js'

/** The Editor.js block type each model block type maps to, and the reverse. */
export const EDITOR_BLOCK_TYPES = {
  paragraph: 'paragraph',
  heading: 'header',
  listItem: 'list',
  quote: 'quote',
  code: 'code',
  pageBreak: 'delimiter',
}

/** The two HTML adapters a caller hands in: the one thing this module cannot do itself. */
export const EDITOR_DOM_CONTRACT = [
  'html(runs): the model\u2019s runs as the HTML the editor shows',
  'parse(html): that HTML back as the model\u2019s runs',
]

/**
 * A DOM adapter that keeps only the TEXT: the shape `check-writing-node.mjs` and
 * the host use when there is no browser. It proves the block translation without a
 * DOM - the marks are the client's business, and the browser half is driven with
 * its own adapter in `check-client-bundles.mjs`.
 *
 * @returns `{ html, parse }`.
 */
export function plainTextDom() {
  return {
    html: (runs) => normalizeRuns(runs).map((run) => run.text).join(''),
    parse: (html) => {
      // Tags dropped, `<br>` kept as the soft break the model spells `\n`, and the
      // handful of entities an editor produces turned back into characters.
      const text = String(html ?? '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replaceAll('&nbsp;', ' ')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'")
        .replaceAll('&amp;', '&')
      return text.length > 0 ? normalizeRuns([{ text, marks: [] }]) : [{ text: '', marks: [] }]
    },
  }
}

/**
 * The order the browser loads the vendored UMD files in, and the global each one
 * leaves behind. The two names that are not the obvious one are here rather than
 * in the client, so a bump that renames a tool has one place to be corrected:
 * `@editorjs/list` leaves `EditorjsList` and `@editorjs/quote` leaves `Quote`.
 */
export const EDITOR_SCRIPTS = [
  { file: 'editorjs.umd.js', global: 'EditorJS', note: 'the core' },
  { file: 'paragraph.umd.js', global: 'Paragraph', note: 'the default text tool this package replaces with one that carries the pack\u2019s marks' },
  { file: 'header.umd.js', global: 'Header', note: 'headings' },
  { file: 'editorjs-list.umd.js', global: 'EditorjsList', note: 'lists' },
  { file: 'quote.umd.js', global: 'Quote', note: 'quotes' },
  { file: 'code.umd.js', global: 'Code', note: 'code' },
]

/** The list items a run of model blocks becomes: consecutive, same-kind items. */
function listItemsFrom(blocks, start) {
  const ordered = blocks[start].ordered === true
  const items = []
  let index = start
  while (index < blocks.length) {
    const block = blocks[index]
    if (!block || block.type !== 'listItem' || (block.ordered === true) !== ordered) break
    items.push({ level: Number.isFinite(block.level) ? Math.max(0, Math.min(4, Math.round(block.level))) : 0, runs: normalizeRuns(block.runs) })
    index += 1
  }
  return { style: ordered ? 'ordered' : 'unordered', items, next: index }
}

/**
 * Model blocks as Editor.js `data`.
 *
 * @param doc - a document (anything with a `blocks` array).
 * @param dom - `{ html(runs) }`: the model's runs as the HTML the editor shows.
 * @param now - the timestamp put in `data.time`; a check passes a fixed one so
 *   the translation is a pure function of its arguments.
 * @returns `{ time, blocks }`, the shape `new EditorJS({ data })` takes.
 */
export function toEditorData(doc, dom, now = Date.now()) {
  const blocks = doc && Array.isArray(doc.blocks) ? doc.blocks : []
  const out = []
  let index = 0
  while (index < blocks.length && out.length < MAX_BLOCKS) {
    const block = blocks[index]
    if (!block || typeof block !== 'object') {
      index += 1
      continue
    }
    const runs = normalizeRuns(block.runs)
    if (block.type === 'heading') {
      const level = Number.isFinite(block.level) ? Math.max(1, Math.min(6, Math.round(block.level))) : 1
      out.push({ type: 'header', data: { text: dom.html(runs), level } })
      index += 1
      continue
    }
    if (block.type === 'listItem') {
      const group = listItemsFrom(blocks, index)
      // The list tool nests; the model carries a 0-based level. An item at a deeper
      // level becomes the LAST CHILD of the deepest item above it, which is what the
      // tool's own indentation means - and what the reverse reads back. The stack is
      // the chain of open ancestors, so its length after the pop IS the level the
      // item belongs at.
      const roots = []
      const stack = []
      for (const item of group.items) {
        const node = { content: dom.html(item.runs), items: [] }
        stack.length = Math.min(stack.length, item.level)
        const parent = stack.length > 0 ? stack[stack.length - 1] : null
        if (parent) parent.items.push(node)
        else roots.push(node)
        stack.push(node)
      }
      out.push({ type: 'list', data: { style: group.style, items: roots } })
      index = group.next
      continue
    }
    if (block.type === 'quote') {
      out.push({ type: 'quote', data: { text: dom.html(runs), caption: '' } })
      index += 1
      continue
    }
    if (block.type === 'code') {
      out.push({ type: 'code', data: { code: runs.map((run) => run.text).join('') } })
      index += 1
      continue
    }
    if (block.type === 'pageBreak') {
      out.push({ type: 'delimiter', data: {} })
      index += 1
      continue
    }
    out.push({ type: 'paragraph', data: { text: dom.html(runs) } })
    index += 1
  }
  return { time: now, blocks: out }
}

/** Flatten the list tool's nested items into the model's 0-based levels. */
function listItemsFromData(items, level, ordered, out, dom) {
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue
    const content = typeof item.content === 'string' ? item.content : ''
    out.push({ type: 'listItem', ordered, level, runs: dom.parse(content) })
    listItemsFromData(item.items, Math.min(4, level + 1), ordered, out, dom)
  }
  return out
}

/**
 * Editor.js `data` as model blocks.
 *
 * @param data - `{ blocks }` from `editor.saver.save()`.
 * @param dom - `{ parse(html) }`: HTML back to the model's runs.
 * @returns `{ blocks, losses }` - the blocks, and the counted losses only a
 *   SAVE can know: a page break the model holds (which the host's importer
 *   never reports) and a block type no tool of this surface can edit.
 */
export function fromEditorData(data, dom) {
  const source = Array.isArray(data && data.blocks) ? data.blocks : []
  const blocks = []
  const losses = []
  let unknown = 0
  const KNOWN = new Set(['paragraph', 'header', 'list', 'quote', 'code', 'delimiter'])
  for (const raw of source) {
    if (!raw || typeof raw !== 'object' || blocks.length >= MAX_BLOCKS) continue
    const type = String(raw.type ?? '')
    const body = raw.data && typeof raw.data === 'object' ? raw.data : {}
    if (!KNOWN.has(type)) unknown += 1
    if (type === 'header') {
      const level = Number.isFinite(Number(body.level)) ? Math.max(1, Math.min(6, Math.round(Number(body.level)))) : 2
      blocks.push({ type: 'heading', level, runs: dom.parse(String(body.text ?? '')) })
      continue
    }
    if (type === 'list') {
      const ordered = body.style === 'ordered'
      for (const item of listItemsFromData(body.items, 0, ordered, [], dom)) {
        blocks.push({ type: 'listItem', ordered: item.ordered, level: item.level, runs: item.runs })
      }
      continue
    }
    if (type === 'quote') {
      const text = String(body.text ?? '')
      const caption = String(body.caption ?? '')
      // The model has no caption field: it is a second line, which is honest
      // (the text is preserved) and is NOT counted as a loss.
      blocks.push({ type: 'quote', runs: dom.parse(caption.length > 0 ? text + '<br>' + caption : text) })
      continue
    }
    if (type === 'code') {
      blocks.push({ type: 'code', runs: normalizeRuns([{ text: String(body.code ?? ''), marks: [] }]) })
      continue
    }
    if (type === 'delimiter') {
      // The editor's separator IS the model's page break, so a document that came
      // from a `.docx` with one keeps it - and the tab says it cannot draw a page.
      blocks.push({ type: 'pageBreak', runs: [{ text: '', marks: [] }] })
      losses.push({ kind: 'page break', count: 1, note: 'the editor shows it as a separator, not as a new page' })
      continue
    }
    // `paragraph`, and EVERY type this module does not know: the text is kept.
    // A tool the vendored surface does not have yet (a table, an image) must not
    // be a block that disappears.
    const text = typeof body.text === 'string' ? body.text : typeof body.code === 'string' ? body.code : ''
    blocks.push({ type: 'paragraph', runs: dom.parse(text) })
  }
  if (unknown > 0) {
    losses.push({ kind: 'block type the editor does not have', count: unknown, note: 'kept as a paragraph, with its text' })
  }
  return { blocks, losses: mergeLoss(losses) }
}

/**
 * The per-run typography this surface cannot carry, as counted losses.
 *
 * Editor.js's tools hold text; they have nowhere to put a run's own family or
 * size. The document's own font and size ARE applied (they are the editor's
 * typography), so this reports only the runs that name one of their own - the
 * same shape the `.docx` importer reports, so the tab keeps ONE banner.
 *
 * @param blocks - the model blocks, after a save.
 * @returns the loss entries, or an empty array.
 */
export function runTypographyLosses(blocks) {
  const list = Array.isArray(blocks) ? blocks : []
  let formatted = 0
  for (const block of list) {
    for (const run of normalizeRuns(block && block.runs)) {
      if ((typeof run.font === 'string' && run.font.length > 0) || Number.isFinite(run.size)) formatted += 1
    }
  }
  if (formatted === 0) return []
  return mergeLoss([
    {
      kind: 'run font or size',
      count: formatted,
      note: 'the editor carries text, not per-run typography; the document font and size are what every run gets',
    },
  ])
}
