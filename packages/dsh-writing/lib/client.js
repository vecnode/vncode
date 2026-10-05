/**
 * dsh-writing — browser half.
 *
 * One thing lives here: **the Writing tab**, a `conversation.view` entry with the
 * id `writing` at `order: 30`, which puts it to the right of Canvas (20),
 * Trajectory (10) and Chat (0) - the chat panel's own view ring.
 *
 * WHAT IT IS. A document you write on, editable in the **vendored Editor.js**
 * surface (see `packages/dsh-writing/vendor/editorjs/`). The document model is the
 * host's (`lib/model.js`): a title, a page setup, and a block list of runs carrying
 * the six inline marks a `.docx` holds without a style table - and this tab is the
 * bridge between that model and Editor.js's own block JSON, in both directions, on
 * every save. The tab saves into the plugin's own persistent store - many documents
 * per conversation, the shape `dsh-diagrams` gives a diagram - so nothing here
 * overwrites a file somebody wrote by hand.
 *
 * WHAT IT IS NOT, and this is the design's centre: **it renders nothing with
 * LibreOffice and it wants to.** "Proof" exports the document as a real `.docx`
 * into the conversation folder and hands that address to the SHIPPED office
 * preview, which converts it with the LibreOffice the harness already ships
 * (`@deepseek-ai/libreoffice-kit`, behind `@deepseek-ai/dsh-office-to-pdf`) and
 * paints the PDF. So the page you edit is this tab's, and the page LibreOffice
 * makes of it is core's own - which is exactly the split that keeps this package
 * from becoming a second office renderer.
 *
 * HOW THE EDITING WORKS. Editor.js owns the surface: it draws the blocks, its own
 * block menu inserts a header, a list, a quote or a code block, and its inline
 * toolbar carries bold and italic. The two blocks this pack needs to carry MORE
 * than Editor.js's stock tools do - the paragraph and the header - are this
 * package's own tools below: they render the six inline marks this model has (and
 * the run font and size it can hold), and they read them back into runs on save.
 * What the editor cannot carry is not silently dropped: the tab's banner names it,
 * which is the same report the `.docx` importer already gives.
 *
 * THE PAPER IS GONE, deliberately. Editor.js is a block list, not a paginated
 * surface: there are no page boxes, no margins in millimetres and no sheet numbers,
 * and the page setup in the Document menu is applied as the editor's column width
 * and typography (and written into the `.docx`) rather than drawn. `lib/page.js`
 * still exists and the host still serves it - the block-level splitter is a public
 * part of this package - but this half no longer imports it. See the README's
 * Limits.
 */
/* global window, document, fetch, Blob, URL, console */
window.__ModuleLoader__.load({
  id: 'dsh-writing',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** The version marker shown in the status bar, so a fresh bundle is easy to spot. */
    const PLUGIN_VERSION = '0.1.0-alpha.6'
    /** The conversation view this package adds to the chat panel's ring. */
    const VIEW_ID = 'writing'
    /** Base URL of this plugin's own authenticated routes. */
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
    /** The pane type this package registers in the right bar: a `.docx`, edited. */
    const DOC_TYPE_ID = 'dsh-writing'
    const DOC_KIND = 'writing-doc'
    /** The address the "+" guide opens a blank page under. */
    const PAGE_ADDRESS = 'sidebar://' + DOC_KIND
    /** The second pane type: this document's headings, as a navigator. */
    const OUTLINE_TYPE_ID = 'dsh-writing-outline'
    const OUTLINE_KIND = 'writing-outline'
    const OUTLINE_ADDRESS = 'sidebar://' + OUTLINE_KIND
    /** The third pane type: a workbook, edited as a grid. */
    const SHEET_TYPE_ID = 'dsh-writing-sheet'
    const SHEET_KIND = 'writing-sheet'
    /** How much of the grid is drawn before anybody asks for more, and the caps. */
    const SHEET_VIEW_ROWS = 30
    const SHEET_VIEW_COLUMNS = 26
    const SHEET_MAX_ROWS = 200
    const SHEET_MAX_COLUMNS = 78
    const SHEET_MAX_SHEETS = 12
    /** The extensions this tab edits as PAGES: what its own codec reads. */
    const PAGE_EXTENSIONS = new Set(['docx', 'md', 'markdown', 'txt'])
    /**
     * The document each conversation currently has open, by session id.
     *
     * It exists for the OUTLINE pane, which is a different surface from the
     * editor and has no other way to know which document to show. It is in-memory
     * and per page on purpose: it is a convenience between two tabs, not state
     * anything depends on.
     */
    const ACTIVE_DOCUMENTS = new Map()
    /** The mounted editors that an outline pane may ask to scroll to a heading. */
    const FOCUS_LISTENERS = new Set()
    /** The client service dsh-modal provides; resolved lazily, never required. */
    // (The New-file dialog is this tab's OWN, so no modal service is needed for
    // it: a dialog the page cannot style and cannot close on its own terms is not
    // what a document tab should hand a person.)
    /** The right bar's navigation controller (dsh-rightbar), resolved lazily. */
    const SIDEBAR_SERVICE = 'sidebarRight'
    /** The tab-type registry (dsh-rightbar), whose entries name every registered kind. */
    const TAB_TYPES_SERVICE = 'sidebarRightTabs'
    /** The shipped document preview's registry id; its KIND is read from the registry. */
    const PREVIEW_TYPE_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview'
    /** Address grammar owned by @deepseek-ai/dsh-util-workspace-path. */
    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/session/'
    /** CSS pixels per millimetre at 100% page scale (96 dpi). */
    const PX_PER_MM = 96 / 25.4
    /** Millimetres per CSS pixel: the same number, the other way. */
    const MM_PER_PX = 25.4 / 96
    /**
     * How many characters one line measurement walks before it gives up and
     * estimates the rest. A measurement happens on every keystroke for the block
     * being typed in, so its cost must not grow with the worst paragraph in the
     * document: past this many characters the remaining text becomes ONE estimated
     * line (see `measureLinesFor`), which keeps every character and loses only
     * precision about where the last page break falls.
     */
    const MAX_LINE_SCAN = 2400
    /** The zoom ladder. The column always fills the pane; this scales the TYPE in it. */
    const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2]
    /** How long typing rests before the document saves itself. */
    const AUTOSAVE_MS = 4000
    /**
     * The vendored Editor.js surface this tab edits in: one file per script, in the
     * order the browser must load them (the tools need the core global), and the
     * global each one leaves behind. The two names that are not the obvious one are
     * here on purpose: `@editorjs/list` leaves `EditorjsList` and `@editorjs/quote`
     * leaves `Quote`.
     */
    const EDITOR_SCRIPTS = [
      { file: 'editorjs.umd.js', global: 'EditorJS' },
      { file: 'paragraph.umd.js', global: 'Paragraph' },
      { file: 'header.umd.js', global: 'Header' },
      { file: 'editorjs-list.umd.js', global: 'EditorjsList' },
      { file: 'quote.umd.js', global: 'Quote' },
      { file: 'code.umd.js', global: 'Code' },
    ]
    /** Where those files are served from: one exact route per file. */
    const EDITOR_ROUTE = API_ROOT + '/vendor/editorjs/'
    /** How long one vendored script is given to arrive before the tab says so. */
    const EDITOR_LOAD_MS = 20000
    /** How long typing rests before the model is re-read from the editor. */
    const SYNC_MS = 150
    /** The inline mark attribute this pack's own tools stamp, and their sanitizer allows. */
    const MARK_ATTRIBUTE = 'data-mark'
    /** The inline tools Editor.js's OWN toolbar offers here. */
    const EDITOR_INLINE_TOOLS = ['bold', 'italic']
    /** The block types the vendored editor knows: any other is kept as a paragraph. */
    const EDITOR_KNOWN_TYPES = new Set(['paragraph', 'header', 'list', 'quote', 'code', 'delimiter'])
    /** At most this many blocks: the model's own budget, enforced on this side too. */
    const MAX_BLOCKS = 4000
    /** The inline marks, in toolbar order. */
    const MARK_BUTTONS = [
      ['b', 'B', 'Bold'],
      ['i', 'I', 'Italic'],
      ['u', 'U', 'Underline'],
      ['s', 'S', 'Strikethrough'],
      ['code', '\u2039\u203a', 'Code'],
    ]
    /** The block types the status bar names, with the label each option shows. */
    const BLOCK_CHOICES = [
      ['paragraph', null, 'Body text'],
      ['heading', 1, 'Heading 1'],
      ['heading', 2, 'Heading 2'],
      ['heading', 3, 'Heading 3'],
      ['quote', null, 'Quote'],
      ['code', null, 'Code block'],
    ]
    /** A page break, as a block (the writer emits `<w:br w:type="page"/>`). */
    const PAGE_BREAK_BLOCK = { type: 'pageBreak', runs: [{ text: '', marks: [] }] }

    // -----------------------------------------------------------------------
    // The pure half: runs, marks and HTML. No DOM, no React, no state - which is
    // what lets check-client-bundles drive all of it with hand-built trees.
    // -----------------------------------------------------------------------

    /** Escape one text node for an HTML string. */
    function escapeHtml(text) {
      return String(text ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
    }

    /** The marks an element name adds, if any. */
    function markForTag(tag) {
      switch (String(tag ?? '').toUpperCase()) {
        case 'B':
        case 'STRONG':
          return 'b'
        case 'I':
        case 'EM':
          return 'i'
        case 'U':
          return 'u'
        case 'S':
        case 'STRIKE':
        case 'DEL':
          return 's'
        case 'CODE':
          return 'code'
        default:
          return null
      }
    }

    /** Strip the quotes a browser puts around a family name. */
    function unquoteFamily(value) {
      return String(value ?? '')
        .split(',')[0]
        .trim()
        .replace(/^["']|["']$/g, '')
    }

    /**
     * A CSS font-size as POINTS. A browser reports back the inline value it was
     * given (`14pt`), but a px value is converted rather than dropped: 96 px to
     * the inch and 72 points to the inch, so px * 0.75 is points.
     *
     * @param value - the CSS value.
     * @returns the size in points, or null when it says nothing usable.
     */
    function parseFontSize(value) {
      const match = /^([\d.]+)\s*(pt|px|em|rem|%)?$/i.exec(String(value ?? '').trim())
      if (!match) return null
      const number = Number(match[1])
      if (!Number.isFinite(number) || number <= 0) return null
      const unit = (match[2] ?? 'pt').toLowerCase()
      if (unit === 'px') return Math.round(number * 0.75 * 2) / 2
      if (unit === 'pt') return Math.round(number * 2) / 2
      // An em/rem/% size needs the element's computed style to resolve, and
      // guessing one is worse than saying nothing.
      return null
    }

    /** The inline style one run's family and size produce (`''` when it has none). */
    function runStyle(run) {
      const parts = []
      if (typeof run.font === 'string' && run.font.length > 0) parts.push("font-family:'" + String(run.font).replaceAll("'", '') + "'")
      if (Number.isFinite(run.size)) parts.push('font-size:' + run.size + 'pt')
      return parts.join(';')
    }

    /**
     * The DATA ATTRIBUTES one run's family and size produce.
     *
     * A run's own typography is carried as data as well as paint, and the reason is
     * the same one the marks already ride on `data-mark` for - plus a harder one:
     * **Editor.js's saver SANITIZES what it saves** (`Saver.save()` runs the saved
     * data through the tool's own `sanitize` config, measured in
     * `check-writing-browser.mjs`), and the sanitizer keeps `data-*` attributes that
     * the config names while dropping the `style` attribute entirely. So a size
     * written only as `style="font-size:18pt"` survives the paint and is GONE by the
     * next model read - which is exactly what a run whose size vanished the moment
     * the person stopped typing looked like. The style stays, because it is what the
     * browser draws; the attributes are what the round trip reads.
     *
     * @param run - a run.
     * @returns the attribute text (with a leading space), or `''`.
     */
    function runAttributes(run) {
      const parts = []
      if (typeof run.font === 'string' && run.font.length > 0) parts.push('data-font="' + escapeHtml(run.font) + '"')
      if (Number.isFinite(run.size)) parts.push('data-size="' + run.size + '"')
      return parts.length > 0 ? ' ' + parts.join(' ') : ''
    }

    /** Whether two runs carry the same properties, so their text may merge. */
    function sameRun(left, right) {
      return (
        (left.marks ?? []).join(',') === (right.marks ?? []).join(',') &&
        (left.font ?? '') === (right.font ?? '') &&
        (left.size ?? null) === (right.size ?? null)
      )
    }

    /** Append a run, merging it with the previous one when EVERY property agrees. */
    function pushRun(out, text, marks, font = '', size = null) {
      if (typeof text !== 'string' || text.length === 0) return
      const normalized = MARK_BUTTONS.map((entry) => entry[0]).filter((mark) => marks.includes(mark))
      const family = typeof font === 'string' ? font : ''
      const points = Number.isFinite(size) ? Number(size) : null
      const last = out[out.length - 1]
      if (last && sameRun(last, { marks: normalized, font: family, size: points })) {
        last.text += text
        return
      }
      const run = { text, marks: normalized }
      if (family.length > 0) run.font = family
      if (points !== null) run.size = points
      out.push(run)
    }

    /**
     * A block's runs as this model holds them: empty runs dropped, and neighbouring
     * runs with the SAME marks, family and size merged.
     *
     * The merge is the model's own rule (`lib/model.js` does exactly this on the
     * host) and it is on this side too, because it is what keeps the `.docx`
     * writer's output stable: one `<w:r>` per keystroke would make a 400-word page
     * a hundred kilobytes. The two copies cannot drift where it matters -
     * `check-writing-node.mjs` runs the host's and `check-client-bundles.mjs` runs
     * this one against the same cases.
     *
     * @param runs - the runs to normalize.
     * @returns the runs (never zero: one empty run, so a block always has a shape).
     */
    function normalizeRuns(runs) {
      const list = Array.isArray(runs) ? runs : []
      const out = []
      for (const raw of list) {
        const value = raw && typeof raw.text === 'string' ? raw.text : ''
        if (value.length === 0) continue
        pushRun(out, value, Array.isArray(raw.marks) ? raw.marks : [], typeof raw.font === 'string' ? raw.font : '', raw.size)
      }
      return out.length > 0 ? out : [{ text: '', marks: [] }]
    }

    /**
     * Runs from a DOM-shaped tree: `'text'` or `{ tag, children, font, size }`.
     *
     * The browser hands this the real DOM (through `nodesFromDom`), and a check
     * hands it the same shape by hand - so the ONE piece of logic that decides
     * what a person's typing means is driven in both places.
     *
     * @param nodes - the children, in order.
     * @param inherited - `{ marks, font, size }` the enclosing elements carry.
     * @returns the runs (never fewer than one, possibly empty).
     */
    function runsFromNodes(nodes, inherited = null) {
      const outer = inherited ?? { marks: [], font: '', size: null }
      const out = []
      const walk = (list, properties) => {
        for (const node of Array.isArray(list) ? list : []) {
          if (typeof node === 'string') {
            pushRun(out, node, properties.marks, properties.font, properties.size)
            continue
          }
          if (!node || typeof node !== 'object') continue
          const tag = String(node.tag ?? '').toUpperCase()
          if (tag === 'BR') {
            pushRun(out, '\n', properties.marks, properties.font, properties.size)
            continue
          }
          const mark = markForTag(tag)
          // Marks ACCUMULATE down the tree (bold inside italic is both); a family
          // or a size REPLACES what it inherits, because that is what an inline
          // style means.
          walk(node.children, {
            marks: mark === null ? properties.marks : properties.marks.concat(mark),
            font: typeof node.font === 'string' && node.font.length > 0 ? node.font : properties.font,
            size: Number.isFinite(node.size) ? node.size : properties.size,
          })
        }
      }
      walk(nodes, outer)
      return out.length > 0 ? out : [{ text: '', marks: [] }]
    }

    /** A block's total character count: what a caret offset is measured in. */
    function runsLength(runs) {
      return (Array.isArray(runs) ? runs : []).reduce((total, run) => total + String(run.text ?? '').length, 0)
    }

    /**
     * The marks in force at one character offset - what the toolbar highlights.
     * A caret between two runs reads the run it is at the START of, because that
     * is the run the next character will join.
     *
     * @param runs - the block's runs.
     * @param offset - the caret offset.
     * @returns the marks (an array).
     */
    function marksAt(runs, offset) {
      const list = Array.isArray(runs) ? runs : []
      let cursor = 0
      for (const run of list) {
        const next = cursor + String(run.text ?? '').length
        if (offset >= cursor && offset <= next) return Array.isArray(run.marks) ? [...run.marks] : []
        cursor = next
      }
      const last = list[list.length - 1]
      return last && Array.isArray(last.marks) ? [...last.marks] : []
    }

    /**
     * Add or remove one mark over one character range, as a pure function of the
     * runs.
     *
     * The rule is a TOGGLE over the whole range: if every character in the range
     * already carries the mark it is removed, otherwise it is added to all of
     * them. That is what makes Ctrl+B on a half-bold selection bold the whole
     * thing rather than flipping each half independently.
     *
     * @param runs - the block's runs.
     * @param start - the range's first character.
     * @param end - the range's end (exclusive).
     * @param mark - the mark to toggle.
     * @returns the new runs.
     */
    function applyMarkToRuns(runs, start, end, mark) {
      const out = []
      const from = Math.max(0, Math.min(start, end))
      const to = Math.max(start, end)
      const list = Array.isArray(runs) ? runs : []
      if (to <= from) return list.map((run) => ({ text: run.text, marks: [...(run.marks ?? [])] }))
      let cursor = 0
      let any = false
      let allMarked = true
      for (const run of list) {
        const runStart = cursor
        const runEnd = cursor + String(run.text ?? '').length
        cursor = runEnd
        if (Math.min(to, runEnd) <= Math.max(from, runStart)) continue
        any = true
        if (!(run.marks ?? []).includes(mark)) allMarked = false
      }
      if (!any) return list.map((run) => ({ text: run.text, marks: [...(run.marks ?? [])] }))
      const add = !allMarked
      cursor = 0
      for (const run of list) {
        const text = String(run.text ?? '')
        const marks = run.marks ?? []
        const runStart = cursor
        const runEnd = cursor + text.length
        cursor = runEnd
        const overlapStart = Math.max(from, runStart)
        const overlapEnd = Math.min(to, runEnd)
        if (overlapEnd <= overlapStart) {
          pushRun(out, text, marks)
          continue
        }
        pushRun(out, text.slice(0, overlapStart - runStart), marks)
        pushRun(out, text.slice(overlapStart - runStart, overlapEnd - runStart), add ? marks.concat(mark) : marks.filter((entry) => entry !== mark))
        pushRun(out, text.slice(overlapEnd - runStart), marks)
      }
      return out.length > 0 ? out : [{ text: '', marks: [] }]
    }

    /**
     * Everything the toolbar needs to know about the caret's position: the marks
     * in force and the family and size the next character would take.
     *
     * @param runs - the block's runs.
     * @param offset - the caret offset.
     * @returns `{ marks, font, size }`.
     */
    function propertiesAt(runs, offset) {
      const list = Array.isArray(runs) ? runs : []
      let cursor = 0
      for (const run of list) {
        const next = cursor + String(run.text ?? '').length
        if (offset >= cursor && offset <= next) {
          return { marks: [...(run.marks ?? [])], font: run.font ?? '', size: Number.isFinite(run.size) ? run.size : null }
        }
        cursor = next
      }
      const last = list[list.length - 1] ?? {}
      return { marks: [...(last.marks ?? [])], font: last.font ?? '', size: Number.isFinite(last.size) ? last.size : null }
    }

    /**
     * Set one run property (the font family or the size) over one character range.
     *
     * SET, not toggle - unlike a mark, a family and a size have a value, and
     * "apply the same value again" is idempotent. `null` (or an empty family)
     * CLEARS the property back to the document's default, which is why the two
     * are handled by one function: the difference is only what the caller passes.
     *
     * @param runs - the block's runs.
     * @param start - the range's first character.
     * @param end - the range's end (exclusive).
     * @param key - `'font'` or `'size'`.
     * @param value - the family name, the size in points, or null to clear.
     * @returns the new runs.
     */
    function applyAttributeToRuns(runs, start, end, key, value) {
      const out = []
      const from = Math.max(0, Math.min(start, end))
      const to = Math.max(start, end)
      const list = Array.isArray(runs) ? runs : []
      if (to <= from && list.length === 0) return list
      const wanted = key === 'size' ? (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null) : String(value ?? '').trim()
      let cursor = 0
      for (const run of list) {
        const text = String(run.text ?? '')
        const runStart = cursor
        const runEnd = cursor + text.length
        cursor = runEnd
        const overlapStart = Math.max(from, runStart)
        const overlapEnd = Math.min(to, runEnd)
        const set = (part, marks, font, size) => pushRun(out, part, marks, font, size)
        if (overlapEnd <= overlapStart) {
          set(text, run.marks ?? [], run.font ?? '', Number.isFinite(run.size) ? run.size : null)
          continue
        }
        const font = key === 'font' ? (wanted.length > 0 ? wanted : '') : run.font ?? ''
        const size = key === 'size' ? wanted : Number.isFinite(run.size) ? run.size : null
        set(text.slice(0, overlapStart - runStart), run.marks ?? [], run.font ?? '', Number.isFinite(run.size) ? run.size : null)
        set(text.slice(overlapStart - runStart, overlapEnd - runStart), run.marks ?? [], font, size)
        set(text.slice(overlapEnd - runStart), run.marks ?? [], run.font ?? '', Number.isFinite(run.size) ? run.size : null)
      }
      return out.length > 0 ? out : [{ text: '', marks: [] }]
    }

    /**
     * One block's runs split at a character offset - Enter in the middle of a
     * paragraph.
     * @returns `[left, right]`, each at least an empty run.
     */
    function splitRunsAt(runs, offset) {
      const left = []
      const right = []
      let cursor = 0
      for (const run of Array.isArray(runs) ? runs : []) {
        const text = String(run.text ?? '')
        const end = cursor + text.length
        if (offset >= end) pushRun(left, text, run.marks ?? [])
        else if (offset <= cursor) pushRun(right, text, run.marks ?? [])
        else {
          pushRun(left, text.slice(0, offset - cursor), run.marks ?? [])
          pushRun(right, text.slice(offset - cursor), run.marks ?? [])
        }
        cursor = end
      }
      return [left.length > 0 ? left : [{ text: '', marks: [] }], right.length > 0 ? right : [{ text: '', marks: [] }]]
    }

    /** Two blocks' runs joined - Backspace at the start of a block. */
    function mergeRuns(first, second) {
      const out = []
      for (const run of (Array.isArray(first) ? first : []).concat(Array.isArray(second) ? second : [])) {
        pushRun(out, String(run.text ?? ''), run.marks ?? [], run.font ?? '', Number.isFinite(run.size) ? run.size : null)
      }
      return out.length > 0 ? out : [{ text: '', marks: [] }]
    }

    /**
     * The runs between two character offsets - what ONE PAGE of a block shows.
     *
     * This is why a paragraph can be broken across a page boundary without the
     * model ever holding half a paragraph: the page renders
     * `sliceRuns(block.runs, from, to)`, and an edit inside that fragment is put
     * back with {@link replaceRange} at the same offsets.
     *
     * @param runs - the block's runs.
     * @param from - the first character to keep.
     * @param to - the end (exclusive); `null` means the block's own end.
     * @returns the sliced runs.
     */
    function sliceRuns(runs, from, to) {
      const list = Array.isArray(runs) ? runs : []
      const total = runsLength(list)
      const start = Math.max(0, Math.min(Number(from) || 0, total))
      const end = to === null || to === undefined ? total : Math.max(start, Math.min(Number(to) || 0, total))
      const out = []
      let cursor = 0
      for (const run of list) {
        const text = String(run.text ?? '')
        const runEnd = cursor + text.length
        const a = Math.max(start, cursor)
        const b = Math.min(end, runEnd)
        if (b > a) pushRun(out, text.slice(a - cursor, b - cursor), run.marks ?? [], run.font ?? '', Number.isFinite(run.size) ? run.size : null)
        cursor = runEnd
      }
      return out.length > 0 ? out : [{ text: '', marks: [] }]
    }

    /**
     * One range of a block's runs replaced by new ones - an edit inside a page
     * fragment, put back where it belongs.
     *
     * @param runs - the block's runs.
     * @param from - the range's first character.
     * @param to - the range's end; `null` means the block's own end.
     * @param replacement - the runs that stand in its place.
     * @returns the new runs.
     */
    function replaceRange(runs, from, to, replacement) {
      const total = runsLength(runs)
      const start = Math.max(0, Math.min(Number(from) || 0, total))
      const end = to === null || to === undefined ? total : Math.max(start, Math.min(Number(to) || 0, total))
      return mergeRuns(mergeRuns(sliceRuns(runs, 0, start), replacement), sliceRuns(runs, end, total))
    }

    /** Runs as HTML, with the one break an empty editable needs to take a caret. */
    function runsHtml(runs) {
      const html = (Array.isArray(runs) ? runs : []).map(runHtml).join('')
      return html.length > 0 ? html : '<br>'
    }

    /** Plain text as one unmarked run (what a paste of one line becomes). */
    function runsFromPlainText(text) {
      const value = String(text ?? '')
      return value.length > 0 ? [{ text: value, marks: [] }] : [{ text: '', marks: [] }]
    }

    /** One run as HTML. */
    function runHtml(run) {
      let html = escapeHtml(run.text).replaceAll('\n', '<br>')
      if (html.length === 0) return ''
      const marks = Array.isArray(run.marks) ? run.marks : []
      if (marks.includes('code')) html = '<code>' + html + '</code>'
      if (marks.includes('b')) html = '<strong>' + html + '</strong>'
      if (marks.includes('i')) html = '<em>' + html + '</em>'
      if (marks.includes('u')) html = '<u>' + html + '</u>'
      if (marks.includes('s')) html = '<s>' + html + '</s>'
      // The family and the size are an inline STYLE around the marks, which is
      // also the shape `nodesFromDom` reads back: a span with a style is exactly
      // what the browser leaves behind after the toolbar set one.
      const style = runStyle(run)
      return style.length > 0 ? '<span style="' + escapeHtml(style) + '">' + html + '</span>' : html
    }

    /**
     * One block's inner HTML, for the page AND for the measurer (which renders
     * exactly this string at the page's content width and reads the height).
     */
    function blockHtmlString(block) {
      const inner = (Array.isArray(block && block.runs) ? block.runs : []).map(runHtml).join('')
      // An empty contenteditable collapses to nothing and cannot be clicked
      // into, so an empty block renders one break - which reads back as a soft
      // break, and a block of nothing but breaks is normalized to empty.
      return inner.length > 0 ? inner : '<br>'
    }

    /** A font family as an inline style value, with the quotes CSS needs. */
    function styleFamily(value) {
      return "'" + String(value).replaceAll("'", '').replaceAll('"', '') + "'"
    }

    /**
     * One block's runs as HTML with the marks spelled as an ATTRIBUTE, not as
     * nested elements.
     *
     * This is the shape this package's own Editor.js tools render and read: a
     * sequence of spans, each carrying the marks it has on `data-mark`. Elements
     * would nest (`<s><u><em><strong><code>x</code>...`), and the browser is free
     * to reorder or drop that nesting when a person types inside it - an attribute
     * cannot be reordered, so a mark survives an edit in the middle of a marked
     * word. `runsFromHtmlString` reads both shapes, so a paste and the browser's
     * own bold still come back with their marks.
     *
     * @param runs - the runs.
     * @returns the HTML (never empty: one break, so an editable has a caret in it).
     */
    function markHtml(runs) {
      const list = Array.isArray(runs) ? runs : []
      const html = list
        .map((run) => {
          const text = escapeHtml(run.text).replaceAll('\n', '<br>')
          if (text.length === 0) return ''
          const marks = (Array.isArray(run.marks) ? run.marks : []).filter((mark) => MARK_BUTTONS.some((entry) => entry[0] === mark))
          const style = runStyle(run)
          const data = runAttributes(run)
          const attributes = []
          if (marks.length > 0) attributes.push(MARK_ATTRIBUTE + '="' + escapeHtml(marks.join(' ')) + '"')
          if (data.length > 0) attributes.push(data.trim())
          if (style.length > 0) attributes.push('style="' + escapeHtml(style) + '"')
          // ONE element per run, never a shared one: neighbouring runs have
          // DIFFERENT marks, so wrapping them together would make the reader hand
          // the first run's marks to the second (a `b` run beside a plain one would
          // come back bold), and a browser's own bold would then drift.
          return attributes.length > 0 ? '<span ' + attributes.join(' ') + '>' + text + '</span>' : text
        })
        .join('')
      return html.length > 0 ? html : '<br>'
    }

    /** One opening/closing tag's name, attributes, self-closing flag and direction. */
    function parseTag(text) {
      const selfClosing = /\/\s*>$/.test(text)
      const body = text.slice(1, selfClosing ? text.length - 2 : -1)
      // A CLOSING tag's body starts with `/`, so the name has to be read past it -
      // otherwise `</span>` parses as an empty name and the frame it should close
      // stays open, which would hand its marks to every run after it.
      const closing = body.startsWith('/')
      const name = (/^\s*\/?\s*([A-Za-z][A-Za-z0-9-]*)/.exec(body) ?? [])[1] ?? ''
      const attributes = {}
      const pattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g
      let match = pattern.exec(body)
      while (match !== null) {
        attributes[match[1].toLowerCase()] = match[3] !== undefined ? match[3] : match[4]
        match = pattern.exec(body)
      }
      return { name: name.toUpperCase(), attributes, selfClosing, closing }
    }

    /**
     * The next real `<...>` in a string, or -1.
     *
     * Every tag this reads starts with a letter or a slash right after the bracket,
     * so a `<` that begins plain text (`a < b`) stays text. A paste is untrusted
     * input, and the cost of being wrong here is one character - where the cost of
     * a browser HTML parser would be a second DOM model to keep in step with this
     * one.
     */
    function nextTag(text, from) {
      for (let i = text.indexOf('<', from); i !== -1; i = text.indexOf('<', i + 1)) {
        if (/^<\/?[A-Za-z]/.test(text.slice(i, i + 3)) || text.startsWith('<!--', i)) return i
      }
      return -1
    }

    /**
     * The family and size an inline `style` names, as the run properties this model
     * carries: a family name and a size in POINTS.
     *
     * @param style - the CSS text.
     * @returns `{ font, size }` (`''` and null when it names neither).
     */
    function parseRunStyle(style) {
      const family = /font-family\s*:\s*([^;]+)/i.exec(String(style ?? ''))
      const size = /font-size\s*:\s*([^;]+)/i.exec(String(style ?? ''))
      return {
        font: family ? unquoteFamily(family[1]) : '',
        size: size ? parseFontSize(size[1]) : null,
      }
    }

    /**
     * Runs from an HTML string - what this tab's own tools save, and what a paste
     * lands as.
     *
     * Tolerant by design: an unknown element is transparent (its text is kept), a
     * `<br>` is a soft break inside the run, and the marks come from an element
     * name, a `data-mark` attribute or the inline style the toolbar set. Nothing
     * here can throw on a malformed document, and nothing is dropped.
     *
     * @param html - the HTML.
     * @returns the runs (never zero: one empty run, so a block always has a shape).
     */
    function runsFromHtmlString(html) {
      const out = []
      const source = String(html ?? '')
      const stack = []
      let text = ''
      let index = 0
      const flush = () => {
        if (text.length === 0) return
        const marks = []
        let font = ''
        let size = null
        for (const frame of stack) {
          if (frame.mark !== null && !marks.includes(frame.mark)) marks.push(frame.mark)
          for (const mark of frame.marks) if (!marks.includes(mark)) marks.push(mark)
          if (frame.font.length > 0) font = frame.font
          if (frame.size !== null) size = frame.size
        }
        pushRun(out, text.replaceAll('\u00a0', ' '), marks, font, size)
        text = ''
      }
      while (index < source.length) {
        const at = nextTag(source, index)
        if (at === -1) {
          text += source.slice(index)
          break
        }
        text += source.slice(index, at)
        const close = source.indexOf('>', at + 1)
        if (close === -1) {
          text += source.slice(at)
          break
        }
        const raw = source.slice(at, close + 1)
        index = close + 1
        if (raw.startsWith('<!--')) {
          const end = source.indexOf('-->', at)
          index = end === -1 ? source.length : end + 3
          continue
        }
        const tag = parseTag(raw)
        if (tag.name === '') continue
        if (tag.name === 'BR') {
          text += '\n'
          continue
        }
        if (tag.closing) {
          if (stack.length > 0) {
            flush()
            stack.pop()
          }
          continue
        }
        const style = parseRunStyle(tag.attributes.style ?? '')
        // A run's own family and size are read from the DATA first and the inline
        // style second: the attributes are what survives Editor.js's save-time
        // sanitizer (see `runAttributes`), and the style is what a paste from Word
        // or a browser's own formatting arrives with.
        const declaredSize = Number(tag.attributes['data-size'])
        const declaredFont = tag.attributes['data-font'] ?? ''
        const runStyleHere = {
          font: declaredFont.length > 0 ? declaredFont : style.font,
          size: Number.isFinite(declaredSize) && declaredSize > 0 ? declaredSize : style.size,
        }
        const declared = String(tag.attributes[MARK_ATTRIBUTE] ?? '').toLowerCase().split(/[\s,]+/).filter((mark) => mark.length > 0)
        flush()
        if (!tag.selfClosing) {
          stack.push({ mark: markForTag(tag.name), marks: declared, font: runStyleHere.font, size: runStyleHere.size })
        }
      }
      flush()
      return out.length > 0 ? out : [{ text: '', marks: [] }]
    }

    /**
     * The list items a run of model blocks becomes: consecutive, same-kind items.
     * @param blocks - the model's blocks.
     * @param start - the index the run starts at.
     * @returns `{ style, items, next }`.
     */
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

    /** The list tool's nested items, as the model's 0-based levels. */
    function listItemsFromData(items, level, ordered, out) {
      for (const item of Array.isArray(items) ? items : []) {
        if (!item || typeof item !== 'object') continue
        out.push({ ordered, level, runs: runsFromHtmlString(typeof item.content === 'string' ? item.content : '') })
        listItemsFromData(item.items, Math.min(4, level + 1), ordered, out)
      }
      return out
    }

    // -----------------------------------------------------------------------
    // The bridge to Editor.js: this model in, Editor.js's block JSON out, and
    // back. The host half of the same translation is
    // `packages/dsh-writing/lib/editorjs.js`, and `check-writing-node.mjs` drives
    // that one while `check-client-bundles.mjs` drives these - the browser half is
    // one bundle with no imports, and the host half may not touch a DOM, so the two
    // implementations are kept in step by being driven against the same cases from
    // both sides.
    // -----------------------------------------------------------------------

    /**
     * Model blocks as Editor.js `data`.
     *
     * @param doc - a document.
     * @param now - the timestamp in `data.time`, so a check can pass a fixed one.
     * @returns `{ time, blocks }`, the shape `new EditorJS({ data })` takes.
     */
    function toEditorData(doc, now = Date.now()) {
      const blocks = doc && Array.isArray(doc.blocks) ? doc.blocks : []
      const out = []
      let index = 0
      while (index < blocks.length && out.length < MAX_BLOCKS) {
        const block = blocks[index]
        if (!block || typeof block !== 'object') {
          index += 1
          continue
        }
        if (block.type === 'heading') {
          const level = Number.isFinite(block.level) ? Math.max(1, Math.min(6, Math.round(block.level))) : 1
          out.push({ type: 'header', data: { text: markHtml(normalizeRuns(block.runs)), level } })
          index += 1
          continue
        }
        if (block.type === 'listItem') {
          const group = listItemsFrom(blocks, index)
          // The list tool nests; the model carries a 0-based level. An item at a
          // deeper level becomes the LAST CHILD of the deepest item above it, which
          // is what the tool's own indentation means - and what the reverse reads
          // back. The stack is the chain of open ancestors, so its length after the
          // pop IS the level the item belongs at.
          const roots = []
          const stack = []
          for (const item of group.items) {
            const node = { content: markHtml(item.runs), items: [] }
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
          out.push({ type: 'quote', data: { text: markHtml(normalizeRuns(block.runs)), caption: '' } })
          index += 1
          continue
        }
        if (block.type === 'code') {
          out.push({ type: 'code', data: { code: normalizeRuns(block.runs).map((run) => run.text).join('') } })
          index += 1
          continue
        }
        if (block.type === 'pageBreak') {
          out.push({ type: 'delimiter', data: {} })
          index += 1
          continue
        }
        out.push({ type: 'paragraph', data: { text: markHtml(normalizeRuns(block.runs)) } })
        index += 1
      }
      return { time: now, blocks: out }
    }

    /**
     * Editor.js `data` as model blocks, with the counted losses only a save can
     * know: a page break (the editor shows it as a separator, not as a page) and a
     * block type no vendored tool has.
     *
     * @param data - `{ blocks }` from `editor.saver.save()`.
     * @returns `{ blocks, losses }`.
     */
    function fromEditorData(data) {
      const source = Array.isArray(data && data.blocks) ? data.blocks : []
      const blocks = []
      const losses = []
      let unknown = 0
      for (const raw of source) {
        if (!raw || typeof raw !== 'object' || blocks.length >= MAX_BLOCKS) continue
        const type = String(raw.type ?? '')
        const body = raw.data && typeof raw.data === 'object' ? raw.data : {}
        if (!EDITOR_KNOWN_TYPES.has(type)) unknown += 1
        if (type === 'header') {
          const level = Number.isFinite(Number(body.level)) ? Math.max(1, Math.min(6, Math.round(Number(body.level)))) : 2
          blocks.push({ type: 'heading', level, runs: runsFromHtmlString(String(body.text ?? '')) })
          continue
        }
        if (type === 'list') {
          const ordered = body.style === 'ordered'
          for (const item of listItemsFromData(body.items, 0, ordered, [])) {
            blocks.push({ type: 'listItem', ordered: item.ordered, level: item.level, runs: item.runs })
          }
          continue
        }
        if (type === 'quote') {
          const text = String(body.text ?? '')
          const caption = String(body.caption ?? '')
          // The model has no caption field: a caption is a second line, which
          // preserves the text and is not counted as a loss.
          blocks.push({ type: 'quote', runs: runsFromHtmlString(caption.length > 0 ? text + '<br>' + caption : text) })
          continue
        }
        if (type === 'code') {
          blocks.push({ type: 'code', runs: normalizeRuns([{ text: String(body.code ?? ''), marks: [] }]) })
          continue
        }
        if (type === 'delimiter') {
          blocks.push({ type: 'pageBreak', runs: [{ text: '', marks: [] }] })
          losses.push({ kind: 'page break', count: 1, note: 'the editor shows it as a separator, not as a new page' })
          continue
        }
        const text = typeof body.text === 'string' ? body.text : typeof body.code === 'string' ? body.code : ''
        blocks.push({ type: 'paragraph', runs: runsFromHtmlString(text) })
      }
      if (unknown > 0) {
        losses.push({ kind: 'block type the editor does not have', count: unknown, note: 'kept as a paragraph, with its text' })
      }
      return { blocks, losses }
    }

    /** The class and data attributes one block's element wears. */
    function blockAttributes(block, extra) {
      const attributes = {
        'data-type': block.type,
        className: 'dsw-block' + (block.type === 'listItem' ? ' dsw-list' : ''),
      }
      if (block.type === 'heading') attributes['data-level'] = String(block.level ?? 1)
      if (block.type === 'listItem') {
        attributes['data-ordered'] = block.ordered === true ? 'true' : 'false'
        attributes['data-level'] = String(block.level ?? 0)
      }
      if (block.align) attributes['data-align'] = block.align
      return Object.assign(attributes, extra ?? {})
    }

    /** The toolbar's label for one block's type. */
    function describeBlock(block) {
      if (!block) return 'Body text'
      if (block.type === 'heading') return 'Heading ' + (block.level ?? 1)
      const choice = BLOCK_CHOICES.find((entry) => entry[0] === block.type)
      return choice ? choice[2] : 'Body text'
    }

    /**
     * One block retyped, keeping its text and its alignment. This is the one
     * place a toolbar's block choice becomes a block, so the rule that `level`
     * and `ordered` belong to the types that use them is stated once.
     *
     * @param block - the block to retype.
     * @param type - the new type.
     * @param level - a heading level, or a list level.
     * @param ordered - a list kind.
     * @returns the new block.
     */
    function retypeBlock(block, type, level = null, ordered = null) {
      const next = { type: type === 'pageBreak' ? 'paragraph' : type, runs: block && Array.isArray(block.runs) ? block.runs : [{ text: '', marks: [] }] }
      if (block && block.align) next.align = block.align
      if (next.type === 'heading') next.level = Math.min(6, Math.max(1, Number(level) || (block && block.level) || 1))
      if (next.type === 'listItem') {
        next.ordered = ordered === null ? block && block.ordered === true : ordered === true
        next.level = Math.min(4, Math.max(0, Number(level) || (block && block.level) || 0))
      }
      return next
    }

    /**
     * The degradation when `lib/page.js` cannot be imported: everything on one
     * page, and the tab says so. A wrong page break is a page break somebody
     * moves by hand; a blank surface is a tab that does not work at all.
     */
    function fallbackPaginate({ blocks }) {
      const list = Array.isArray(blocks) ? blocks : []
      let top = 0
      const placed = []
      list.forEach((block, index) => {
        if (block && block.type === 'pageBreak') return
        placed.push({ index, topMm: top, heightMm: 0, overflow: false })
        top += 1
      })
      return { pages: [{ index: 0, blocks: placed }], overflow: 0, content: { widthMm: 0, heightMm: 0, marginsMm: {} }, degraded: true }
    }

    // -----------------------------------------------------------------------
    // The DOM adapters: the only browser-shaped code in the pure half.
    // -----------------------------------------------------------------------

    /** A DOM subtree in the `{ tag, children, font, size }` shape `runsFromNodes` reads. */
    function nodesFromDom(element) {
      const nodes = []
      const children = element && element.childNodes ? Array.from(element.childNodes) : []
      for (const child of children) {
        if (child.nodeType === 3) {
          nodes.push(child.nodeValue ?? '')
          continue
        }
        if (child.nodeType !== 1) continue
        const style = child.style ?? {}
        const node = { tag: child.tagName || child.nodeName || '', children: nodesFromDom(child) }
        // A family or a size the toolbar set arrives here as the inline style the
        // browser kept, which is why this reads the element's OWN style and not
        // its computed one: inheriting from an ancestor is the model's job.
        const family = unquoteFamily(style.fontFamily ?? '')
        if (family.length > 0) node.font = family
        const size = parseFontSize(style.fontSize ?? '')
        if (size !== null) node.size = size
        nodes.push(node)
      }
      return nodes
    }

    /** How many characters one DOM node is worth, with `<br>` counting as one. */
    function charCount(node) {
      if (!node) return 0
      if (node.nodeType === 3) return (node.nodeValue ?? '').length
      if (String(node.tagName || '').toUpperCase() === 'BR') return 1
      let total = 0
      for (const child of node.childNodes ? Array.from(node.childNodes) : []) total += charCount(child)
      return total
    }

    /** A text node's element parent and its index inside it (`<br>` positions). */
    function childIndex(node) {
      const parent = node.parentNode
      if (!parent || !parent.childNodes) return null
      return { node: parent, offset: Array.prototype.indexOf.call(parent.childNodes, node) }
    }

    /**
     * The selection's character offsets inside one block element, or null when
     * the selection is elsewhere. `<br>` counts as one character because the
     * model says a soft break is `\n`, and a caret that disagreed with the model
     * would format the wrong words.
     */
    function caretOffsets(root) {
      try {
        const selection = window.getSelection ? window.getSelection() : null
        if (!selection || selection.rangeCount === 0 || !root) return null
        const range = selection.getRangeAt(0)
        if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
        const start = offsetWithin(root, range.startContainer, range.startOffset)
        const end = offsetWithin(root, range.endContainer, range.endOffset)
        if (start === null || end === null) return null
        return { start, end }
      } catch (err) {
        return null
      }
    }

    /** The character offset of one (container, offset) position inside `root`. */
    function offsetWithin(root, container, offset) {
      let total = 0
      let found = false
      const walk = (node) => {
        for (const child of node.childNodes ? Array.from(node.childNodes) : []) {
          if (found) return
          if (child === container) {
            if (child.nodeType === 3) {
              total += Math.min(Number(offset) || 0, (child.nodeValue ?? '').length)
            } else {
              const kids = child.childNodes ? Array.from(child.childNodes) : []
              for (let index = 0; index < Math.min(Number(offset) || 0, kids.length); index += 1) total += charCount(kids[index])
            }
            found = true
            return
          }
          if (child.nodeType === 3 || String(child.tagName || '').toUpperCase() === 'BR') total += charCount(child)
          else walk(child)
        }
      }
      walk(root)
      return found ? total : null
    }

    /** Put the caret back at a character offset inside one block element. */
    function setCaretOffsets(root, start, end) {
      try {
        if (!root || !window.getSelection || !document.createRange) return
        const selection = window.getSelection()
        const range = document.createRange()
        const first = locateOffset(root, start)
        const last = end === undefined || end === null ? first : locateOffset(root, end)
        if (!first || !last) return
        range.setStart(first.node, first.offset)
        range.setEnd(last.node, last.offset)
        selection.removeAllRanges()
        selection.addRange(range)
      } catch (err) {
        /* a caret we could not restore is a caret the next click fixes */
      }
    }

    /** The (node, offset) a Range should start at for one character offset. */
    function locateOffset(root, target) {
      const wanted = Math.max(0, Number(target) || 0)
      let total = 0
      let result = null
      const walk = (node) => {
        for (const child of node.childNodes ? Array.from(node.childNodes) : []) {
          if (result) return
          if (child.nodeType === 3) {
            const length = (child.nodeValue ?? '').length
            if (wanted <= total + length) {
              result = { node: child, offset: Math.max(0, wanted - total) }
              return
            }
            total += length
            continue
          }
          if (String(child.tagName || '').toUpperCase() === 'BR') {
            if (wanted <= total) {
              result = childIndex(child)
              return
            }
            total += 1
            continue
          }
          walk(child)
        }
      }
      walk(root)
      return result ?? { node: root, offset: root && root.childNodes ? root.childNodes.length : 0 }
    }

    // -----------------------------------------------------------------------
    // Typography on a RANGE of the document
    //
    // A family and a size are RUN properties: they belong to a character range,
    // not to the document (`w:rPr/w:rFonts` and `w:sz` are per run; the document's
    // own pair lives in `w:docDefaults`), and the bar's two controls therefore set
    // them on the SELECTION. The model is the single answer - `propertiesAt` says
    // what a caret carries and `applyAttributeToRuns` is where a range's property is
    // decided, with `check-client-bundles.mjs` driving both algebras with no browser
    // - and the editor is re-rendered from the model, with the caret put back,
    // rather than the DOM being patched behind the model's back.
    // -----------------------------------------------------------------------

    /**
     * Wait until an Editor.js instance has published its API.
     *
     * THE API IS NOT THERE AT CONSTRUCTION. Editor.js 2.31.7's exported class builds
     * the real editor asynchronously and only installs `blocks`/`caret`/`events`/
     * `save`/`render` onto the instance when its own `isReady` promise resolves - so
     * a caller that reaches for `editor.render(...)` straight after `new EditorJS()`
     * gets "editor.render is not a function" and, worse, leaves the previous
     * document on screen while the status bar carries that error. Every call into
     * the instance goes through here.
     *
     * @param editor - the Editor.js instance.
     * @returns the same instance, ready.
     */
    async function editorReady(editor) {
      if (editor && editor.isReady && typeof editor.isReady.then === 'function') await editor.isReady
      return editor
    }

    /**
     * Put a document's blocks into a mounted editor.
     *
     * `editor.blocks.render(data)` is the 2.30+ spelling and the one this pin
     * documents; the instance-level `render(data)` is kept as the fallback because
     * this build copies it too. Both broken call sites (the document-open effect and
     * the run-property write) meet here, so a bump that renames the method again has
     * one place to correct.
     *
     * @param editor - the Editor.js instance.
     * @param data - `{ time, blocks }`.
     * @returns the render's own promise.
     */
    async function renderIntoEditor(editor, data) {
      await editorReady(editor)
      if (editor && editor.blocks && typeof editor.blocks.render === 'function') return editor.blocks.render(data)
      if (editor && typeof editor.render === 'function') return editor.render(data)
      throw new Error('this Editor.js build renders through neither editor.blocks.render nor editor.render')
    }

    /** The editable element of one block of the mounted editor, or null. */
    function blockElementAt(host, index) {
      if (!host || !Number.isFinite(index) || index < 0) return null
      const block = host.querySelectorAll('.ce-block')[index] ?? null
      return block ? block.querySelector('[contenteditable="true"]') : null
    }

    /**
     * The block the caret is in, as the EDITOR addresses it: its wrapper element,
     * its editable, the block id Editor.js stamped on the wrapper (`Block.compose()`
     * sets `wrapper.dataset.id = block.id`) and its index among the rendered blocks.
     *
     * The ID is the point: `blocks.update(id, data)` is Editor.js's own way to change
     * one block, and it is addressed by id rather than by index - so a document whose
     * model indexes and editor indexes differ (one `list` block holds many model list
     * items) cannot make this write to the wrong block.
     *
     * @param host - the editor holder.
     * @returns `{ wrapper, editable, id, index }`, or null.
     */
    function caretTarget(host) {
      const selection = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null
      if (!host || !selection || selection.rangeCount === 0) return null
      const node = selection.getRangeAt(0).startContainer
      if (!node || !host.contains(node)) return null
      const element = node.nodeType === 3 ? node.parentElement : node
      const editable = element && typeof element.closest === 'function' ? element.closest('[contenteditable="true"]') : null
      const wrapper = editable && typeof editable.closest === 'function' ? editable.closest('.ce-block') : null
      if (!editable || !wrapper) return null
      const index = Array.prototype.indexOf.call(host.querySelectorAll('.ce-block'), wrapper)
      const id = wrapper.getAttribute('data-id') || (wrapper.dataset ? wrapper.dataset.id : null)
      if (index < 0 || !id) return null
      return { wrapper, editable, id, index }
    }

    /**
     * The MODEL block index one EDITOR block belongs to, or -1.
     *
     * Editor.js draws ONE `list` block for a RUN of consecutive list items, so the
     * two index spaces diverge as soon as a list is in the document and a caret in
     * the paragraph after it would otherwise be read as the wrong block. A list block
     * answers -1, which is what makes "a size inside a list is refused" a fact rather
     * than a wrong-block write: the list tool addresses its items by its own index,
     * which this model does not carry.
     *
     * @param blocks - the model's blocks.
     * @param editorIndex - the index among the rendered `.ce-block` elements.
     * @returns the model index, or -1 (a list block, or past the end).
     */
    function modelIndexForEditorBlock(blocks, editorIndex) {
      const list = Array.isArray(blocks) ? blocks : []
      let editorAt = -1
      let index = 0
      while (index < list.length) {
        const block = list[index]
        if (!block || typeof block !== 'object') {
          index += 1
          continue
        }
        if (block.type === 'listItem') {
          editorAt += 1
          if (editorAt === editorIndex) return -1
          const ordered = block.ordered === true
          while (index < list.length && list[index].type === 'listItem' && (list[index].ordered === true) === ordered) index += 1
          continue
        }
        editorAt += 1
        if (editorAt === editorIndex) return index
        index += 1
      }
      return -1
    }

    /** The Editor.js data one model block's runs make, for `blocks.update`. */
    function blockUpdateData(block, runs) {
      if (block && block.type === 'heading') {
        const level = Number.isFinite(block.level) ? Math.max(1, Math.min(6, Math.round(block.level))) : 2
        return { text: markHtml(normalizeRuns(runs)), level }
      }
      return { text: markHtml(normalizeRuns(runs)) }
    }

    /**
     * The index of the block the caret is in, read from the DOM - the index the
     * MODEL uses.
     *
     * Editor.js's own `getCurrentBlockIndex()` is the other candidate and it is not
     * enough on its own: it is updated by the events the editor listens for, so a
     * caret placed by a click on a toolbar control, by an arrow key the editor did
     * not see, or by anything programmatic can leave it naming the block the person
     * was in BEFORE - which would set a font on the wrong paragraph. The DOM says
     * where the caret actually is, so the DOM is asked first and the editor's own
     * answer is only the fallback for a caret this cannot see.
     *
     * @param host - the editor holder.
     * @param editor - the Editor.js instance (its index is the fallback).
     * @returns the block index, or -1.
     */
    function caretBlockIndex(host, editor) {
      const selection = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null
      if (host && selection && selection.rangeCount > 0) {
        const node = selection.getRangeAt(0).startContainer
        if (node && host.contains(node)) {
          const element = node.nodeType === 3 ? node.parentElement : node
          const editable = element && typeof element.closest === 'function' ? element.closest('[contenteditable="true"]') : null
          const holder = editable && typeof editable.closest === 'function' ? editable.closest('.ce-block') : null
          if (holder) {
            const index = Array.prototype.indexOf.call(host.querySelectorAll('.ce-block'), holder)
            if (index >= 0) return index
          }
        }
      }
      return editor && editor.blocks && typeof editor.blocks.getCurrentBlockIndex === 'function' ? editor.blocks.getCurrentBlockIndex() : -1
    }

    // -----------------------------------------------------------------------
    // Styles
    // -----------------------------------------------------------------------
    const CSS = `
.dsw-root{position:absolute;inset:0;display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:13px/1.45 var(--dsw-font-family,inherit)}
.dsw-bar{flex:none;display:flex;align-items:center;gap:6px;padding:5px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3);min-height:38px;flex-wrap:wrap;row-gap:4px}
.dsw-group{display:flex;align-items:center;gap:3px;flex:none}
.dsw-sep{width:1px;height:18px;background:var(--dsw-alias-border-l3);margin:0 2px;flex:none}
.dsw-btn{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;box-sizing:border-box;padding:0 6px;border:.5px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.dsw-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsw-btn[data-active=true]{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-border-l3)}
.dsw-btn:disabled{opacity:.4;cursor:default}
.dsw-btn[data-emphasis=primary]{background:var(--dsw-alias-state-accent,#4f8cff);color:#fff;padding:0 10px;font-weight:500}
.dsw-bold{font-weight:700}
.dsw-italic{font-style:italic}
.dsw-under{text-decoration:underline}
.dsw-strike{text-decoration:line-through}
.dsw-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dsw-select{height:24px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 4px;outline:none;max-width:132px}
.dsw-title{flex:1 1 150px;min-width:120px;height:24px;box-sizing:border-box;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-weight:500;padding:0 6px;outline:none}
.dsw-title:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsw-title:focus{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1)}
.dsw-alignGlyph{display:inline-flex;flex-direction:column;justify-content:center;gap:2px;width:13px;height:13px}
.dsw-alignGlyph i{display:block;height:1.5px;background:currentColor;border-radius:1px}
.dsw-alignGlyph[data-mode=left] i:nth-child(1){width:100%}
.dsw-alignGlyph[data-mode=left] i:nth-child(2){width:66%}
.dsw-alignGlyph[data-mode=left] i:nth-child(3){width:86%}
.dsw-alignGlyph[data-mode=center] i:nth-child(1){width:100%}
.dsw-alignGlyph[data-mode=center] i:nth-child(2){width:64%;margin:0 auto}
.dsw-alignGlyph[data-mode=center] i:nth-child(3){width:86%;margin:0 auto}
.dsw-alignGlyph[data-mode=right] i:nth-child(1){width:100%}
.dsw-alignGlyph[data-mode=right] i:nth-child(2){width:66%;margin-left:auto}
.dsw-alignGlyph[data-mode=right] i:nth-child(3){width:86%;margin-left:auto}
.dsw-alignGlyph[data-mode=justify] i{width:100%}
.dsw-menu{position:relative;flex:none}
.dsw-menu>summary{list-style:none;cursor:pointer;user-select:none;white-space:nowrap;display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l3);font-size:12px}
.dsw-menu>summary::-webkit-details-marker{display:none}
.dsw-menu[open]>summary{background:var(--dsw-alias-interactive-bg-active)}
.dsw-menuPanel{position:absolute;left:0;top:calc(100% + 6px);z-index:1000;min-width:230px;display:flex;flex-direction:column;gap:4px;padding:8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 32px rgba(0,0,0,.28)}
.dsw-menuPanel[data-side=right]{left:auto;right:0}
.dsw-menuRow{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px}
.dsw-menuItem{display:block;width:100%;text-align:left;padding:6px 8px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.dsw-menuItem:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsw-menuItem:disabled{opacity:.5;cursor:default}
.dsw-num{width:52px;height:22px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 4px;outline:none}
.dsw-body{flex:1;min-height:0;display:flex}
.dsw-rail{flex:none;width:218px;min-width:218px;display:flex;flex-direction:column;border-right:.5px solid var(--dsw-alias-border-l3);overflow:hidden}
.dsw-railHead{flex:none;display:flex;align-items:center;gap:4px;padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dsw-railList{flex:1;min-height:0;overflow:auto;padding:4px}
.dsw-railSection{padding:8px 8px 2px;font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.dsw-railItem{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;padding:6px 7px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
.dsw-railItem:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsw-railItem[data-active=true]{background:var(--dsw-alias-interactive-bg-active)}
.dsw-railTitle{font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsw-railMeta{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.dsw-railFoot{flex:none;display:flex;flex-direction:column;gap:4px;padding:6px 8px;border-top:.5px solid var(--dsw-alias-border-l3)}
.dsw-importRow{display:flex;gap:4px}
.dsw-input{flex:1;min-width:0;height:24px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;padding:0 6px;outline:none}
.dsw-scroll{flex:1;min-width:0;overflow:auto;padding:16px 0 140px;background:var(--dsw-alias-bg-layer-1)}
/* THE EDITOR SURFACE. The document is a column of blocks, not a sheet of paper:
   the column is as wide as THIS PANE (the block fills its scroll port, minus the
   gutter) and its typography is the document's own scaled by the zoom, so the text
   on screen is the text the .docx carries. The PAPER is the file's business: A4 and
   its margins are what the codec writes and what LibreOffice lays out. */
.dsw-editor{max-width:100%;margin:0 auto;padding:0 24px}
.dsw-host{min-height:320px}
.dsw-host[data-writing-editor='loading']{opacity:.6}
.dsw-editorNote{padding:6px 0 0;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.dsw-loss{flex:none;display:flex;align-items:flex-start;gap:8px;padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-state-warning-bg,rgba(210,153,34,.14));font-size:12px}
.dsw-lossText{flex:1;min-width:0}
.dsw-status{flex:none;display:flex;align-items:center;gap:10px;padding:4px 10px;border-top:.5px solid var(--dsw-alias-border-l3);font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsw-status[data-kind=err]{color:var(--dsw-alias-state-error-primary,#d3382c)}
.dsw-status[data-kind=warn]{color:var(--dsw-alias-state-warning-primary,#d29922)}
.dsw-spacer{flex:1;min-width:0}
.dsw-empty{padding:24px;font-size:12.5px;color:var(--dsw-alias-label-tertiary);text-align:center}
/* Editor.js injects its own stylesheet (its UMD carries it) and its defaults are a
   light theme. These overrides put the surface on this app's own tokens so the
   editor is not the one white rectangle in a dark window - and they are scoped
   under .dsw-editor, so nothing here leaks into another plugin's surface. */
.dsw-editor .codex-editor{color:var(--dsw-alias-label-primary);font-family:inherit}
.dsw-editor .codex-editor__redactor{padding-bottom:60px!important}
.dsw-editor .ce-block__content,.dsw-editor .ce-toolbar__content{max-width:none;margin:0}
.dsw-editor .ce-paragraph,.dsw-editor .ce-header,.dsw-editor .cdx-block{color:var(--dsw-alias-label-primary);font-family:inherit}
/* The heading levels. Editor.js's own header tool ships no size scale, and this
   package renders the level as a class (h1..h6) rather than as the element name, so
   the scale lives here - relative to the DOCUMENT's own size, because that is what
   the .docx carries and what the whole column inherits. */
.dsw-editor .ce-header{margin:0 0 .5em;font-weight:600;line-height:1.25}
.dsw-editor .ce-header.h1{font-size:1.9em}
.dsw-editor .ce-header.h2{font-size:1.55em}
.dsw-editor .ce-header.h3{font-size:1.3em}
.dsw-editor .ce-header.h4{font-size:1.12em}
.dsw-editor .ce-header.h5{font-size:1em}
.dsw-editor .ce-header.h6{font-size:1em;font-style:italic}
.dsw-editor .ce-toolbar__plus,.dsw-editor .ce-toolbar__settings-btn{color:var(--dsw-alias-label-secondary);border-radius:6px}
.dsw-editor .ce-toolbar__plus:hover,.dsw-editor .ce-toolbar__settings-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsw-editor .ce-popover,.dsw-editor .ce-inline-toolbar,.dsw-editor .ce-settings{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);box-shadow:0 12px 32px rgba(0,0,0,.28);color:var(--dsw-alias-label-primary)}
.dsw-editor .ce-popover-item,.dsw-editor .ce-inline-tool{color:var(--dsw-alias-label-primary)}
.dsw-editor .ce-popover-item:hover:not(.ce-popover-item--no-hover),.dsw-editor .ce-inline-tool:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsw-editor .ce-popover-item__title,.dsw-editor .ce-popover__nothing-found-message{color:var(--dsw-alias-label-primary)}
.dsw-editor .ce-popover__nothing-found-message{opacity:.7}
.dsw-editor .ce-inline-toolbar{border-radius:8px}
.dsw-editor .ce-inline-tool--active,.dsw-editor .ce-inline-tool--focused{color:var(--dsw-alias-state-accent,#4f8cff);background:var(--dsw-alias-interactive-bg-active)}
.dsw-editor .cdx-search-field,.dsw-editor .ce-popover__search{background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l3)}
.dsw-editor .cdx-search-field__input,.dsw-editor .ce-popover__search input{color:var(--dsw-alias-label-primary)}
.dsw-editor [contenteditable]{outline:none}
/* The block the model holds but the editor cannot draw as a page. */
.dsw-editor .ce-delimiter:before{color:var(--dsw-alias-label-tertiary)}
.dsw-editor .ce-code__textarea{background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l3);border-radius:6px}
.dsw-editor .cdx-quote{border-left:2px solid var(--dsw-alias-border-l3);padding-left:12px}
.dsw-editor .cdx-quote__text{min-height:0;margin-bottom:4px;font-style:italic}
.dsw-editor .cdx-quote__caption{color:var(--dsw-alias-label-tertiary)}
.dsw-editor .cdx-list{margin:0;padding:0 0 0 4px}
/* The three marks Editor.js's own toolbar does not carry: this pack's own tools
   stamp them on a span, and this is what makes them look like marks. */
.dsw-editor [data-mark~=u]{text-decoration:underline}
.dsw-editor [data-mark~=s]{text-decoration:line-through}
.dsw-editor [data-mark~=code]{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.94em;padding:0 .2em;border-radius:3px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14))}
/* THE NEW-FILE DIALOG: a real dialog, centred over the tab, closed by Escape, a
   click outside, or the moment the file exists. */
.dsw-dialogMask{position:absolute;inset:0;z-index:1100;display:flex;align-items:flex-start;justify-content:center;padding-top:12vh;background:rgba(0,0,0,.32)}
.dsw-dialog{width:min(420px,86%);display:flex;flex-direction:column;gap:10px;padding:14px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 18px 48px rgba(0,0,0,.34)}
.dsw-dialogTitle{font-size:13px;font-weight:600}
.dsw-dialogRow{display:flex;align-items:center;gap:6px}
.dsw-dialogInput{flex:1;min-width:0;height:28px;box-sizing:border-box;border:1px solid var(--dsw-alias-state-accent,#4f8cff);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:0 8px;outline:none}
.dsw-dialogExt{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dsw-dialogActions{display:flex;justify-content:flex-end;gap:6px}
/* The font control is wide because a family name is; the datalist does the
   filtering, so this only has to hold what has been typed. */
.dsw-font{width:132px;height:24px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 5px;outline:none}
.dsw-font:disabled{opacity:.5}
/* THE HEADINGS NAVIGATOR. A column of its own on the right of the page, the way
   a word processor's navigator sits: indented by level, quiet until hovered. */
.dsw-outline{flex:none;width:216px;min-width:216px;display:flex;flex-direction:column;border-left:.5px solid var(--dsw-alias-border-l3);overflow:hidden}
.dsw-outlineHead{flex:none;display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l3);font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.dsw-outlineList{flex:1;min-height:0;overflow:auto;padding:4px}
.dsw-outlineItem{display:block;width:100%;text-align:left;padding:4px 6px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsw-outlineItem:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsw-outlineItem[data-heading-active=true]{background:var(--dsw-alias-interactive-bg-active)}
.dsw-outlineItem[data-heading-level="1"]{font-weight:600}
.dsw-outlineItem[data-heading-level="2"]{padding-left:1.1em}
.dsw-outlineItem[data-heading-level="3"]{padding-left:2.2em;color:var(--dsw-alias-label-secondary)}
.dsw-outlineItem[data-heading-level="4"]{padding-left:3.3em;color:var(--dsw-alias-label-secondary)}
.dsw-outlineItem[data-heading-level="5"]{padding-left:4.4em;color:var(--dsw-alias-label-tertiary)}
.dsw-outlineItem[data-heading-level="6"]{padding-left:5.5em;color:var(--dsw-alias-label-tertiary)}
.dsw-outlineText{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The right-bar pane shell: the same surface, one column. */
.dsw-pane{position:absolute;inset:0;display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:13px/1.45 var(--dsw-font-family,inherit)}
.dsw-paneBar{flex:none;display:flex;align-items:center;gap:6px;height:38px;box-sizing:border-box;padding:0 10px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dsw-paneTitle{font-size:12.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* THE GRID. A table, because a spreadsheet IS a table: the headers are the row
   and column names the addresses are built from, and the first column and row
   stay put while the rest scrolls. */
.dsw-gridWrap{flex:1;min-height:0;overflow:auto;background:var(--dsw-alias-bg-layer-1)}
.dsw-grid{border-collapse:separate;border-spacing:0;table-layout:fixed;font:12px/1.4 var(--dsw-font-family,inherit)}
.dsw-gridHead{position:sticky;top:0;z-index:2;min-width:76px;width:76px;height:22px;box-sizing:border-box;padding:0 4px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));border-right:.5px solid var(--dsw-alias-border-l3);border-bottom:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);font-weight:500;text-align:center;font-size:11px}
.dsw-grid tbody .dsw-gridHead{position:sticky;left:0;z-index:1}
.dsw-gridCorner{position:sticky;left:0;top:0;z-index:3;width:44px;min-width:44px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));border-right:.5px solid var(--dsw-alias-border-l3);border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dsw-gridHead[data-active=true]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
.dsw-cell{min-width:76px;width:76px;height:22px;box-sizing:border-box;border-right:.5px solid var(--dsw-alias-border-l3);border-bottom:.5px solid var(--dsw-alias-border-l3);padding:0;vertical-align:top}
.dsw-cell[data-active=true]{outline:1.5px solid var(--dsw-alias-state-accent,#4f8cff);outline-offset:-1.5px}
.dsw-cellInput{min-height:21px;padding:1px 4px;outline:none;white-space:pre;overflow:hidden;text-overflow:ellipsis;cursor:cell}
.dsw-sheetTabs{flex:none;display:flex;align-items:center;gap:4px;padding:4px 8px;border-top:.5px solid var(--dsw-alias-border-l3);overflow-x:auto}
.dsw-sheetTab{flex:none;height:22px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap}
.dsw-sheetTab[data-active=true]{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-state-accent,#4f8cff)}
.dsw-sheetName{flex:none;width:120px;height:22px}
`
    /** The id of the style tag, so a reload replaces it rather than stacking. */
    const CSS_TAG = 'dsh-writing/writing.css'

    /** Install the stylesheet once, replacing the old tag if there is one. */
    function installStyles(tagId, css) {
      if (!document || !document.head || typeof document.createElement !== 'function') return
      for (const child of document.head.children ? Array.from(document.head.children) : []) {
        if (child && child.dataset && child.dataset.pluginCss === tagId) child.remove()
      }
      const tag = document.createElement('style')
      tag.dataset.pluginCss = tagId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // -----------------------------------------------------------------------
    // Routes
    // -----------------------------------------------------------------------
    /** POST one JSON body and hand back the Response (a 409 is an answer, not a throw). */
    async function postJson(route, body) {
      return await fetch(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    /** GET one JSON route. */
    async function getJson(route) {
      return await fetch(route, { headers: { accept: 'application/json' } })
    }

    /** A short human message from an error or a failed response body. */
    function messageOf(err) {
      if (!err) return 'unknown failure'
      if (typeof err === 'string') return err
      return err.message ? err.message : String(err)
    }

    /**
     * WHY a response failed, in the host's own words.
     *
     * Every route answers `{ ok: false, error: { code, message } }`, and a client
     * that reports only "500" makes the operator open devtools to learn what the
     * host already said. This reads that body, so the status bar carries the
     * sentence the host wrote - which is how a real failure gets reported
     * accurately instead of approximately.
     *
     * @param response - the failed response.
     * @param fallback - what to say when the body is not one of ours.
     * @returns the message.
     */
    async function failureOf(response, fallback) {
      try {
        const payload = await response.clone().json()
        if (payload && payload.error && typeof payload.error.message === 'string' && payload.error.message.length > 0) {
          return fallback + ': ' + payload.error.message
        }
      } catch (err) {
        /* not a JSON body of ours: the fallback stands */
      }
      return fallback + ' (' + response.status + ')'
    }

    // -----------------------------------------------------------------------
    // Glyphs, drawn rather than imported: the toolbar is this package's own
    // surface and the pack's rule is that artwork outlives a class rename.
    // -----------------------------------------------------------------------
    function AlignGlyph(props) {
      return h('span', { className: 'dsw-alignGlyph', 'data-mode': props.mode, 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))
    }

    /** Shut the `details` menu a clicked item lives in - a menu that stays open
     * after its item was chosen reads as a menu that did not work. */
    function closeMenus(element) {
      try {
        if (!element || typeof element.closest !== 'function') return
        const menu = element.closest('details')
        if (menu) menu.open = false
      } catch (err) {
        /* a menu that stays open is a nuisance, not a failure */
      }
    }

    function ToolButton(props) {
      const attributes = {
        type: 'button',
        className: 'dsw-btn' + (props.className ? ' ' + props.className : ''),
        title: props.title,
        'data-action': props.action,
        'data-active': props.active === true ? 'true' : 'false',
        'data-emphasis': props.emphasis,
        disabled: props.disabled === true,
        onMouseDown: props.onMouseDown,
        onClick: props.onClick,
      }
      // Any `data-*` a caller passes rides through, so the button that COUNTS for a
      // check (`data-writing-new`) can be the button that acts - a check asserting a
      // marker a person clicks is worth more than one asserting a marker beside it.
      for (const [key, value] of Object.entries(props)) {
        if (key.startsWith('data-') && value !== undefined && value !== null) attributes[key] = value
      }
      return h('button', attributes, props.children)
    }

    /**
     * The column name of one 0-based index: A..Z, AA..AZ, … The same arithmetic
     * a spreadsheet uses for `A1`, and the reason a cell's address is printable
     * without a lookup table.
     *
     * @param index - the 0-based column.
     * @returns the letters.
     */
    function columnName(index) {
      let value = Math.max(0, Math.floor(Number(index) || 0))
      let name = ''
      do {
        name = String.fromCharCode(65 + (value % 26)) + name
        value = Math.floor(value / 26) - 1
      } while (value >= 0)
      return name
    }

    /** `A1` for one cell. */
    function cellAddress(row, column) {
      return columnName(column) + String(row + 1)
    }

    /**
     * What a person typed into a cell, as the model holds it.
     *
     * The rules are the ones a spreadsheet has always had: a leading `=` is a
     * FORMULA (kept without the `=`, because that is what the file carries), a
     * number is a number (so a `.xlsx` has a number and not the text "42"), the
     * two boolean spellings are booleans, and anything else is text. An empty
     * cell is `null` and never `''` - one meaning for empty is what lets a round
     * trip be stable.
     *
     * @param text - what was typed.
     * @returns the cell.
     */
    function parseCellInput(text) {
      const raw = String(text ?? '')
      if (raw.length === 0) return null
      if (raw.startsWith('=')) {
        const formula = raw.slice(1).trim()
        return formula.length === 0 ? null : { value: '', formula }
      }
      const trimmed = raw.trim()
      if (trimmed.length > 0 && Number.isFinite(Number(trimmed)) && !/^0\d/.test(trimmed)) return Number(trimmed)
      if (/^true$/i.test(trimmed)) return true
      if (/^false$/i.test(trimmed)) return false
      return raw
    }

    /** One cell as the text a cell shows (a formula shows its `=`). */
    function cellDisplay(cell) {
      if (cell === null || cell === undefined) return ''
      if (typeof cell === 'object') return cell.formula ? '=' + cell.formula : String(cell.value ?? '')
      if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE'
      return String(cell)
    }

    /** A workbook as the grid's own shape: rectangular, padded, at least 1x1. */
    function sheetGrid(sheet) {
      const rows = []
      const source = sheet && Array.isArray(sheet.rows) ? sheet.rows : []
      const width = source.reduce((widest, row) => Math.max(widest, Array.isArray(row) ? row.length : 0), 0)
      for (const row of source) {
        const cells = Array.isArray(row) ? row.slice() : []
        while (cells.length < width) cells.push(null)
        rows.push(cells)
      }
      if (rows.length === 0) rows.push([])
      return rows
    }

    // -----------------------------------------------------------------------
    // The page surface, as ELEMENTS
    //
    // Built here rather than inside the component, and taking its handlers as an
    // argument, for one reason: the surface a person writes on is the part of
    // this tab that most needs proving, and a pure element builder can be
    // rendered by a check (`renderToStaticMarkup`) with a document and a page
    // list it made itself, with no browser and no hooks involved. The component
    // below is then only wiring: state in, handlers out.
    // -----------------------------------------------------------------------

    /**
     * One FRAGMENT of a block (or one page break) as an editable element.
     *
     * A block that fits is one fragment covering it whole (`data-from` 0,
     * `data-to` empty). A block broken by a page boundary is several, one per
     * page, each carrying the character range it shows - and it is those two
     * attributes that let an edit be put back into the block at the right offset.
     */
    function blockElement(options) {
      const { block, placed, html, handlers, pageIndex } = options
      const index = placed.index
      const from = Number.isFinite(placed.from) ? placed.from : 0
      const to = placed.to === null || placed.to === undefined ? null : placed.to
      if (!block || block.type === 'pageBreak') {
        return h('div', { key: 'break-' + pageIndex + '-' + index, className: 'dsw-break', 'data-page-break': true })
      }
      const attributes = blockAttributes(block, {
        key: 'block-' + index + '-' + from,
        'data-block': String(index),
        'data-from': String(from),
        'data-to': to === null ? '' : String(to),
        contentEditable: true,
        suppressContentEditableWarning: true,
        spellCheck: true,
        dangerouslySetInnerHTML: { __html: html ?? '' },
        onInput: handlers.onInput,
        onKeyDown: handlers.onKeyDown,
        onPaste: handlers.onPaste,
        onFocus: handlers.onFocus,
      })
      if (placed.overflow) attributes['data-overflow'] = 'true'
      // A fragment is flagged when a page boundary runs through its block, so the
      // stylesheet can keep the paper's own top and bottom edges quiet.
      if (placed.split) attributes['data-split'] = 'true'
      return h('div', attributes)
    }

    /**
     * The pages: one element per page, sized in PIXELS from the millimetres the
     * model carries (`PX_PER_MM`), with the margins as the page's own padding so
     * the text sits exactly inside them. The page is white paper whatever the app
     * theme is - a sheet of paper is white in a dark room too.
     *
     * @param options - `{ doc, pages, geometry, handlers }`.
     * @returns the page elements, in order.
     */
    function pagesElement(options) {
      const { doc, pages, geometry, handlers } = options
      // Millimetres are the model's; pixels are the screen's. Rounded to two
      // decimals, because a page box at 793.7007874015748px is a number nobody
      // can read in a stylesheet and nothing gains from the extra digits.
      const px = (millimetres) => Math.round(Number(millimetres) * PX_PER_MM * 100) / 100 + 'px'
      const contentWidthPx = px(geometry.contentWidthMm)
      const pageWidthPx = px(geometry.widthMm)
      const pageHeightPx = px(geometry.heightMm)
      const margins = geometry.margins
      return (Array.isArray(pages) ? pages : []).map((page, pageIndex) =>
        h(
          'div',
          {
            key: 'page-' + pageIndex,
            className: 'dsw-page',
            'data-writing-page': pageIndex,
            style: {
              width: pageWidthPx,
              height: pageHeightPx,
              padding: px(margins.top) + ' ' + px(margins.right) + ' ' + px(margins.bottom) + ' ' + px(margins.left),
            },
          },
          h(
            'div',
            { className: 'dsw-pageFlow', style: flowStyle(doc, contentWidthPx) },
            page.blocks.map((placed) =>
              blockElement({
                block: doc.blocks[placed.index],
                placed,
                html: runsHtml(sliceRuns(doc.blocks[placed.index] ? doc.blocks[placed.index].runs : null, placed.from, placed.to)),
                handlers,
                pageIndex,
              }),
            ),
            // A page with nothing on it still needs a target: that is what an
            // empty page after a page break IS.
            page.blocks.length === 0
              ? h('div', { className: 'dsw-block dsw-emptyPage', 'data-writing-empty-page': pageIndex, onClick: handlers.onEmptyPage }, '\u00a0')
              : null,
          ),
          h('div', { className: 'dsw-pageNo' }, String(pageIndex + 1)),
        ),
      )
    }

    /**
     * The text column's own box: its width in pixels, and the document's default
     * family and size - which is what every run that names neither inherits, both
     * on screen and in the `.docx` (`docDefaults`).
     *
     * @param doc - the document.
     * @param contentWidthPx - the measured text width.
     * @returns the style object.
     */
    function flowStyle(doc, contentWidthPx) {
      const style = { width: contentWidthPx }
      if (doc && typeof doc.font === 'string' && doc.font.length > 0) style.fontFamily = "'" + doc.font.replaceAll("'", '') + "'"
      // A size is always written: it is what the heading sizes are em-relative to,
      // so leaving it off would make the document's own size invisible.
      style.fontSize = (doc && Number.isFinite(doc.fontSize) ? doc.fontSize : 12) + 'pt'
      return style
    }

    // -----------------------------------------------------------------------
    // The tab
    // -----------------------------------------------------------------------
    /**
     * The Writing view.
     *
     * A conversation view receives no `sessionId` prop: the registration's own
     * `inject` hands it in as `writingSession`.
     */
    function WritingView(props) {
      // A conversation view is handed its session by the registration's `inject`;
      // a right-bar panes tab is handed the FILE its address names. Both mount
      // this one component, because they are the same editor.
      const fileProp = props.file && typeof props.file === 'object' ? props.file : null
      const session =
        fileProp && typeof fileProp.sessionId === 'string' && fileProp.sessionId.length > 0
          ? fileProp.sessionId
          : typeof props.writingSession === 'string' && props.writingSession.length > 0
            ? props.writingSession
            : null
      const filePath = fileProp && typeof fileProp.path === 'string' && fileProp.path.length > 0 ? fileProp.path : null
      const ctxRef = useRef(props.ctx ?? null)
      /** The open document (the host's model, plus its id and revision). */
      const [doc, setDoc] = useState(null)
      const docRef = useRef(null)
      const [summaries, setSummaries] = useState([])
      const [library, setLibrary] = useState([])
      const [dirty, setDirty] = useState(false)
      const dirtyRef = useRef(false)
      const [status, setStatus] = useState({ kind: 'info', text: '' })
      const [phase, setPhase] = useState('loading')
      const [epoch, setEpoch] = useState(0)
      const [zoom, setZoom] = useState(1)
      const [showRail, setShowRail] = useState(true)
      const [showOutline, setShowOutline] = useState(false)
      const [loss, setLoss] = useState([])
      const [conflict, setConflict] = useState(null)
      const [importPath, setImportPath] = useState('')
      const [activeIndex, setActiveIndex] = useState(null)
      const [activeMarks, setActiveMarks] = useState([])
      const [activeProperties, setActiveProperties] = useState({ font: '', size: null })
      const [exported, setExported] = useState(null)
      /** Every font family this machine has, from the host (`GET /fonts`). */
      const [fonts, setFonts] = useState([])
      const [fontsNote, setFontsNote] = useState('')
      /** The name dialog: a real dialog, not the browser's prompt. */
      const [namePrompt, setNamePrompt] = useState(null)
      /** The caret to restore after the next render, as two (block, offset) ends. */
      const pendingCaret = useRef(null)
      const measureRef = useRef(null)
      const pagesRef = useRef(null)
      /** The line-height cache, so only the block being typed in is re-measured. */
      const lineCacheRef = useRef(new Map())
      /** The active block index, readable from a listener that closes over nothing stale. */
      const activeIndexRef = useRef(null)
      /** The page breaker module: the real one from the route, or the fallback. */
      const paginatorRef = useRef(null)
      const [paginatorReady, setPaginatorReady] = useState(false)

      useEffect(() => {
        activeIndexRef.current = activeIndex
      }, [activeIndex])

      /**
       * Follow the CARET: which block it is in, and what run properties are declared
       * around it.
       *
       * A `selectionchange` listener rather than Editor.js's own change event,
       * because moving the caret with a click or an arrow is not an edit - and the
       * bar's two controls have to answer to where the person IS, not to the last
       * keystroke. The block index is read from the DOM (the element's own
       * `.ce-block` among its siblings), which is the same index the model uses, so
       * a caret in a block Editor.js did not report still names the right block.
       */
      useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const read = () => {
          const host = hostRef.current
          if (!host) return
          const index = caretBlockIndex(host, editorRef.current)
          if (index < 0) return
          setActiveIndex(index)
          const current = liveRef.current ?? docRef.current
          const block = current ? current.blocks[index] : null
          if (!block) return
          // What the caret CARRIES, read from the model at the caret's own offset -
          // the same function the mark toolbar reads, so the two controls and the
          // document cannot disagree about a run.
          const editable = blockElementAt(host, index)
          const offsets = editable ? caretOffsets(editable) : null
          setActiveProperties(propertiesAt(block.runs, offsets ? offsets.start : runsLength(block.runs)))
        }
        document.addEventListener('selectionchange', read)
        return () => document.removeEventListener('selectionchange', read)
      }, [])
      /** Every document change goes through here, so the ref and the state cannot drift. */
      const applyDoc = useCallback((next) => {
        docRef.current = next
        setDoc(next)
      }, [])

      const openDocument = useCallback((document) => {
        applyDoc(document)
        setDirty(false)
        dirtyRef.current = false
        setConflict(false)
        setLoss([])
        setActiveIndex(null)
        setActiveMarks([])
        setEpoch((value) => value + 1)
      }, [applyDoc])

      /** Read the conversation's documents (and the library) from the host. */
      const refresh = useCallback(async () => {
        if (!session) return null
        const response = await getJson(STATE_ROUTE + '?session=' + encodeURIComponent(session))
        if (!response.ok) throw new Error(await failureOf(response, 'the document list could not be read'))
        const payload = await response.json()
        setSummaries(Array.isArray(payload.documents) ? payload.documents : [])
        setLibrary(Array.isArray(payload.library) ? payload.library : [])
        return payload
      }, [session])

      /** Load one document by id. */
      const load = useCallback(
        async (id) => {
          if (!session || !id) return
          setPhase('loading')
          try {
            const response = await getJson(DOCUMENT_ROUTE + '?session=' + encodeURIComponent(session) + '&id=' + encodeURIComponent(id))
            if (!response.ok) throw new Error(await failureOf(response, 'the document could not be read'))
            const payload = await response.json()
            openDocument(payload.document)
            setPhase('ready')
            setStatus({ kind: 'info', text: '' })
          } catch (err) {
            setPhase('error')
            setStatus({ kind: 'err', text: messageOf(err) })
          }
        },
        [openDocument, session],
      )

      /** Create a blank document and open it. */
      const create = useCallback(
        async (title) => {
          if (!session) return null
          try {
            const response = await postJson(DOCUMENT_ROUTE, {
              session,
              title: title && title.length > 0 ? title : 'Untitled',
              blocks: [{ type: 'paragraph', runs: [{ text: '', marks: [] }] }],
              by: 'user',
              note: 'created',
            })
            if (!response.ok) throw new Error(await failureOf(response, 'a new document could not be created'))
            const payload = await response.json()
            openDocument(payload.document)
            setPhase('ready')
            await refresh()
            return payload.document
          } catch (err) {
            setPhase('error')
            setStatus({ kind: 'err', text: messageOf(err) })
            return null
          }
        },
        [openDocument, refresh, session],
      )

      /**
       * Open the FILE a right-bar pane was asked for.
       *
       * The host decides whether that means an existing linked document or a
       * fresh import, so this side never has to know - and a `.docx` opened from
       * Files behaves exactly like one created by "New" from here on.
       */
      const openFile = useCallback(
        async (relativePath, options = {}) => {
          if (!session || !relativePath) return
          setPhase('loading')
          try {
            const response = await postJson(OPEN_FILE_ROUTE, { session, path: relativePath, reload: options.reload === true, by: 'user' })
            const payload = await response.json().catch(() => null)
            if (!response.ok) throw new Error((payload && payload.error && payload.error.message) || 'could not open the file (' + response.status + ')')
            openDocument(payload.document)
            setLoss(Array.isArray(payload.loss) ? payload.loss : [])
            setPhase('ready')
            setStatus({ kind: 'info', text: (payload.reused ? 'Opened ' : 'Imported ') + relativePath })
            await refresh()
          } catch (err) {
            setPhase('error')
            setStatus({ kind: 'err', text: messageOf(err) })
          }
        },
        [openDocument, refresh, session],
      )

      /**
       * Save the open document. `force` skips the revision check, which is what
       * "Keep mine" means when the host answered 409.
       *
       * The editor is read FIRST (`readLive`): a keystroke that has not reached
       * `onChange` yet is still a keystroke somebody made, and saving the model as it
       * stood would drop it. `readLive` never throws - it answers the model this side
       * already has.
       */
      const save = useCallback(
        async (options = {}) => {
          const current = await readLive()
          if (!session || !current) return false
          if (options.silent !== true) setStatus({ kind: 'info', text: 'Saving\u2026' })
          try {
            const response = await postJson(DOCUMENT_ROUTE, {
              session,
              id: current.id,
              title: current.title,
              page: current.page,
              font: current.font,
              fontSize: current.fontSize,
              blocks: current.blocks,
              by: 'user',
              note: options.note ?? 'edited',
              expectedRevision: options.force === true ? undefined : current.revision,
            })
            if (response.status === 409) {
              setConflict('document')
              setStatus({ kind: 'warn', text: 'This document changed elsewhere \u2014 reload it or keep this version.' })
              return false
            }
            if (!response.ok) {
              const payload = await response.json().catch(() => null)
              throw new Error((payload && payload.error && payload.error.message) || 'save failed (' + response.status + ')')
            }
            const payload = await response.json()
            liveRef.current = payload.document
            applyDoc(payload.document)
            setDirty(false)
            dirtyRef.current = false
            setConflict(null)
            setStatus({ kind: 'info', text: 'Saved ' + new Date().toLocaleTimeString() })
            await refresh()
            // A document linked to a file is written to that file too: the store
            // is where the tab keeps its copy, and the file is what the person
            // will open in Word or LibreOffice. Saving one without the other
            // would be a silent divergence.
            if (current.origin && typeof current.origin.path === 'string' && current.origin.path.length > 0) {
              return await saveToFile({ force: options.force === true, silent: options.silent === true })
            }
            return true
          } catch (err) {
            setStatus({ kind: 'err', text: 'Save failed: ' + messageOf(err) })
            return false
          }
        },
        // `saveToFile` is defined below and closes over the same refs, so it is
        // deliberately not a dependency here (it would be recreated every render).
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [applyDoc, refresh, session],
      )

      /**
       * Write the open document back to the FILE it came from.
       *
       * The file is what somebody opens in Word or LibreOffice, so this is the
       * write that must not lose work: the host writes atomically and answers 409
       * with the file's current stat when it moved underneath the tab.
       */
      const saveToFile = useCallback(
        async (options = {}) => {
          const current = docRef.current
          const origin = current && current.origin ? current.origin : null
          if (!session || !current || !origin || typeof origin.path !== 'string' || origin.path.length === 0) return false
          if (options.silent !== true) setStatus({ kind: 'info', text: 'Writing ' + origin.path + '\u2026' })
          try {
            const response = await postJson(SAVE_FILE_ROUTE, {
              session,
              id: current.id,
              expected: { mtimeMs: origin.mtimeMs, size: origin.size },
              force: options.force === true,
            })
            if (response.status === 409) {
              const payload = await response.json().catch(() => null)
              if (payload && payload.error && payload.error.code === 'CHANGED_ON_DISK') {
                setConflict('file')
                setStatus({ kind: 'warn', text: 'The file changed on disk since it was opened \u2014 reload it or keep this version.' })
                return false
              }
            }
            if (!response.ok) {
              const payload = await response.json().catch(() => null)
              throw new Error((payload && payload.error && payload.error.message) || 'write failed (' + response.status + ')')
            }
            const payload = await response.json()
            setDirty(false)
            dirtyRef.current = false
            setConflict(null)
            setStatus({ kind: 'info', text: 'Wrote ' + payload.name + ' (' + payload.bytes + ' bytes)' })
            await load(current.id)
            return true
          } catch (err) {
            setStatus({ kind: 'err', text: 'Could not write the file: ' + messageOf(err) })
            return false
          }
        },
        [load, session],
      )

      /**
       * Create a REAL file on the Desktop of the machine running the harness.
       *
       * The name is asked in the tab's OWN dialog (`namePrompt`), not with
       * `window.prompt`: the browser's prompt is a modal the page cannot style,
       * cannot keep a keyboard contract for, and cannot close when the file is
       * made. The dialog confirms ONCE and the file starts - which is the whole
       * of what "New" should be.
       *
       * @param format - `'docx'` (what the bar's New button asks for), or `'xlsx'`,
       *   `'md'` or `'txt'`.
       * @param name - the name to create (already confirmed by the dialog).
       * @returns the created file's payload, or null.
       */
      const createFile = useCallback(
        async (format, name) => {
          if (!session) return null
          try {
            setStatus({ kind: 'info', text: 'Creating ' + name + '\u2026' })
            const response = await postJson(CREATE_FILE_ROUTE, { session, format, name, by: 'user', target: 'desktop' })
            const payload = await response.json().catch(() => null)
            if (!response.ok) throw new Error((payload && payload.error && payload.error.message) || 'could not create the file (' + response.status + ')')
            // The dialog is gone the moment the file exists: one action, one result.
            setNamePrompt(null)
            if (format === 'xlsx') {
              // A workbook is edited in the RIGHT BAR's grid pane, not on a page:
              // creating one hands the new address there, and if the bar is not
              // mounted the file is still real and the status bar says where it
              // is rather than pretending a grid opened.
              const controller = (() => {
                const ctx = ctxRef.current
                try {
                  return ctx && typeof ctx.get === 'function' ? ctx.get(SIDEBAR_SERVICE) : undefined
                } catch (err) {
                  return undefined
                }
              })()
              if (controller && typeof controller.openResource === 'function') {
                controller.openResource(FILE_ADDRESS_PREFIX + encodeURIComponent(session) + '/' + payload.path, { kind: SHEET_KIND })
                setStatus({ kind: 'info', text: 'Created ' + payload.name + ' \u2014 opened in the right bar' })
              } else {
                setStatus({ kind: 'warn', text: 'Created ' + payload.name + ' in the conversation folder (the right bar is not mounted)' })
              }
              await refresh()
              return payload
            }
            openDocument(payload.document)
            setPhase('ready')
            setStatus({ kind: 'info', text: 'Created ' + payload.name + (payload.dir ? ' in ' + payload.dir : '') })
            await refresh()
            return payload
          } catch (err) {
            setStatus({ kind: 'err', text: messageOf(err) })
            return null
          }
        },
        [openDocument, refresh, session],
      )

      /**
       * Open the tab's own New-file dialog, with the name it should suggest.
       *
       * A DOCUMENT is what this tab makes, and a `.docx` is what the editor writes,
       * so the extension is fixed and shown beside the field rather than offered as a
       * choice - the workbook has its own surface in the right bar and its own route
       * (`create-file` with `xlsx`), which is where it belongs.
       */
      const askForFile = useCallback(
        (format) => {
          const extension = format === 'xlsx' ? '.xlsx' : format === 'md' ? '.md' : format === 'txt' ? '.txt' : '.docx'
          const base = format === 'xlsx' ? 'Spreadsheet' : 'Document'
          setNamePrompt({ format, value: base + extension, extension, title: 'New ' + (format === 'xlsx' ? 'spreadsheet' : 'document') })
        },
        [],
      )

      /** The bar's New button: one action, the file this tab actually writes. */
      const newDocument = useCallback(() => askForFile('docx'), [askForFile])

      /** Delete the open document. */
      const remove = useCallback(
        async (id) => {
          if (!session || !id) return
          try {
            const response = await postJson(DELETE_ROUTE, { session, id })
            if (!response.ok) throw new Error(await failureOf(response, 'the document could not be deleted'))
            if (docRef.current && docRef.current.id === id) {
              applyDoc(null)
              setDirty(false)
              dirtyRef.current = false
            }
            setStatus({ kind: 'info', text: 'Deleted' })
            const payload = await refresh()
            if (!docRef.current && payload && payload.documents.length > 0) await load(payload.documents[0].id)
          } catch (err) {
            setStatus({ kind: 'err', text: messageOf(err) })
          }
        },
        [applyDoc, load, refresh, session],
      )

      /** Copy the open document into the shared library. */
      const publish = useCallback(async () => {
        const current = docRef.current
        if (!session || !current) return
        try {
          const saved = dirtyRef.current ? await save({ silent: true }) : true
          if (!saved) return
          const response = await postJson(PUBLISH_ROUTE, { session, id: current.id, by: 'user' })
          if (!response.ok) throw new Error(await failureOf(response, 'the document could not be published'))
          setStatus({ kind: 'info', text: 'Published to the library' })
          await refresh()
        } catch (err) {
          setStatus({ kind: 'err', text: messageOf(err) })
        }
      }, [refresh, save, session])

      /** Import a workspace file into the conversation's documents. */
      const runImport = useCallback(
        async (relativePath) => {
          const value = String(relativePath ?? '').trim()
          if (!session || value.length === 0) return
          setStatus({ kind: 'info', text: 'Reading ' + value + '\u2026' })
          try {
            const response = await postJson(IMPORT_ROUTE, { session, path: value, by: 'user' })
            const payload = await response.json().catch(() => null)
            if (!response.ok) throw new Error((payload && payload.error && payload.error.message) || 'import failed (' + response.status + ')')
            openDocument(payload.document)
            setLoss(Array.isArray(payload.loss) ? payload.loss : [])
            setImportPath('')
            setPhase('ready')
            setStatus({
              kind: Array.isArray(payload.loss) && payload.loss.length > 0 ? 'warn' : 'info',
              text: Array.isArray(payload.loss) && payload.loss.length > 0 ? 'Imported with ' + payload.loss.length + ' kind(s) of content this tab cannot hold' : 'Imported ' + value,
            })
            await refresh()
          } catch (err) {
            setStatus({ kind: 'err', text: 'Import failed: ' + messageOf(err) })
          }
        },
        [openDocument, refresh, session],
      )

      /** Copy one library document into this conversation. */
      const copyHere = useCallback(
        async (id) => {
          if (!session) return
          try {
            const response = await getJson(DOCUMENT_ROUTE + '?scope=library&id=' + encodeURIComponent(id))
            if (!response.ok) throw new Error(await failureOf(response, 'the library document could not be read'))
            const payload = await response.json()
            const created = await postJson(DOCUMENT_ROUTE, {
              session,
              title: payload.document.title,
              page: payload.document.page,
              blocks: payload.document.blocks,
              by: 'user',
              note: 'copied from the library',
            })
            if (!created.ok) throw new Error('the copy could not be saved (' + created.status + ')')
            const body = await created.json()
            openDocument(body.document)
            setPhase('ready')
            setStatus({ kind: 'info', text: 'Copied into this conversation' })
            await refresh()
          } catch (err) {
            setStatus({ kind: 'err', text: messageOf(err) })
          }
        },
        [openDocument, refresh, session],
      )

      /**
       * Export the open document as a file, and hand a `.docx` to the SHIPPED
       * office preview.
       *
       * This is the whole LibreOffice story in one function: the tab writes a
       * real `.docx` onto the Desktop of the machine running the harness, and core's
       * own preview - whose `docx` body converts with the harness's bundled
       * LibreOffice - renders a workspace copy of it in the right bar. The preview's
       * KIND is read out of the tab-type registry rather than hardcoded, so a
       * harness line that renames it cannot turn this button into a dead one.
       */
      const exportDocument = useCallback(
        async (format, options = {}) => {
          const current = docRef.current
          if (!session || !current) return null
          // EVERY export lands on the DESKTOP of the machine running the harness -
          // that is where a person looks for a file they just asked for, and the file
          // is the whole point of the button. A proof also asks the host for a copy
          // inside the conversation folder, because core's document preview can only
          // read a workspace address; the desktop file is the one that stays.
          const proof = options.proof === true
          setStatus({ kind: 'info', text: proof ? 'Exporting and rendering\u2026' : 'Exporting\u2026' })
          try {
            if (dirtyRef.current) await save({ silent: true })
            const response = await postJson(EXPORT_ROUTE, {
              session,
              id: current.id,
              format,
              target: 'desktop',
              name: options.name,
              proof,
            })
            const payload = await response.json().catch(() => null)
            if (!response.ok) throw new Error((payload && payload.error && payload.error.message) || 'export failed (' + response.status + ')')
            setExported(payload)
            if (proof) {
              const where = payload.dir ? ' to ' + payload.dir : ''
              const previewed = payload.previewPath ? openInPreview(payload.previewPath) : false
              const launched = payload.absolute ? await openInApp(payload.absolute) : false
              setStatus({
                kind: previewed || launched ? 'info' : 'warn',
                text:
                  'Exported ' +
                  payload.name +
                  where +
                  ' \u2014 ' +
                  (previewed ? 'LibreOffice is rendering it in the right bar' : 'nothing in the right bar renders a .docx') +
                  (launched ? ', and it is open in its own application' : previewed ? '' : '; open it from the Desktop to see it') +
                  '.',
              })
            } else {
              setStatus({ kind: 'info', text: 'Exported ' + payload.name + (payload.dir ? ' to ' + payload.dir : '') })
            }
            return payload
          } catch (err) {
            setStatus({ kind: 'err', text: 'Export failed: ' + messageOf(err) })
            return null
          }
        },
        [save, session],
      )

      /** The kind the shipped document preview registered under, read from the registry. */
      /**
       * The kind the shipped document preview registered under, read from the
       * registry - or NULL when this harness has no such tab type.
       *
       * NULL RATHER THAN A FALLBACK. The old answer was a hardcoded `text` kind,
       * which handed a `.docx` to a text preview: the person clicked Proof and got
       * a pane of binary noise, which is worse than no pane at all. A harness that
       * does not register the preview says so in the status bar, and the file on the
       * Desktop (and the application Proof opens) is what shows the export.
       */
      const previewKind = useCallback(() => {
        const ctx = ctxRef.current
        try {
          const registry = ctx && typeof ctx.get === 'function' ? ctx.get(TAB_TYPES_SERVICE) : undefined
          const entries = registry && typeof registry.entries === 'function' ? registry.entries() : null
          for (const definition of Array.isArray(entries) ? entries : []) {
            if (definition && definition.id === PREVIEW_TYPE_ID && typeof definition.kind === 'string') return definition.kind
          }
        } catch (err) {
          /* no registry, or no such type: the caller needs to know */
        }
        return null
      }, [])

      /**
       * Open one exported workspace file in the shipped preview, IN A COLUMN THE
       * PERSON CAN SEE.
       *
       * `openResource` places the tab but does not show the column: a collapsed
       * right bar would take the proof invisibly, which reads as "Proof did nothing"
       * - the bug this fixed. The controller's own `isExpanded`/`toggleExpanded` is
       * the only pair it publishes for that, so the column is expanded when it is
       * not already showing.
       *
       * @param relativePath - the workspace copy the host wrote for rendering.
       * @returns whether a preview was handed the file.
       */
      const openInPreview = useCallback(
        (relativePath) => {
          const ctx = ctxRef.current
          const controller = ctx && typeof ctx.get === 'function' ? ctx.get(SIDEBAR_SERVICE) : undefined
          if (!controller || typeof controller.openResource !== 'function') return false
          const kind = previewKind()
          if (kind === null) return false
          try {
            controller.openResource(FILE_ADDRESS_PREFIX + encodeURIComponent(session) + '/' + relativePath, { kind })
            if (typeof controller.isExpanded === 'function' && typeof controller.toggleExpanded === 'function' && controller.isExpanded() !== true) {
              controller.toggleExpanded()
            }
            return true
          } catch (err) {
            return false
          }
        },
        [previewKind, session],
      )

      /**
       * Open one absolute path on THIS host in the application that owns it.
       *
       * The Remote FACE is resolved through `ctx.get('remote.session')` and never
       * `ctx.remote`: touching a bare `ctx.remote` without inject throws, and a
       * guard that swallows that throw reports "no such remote" on every reload -
       * the trap `dsh-image` documents at its own read site. A failure here is not
       * an error the person has to act on: the file is on the Desktop either way,
       * and the status bar says so.
       *
       * @param absolutePath - the file the host just wrote.
       * @returns whether the host opened it.
       */
      const openInApp = useCallback(async (absolutePath) => {
        const ctx = ctxRef.current
        const remote = ctx && typeof ctx.get === 'function' ? ctx.get('remote.session') : undefined
        if (!remote || typeof remote.openWorkspacePath !== 'function') return false
        try {
          const result = await remote.openWorkspacePath({ path: absolutePath })
          return Boolean(result && result.ok)
        } catch (err) {
          return false
        }
      }, [])

      // ---------------------------------------------------------------------
      // The page breaker module (fetched once, imported from a blob URL)
      // ---------------------------------------------------------------------
      useEffect(() => {
        let cancelled = false
        const load = async () => {
          if (paginatorRef.current) return
          paginatorRef.current = { paginate: fallbackPaginate, degraded: true }
          try {
            if (typeof fetch !== 'function' || !URL || typeof URL.createObjectURL !== 'function' || typeof Blob !== 'function') {
              setPaginatorReady(true)
              return
            }
            const response = await fetch(PAGE_ROUTE, { headers: { accept: 'text/javascript' } })
            if (!response.ok) throw new Error('status ' + response.status)
            const source = await response.text()
            const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
            try {
              const module = await import(/* webpackIgnore: true */ url)
              if (typeof module.paginate === 'function') paginatorRef.current = module
            } finally {
              URL.revokeObjectURL(url)
            }
          } catch (err) {
            // The fallback is already installed and the status bar says so.
          }
          if (!cancelled) setPaginatorReady(true)
        }
        void load()
        return () => {
          cancelled = true
        }
      }, [])

      // ---------------------------------------------------------------------
      // Load on mount: the FILE this pane was opened for, or the conversation's
      // own documents (creating the first one so the tab is never a blank box).
      // ---------------------------------------------------------------------
      useEffect(() => {
        if (!session) {
          setPhase('error')
          setStatus({ kind: 'err', text: 'This tab needs a conversation.' })
          return undefined
        }
        let cancelled = false
        const start = async () => {
          setPhase('loading')
          try {
            if (filePath !== null) {
              await openFile(filePath)
              return
            }
            const payload = await refresh()
            if (cancelled || !payload) return
            if (payload.documents.length > 0) await load(payload.documents[0].id)
            else await create('Untitled')
          } catch (err) {
            if (!cancelled) {
              setPhase('error')
              setStatus({ kind: 'err', text: messageOf(err) })
            }
          }
        }
        void start()
        return () => {
          cancelled = true
        }
      }, [create, filePath, load, openFile, refresh, session])

      // ---------------------------------------------------------------------
      // This machine's fonts, and the outline's link to the mounted editor
      // ---------------------------------------------------------------------
      useEffect(() => {
        let cancelled = false
        const read = async () => {
          try {
            const response = await getJson(FONTS_ROUTE)
            if (!response.ok) throw new Error(await failureOf(response, 'the font list could not be read'))
            const payload = await response.json()
            if (cancelled) return
            setFonts(Array.isArray(payload.families) ? payload.families : [])
            setFontsNote(payload.count + ' families on this machine' + (payload.failed > 0 ? ', ' + payload.failed + ' unreadable file(s)' : ''))
          } catch (err) {
            if (!cancelled) {
              setFonts([])
              setFontsNote('the font list is unavailable: ' + messageOf(err))
            }
          }
        }
        void read()
        return () => {
          cancelled = true
        }
      }, [])

      /**
       * An outline pane asking this editor to show a heading. The pane and the
       * editor are different tabs, so this is the one channel between them: the
       * editor registers, the pane calls, and a jump that cannot be made (the
       * editor is not mounted) is simply not made.
       */
      useEffect(() => {
        const listener = (askedSession, index) => {
          if (askedSession !== session) return
          jumpToRef.current(index)
        }
        FOCUS_LISTENERS.add(listener)
        return () => {
          FOCUS_LISTENERS.delete(listener)
        }
      }, [session])

      /**
       * The document this conversation has open, for the outline pane to read.
       * It is published on every load and removed when the editor goes away.
       */
      useEffect(() => {
        if (!session) return undefined
        if (doc && doc.id) ACTIVE_DOCUMENTS.set(session, { id: doc.id, title: doc.title, origin: doc.origin ?? null })
        return () => {
          if (session && docRef.current === null) ACTIVE_DOCUMENTS.delete(session)
        }
      }, [doc, session])

      // ---------------------------------------------------------------------
      // Autosave, and one last save when the tab goes away
      // ---------------------------------------------------------------------
      useEffect(() => {
        if (!dirty || !doc) return undefined
        const timer = setTimeout(() => {
          void save({ silent: true })
        }, AUTOSAVE_MS)
        return () => clearTimeout(timer)
      }, [dirty, doc, save])

      useEffect(
        () => () => {
          // A tab closing is a component unmount: the last unsaved keystrokes get
          // one attempt. (A whole page reload cannot be caught, which is what the
          // autosave window is for.)
          if (dirtyRef.current && docRef.current) void save({ silent: true, note: 'autosave on close' })
        },
        [save],
      )
      // ---------------------------------------------------------------------
      // The editor surface: one Editor.js instance, one document at a time
      //
      // The editor OWNS what is on screen while a document is open, and the model
      // follows it: `liveRef` holds what the editor last said it holds, and a save
      // reads the editor itself first, so what is written is never one keystroke
      // behind. A document that arrives from the store or from a `.docx` is pushed
      // INTO the editor (`render`), and a document this tab created or saved is
      // pushed the same way - so there is exactly one direction of surprise.
      // ---------------------------------------------------------------------

      /** The mounted editor, and what it holds. */
      const editorRef = useRef(null)
      const liveRef = useRef(null)
      /** The document id the mounted editor was last rendered with. */
      const shownIdRef = useRef(null)
      /** The element Editor.js draws into. */
      const hostRef = useRef(null)
      /** Whether the editor is installed, and why not when it is not. */
      const [editorState, setEditorState] = useState('idle')
      const [editorError, setEditorError] = useState('')
      /** The pending re-read of the editor, so a keystroke is not a translation of
       *  the whole document (and the timer is cleared when the editor is destroyed). */
      const syncTimer = useRef(null)

      /**
       * What the editor holds NOW, as a model document.
       *
       * `editor.saver.save()` is async, and it throws on a half-initialised instance -
       * so this is the one place that call is made, and a throw becomes the model
       * that was already current rather than a lost save. The page break and
       * typography losses the editor reports are merged with the ones the `.docx`
       * importer reported, because the tab has one banner.
       */
      const readLive = useCallback(async () => {
        const editor = editorRef.current
        const current = liveRef.current ?? docRef.current
        if (!current) return null
        if (!editor || typeof editor.saver?.save !== 'function') return current
        try {
          const data = await editor.saver.save()
          const converted = fromEditorData(data)
          const next = { ...current, blocks: converted.blocks, editorLosses: converted.losses }
          liveRef.current = next
          return next
        } catch (err) {
          setStatus({ kind: 'warn', text: 'The editor did not answer: ' + messageOf(err) })
          return current
        }
      }, [])
      /**
       * Re-read the editor into the model WITHOUT saving.
       *
       * The word count, the headings navigator and the loss banner all read the model,
       * so without this they would answer to the last save rather than to what has
       * been typed. It never throws (`readLive` answers the current model instead) and
       * it never re-renders the editor, because the effect that renders is keyed on
       * the document's identity rather than on the model object.
       */
      const syncFromEditor = useCallback(async () => {
        const next = await readLive()
        if (next) applyDoc(next)
      }, [applyDoc, readLive])

      // ---------------------------------------------------------------------
      // The vendored Editor.js surface
      // ---------------------------------------------------------------------

      /**
       * Load the pinned UMD files, in order, each as a `<script>` appended to the
       * head - the same files the routes serve, hashed in `lib/vendor/editorjs/`.
       *
       * A file that does not arrive is NOT a dead tab: the editor mounts with
       * whichever tools did load, and the status bar names the missing ones. That
       * matters more than it sounds: the paragraph tool is this package's own
       * (below), so a tool failure leaves a document that can still be typed in and
       * saved rather than a blank column.
       *
       * @returns `{ missing, skipped }` - the files that failed, and their names.
       */
      const loadEditorSurface = useCallback(async () => {
        const win = typeof window === 'undefined' ? null : window
        if (!win) return { missing: EDITOR_SCRIPTS.map((entry) => entry.file), skipped: [] }
        const missing = []
        for (const entry of EDITOR_SCRIPTS) {
          if (typeof win[entry.global] === 'function') continue
          const loaded = await new Promise((resolve) => {
            const tag = document.createElement('script')
            tag.src = EDITOR_ROUTE + entry.file
            tag.async = false
            let settled = false
            const done = (ok) => {
              if (settled) return
              settled = true
              resolve(ok)
            }
            tag.onload = () => done(true)
            tag.onerror = () => done(false)
            document.head.appendChild(tag)
            // A route that never answers must not hang the tab: this is the
            // difference between "the browser is slow" and "this never loads".
            setTimeout(() => done(false), EDITOR_LOAD_MS)
          })
          if (!loaded || typeof win[entry.global] !== 'function') missing.push(entry.file)
        }
        const skipped = missing
          .filter((file) => file !== 'editorjs.umd.js' && file !== 'paragraph.umd.js')
          .map((file) => file.replace('.umd.js', ''))
        return { missing, skipped }
      }, [])

      /**
       * THIS PACKAGE'S OWN TEXT TOOL.
       *
       * Editor.js's stock paragraph renders a contenteditable and saves its
       * `innerHTML` - which is exactly the shape this model needs, so the tool is
       * small on purpose: it renders the pack's marks (`markHtml`) and reads them
       * back (`runsFromHtmlString`) on save.
       *
       * `data-mark` is declared in `sanitize` so a paste and the browser's own
       * editing keep the attribute instead of stripping it.
       *
       * @param tagName - the element the editable is.
       * @param options - `{ className, title }`.
       */
      function makeTextTool(tagName, options = {}) {
        const className = options.className ?? 'ce-paragraph'
        const title = options.title ?? 'Text'
        return class PackTextTool {
          static get isReadOnlySupported() {
            return true
          }

          static get sanitize() {
            // `data-size` and `data-font` are named HERE or Editor.js's save-time
            // sanitizer drops them with the style attribute - see `runAttributes`.
            return {
              text: { br: true, span: { 'data-mark': true, 'data-size': true, 'data-font': true, style: true }, b: true, i: true, u: true, s: true, code: true },
            }
          }

          static get toolbox() {
            return { title, icon: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 2h10v2H7v7H5V4H1z"/></svg>' }
          }

          constructor({ data, api, readOnly }) {
            this.data = data && typeof data === 'object' ? data : { text: '' }
            this.api = api
            this.readOnly = readOnly === true
          }

          render() {
            const element = document.createElement(tagName)
            element.className = className
            element.setAttribute('data-placeholder', 'Type something, or press Tab for a block')
            element.contentEditable = this.readOnly ? 'false' : 'true'
            // The editor's own write path is HTML, and this is the HTML this pack's
            // reader understands - an empty run is still one break, which is what
            // gives an empty block a caret to sit in.
            element.innerHTML = typeof this.data.text === 'string' && this.data.text.length > 0 ? this.data.text : '<br>'
            return element
          }

          save(element) {
            return { text: element.innerHTML }
          }
        }
      }

      const PackParagraph = makeTextTool('div')

      /** The heading levels the block's own tune offers, in order. */
      const HEADING_LEVELS = [1, 2, 3, 4, 5, 6]

      /**
       * THE PACKAGE'S OWN HEADER TOOL.
       *
       * A paragraph with a LEVEL, and a level is an OPTION this tool offers rather
       * than a fixed type: Editor.js's own header ships a "convert to" submenu that
       * switches an existing block between H1 and H6, and replacing that tool with a
       * plain `h2` - which is what this package used to do - takes that control away
       * and leaves a document whose only heading is a Heading 2.
       *
       * The element is a `div` with the editor's own `ce-header` class and the
       * heading classes the header tool's CSS sizes (`h1`..`h6`), because Headings 1
       * through 6 in one element name would be six element names for one tool. The
       * model still writes a real `<w:pStyle w:val="HeadingN">` into the `.docx`:
       * the level is data, and it is the data that matters.
       */
      class PackHeader extends makeTextTool('div', { className: 'ce-header', title: 'Heading' }) {
        constructor(options) {
          super(options)
          const level = Number(this.data.level)
          this.level = Number.isFinite(level) ? Math.max(1, Math.min(6, Math.round(level))) : 2
        }

        render() {
          const element = super.render()
          this.applyLevel(element, this.level)
          return element
        }

        /** Wear the level the model carries, on the element and as data. */
        applyLevel(element, level) {
          for (const className of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) element.classList.remove(className)
          element.classList.add('h' + level)
          element.setAttribute('data-level', String(level))
        }

        save(element) {
          return { text: element.innerHTML, level: this.level }
        }

        renderSettings() {
          return HEADING_LEVELS.map((level) => ({
            icon: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5"/></svg>',
            label: 'Heading ' + level,
            isActive: level === this.level,
            closeOnActivate: true,
            onActivate: () => {
              this.level = level
              const element = this.toolRenderedElement ?? null
              if (element && typeof this.applyLevel === 'function') this.applyLevel(element, level)
            },
          }))
        }
      }

      /**
       * Build the editor, once, on the holder this tab owns.
       *
       * The paragraph is this pack's tool and so is the header (so a heading keeps
       * its marks); the list, quote and code blocks are the vendored tools. A tool
       * that did not load is simply absent from the map - Editor.js renders a block
       * of a missing type as a paragraph, so the TEXT survives an incomplete
       * surface rather than being lost with it.
       */
      const buildEditor = useCallback(() => {
        const host = hostRef.current
        const win = typeof window === 'undefined' ? null : window
        if (!host || !win || typeof win.EditorJS !== 'function') {
          setEditorError('the vendored Editor.js core did not load (build it with `node packages/dsh-writing/vendor/editorjs/build.mjs`)')
          setEditorState('error')
          return null
        }
        const tools = { paragraph: PackParagraph, header: PackHeader }
        if (typeof win.EditorjsList === 'function') tools.list = win.EditorjsList
        if (typeof win.Quote === 'function') tools.quote = win.Quote
        if (typeof win.Code === 'function') tools.code = win.Code
        const current = liveRef.current ?? docRef.current
        let instance = null
        try {
          instance = new win.EditorJS({
            holder: host,
            tools,
            data: toEditorData(current ?? { blocks: [] }),
            inlineToolbar: EDITOR_INLINE_TOOLS,
            // The pack's own surface is the tab, so the style picker is off: a
            // document's typography belongs to the Document menu (and to the
            // `.docx`), not to a control that writes an inline style per block.
            onChange: () => {
              setDirty(true)
              dirtyRef.current = true
              const editor = editorRef.current
              const index = editor && editor.blocks && typeof editor.blocks.getCurrentBlockIndex === 'function' ? editor.blocks.getCurrentBlockIndex() : -1
              if (index >= 0) setActiveIndex(index)
              // THE MODEL FOLLOWS THE EDITOR, not just the save. What the editor says
              // it holds is read here and merged into the document, so the word
              // count, the headings navigator and the loss banner answer to what has
              // been typed rather than to the last time it was written to disk. The
              // merge is NOT a re-render of the editor (the effect that renders is
              // keyed on the document's identity), so the caret stays where the
              // person put it. It is debounced because a keystroke is not a reason to
              // translate the whole document.
              if (syncTimer.current !== null) clearTimeout(syncTimer.current)
              syncTimer.current = setTimeout(() => {
                syncTimer.current = null
                void syncFromEditor()
              }, SYNC_MS)
            },
          })
        } catch (err) {
          setEditorError(messageOf(err))
          setEditorState('error')
          return null
        }
        editorRef.current = instance
        return instance
      }, [])

      // Mount the editor once the scripts are there, and render a DIFFERENT
      // document into it. The dependency is deliberately the document's IDENTITY
      // (`id` plus the `epoch` tick `openDocument` bumps), never the model object
      // this half keeps manufacturing: re-rendering on every model change would put
      // the caret back to the top of the document on every save.
      useEffect(() => {
        if (!doc || !doc.id || typeof window === 'undefined') return undefined
        let cancelled = false
        const start = async () => {
          setEditorState('loading')
          setEditorError('')
          const surface = await loadEditorSurface()
          if (cancelled) return
          if (surface.missing.indexOf('editorjs.umd.js') !== -1) {
            setEditorError('the vendored Editor.js core did not load (build it with `node packages/dsh-writing/vendor/editorjs/build.mjs`)')
            setEditorState('error')
            return
          }
          if (surface.skipped.length > 0) {
            setStatus({ kind: 'warn', text: 'The editor is missing the ' + surface.skipped.join(', ') + ' tool(s): their blocks show as text.' })
          }
          if (!editorRef.current) buildEditor()
          if (!editorRef.current) return
          if (shownIdRef.current !== doc.id) {
            shownIdRef.current = doc.id
            try {
              setEditorState('rendering')
              // `editor.blocks.render(data)`, NOT `editor.render(data)`: the
              // instance-level `render` was removed from Editor.js in 2.30 and the
              // pin here is 2.31.7, so the old call threw
              // "editor.render is not a function" on the FIRST mount (the
              // constructor had already drawn the blocks, which is why the tab
              // looked fine while the status bar carried that error) and every
              // later document switch left the previous document on screen.
              await renderIntoEditor(editorRef.current, toEditorData(doc))
              if (!cancelled) {
                liveRef.current = doc
                setEditorState('ready')
              }
            } catch (err) {
              if (!cancelled) {
                setEditorError(messageOf(err))
                setEditorState('error')
              }
            }
            return
          }
          liveRef.current = liveRef.current ?? doc
          if (!cancelled) setEditorState('ready')
        }
        void start()
        return () => {
          cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [doc ? doc.id : null, epoch, buildEditor, loadEditorSurface])

      /** Tear the editor down on unmount. Editor.js throws on a double destroy. */
      useEffect(
        () => () => {
          if (syncTimer.current !== null) {
            clearTimeout(syncTimer.current)
            syncTimer.current = null
          }
          const editor = editorRef.current
          editorRef.current = null
          if (editor && typeof editor.destroy === 'function') {
            try {
              editor.destroy()
            } catch (err) {
              /* a destroy that threw is a leak, not a failure of the tab */
            }
          }
        },
        [],
      )

      /** A title edit, as it is typed. */
      const setTitle = useCallback(
        (value) => {
          const current = liveRef.current ?? docRef.current
          if (!current) return
          const next = { ...current, title: value }
          liveRef.current = next
          applyDoc(next)
          setDirty(true)
          dirtyRef.current = true
        },
        [applyDoc],
      )

      /** One page-setup change (size, orientation or a margin). */
      const setPage = useCallback(
        (patch) => {
          const current = liveRef.current ?? docRef.current
          if (!current) return
          const page = { ...current.page, ...patch, margins: { ...current.page.margins, ...(patch.margins ?? {}) } }
          const next = { ...current, page }
          liveRef.current = next
          applyDoc(next)
          setDirty(true)
          dirtyRef.current = true
        },
        [applyDoc],
      )

      /**
       * The document's own family and size - what every run inherits when it names
       * none. One write, and the whole document changes, which is what "this
       * document is set in Georgia" has to mean. The editor's column takes the same
       * two values, so what is typed IS what the `.docx` will say.
       */
      const setDocumentTypography = useCallback(
        (patch) => {
          const current = liveRef.current ?? docRef.current
          if (!current) return
          const next = {
            ...current,
            font: patch.font !== undefined ? patch.font : current.font,
            fontSize: patch.fontSize !== undefined ? patch.fontSize : current.fontSize,
          }
          liveRef.current = next
          applyDoc(next)
          setDirty(true)
          dirtyRef.current = true
        },
        [applyDoc],
      )

      /**
       * Set one run property - the family or the size - on the SELECTION, or on the
       * whole block the caret is in when nothing is selected.
       *
       * EDITOR.JS OWNS THE WRITE, and that is the whole design. A family and a size
       * are run properties (the `.docx` writes `w:rFonts`/`w:sz` per `<w:r>`), so
       * `applyAttributeToRuns` decides the range - and the result goes back through
       * `blocks.update(id, data)`, Editor.js's own way to change one block. Two
       * alternatives were tried against a real browser and both failed for a reason
       * worth keeping: wrapping spans in the DOM by hand left Editor.js's cached block
       * data stale, so the next repaint silently put the run's own size back; and
       * re-rendering the whole document (`blocks.render`) is what this pin answers
       * with "Can't find a Block to remove" and a half-cleared redactor. Going through
       * `blocks.update` means the editor's data and the DOM move together, and the
       * MODEL follows the editor (`syncFromEditor`) exactly as it does for typing.
       *
       * A COLLAPSED CARET MEANS THE BLOCK: a size typed with the caret in a
       * paragraph and nothing selected sets that paragraph, which is the useful
       * reading of "make this line bigger" and is said out loud in the status bar.
       *
       * @param key - `'font'` or `'size'`.
       * @param value - the family name, the size in points, or null to clear.
       * @returns whether anything was written.
       */
      const applyTypographyToSelection = useCallback(
        async (key, value) => {
          const editor = editorRef.current
          const host = hostRef.current
          const current = liveRef.current ?? docRef.current
          if (!editor || !host || !current) {
            // NAMED, never silent: a control that changes nothing and says nothing
            // reads as a broken button.
            setStatus({ kind: 'warn', text: 'The editor is not ready yet \u2014 try again in a moment.' })
            return false
          }
          const target = caretTarget(host)
          if (!target) {
            setStatus({ kind: 'warn', text: 'Put the caret in some text first.' })
            return false
          }
          const modelIndex = modelIndexForEditorBlock(current.blocks, target.index)
          if (modelIndex < 0) {
            setStatus({
              kind: 'warn',
              text: 'A list is the vendored list tool\u2019s block: its items are addressed by the editor\u2019s own index, so a font or size cannot be set inside one from here.',
            })
            return false
          }
          const block = current.blocks[modelIndex]
          if (!block || block.type === 'pageBreak') {
            setStatus({ kind: 'warn', text: 'Put the caret in some text first.' })
            return false
          }
          if (block.type === 'code') {
            setStatus({ kind: 'warn', text: 'A code block carries no runs, so it has no font or size of its own.' })
            return false
          }
          // A QUOTE IS REFUSED RATHER THAN SILENTLY LOST. The vendored quote tool
          // declares `sanitize: { text: { br: true } }` - its own save strips every
          // other attribute - so a family or size set inside a quote would ride in the
          // model until the next save and then vanish, which is the worst of both
          // answers. The refusal names that; this package's own paragraph and header
          // tools keep the attributes their own sanitize config names.
          if (block.type === 'quote') {
            setStatus({
              kind: 'warn',
              text: 'A quote is the vendored quote tool\u2019s block: it keeps text only, so a font or size set here would be dropped at the next save.',
            })
            return false
          }
          // The runs come from the EDITOR's own HTML - the same text the debounced
          // model read would take - so a run the person just typed is part of the
          // range even if the model has not caught up yet.
          const runs = runsFromHtmlString(target.editable.innerHTML)
          const offsets = caretOffsets(target.editable)
          const length = runsLength(runs)
          const collapsed = offsets === null || offsets.start === offsets.end
          // WHERE THE CARET WAS, before the range is re-interpreted as the block: a
          // collapsed caret is restored where the person left it, and a selection is
          // kept selected so what was just sized is still visibly the target.
          const caretAt = offsets ? offsets.start : length
          const start = collapsed ? 0 : Math.min(offsets.start, length)
          const end = collapsed ? length : Math.min(offsets.end, length)
          if (end <= start) {
            setStatus({ kind: 'warn', text: 'This block is empty - type something to give it a size.' })
            return false
          }
          const next = applyAttributeToRuns(block.runs ?? [], start, end, key, value)
          const blocks = current.blocks.map((entry, at) => (at === modelIndex ? { ...entry, runs: next } : entry))
          const document = { ...current, blocks }
          liveRef.current = document
          applyDoc(document)
          setDirty(true)
          dirtyRef.current = true
          // THE EDITOR IS REBUILT FROM THE MODEL, which is the one path this pinned
          // Editor.js has been measured to draw a whole document through - the same
          // one the tab opens a document with. Three other ways were tried against a
          // real browser and each is written down here so nobody repeats them:
          //   - `editor.blocks.render(data)` APPENDS in 2.31.7 once the redactor has
          //     been touched: its `clear()` fails with "Can't find a Block to remove"
          //     and the document is duplicated block for block;
          //   - `editor.blocks.update(id, data)` composes a new block and INSERTS it,
          //     so the change lands as a second block at the end;
          //   - writing the block's `innerHTML` by hand is undone a few frames later,
          //     when Editor.js repaints that block from the data it still holds.
          // A fresh instance starts from the model and therefore cannot disagree with
          // it - and `destroy()` is guarded because Editor.js throws on a double one.
          try {
            if (editor && typeof editor.destroy === 'function') editor.destroy()
          } catch (err) {
            /* an instance that will not die is replaced anyway */
          }
          editorRef.current = null
          // Editor.js leaves its DOM behind when an instance is replaced (and its own
          // `destroy()` is not a guarantee that the holder is empty), so the holder is
          // cleared before the next instance mounts into it.
          if (hostRef.current) hostRef.current.innerHTML = ''
          buildEditor()
          // The caret goes back as soon as the rebuilt editor has drawn the block. This
          // POLLS rather than awaiting the instance's own `isReady`: a second instance
          // in the same holder has been measured to leave that promise unsettled, and an
          // await on it would strand the write half-finished (the model is already
          // written; only the caret is at stake).
          const restoreCaret = (attempt) => {
            const painted = blockElementAt(hostRef.current, target.index)
            if (painted) {
              setCaretOffsets(painted, start, collapsed ? caretAt : end)
              return
            }
            if (attempt < 24 && typeof window !== 'undefined') window.setTimeout(() => restoreCaret(attempt + 1), 25)
          }
          restoreCaret(0)
          // What the selection now carries, so the two controls agree with the model
          // the moment the property lands rather than at the next caret move.
          setActiveProperties(propertiesAt(next, collapsed ? caretAt : start))
          const named = key === 'size' ? (value === null ? 'the document\u2019s size' : Number(value) + 'pt') : value === '' || value === null ? 'the document\u2019s font' : String(value)
          setStatus({ kind: 'info', text: 'Set ' + named + ' on ' + (collapsed ? 'this block' : 'the selection') + '.' })
          return true
        },
        [applyDoc],
      )


      /** This document's headings, for the navigator. */
      const headings = useMemo(() => {
        if (!doc) return []
        return doc.blocks
          .map((block, index) => (block.type === 'heading' ? { index, level: block.level ?? 1, text: block.runs.map((run) => run.text).join('') || '(untitled heading)' } : null))
          .filter(Boolean)
      }, [doc])

      /** Show one heading: hand the editor that block. */
      const jumpTo = useCallback((index) => {
        const editor = editorRef.current
        if (!editor || !editor.blocks) return
        try {
          if (typeof editor.blocks.getBlockByIndex === 'function') {
            const block = editor.blocks.getBlockByIndex(index)
            const holder = block && typeof block.holder === 'function' ? block.holder : null
            if (holder && typeof holder.scrollIntoView === 'function') holder.scrollIntoView({ block: 'center' })
          }
          if (editor.caret && typeof editor.caret.setToBlock === 'function') editor.caret.setToBlock(index, 'start')
        } catch (err) {
          /* a jump that cannot be made is simply not made */
        }
      }, [])
      // The outline pane reaches the editor through FOCUS_LISTENERS, which is
      // registered once - so it calls the LATEST jump through a ref instead of
      // holding a stale one.
      const jumpToRef = useRef(jumpTo)
      jumpToRef.current = jumpTo

      /**
       * Insert a block of one type after the block the caret is in.
       *
       * Editor.js's own block menu does this (its "+" and "/"), and this is the same
       * insertion reached from the Document menu - which is how a heading of a chosen
       * level, a quote or a code block is reachable without knowing that a slash
       * opens a menu. A failed insertion is said in the status bar, not swallowed.
       *
       * @param type - the Editor.js block type.
       * @param data - the block's own data (`{ level }` for a header).
       */
      const insertBlock = useCallback(
        (type, data = {}) => {
          const editor = editorRef.current
          if (!editor || !editor.blocks) {
            setStatus({ kind: 'warn', text: 'The editor is not ready to insert a block yet.' })
            return
          }
          const level = Number.isFinite(Number(data.level)) ? Math.max(1, Math.min(6, Math.round(Number(data.level)))) : 2
          const payload = type === 'header' ? { text: '', level } : data
          try {
            const at = typeof editor.blocks.getCurrentBlockIndex === 'function' ? editor.blocks.getCurrentBlockIndex() : -1
            editor.blocks.insert(type, payload, undefined, at + 1, true)
            setStatus({ kind: 'info', text: 'Inserted a ' + describeBlock({ type: type === 'header' ? 'heading' : type, level }) + ' block.' })
          } catch (err) {
            setStatus({ kind: 'warn', text: 'Could not insert that block: ' + messageOf(err) })
          }
        },
        [],
      )

      /**
       * The editor column's own style: the document's type, scaled by the zoom,
       * with NO width of its own.
       *
       * THE COLUMN ALWAYS FILLS THE PANE. It used to be capped at the page's
       * content width (A4 with 25.4mm margins is 602px, a narrow ribbon in a wide
       * window), and the zoom multiplied that cap - so at 100% the column was a
       * column, and at 200% it finally looked like a document editor. That is
       * backwards: the person is reading on the screen they have, so the width is
       * the PANE's (the block is as wide as its scroll port, minus the 24px
       * gutter) and the ZOOM scales the TYPE instead - which is what a zoom does
       * everywhere else in this app.
       *
       * What the page still decides is the `.docx`: its paper and margins are
       * written by the codec, and the page's own content width is what LibreOffice
       * lays the text out in. The column is the pane; the file is the page.
       */
      const columnStyle = useMemo(() => {
        const style = {}
        if (doc && typeof doc.font === 'string' && doc.font.length > 0) style.fontFamily = styleFamily(doc.font)
        // A size is always written: it is what everything on screen inherits, and
        // leaving it off would make the document's own size invisible. Half-point
        // granularity, because that is what `w:sz` carries and what the model
        // rounds to - a zoomed size no `.docx` could hold would be a lie on screen.
        const size = doc && Number.isFinite(doc.fontSize) ? doc.fontSize : 12
        style.fontSize = Math.round(size * zoom * 2) / 2 + 'pt'
        return style
      }, [doc, zoom])

      /** The block type of the block the caret is in, for the status bar. */
      const activeBlock = useMemo(() => {
        if (!doc || activeIndex === null) return null
        return doc.blocks[activeIndex] ?? null
      }, [doc, activeIndex])

      /**
       * What the editor could not carry, as ONE list for the tab's one banner: what
       * the `.docx` importer already said (tables, images, footnotes) and what a save
       * through Editor.js reports (a page break, a run's own font or size). Counted by
       * kind, so the banner names a kind once with its total.
       */
      const lossEntries = useMemo(() => {
        const current = liveRef.current ?? doc
        const byKind = new Map()
        for (const entry of [...loss, ...(current && Array.isArray(current.editorLosses) ? current.editorLosses : [])]) {
          if (!entry || typeof entry.kind !== 'string') continue
          const existing = byKind.get(entry.kind)
          if (existing) existing.count += Number.isFinite(entry.count) ? entry.count : 1
          else byKind.set(entry.kind, { kind: entry.kind, count: Number.isFinite(entry.count) ? entry.count : 1, note: entry.note })
        }
        return [...byKind.values()]
      }, [doc, loss])

      // ---------------------------------------------------------------------
      // Render
      // ---------------------------------------------------------------------
      const railItems = summaries.map((item) =>
        h(
          'button',
          {
            type: 'button',
            key: 'doc-' + item.id,
            className: 'dsw-railItem',
            'data-doc': item.id,
            'data-active': doc && doc.id === item.id ? 'true' : 'false',
            onClick: () => {
              if (dirtyRef.current && docRef.current && docRef.current.id !== item.id) void save({ silent: true })
              void load(item.id)
            },
          },
          h('span', { className: 'dsw-railTitle' }, item.title || item.id),
          h('span', { className: 'dsw-railMeta' }, item.words + ' words \u00b7 ' + item.blocks + ' blocks \u00b7 ' + shortTime(item.updatedAt)),
        ),
      )

      const bar = h(
        'div',
        { className: 'dsw-bar', 'data-writing-bar': true },
        // NEW IS THE LEFTMOST CONTROL, where a document tab is expected to keep it:
        // the first thing on the bar, left of the title and every other control. It
        // is ONE button, not a menu: a document is what this tab makes and a `.docx`
        // is what the editor writes, so the only choice left to make is the name -
        // and that is the dialog's business.
        h(
          ToolButton,
          {
            title: 'New document \u2014 writes a real .docx on the Desktop',
            action: 'new',
            'data-writing-new': true,
            emphasis: 'primary',
            disabled: !session,
            onClick: newDocument,
          },
          'New',
        ),
        h(
          ToolButton,
          {
            title: showRail ? 'Hide the document list' : 'Show the document list',
            action: 'rail',
            active: showRail,
            onClick: () => setShowRail((value) => !value),
          },
          '\u2630',
        ),
        h('input', {
          className: 'dsw-title',
          'data-writing-title': true,
          value: doc ? doc.title : '',
          placeholder: 'Untitled',
          disabled: !doc,
          onChange: (event) => setTitle(event.target.value),
        }),
        h('span', { className: 'dsw-sep' }),
        // THE FONTS THIS MACHINE HAS. The list is a `<datalist>`, so it filters
        // as the name is typed: a Windows box with 234 families is a list nobody
        // scrolls through, and a typed prefix is how you find one.
        // THE TWO CONTROLS SET THE SELECTION, NOT THE DOCUMENT. The document's own
        // family and size live in the Document menu (`Document font`, `Document
        // size`) and are what every run inherits; these two say what THIS range
        // carries, which is what a person means when they select a phrase and reach
        // for a size. Emptying either clears the property back to the document's.
        h('input', {
          className: 'dsw-font',
          'data-writing-font': true,
          list: 'dsw-fontFamilies',
          placeholder: doc && doc.font ? doc.font : 'Font',
          title: 'The font of the selection \u2014 with nothing selected, of the block the caret is in. The Document menu sets the document\u2019s own font.',
          value: activeProperties.font,
          disabled: !doc,
          onChange: (event) => void applyTypographyToSelection('font', event.target.value),
        }),
        h(
          'datalist',
          { id: 'dsw-fontFamilies' },
          fonts.map((entry) => h('option', { key: 'font-' + entry.family, value: entry.family }, entry.family)),
        ),
        h('input', {
          className: 'dsw-num',
          'data-writing-fontsize': true,
          type: 'number',
          min: '4',
          max: '400',
          step: '0.5',
          title: 'The size of the selection in points \u2014 with nothing selected, of the block the caret is in. Empty it to go back to the document\u2019s size.',
          value: Number.isFinite(activeProperties.size) ? activeProperties.size : doc ? doc.fontSize : '',
          placeholder: doc ? String(doc.fontSize) : '12',
          disabled: !doc,
          onChange: (event) => void applyTypographyToSelection('size', Number(event.target.value)),
        }),
        h(
          ToolButton,
          {
            title: 'Show the headings of this document',
            action: 'headings',
            active: showOutline,
            disabled: !doc,
            onClick: () => setShowOutline((value) => !value),
          },
          'Headings',
        ),
        h(
          'details',
          { className: 'dsw-menu', 'data-writing-pagemenu': true },
          h('summary', null, 'Document'),
          h(
            'div',
            { className: 'dsw-menuPanel', 'data-side': 'left' },
            // The block types Editor.js does not reach from its own toolbar live
            // here. Its block menu inserts them by typing "/", and a control that
            // names the type outright is the one a person hunting for "Heading 1"
            // actually reaches for. EVERY heading level is offered, not just one:
            // a document whose first heading is a level 2 is a document nobody can
            // write a title for.
            h('div', { className: 'dsw-menuRow' }, h('span', null, 'Insert')),
            [1, 2, 3, 4, 5, 6].map((level) =>
              h(
                'button',
                {
                  key: 'insert-heading-' + level,
                  type: 'button',
                  className: 'dsw-menuItem',
                  'data-writing-insert': 'heading-' + level,
                  disabled: !doc,
                  onClick: (event) => {
                    closeMenus(event.currentTarget)
                    insertBlock('header', { level })
                  },
                },
                'Heading ' + level,
              ),
            ),
            ['quote', 'code'].map((what) =>
              h(
                'button',
                {
                  key: 'insert-' + what,
                  type: 'button',
                  className: 'dsw-menuItem',
                  'data-writing-insert': what,
                  disabled: !doc,
                  onClick: (event) => {
                    closeMenus(event.currentTarget)
                    insertBlock(what)
                  },
                },
                what === 'quote' ? 'Quote' : 'Code block',
              ),
            ),
            h('div', { className: 'dsw-menuRow' }, h('span', null, 'Page size')),
            h(
              'select',
              {
                className: 'dsw-select',
                'data-writing-pagesize': true,
                value: doc ? doc.page.size : 'a4',
                disabled: !doc,
                onChange: (event) => setPage({ size: event.target.value }),
              },
              h('option', { value: 'a4' }, 'A4 (210 \u00d7 297 mm)'),
              h('option', { value: 'letter' }, 'Letter (8.5 \u00d7 11 in)'),
            ),
            h('div', { className: 'dsw-menuRow' }, h('span', null, 'Orientation')),
            h(
              'select',
              {
                className: 'dsw-select',
                'data-writing-orientation': true,
                value: doc ? doc.page.orientation : 'portrait',
                disabled: !doc,
                onChange: (event) => setPage({ orientation: event.target.value }),
              },
              h('option', { value: 'portrait' }, 'Portrait'),
              h('option', { value: 'landscape' }, 'Landscape'),
            ),
            ['top', 'right', 'bottom', 'left'].map((side) =>
              h(
                'div',
                { className: 'dsw-menuRow', key: 'margin-' + side },
                h('span', null, side[0].toUpperCase() + side.slice(1) + ' margin (mm)'),
                h('input', {
                  className: 'dsw-num',
                  'data-writing-margin': side,
                  type: 'number',
                  min: '0',
                  max: '100',
                  step: '1',
                  value: doc ? doc.page.margins[side] : 25.4,
                  disabled: !doc,
                  onChange: (event) => setPage({ margins: { [side]: Number(event.target.value) } }),
                }),
              ),
            ),
            // The document's OWN typography: what every run inherits when it names
            // no font of its own. Changing it here is one write, not one per run -
            // which is the difference between "this document is set in Georgia" and
            // "these four hundred runs are".
            h(
              'div',
              { className: 'dsw-menuRow' },
              h('span', null, 'Document font'),
              h('input', {
                className: 'dsw-font',
                'data-writing-docfont': true,
                list: 'dsw-fontFamilies',
                value: doc ? doc.font ?? '' : '',
                placeholder: 'Application default',
                disabled: !doc,
                onChange: (event) => setDocumentTypography({ font: event.target.value }),
              }),
            ),
            h(
              'div',
              { className: 'dsw-menuRow' },
              h('span', null, 'Document size (pt)'),
              h('input', {
                className: 'dsw-num',
                'data-writing-docsize': true,
                type: 'number',
                min: '4',
                max: '400',
                step: '0.5',
                value: doc ? doc.fontSize : 12,
                disabled: !doc,
                onChange: (event) => setDocumentTypography({ fontSize: Number(event.target.value) }),
              }),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dsw-group' },
          h(
            'select',
            {
              className: 'dsw-select',
              'data-writing-zoom': true,
              title: 'How large the type is drawn — the column always fills the pane',
              value: String(zoom),
              onChange: (event) => setZoom(Number(event.target.value)),
            },
            ZOOM_STEPS.map((step) => h('option', { key: 'zoom-' + step, value: String(step) }, Math.round(step * 100) + '%')),
          ),
        ),
        h('span', { className: 'dsw-spacer' }),
        h(
          'div',
          { className: 'dsw-group' },
          conflict
            ? [
                h(
                  ToolButton,
                  {
                    key: 'reload',
                    title: conflict === 'file' ? 'Read the file from disk again' : 'Load the stored version again',
                    action: 'reload',
                    onClick: () => {
                      const current = docRef.current
                      if (!current) return
                      if (conflict === 'file') void openFile(current.origin ? current.origin.path : '', { reload: true })
                      else void load(current.id)
                    },
                  },
                  'Reload',
                ),
                h(
                  ToolButton,
                  {
                    key: 'keep',
                    title: 'Overwrite it with this version',
                    action: 'keep',
                    onClick: () => (conflict === 'file' ? saveToFile({ force: true, silent: false }) : save({ force: true, note: 'overwrote a newer revision' })),
                  },
                  'Keep mine',
                ),
              ]
            : null,
          // THE × IS THE DOCUMENT'S OWN REMOVE. Deleting the document you are writing
          // on is an action you take while looking at it, not one you go looking for
          // in the rail - and the rail's own Delete is still there for the others.
          h(
            ToolButton,
            {
              title: doc ? 'Delete "' + (doc.title || 'Untitled') + '"' : 'Delete this document',
              action: 'delete-document',
              'data-writing-delete': true,
              disabled: !doc || !session,
              onClick: () => {
                const current = docRef.current
                if (current) void remove(current.id)
              },
            },
            '\u00d7',
          ),
          h(ToolButton, { title: 'Save (Ctrl+S)', action: 'save', emphasis: 'primary', disabled: !doc, onClick: () => save({ note: 'saved' }) }, 'Save'),
          h(ToolButton, { title: 'Export as .docx to the Desktop and render it with LibreOffice', action: 'proof', disabled: !doc, onClick: () => exportDocument('docx', { proof: true }) }, 'Proof'),
          h(
            'details',
            { className: 'dsw-menu', 'data-writing-export': true },
            h('summary', null, 'Export'),
            h(
              'div',
              { className: 'dsw-menuPanel', 'data-side': 'right' },
              h('button', { type: 'button', className: 'dsw-menuItem', 'data-export': 'docx', disabled: !doc, onClick: (event) => { closeMenus(event.currentTarget); void exportDocument('docx') } }, 'Word document (.docx) \u2014 to the Desktop'),
              h('button', { type: 'button', className: 'dsw-menuItem', 'data-export': 'md', disabled: !doc, onClick: (event) => { closeMenus(event.currentTarget); void exportDocument('md') } }, 'Markdown (.md) \u2014 to the Desktop'),
              h('button', { type: 'button', className: 'dsw-menuItem', 'data-export': 'txt', disabled: !doc, onClick: (event) => { closeMenus(event.currentTarget); void exportDocument('txt') } }, 'Plain text (.txt) \u2014 to the Desktop'),
              exported ? h('div', { className: 'dsw-menuRow', 'data-writing-exported': true }, h('span', null, 'Last: ' + exported.name)) : null,
            ),
          ),
        ),
      )

      const rail = showRail
        ? h(
            'div',
            { className: 'dsw-rail', 'data-writing-rail': true },
            h(
              'div',
              { className: 'dsw-railHead' },
              h(ToolButton, { title: 'New document', action: 'new', onClick: () => create('Untitled') }, '+ New'),
              h(ToolButton, { title: 'Save now', action: 'save-rail', disabled: !doc || !dirty, onClick: () => save({ note: 'saved' }) }, 'Save'),
            ),
            h(
              'div',
              { className: 'dsw-railList' },
              h('div', { className: 'dsw-railSection' }, 'This conversation'),
              railItems.length > 0 ? railItems : h('div', { className: 'dsw-empty' }, 'No documents yet.'),
              library.length > 0 ? h('div', { className: 'dsw-railSection' }, 'Library') : null,
              library.map((item) =>
                h(
                  'button',
                  {
                    type: 'button',
                    key: 'lib-' + item.id,
                    className: 'dsw-railItem',
                    'data-library': item.id,
                    title: 'Copy this document into the conversation',
                    onClick: () => copyHere(item.id),
                  },
                  h('span', { className: 'dsw-railTitle' }, item.title || item.id),
                  h('span', { className: 'dsw-railMeta' }, 'shared \u00b7 ' + item.words + ' words'),
                ),
              ),
            ),
            h(
              'div',
              { className: 'dsw-railFoot' },
              h(
                'div',
                { className: 'dsw-importRow' },
                h('input', {
                  className: 'dsw-input',
                  'data-writing-import': true,
                  placeholder: 'notes.docx',
                  value: importPath,
                  onChange: (event) => setImportPath(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') void runImport(importPath)
                  },
                }),
                h(ToolButton, { title: 'Import a .docx, .md or .txt from the conversation folder', action: 'import', onClick: () => runImport(importPath) }, 'Import'),
              ),
              h(
                'div',
                { className: 'dsw-importRow' },
                h(ToolButton, { title: 'Publish this document to the library', action: 'publish', disabled: !doc, onClick: publish }, 'Publish'),
                h(ToolButton, { title: 'Delete this document', action: 'delete', disabled: !doc, onClick: () => doc && remove(doc.id) }, 'Delete'),
              ),
            ),
          )
        : null

      /**
       * The headings of this document, as a navigator: the levels are indented,
       * clicking one puts the caret in it, and a document with no headings says
       * so rather than showing an empty box.
       */
      const outline = showOutline
        ? h(
            'div',
            { className: 'dsw-outline', 'data-writing-outline': true },
            h(
              'div',
              { className: 'dsw-outlineHead' },
              h('span', null, 'Headings'),
              h(ToolButton, { title: 'Hide the headings', action: 'headings-hide', onClick: () => setShowOutline(false) }, '\u2715'),
            ),
            h(
              'div',
              { className: 'dsw-outlineList' },
              headings.length === 0
                ? h('div', { className: 'dsw-empty' }, 'No headings yet. Insert one from the Document menu and it appears here.')
                : headings.map((heading) =>
                    h(
                      'button',
                      {
                        type: 'button',
                        key: 'heading-' + heading.index,
                        className: 'dsw-outlineItem',
                        'data-heading-level': heading.level,
                        'data-heading-index': heading.index,
                        'data-heading-active': activeIndex === heading.index ? 'true' : 'false',
                        title: heading.text,
                        onClick: () => jumpTo(heading.index),
                      },
                      h('span', { className: 'dsw-outlineText' }, heading.text),
                    ),
                  ),
            ),
          )
        : null

      /**
       * THE EDITOR COLUMN.
       *
       * The holder is React's to own (`ref`) and Editor.js's to fill: React never
       * renders into it after the editor is mounted, which is exactly the bargain
       * that keeps the caret where the person put it. The note under it is only
       * shown when the editor is not ready, so a failure is a sentence rather than
       * a blank column.
       */
      const editorNote =
        editorState === 'error'
          ? editorError || 'The editor could not start.'
          : phase === 'loading' || editorState === 'loading' || editorState === 'rendering'
            ? 'Opening\u2026'
            : editorState === 'idle'
              ? 'The document is open; the editor starts with it.'
              : ''

      const body = h(
        'div',
        { className: 'dsw-body' },
        rail,
        h(
          'div',
          { className: 'dsw-scroll', 'data-writing-scroll': true },
          doc
            ? h(
                'div',
                { className: 'dsw-editor', 'data-writing-editor': editorState, style: columnStyle },
                h('div', { className: 'dsw-host', ref: hostRef, 'data-writing-editorjs': true }),
                editorNote.length > 0 ? h('div', { className: 'dsw-editorNote', 'data-writing-editor-note': true }, editorNote) : null,
              )
            : h('div', { className: 'dsw-empty' }, phase === 'loading' ? 'Opening\u2026' : 'No document is open.'),
        ),
        outline,
      )

      const lossBanner =
        lossEntries.length > 0
          ? h(
              'div',
              { className: 'dsw-loss', 'data-writing-loss': true },
              h(
                'span',
                { className: 'dsw-lossText' },
                'This document uses content the editor cannot carry, and saving it would drop it: ' +
                  lossEntries.map((entry) => entry.count + ' \u00d7 ' + entry.kind).join(', ') +
                  '. The text is kept in the file; edit these parts in LibreOffice.',
              ),
              h(ToolButton, { title: 'Dismiss', action: 'loss-dismiss', onClick: () => setLoss([]) }, '\u2715'),
            )
          : null

      const footer = h(
        'div',
        { className: 'dsw-status', 'data-writing-status': status.kind, 'data-writing-version': PLUGIN_VERSION },
        h('span', { 'data-writing-words': true }, doc ? wordCountOf(doc) + ' words' : '0 words'),
        h('span', null, '\u00b7'),
        h('span', { 'data-writing-blocks': true }, doc ? doc.blocks.length + ' blocks' : '0 blocks'),
        activeBlock ? h('span', { 'data-writing-active': true }, '\u00b7 ' + describeBlock(activeBlock)) : null,
        h('span', { className: 'dsw-spacer' }),
        // A document linked to a file says which file: it is the thing the person
        // will open in Word or LibreOffice, and it is what Save writes.
        doc && doc.origin && doc.origin.path ? h('span', { 'data-writing-file': true, title: 'Linked to this file in the conversation folder' }, '\u25cf ' + doc.origin.path) : null,
        // The document's own typography, so what it is set in is visible without
        // opening a menu; and how many families this machine offers.
        doc ? h('span', { 'data-writing-font-note': true }, (doc.font ? doc.font + ' ' : '') + doc.fontSize + 'pt') : null,
        fonts.length > 0 ? h('span', { 'data-writing-fonts-note': true, title: fontsNote }, fonts.length + ' fonts') : null,
        status.text ? h('span', { 'data-writing-message': true }, status.text) : null,
        dirty ? h('span', { 'data-writing-dirty': true }, 'unsaved') : null,
      )

      /**
       * THE NEW-FILE DIALOG.
       *
       * A real dialog in the tab's own surface, not `window.prompt`: it can be
       * styled, it keeps a keyboard contract a person can learn (the name is
       * selected, Enter creates, Escape closes), and it can close itself the
       * moment the file exists. The extension is shown beside the field and kept
       * out of what is typed, so nobody has to remember to type ".docx".
       */
      const nameDialog = namePrompt
        ? h(
            'div',
            { className: 'dsw-dialogMask', 'data-writing-dialog': namePrompt.format, onClick: () => setNamePrompt(null) },
            h(
              'div',
              {
                className: 'dsw-dialog',
                role: 'dialog',
                'aria-modal': 'true',
                onClick: (event) => event.stopPropagation(),
              },
              h('div', { className: 'dsw-dialogTitle' }, namePrompt.title),
              h(
                'div',
                { className: 'dsw-dialogRow' },
                h('input', {
                  className: 'dsw-dialogInput',
                  'data-writing-dialogInput': true,
                  autoFocus: true,
                  value: namePrompt.value,
                  onFocus: (event) => {
                    // The suggested name is SELECTED, so typing replaces it and
                    // Enter accepts it: one keystroke either way.
                    try {
                      event.target.select()
                    } catch (err) {
                      /* a browser that will not select still gets the caret */
                    }
                  },
                  onChange: (event) => setNamePrompt({ ...namePrompt, value: event.target.value }),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      const value = String(namePrompt.value ?? '').trim()
                      if (value.length === 0) return
                      void createFile(namePrompt.format, value)
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      setNamePrompt(null)
                    }
                  },
                }),
                h('span', { className: 'dsw-dialogExt' }, namePrompt.extension),
              ),
              h(
                'div',
                { className: 'dsw-dialogActions' },
                h(
                  ToolButton,
                  {
                    title: 'Create the file and open it',
                    action: 'dialog-create',
                    emphasis: 'primary',
                    disabled: String(namePrompt.value ?? '').trim().length === 0,
                    onClick: () => void createFile(namePrompt.format, String(namePrompt.value ?? '').trim()),
                  },
                  'Create',
                ),
                h(ToolButton, { title: 'Close without creating anything', action: 'dialog-cancel', onClick: () => setNamePrompt(null) }, 'Cancel'),
              ),
            ),
          )
        : null

      ctxRef.current = props.ctx ?? ctxRef.current
      return h(
        'div',
        { className: 'dsw-root', 'data-dsh-writing-view': true, 'data-writing-phase': phase },
        bar,
        lossBanner,
        body,
        footer,
        nameDialog,
      )
    }

    /** The word count shown in the status bar, from the model's own text. */
    function wordCountOf(doc) {
      const text = (doc.blocks ?? [])
        .filter((block) => block.type !== 'pageBreak')
        .map((block) => (block.runs ?? []).map((run) => run.text).join(''))
        .join('\n')
        .trim()
      return text.length === 0 ? 0 : text.split(/\s+/).length
    }

    /** A short relative time for the rail, without a date library. */
    function shortTime(iso) {
      const then = Date.parse(String(iso ?? ''))
      if (!Number.isFinite(then)) return ''
      const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
      if (seconds < 60) return 'just now'
      if (seconds < 3600) return Math.round(seconds / 60) + 'm ago'
      if (seconds < 86400) return Math.round(seconds / 3600) + 'h ago'
      return Math.round(seconds / 86400) + 'd ago'
    }

    /**
     * The OUTLINE pane: the headings of whatever document this conversation has
     * open in the Writing tab.
     *
     * It is a second surface rather than a second editor, and that is deliberate:
     * a navigator you can park in the right bar next to the page is the point of
     * having one. It reads the outline from the host (so it works for a document
     * the editor is not even showing) and asks the mounted editor to scroll
     * through {@link FOCUS_LISTENERS} - a jump that cannot be made is simply not
     * made, which is honest for a pane that may be open beside a different tab.
     */
    function OutlinePane(props) {
      const session = typeof props.sessionId === 'string' && props.sessionId.length > 0 ? props.sessionId : typeof props.writingSession === 'string' ? props.writingSession : null
      // A pane with no conversation says so on its FIRST paint rather than
      // pretending to load: the state it is in is known before any effect runs.
      const [state, setState] = useState(() => ({ phase: session ? 'loading' : 'empty', title: '', headings: [], words: 0, blocks: 0 }))
      const [activeIndex, setActiveIndex] = useState(null)
      /** The document to show: whatever the Writing tab has open, re-read on a tick. */
      const [target, setTarget] = useState(null)

      useEffect(() => {
        if (!session) return undefined
        const read = () => {
          const active = ACTIVE_DOCUMENTS.get(session) ?? null
          setTarget(active)
        }
        read()
        // The editor publishes its document as it loads; a navigator has no other
        // way to hear about it, and a one-second poll is cheaper than a channel
        // between two panes that are not otherwise connected.
        const timer = setInterval(read, 1000)
        return () => clearInterval(timer)
      }, [session])

      useEffect(() => {
        if (!session || !target || !target.id) {
          setState((previous) => (previous.phase === 'loading' && !target ? previous : { phase: 'empty', title: '', headings: [], words: 0, blocks: 0 }))
          return undefined
        }
        let cancelled = false
        const read = async () => {
          try {
            const response = await fetch(OUTLINE_ROUTE + '?session=' + encodeURIComponent(session) + '&id=' + encodeURIComponent(target.id))
            if (!response.ok) throw new Error('status ' + response.status)
            const payload = await response.json()
            if (!cancelled) setState({ phase: 'ready', title: payload.title, headings: payload.headings ?? [], words: payload.words ?? 0, blocks: payload.blocks ?? 0 })
          } catch (err) {
            if (!cancelled) setState({ phase: 'error', title: '', headings: [], words: 0, blocks: 0 })
          }
        }
        void read()
        const timer = setInterval(read, 5000)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [session, target])

      const jump = (index) => {
        setActiveIndex(index)
        for (const listener of [...FOCUS_LISTENERS]) {
          try {
            listener(session, index)
          } catch (err) {
            /* a listener that threw is a jump that did not happen */
          }
        }
      }

      return h(
        'div',
        { className: 'dsw-pane', 'data-writing-outline-pane': true, 'data-writing-pane-phase': state.phase },
        h('div', { className: 'dsw-paneBar' }, h('span', { className: 'dsw-paneTitle', 'data-writing-pane-title': true }, state.title || 'Headings')),
        state.phase === 'empty'
          ? h('div', { className: 'dsw-empty' }, 'Open a document in the Writing tab and its headings appear here.')
          : state.phase === 'error'
            ? h('div', { className: 'dsw-empty' }, 'The headings could not be read.')
            : state.headings.length === 0
              ? h('div', { className: 'dsw-empty' }, 'This document has no headings yet.')
              : h(
                  'div',
                  { className: 'dsw-outlineList' },
                  state.headings.map((heading) =>
                    h(
                      'button',
                      {
                        type: 'button',
                        key: 'pane-heading-' + heading.index,
                        className: 'dsw-outlineItem',
                        'data-heading-level': heading.level,
                        'data-heading-index': heading.index,
                        'data-heading-active': activeIndex === heading.index ? 'true' : 'false',
                        title: heading.text,
                        onClick: () => jump(heading.index),
                      },
                      h('span', { className: 'dsw-outlineText' }, heading.text),
                    ),
                  ),
                ),
        h('div', { className: 'dsw-status' }, h('span', null, state.words + ' words'), h('span', { className: 'dsw-spacer' }), h('span', null, state.headings.length + ' headings')),
      )
    }

    /**
     * The SHEET pane: a workbook, edited as a grid.
     *
     * It is a separate surface from the page editor on purpose. A spreadsheet is
     * not a page of text: its cell is addressed, its keyboard walks a grid, and
     * its number is a number. What it SHARES with the page editor is the whole
     * host half - the same store, the same `origin` link to a real file on disk,
     * the same "Save writes the file" rule - so the only thing here is the grid.
     *
     * NOTHING HERE COMPUTES A FORMULA, and that is the design, not a gap: a
     * formula is kept as the text the file carries (`<f>` with no cached value)
     * and LibreOffice - the engine the harness already ships - is what evaluates
     * it, both in the Proof hand-off and in whatever the person opens next. A
     * second formula engine would be a second answer to the same question.
     */
    function SheetView(props) {
      const fileProp = props.file && typeof props.file === 'object' ? props.file : null
      const session =
        fileProp && typeof fileProp.sessionId === 'string' && fileProp.sessionId.length > 0
          ? fileProp.sessionId
          : typeof props.sessionId === 'string' && props.sessionId.length > 0
            ? props.sessionId
            : typeof props.writingSession === 'string'
              ? props.writingSession
              : null
      const filePath = fileProp && typeof fileProp.path === 'string' && fileProp.path.length > 0 ? fileProp.path : null
      const ctxRef = useRef(props.ctx ?? null)
      const [doc, setDoc] = useState(null)
      const docRef = useRef(null)
      // A pane with no file to open says so on its FIRST paint rather than
      // pretending to load: the state it is in is known before any effect runs.
      const [phase, setPhase] = useState(() => (filePath !== null ? 'loading' : 'empty'))
      const [status, setStatus] = useState({ kind: 'info', text: '' })
      const [dirty, setDirty] = useState(false)
      const dirtyRef = useRef(false)
      const [activeSheet, setActiveSheet] = useState(0)
      const [activeCell, setActiveCell] = useState({ row: 0, column: 0 })
      const [viewRows, setViewRows] = useState(SHEET_VIEW_ROWS)
      const [conflict, setConflict] = useState(false)
      const cellRefs = useRef({})

      const applyDoc = useCallback((next) => {
        docRef.current = next
        setDoc(next)
      }, [])

      /** Read the file this pane was opened for. */
      const open = useCallback(
        async (options = {}) => {
          if (!session || !filePath) {
            setPhase('empty')
            return
          }
          setPhase('loading')
          try {
            const response = await postJson(OPEN_FILE_ROUTE, { session, path: filePath, reload: options.reload === true, by: 'user' })
            const payload = await response.json().catch(() => null)
            if (!response.ok) throw new Error((payload && payload.error && payload.error.message) || 'could not open the file (' + response.status + ')')
            applyDoc(payload.document)
            setDirty(false)
            dirtyRef.current = false
            setConflict(false)
            setActiveSheet(0)
            setViewRows(Math.max(SHEET_VIEW_ROWS, Math.min(SHEET_MAX_ROWS, (payload.document.sheets[0] ? payload.document.sheets[0].rows.length : 0) + 5)))
            setPhase('ready')
            setStatus({ kind: 'info', text: 'Opened ' + filePath })
          } catch (err) {
            setPhase('error')
            setStatus({ kind: 'err', text: messageOf(err) })
          }
        },
        [applyDoc, filePath, session],
      )

      useEffect(() => {
        void open()
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [filePath, session])

      /** Write the workbook to the store AND back to its file. */
      const save = useCallback(
        async (options = {}) => {
          const current = docRef.current
          if (!session || !current) return false
          if (options.silent !== true) setStatus({ kind: 'info', text: 'Saving\u2026' })
          try {
            const response = await postJson(DOCUMENT_ROUTE, {
              session,
              id: current.id,
              kind: 'sheet',
              title: current.title,
              sheets: current.sheets,
              by: 'user',
              note: options.note ?? 'edited',
              expectedRevision: options.force === true ? undefined : current.revision,
            })
            if (!response.status || response.status === 409) {
              const payload = await response.json().catch(() => null)
              if (payload && payload.error && payload.error.code === 'CONFLICT') {
                setConflict(true)
                setStatus({ kind: 'warn', text: 'This workbook changed elsewhere \u2014 save anyway?' })
                return false
              }
            }
            if (!response.ok) {
              const payload = await response.json().catch(() => null)
              throw new Error((payload && payload.error && payload.error.message) || 'save failed (' + response.status + ')')
            }
            const payload = await response.json()
            applyDoc(payload.document)
            setDirty(false)
            dirtyRef.current = false
            setConflict(false)
            const written = await postJson(SAVE_FILE_ROUTE, {
              session,
              id: payload.document.id,
              expected: current.origin ? { mtimeMs: current.origin.mtimeMs, size: current.origin.size } : undefined,
              force: options.force === true,
            })
            const writtenBody = await written.json().catch(() => null)
            if (written.status === 409) {
              setConflict(true)
              setStatus({ kind: 'warn', text: 'The file changed on disk \u2014 reload it, or save anyway to keep this version.' })
              return false
            }
            if (!written.ok) throw new Error((writtenBody && writtenBody.error && writtenBody.error.message) || 'could not write the file (' + written.status + ')')
            setStatus({ kind: 'info', text: 'Wrote ' + writtenBody.name + ' (' + writtenBody.bytes + ' bytes)' })
            return true
          } catch (err) {
            setStatus({ kind: 'err', text: 'Save failed: ' + messageOf(err) })
            return false
          }
        },
        [applyDoc, session],
      )

      useEffect(() => {
        if (!dirty || !doc) return undefined
        const timer = setTimeout(() => {
          void save({ silent: true })
        }, AUTOSAVE_MS)
        return () => clearTimeout(timer)
      }, [dirty, doc, save])

      /** One cell's text changed. */
      const setCell = useCallback(
        (row, column, text) => {
          const current = docRef.current
          if (!current) return
          const sheets = current.sheets.map((sheet, index) => {
            if (index !== activeSheet) return sheet
            const rows = sheet.rows.map((entry) => entry.slice())
            while (rows.length <= row) rows.push([])
            while (rows[row].length <= column) rows[row].push(null)
            rows[row][column] = parseCellInput(text)
            const width = rows.reduce((widest, entry) => Math.max(widest, entry.length), 0)
            for (const entry of rows) {
              while (entry.length < width) entry.push(null)
            }
            return { ...sheet, rows }
          })
          applyDoc({ ...current, sheets })
          setDirty(true)
          dirtyRef.current = true
        },
        [activeSheet, applyDoc],
      )

      /** Add one sheet, up to the cap the store enforces. */
      const addSheet = useCallback(() => {
        const current = docRef.current
        if (!current) return
        if (current.sheets.length >= SHEET_MAX_SHEETS) {
          setStatus({ kind: 'warn', text: 'A workbook holds at most ' + SHEET_MAX_SHEETS + ' sheets.' })
          return
        }
        const sheets = current.sheets.concat([{ name: 'Sheet' + (current.sheets.length + 1), rows: [[null]] }])
        applyDoc({ ...current, sheets })
        setActiveSheet(sheets.length - 1)
        setDirty(true)
        dirtyRef.current = true
      }, [applyDoc])

      /** Remove the active sheet (a workbook keeps at least one). */
      const removeSheet = useCallback(() => {
        const current = docRef.current
        if (!current || current.sheets.length <= 1) return
        const sheets = current.sheets.filter((sheet, index) => index !== activeSheet)
        applyDoc({ ...current, sheets })
        setActiveSheet(Math.max(0, activeSheet - 1))
        setDirty(true)
        dirtyRef.current = true
      }, [activeSheet, applyDoc])

      /** Rename the active sheet. */
      const renameSheet = useCallback(
        (name) => {
          const current = docRef.current
          if (!current) return
          const sheets = current.sheets.map((sheet, index) => (index === activeSheet ? { ...sheet, name } : sheet))
          applyDoc({ ...current, sheets })
          setDirty(true)
          dirtyRef.current = true
        },
        [activeSheet, applyDoc],
      )

      /** Export a COPY (the file itself is written by Save). */
      const exportCopy = useCallback(
        async (format) => {
          const current = docRef.current
          if (!session || !current) return
          try {
            const response = await postJson(EXPORT_ROUTE, { session, id: current.id, format, target: 'workspace' })
            const payload = await response.json().catch(() => null)
            if (!response.ok) throw new Error((payload && payload.error && payload.error.message) || 'export failed (' + response.status + ')')
            setStatus({ kind: 'info', text: 'Exported ' + payload.name })
          } catch (err) {
            setStatus({ kind: 'err', text: messageOf(err) })
          }
        },
        [session],
      )

      /**
       * The kind the shipped preview registered: where Proof renders this file, or
       * null when this harness has no such tab type (never a hardcoded `text` kind,
       * which would hand a workbook to a text preview).
       */
      const previewKind = useCallback(() => {
        const ctx = ctxRef.current
        try {
          const registry = ctx && typeof ctx.get === 'function' ? ctx.get(TAB_TYPES_SERVICE) : undefined
          const entries = registry && typeof registry.entries === 'function' ? registry.entries() : null
          for (const definition of Array.isArray(entries) ? entries : []) {
            if (definition && definition.id === PREVIEW_TYPE_ID && typeof definition.kind === 'string') return definition.kind
          }
        } catch (err) {
          /* no registry, or no such type */
        }
        return null
      }, [])

      /** Write the file, then let core's own preview render it with LibreOffice. */
      const proof = useCallback(async () => {
        const current = docRef.current
        const origin = current && current.origin ? current.origin : null
        if (!origin || typeof origin.path !== 'string') return
        const ok = await save({ note: 'wrote before Proof' })
        if (!ok) return
        const ctx = ctxRef.current
        const controller = ctx && typeof ctx.get === 'function' ? ctx.get(SIDEBAR_SERVICE) : undefined
        const kind = previewKind()
        if (!controller || typeof controller.openResource !== 'function' || kind === null) {
          setStatus({ kind: 'warn', text: 'Wrote ' + origin.path + ' \u2014 this harness has no office preview to render it with' })
          return
        }
        try {
          controller.openResource(FILE_ADDRESS_PREFIX + encodeURIComponent(session) + '/' + origin.path, { kind })
          if (typeof controller.isExpanded === 'function' && typeof controller.toggleExpanded === 'function' && controller.isExpanded() !== true) {
            controller.toggleExpanded()
          }
          setStatus({ kind: 'info', text: 'Wrote ' + origin.path + ' \u2014 LibreOffice is rendering it' })
        } catch (err) {
          setStatus({ kind: 'warn', text: 'Wrote ' + origin.path })
        }
      }, [previewKind, save, session])

      /** The grid's keyboard: Enter walks down, Tab walks right, Escape blurs. */
      const onCellKeyDown = useCallback(
        (row, column, event) => {
          const key = String(event.key ?? '')
          const accel = event.ctrlKey === true || event.metaKey === true
          if (accel && (key === 's' || key === 'S')) {
            event.preventDefault()
            void save({ note: 'saved' })
            return
          }
          if (key === 'Enter' || key === 'ArrowDown') {
            event.preventDefault()
            focusCell(row + 1, column)
            return
          }
          if (key === 'ArrowUp') {
            event.preventDefault()
            focusCell(row - 1, column)
            return
          }
          if (key === 'Tab') {
            event.preventDefault()
            focusCell(row, column + (event.shiftKey === true ? -1 : 1))
            return
          }
          if (key === 'ArrowRight' || key === 'ArrowLeft') {
            // Only at the END of the text: inside a cell the arrows are the
            // caret's, which is what every spreadsheet does.
            const selection = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null
            const atEdge = selection && selection.isCollapsed
            if (atEdge) {
              event.preventDefault()
              focusCell(row, column + (key === 'ArrowRight' ? 1 : -1))
            }
          }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [save],
      )

      /** Put the caret in one cell, growing the grid if the walk reached past it. */
      const focusCell = useCallback((row, column) => {
        const nextRow = Math.max(0, Math.min(SHEET_MAX_ROWS - 1, row))
        const nextColumn = Math.max(0, Math.min(SHEET_MAX_COLUMNS - 1, column))
        if (nextRow >= viewRows) setViewRows(Math.min(SHEET_MAX_ROWS, nextRow + 5))
        setActiveCell({ row: nextRow, column: nextColumn })
        const element = cellRefs.current[cellAddress(nextRow, nextColumn)]
        if (element && typeof element.focus === 'function') element.focus()
      }, [viewRows])

      const sheet = doc && doc.sheets[activeSheet] ? doc.sheets[activeSheet] : { name: 'Sheet1', rows: [[]] }
      const grid = useMemo(() => sheetGrid(sheet), [sheet])
      const columnCount = Math.min(SHEET_MAX_COLUMNS, Math.max(SHEET_VIEW_COLUMNS, grid.reduce((widest, row) => Math.max(widest, row.length), 0)))
      const rowCount = Math.min(SHEET_MAX_ROWS, Math.max(viewRows, grid.length))
      const filled = grid.reduce((total, row) => total + row.filter((cell) => cell !== null).length, 0)

      const bar = h(
        'div',
        { className: 'dsw-paneBar' },
        h('span', { className: 'dsw-paneTitle', 'data-sheet-title': true }, doc ? doc.title : 'Workbook'),
        h(ToolButton, { title: 'Save (Ctrl+S)', action: 'sheet-save', emphasis: 'primary', disabled: !doc, onClick: () => save({ note: 'saved' }) }, 'Save'),
        h(ToolButton, { title: 'Write the file and render it with LibreOffice', action: 'sheet-proof', disabled: !doc, onClick: proof }, 'Proof'),
        h(
          'details',
          { className: 'dsw-menu', 'data-sheet-export': true },
          h('summary', null, 'Export'),
          h(
            'div',
            { className: 'dsw-menuPanel', 'data-side': 'right' },
            h('button', { type: 'button', className: 'dsw-menuItem', 'data-export': 'xlsx', disabled: !doc, onClick: () => exportCopy('xlsx') }, 'Workbook (.xlsx) \u2014 a copy beside the original'),
            h('button', { type: 'button', className: 'dsw-menuItem', 'data-export': 'txt', disabled: !doc, onClick: () => exportCopy('txt') }, 'Tab-separated text (.txt)'),
          ),
        ),
      )

      const tabs = h(
        'div',
        { className: 'dsw-sheetTabs', 'data-sheet-tabs': true },
        (doc ? doc.sheets : []).map((entry, index) =>
          h(
            'button',
            {
              type: 'button',
              key: 'sheet-tab-' + index,
              className: 'dsw-sheetTab',
              'data-sheet-tab': index,
              'data-active': index === activeSheet ? 'true' : 'false',
              onClick: () => {
                setActiveSheet(index)
                setActiveCell({ row: 0, column: 0 })
              },
            },
            entry.name,
          ),
        ),
        h(ToolButton, { title: 'Add a sheet', action: 'sheet-add', disabled: !doc, onClick: addSheet }, '+'),
        h(ToolButton, { title: 'Remove this sheet', action: 'sheet-remove', disabled: !doc || (doc && doc.sheets.length <= 1), onClick: removeSheet }, '\u2212'),
        h('input', {
          className: 'dsw-input dsw-sheetName',
          'data-sheet-name': true,
          value: sheet.name,
          disabled: !doc,
          title: 'Rename this sheet',
          onChange: (event) => renameSheet(event.target.value),
        }),
        h('span', { className: 'dsw-spacer' }),
        h('span', { 'data-sheet-cell': true }, cellAddress(activeCell.row, activeCell.column)),
      )

      const gridElement = h(
        'div',
        { className: 'dsw-gridWrap', 'data-sheet-grid': true },
        h(
          'table',
          { className: 'dsw-grid' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', { className: 'dsw-gridCorner' }, ''),
              Array.from({ length: columnCount }, (_, column) =>
                h(
                  'th',
                  { key: 'col-' + column, className: 'dsw-gridHead', 'data-column': column, 'data-active': column === activeCell.column ? 'true' : 'false' },
                  columnName(column),
                ),
              ),
            ),
          ),
          h(
            'tbody',
            null,
            Array.from({ length: rowCount }, (_, row) =>
              h(
                'tr',
                { key: 'row-' + row },
                h('th', { className: 'dsw-gridHead', 'data-row': row, 'data-active': row === activeCell.row ? 'true' : 'false' }, String(row + 1)),
                Array.from({ length: columnCount }, (_, column) => {
                  const cell = grid[row] ? grid[row][column] ?? null : null
                  const address = cellAddress(row, column)
                  return h(
                    'td',
                    {
                      key: address,
                      className: 'dsw-cell',
                      'data-cell': address,
                      'data-active': row === activeCell.row && column === activeCell.column ? 'true' : 'false',
                    },
                    h('div', {
                      className: 'dsw-cellInput',
                      contentEditable: true,
                      suppressContentEditableWarning: true,
                      spellCheck: false,
                      ref: (element) => {
                        cellRefs.current[address] = element
                      },
                      onInput: (event) => setCell(row, column, event.currentTarget.textContent ?? ''),
                      onKeyDown: (event) => onCellKeyDown(row, column, event),
                      onFocus: () => setActiveCell({ row, column }),
                      dangerouslySetInnerHTML: { __html: escapeHtml(cellDisplay(cell)) || '<br>' },
                    }),
                  )
                }),
              ),
            ),
          ),
        ),
      )

      return h(
        'div',
        { className: 'dsw-pane', 'data-dsh-sheet-view': true, 'data-sheet-phase': phase },
        bar,
        conflict
          ? h(
              'div',
              { className: 'dsw-loss' },
              h('span', { className: 'dsw-lossText' }, 'The file changed on disk since it was opened.'),
              h(ToolButton, { title: 'Read it again', action: 'sheet-reload', onClick: () => open({ reload: true }) }, 'Reload'),
              h(ToolButton, { title: 'Write this version over it', action: 'sheet-keep', onClick: () => save({ force: true }) }, 'Keep mine'),
            )
          : null,
        phase === 'ready' && doc
          ? gridElement
          : h('div', { className: 'dsw-empty' }, phase === 'loading' ? 'Opening\u2026' : phase === 'error' ? 'The workbook could not be read.' : 'No file to open.'),
        tabs,
        h(
          'div',
          { className: 'dsw-status', 'data-sheet-status': status.kind },
          h('span', null, filled + ' filled cell(s)'),
          h('span', null, '\u00b7'),
          h('span', null, (doc ? doc.sheets.length : 0) + ' sheet(s)'),
          h('span', null, '\u00b7'),
          h('span', null, columnCount + '\u00d7' + rowCount + ' shown'),
          h(ToolButton, { title: 'Show more rows', action: 'sheet-more-rows', disabled: !doc, onClick: () => setViewRows((value) => Math.min(SHEET_MAX_ROWS, value + 20)) }, '+20 rows'),
          h('span', { className: 'dsw-spacer' }),
          dirty ? h('span', null, 'unsaved') : null,
          doc && doc.origin && doc.origin.path ? h('span', { 'data-sheet-file': true }, '\u25cf ' + doc.origin.path) : null,
          status.text ? h('span', { 'data-sheet-message': true }, status.text) : null,
        ),
      )
    }

    // -----------------------------------------------------------------------
    // Plugin entry
    // -----------------------------------------------------------------------
    /** Services the activation waits for: the slot registry the view ring lives in. */
    const inject = ['slots']

    /** The right bar's tab registry, when it is mounted. */
    function tabsNow(ctx) {
      try {
        return ctx && typeof ctx.get === 'function' ? ctx.get(TAB_TYPES_SERVICE) : undefined
      } catch (err) {
        return undefined
      }
    }

    /** The `.docx` this package claims in the right bar (and nothing else). */
    function canOpenDocumentAddress(address) {
      const path = filePathOf(address)
      if (path === null) return false
      const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : ''
      return extension === 'docx'
    }

    /** The `.xlsx` this package claims for the GRID pane. */
    function canOpenSheetAddress(address) {
      const path = filePathOf(address)
      if (path === null) return false
      const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : ''
      return extension === 'xlsx'
    }

    /** The workspace-relative path of a session file address, or null. */
    function filePathOf(address) {
      const text = String(address ?? '')
      const prefix = 'dsh-resource://file/'
      if (!text.startsWith(prefix)) return null
      const rest = text.slice(prefix.length)
      if (!rest.startsWith('session/')) return null
      const parts = rest.slice('session/'.length).split('/')
      const session = parts.shift()
      if (!session || parts.length === 0) return null
      return parts.join('/')
    }

    function apply(ctx) {
      try {
        installStyles(CSS_TAG, CSS)
        // The tab: the conversation view ring's fourth entry, to the right of
        // Canvas (20) - Chat 0, Trajectory 10, Canvas 20, Writing 30. A view
        // receives no `sessionId` prop: the `inject` face is how it learns one.
        ctx.effect(
          () =>
            ctx.slots.inject('conversation.view', () =>
              ctx.slots.register(
                {
                  name: 'conversation.view',
                  id: VIEW_ID,
                  order: 30,
                  label: () => 'Writing',
                  inject: (sessionId) => ({ writingSession: sessionId, ctx }),
                },
                WritingView,
              ),
            ),
          'dsh-writing: writing view',
        )

        // THE RIGHT BAR. Two pane types, registered the way every other tab type
        // in this pack is: a `.docx` opens EDITABLE here (the shipped office
        // preview keeps every other file), and a Headings pane navigates the
        // document the Writing tab has open.
        ctx.effect(() => {
          const registry = tabsNow(ctx)
          if (!registry || typeof registry.register !== 'function') {
            ctx.logger?.debug?.('[dsh-writing] the right bar is not mounted; the pane types are not registered')
            return () => {}
          }
          const offDocument = registry.register({
            id: DOC_TYPE_ID,
            kind: DOC_KIND,
            patterns: ['dsh-resource://file/**'],
            // The `extension` band, like `dsh-editor`, with a `canOpen` that keeps
            // every file this tab cannot actually read: the editor's own veto
            // hands a `.docx` back, and this one takes it.
            priority: 'extension',
            canOpen: canOpenDocumentAddress,
            title: (address) => {
              const path = filePathOf(address)
              return path === null ? 'Writing' : path.slice(path.lastIndexOf('/') + 1)
            },
            guide: [
              {
                order: 30,
                title: () => 'Writing',
                description: () => 'A page you write on, saved as a .docx',
                icon: () => null,
              },
            ],
          })
          const offOutline = registry.register({
            id: OUTLINE_TYPE_ID,
            kind: OUTLINE_KIND,
            patterns: [],
            priority: 'extension',
            canOpen: () => false,
            title: () => 'Headings',
            guide: [
              {
                order: 31,
                title: () => 'Headings',
                description: () => 'The headings of the document the Writing tab has open',
                icon: () => null,
              },
            ],
          })
          const offSheet = registry.register({
            id: SHEET_TYPE_ID,
            kind: SHEET_KIND,
            patterns: ['dsh-resource://file/**'],
            priority: 'extension',
            canOpen: canOpenSheetAddress,
            title: (address) => {
              const path = filePathOf(address)
              return path === null ? 'Sheet' : path.slice(path.lastIndexOf('/') + 1)
            },
            guide: [
              {
                order: 32,
                title: () => 'Sheet',
                description: () => 'A workbook you edit as a grid, saved as a .xlsx',
                icon: () => null,
              },
            ],
          })
          return () => {
            try {
              offDocument()
            } catch (err) {
              /* the bar is going away either way */
            }
            try {
              offOutline()
            } catch (err) {
              /* the bar is going away either way */
            }
            try {
              offSheet()
            } catch (err) {
              /* the bar is going away either way */
            }
          }
        }, 'dsh-writing: right-bar pane types')

        // The pane BODIES, in the keyed seats their definitions name. A pane
        // receives the FILE its address carried (`{ sessionId, path }`), which is
        // what the editor needs to open it.
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: DOC_TYPE_ID,
                  inject: () => ({ ctx }),
                },
                WritingView,
              ),
            ),
          'dsh-writing: document pane body',
        )
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register({ name: 'sidebar.right.pane.tab', key: OUTLINE_TYPE_ID, inject: () => ({ ctx }) }, OutlinePane),
            ),
          'dsh-writing: outline pane body',
        )
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register({ name: 'sidebar.right.pane.tab', key: SHEET_TYPE_ID, inject: () => ({ ctx }) }, SheetView),
            ),
          'dsh-writing: sheet pane body',
        )
        ctx.logger?.debug?.('[dsh-writing] client half active (' + PLUGIN_VERSION + ')')
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[dsh-writing] activation failed', err)
        ctx.logger?.warn?.('[dsh-writing] activation failed', err && err.message ? err.message : err)
      }
    }

    exports.name = 'dsh-writing'
    exports.inject = inject
    exports.apply = apply
    // The pure-ish half a check can reach: the run model, the mark algebra and
    // the block rules whose behaviour is otherwise only visible in a browser.
    exports.__internals = {
      VIEW_ID,
      PLUGIN_VERSION,
      DOC_TYPE_ID,
      DOC_KIND,
      OUTLINE_TYPE_ID,
      OUTLINE_KIND,
      SHEET_TYPE_ID,
      SHEET_KIND,
      SHEET_MAX_ROWS,
      SHEET_MAX_COLUMNS,
      SHEET_MAX_SHEETS,
      PAGE_ADDRESS,
      OUTLINE_ADDRESS,
      PAGE_EXTENSIONS,
      ROUTES: { STATE_ROUTE, DOCUMENT_ROUTE, DELETE_ROUTE, PUBLISH_ROUTE, IMPORT_ROUTE, EXPORT_ROUTE, CREATE_FILE_ROUTE, SAVE_FILE_ROUTE, OPEN_FILE_ROUTE, OUTLINE_ROUTE, FONTS_ROUTE },
      EDITOR_ROUTE,
      EDITOR_SCRIPTS,
      EDITOR_KNOWN_TYPES,
      EDITOR_INLINE_TOOLS,
      MARK_ATTRIBUTE,
      MAX_BLOCKS,
      MARK_BUTTONS,
      BLOCK_CHOICES,
      fallbackPaginate,
      escapeHtml,
      pushRun,
      sameRun,
      normalizeRuns,
      markHtml,
      runsFromHtmlString,
      parseRunStyle,
      styleFamily,
      toEditorData,
      fromEditorData,
      runsFromNodes,
      runsFromPlainText,
      runsLength,
      sliceRuns,
      replaceRange,
      runsHtml,
      marksAt,
      propertiesAt,
      applyMarkToRuns,
      applyAttributeToRuns,
      blockElementAt,
      splitRunsAt,
      mergeRuns,
      runHtml,
      runStyle,
      parseFontSize,
      unquoteFamily,
      blockHtmlString,
      blockAttributes,
      flowStyle,
      describeBlock,
      retypeBlock,
      blockElement,
      pagesElement,
      closeMenus,
      filePathOf,
      canOpenDocumentAddress,
      canOpenSheetAddress,
      columnName,
      cellAddress,
      parseCellInput,
      cellDisplay,
      sheetGrid,
      OutlinePane,
      SheetView,
      wordCountOf: wordCountOf,
    }
    return module.exports
  },
})
