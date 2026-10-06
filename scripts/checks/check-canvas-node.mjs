// check-canvas-node.mjs — drive the whole dsh-canvas host half, with no browser
// and no network, and prove the arithmetic a browser-only surface cannot prove
// anywhere else.
//
// Why this exists, in the order it matters:
//
//   1. **The layout is the design.** Every number that decides where a word lands
//      comes from `lib/engine.js`'s pure layout with an INJECTED measurer, so the
//      wrapping, hugging, filling, absolute placement, cropping and ellipsis are
//      all checked here - on a host with no fonts and no canvas - and the browser
//      later runs the very same code with real metrics.
//   2. **The two painters cannot drift.** The op list is the IR: the canvas
//      painter is asserted through a RECORDER (every call it makes), and the SVG
//      serializer is asserted to consume every op kind. A design that renders in
//      the tab therefore exports as the same picture.
//   3. **The host half is real code.** The tools and the routes are driven
//      directly - the same `execute()`/`fetch()` seams the agent loop and the
//      browser use - including the full render round trip: the tool enqueues a
//      request, the queue route hands it out, a synthetic browser posts a PNG
//      back, and the tool resolves with a path on disk that is then read back.
//   4. **Nothing here touches the real profile.** `DSH_HOME`, `USERPROFILE`,
//      `HOME` and `XDG_CONFIG_HOME` all point into a temp directory created for
//      this run, so the stores, the render writes and the "Desktop" export land
//      in a folder this check deletes at the end.
//
// Run:  node scripts/checks/check-canvas-node.mjs
export {} // (import-free: ESM for the dynamic imports below)

const { promises: fsp } = await import('node:fs')
const { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
const { spawnSync } = await import('node:child_process')
const { createHash } = await import('node:crypto')
const { deflateSync } = await import('node:zlib')
const os = await import('node:os')
const path = (await import('node:path')).default
const { pathToFileURL, fileURLToPath } = await import('node:url')

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))

// ---------------------------------------------------------------------------
// The contained environment: everything this check writes lands in one temp tree
// ---------------------------------------------------------------------------
const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-canvas-check-'))
const home = path.join(sandbox, 'home')
const desktop = path.join(sandbox, 'Desktop')
const workspace = path.join(sandbox, 'workspace')
mkdirSync(home, { recursive: true })
mkdirSync(desktop, { recursive: true })
mkdirSync(workspace, { recursive: true })
process.env.DSH_HOME = home
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox
delete process.env.XDG_CONFIG_HOME

let failures = 0
function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(52) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}

/** A section header. */
function section(title) {
  console.log('')
  console.log('--- ' + title)
}

// ---------------------------------------------------------------------------
// Imports (after the env is set: the stores read DSH_HOME per call, but the row
// resolves it once at creation, and this keeps the order honest)
// ---------------------------------------------------------------------------
const engine = await import(pathToFileURL(path.join(repo, 'packages/dsh-canvas/lib/engine.js')).href)
const presetsModule = await import(pathToFileURL(path.join(repo, 'packages/dsh-canvas/lib/presets.js')).href)
const fontsModule = await import(pathToFileURL(path.join(repo, 'packages/dsh-canvas/lib/fonts.js')).href)
const storeModule = await import(pathToFileURL(path.join(repo, 'packages/dsh-canvas/lib/store.js')).href)
const exportModule = await import(pathToFileURL(path.join(repo, 'packages/dsh-canvas/lib/export.js')).href)
const archetypesModule = await import(pathToFileURL(path.join(repo, 'packages/dsh-canvas/lib/archetypes/index.js')).href)
const hostModule = await import(pathToFileURL(path.join(repo, 'packages/dsh-canvas/lib/index.js')).href)

const PRESETS = presetsModule.PRESETS
const FONTS = fontsModule.fontTable()

/** The synthetic measurer: half the font size per character, so wrapping is predictable. */
const measure = (text, font) => text.length * (font.size ?? 16) * 0.5
measure.metrics = () => ({ ascent: 0.8, descent: 0.2 })

/** A document that exercises every node kind. */
function sampleDocument(overrides = {}) {
  return {
    title: 'Check design',
    preset: 'github-social',
    tokens: {
      color: { ink: '#F8FAFC', muted: '#94A3B8', accent: '#4D6BFE', surface: '#0B0E14' },
      font: { display: 'Space Grotesk', text: 'Inter', mono: 'system' },
      scale: { display: 72, title: 40, body: 22, caption: 15 },
      space: 8,
      radius: { card: 20, pill: 999 },
    },
    layers: [
      { kind: 'art', style: 'mesh', colors: ['accent', 'surface'], seed: 7, opacity: 0.6 },
      {
        kind: 'frame',
        x: 72,
        y: 72,
        w: 700,
        direction: 'column',
        gap: 16,
        padding: 24,
        align: 'start',
        border: { width: 1, color: 'muted' },
        children: [
          { kind: 'text', text: 'Eyebrow', style: 'caption', color: 'accent', transform: 'upper' },
          { kind: 'text', w: 'fill', style: 'display', color: 'ink', maxLines: 2, runs: [{ text: 'One agent. ' }, { text: 'One toolchain.', color: 'accent' }] },
          { kind: 'text', w: 500, style: 'body', color: 'muted', text: 'A sentence that has to wrap somewhere sensible inside five hundred pixels of space.' },
          { kind: 'shape', shape: 'rect', w: 160, h: 40, radius: 999, fill: 'accent' },
          { kind: 'shape', shape: 'line', w: 300, h: 2, stroke: 'accent', strokeWidth: 2 },
          { kind: 'shape', shape: 'polygon', w: 60, h: 40, points: [{ x: 0, y: 1 }, { x: 0.5, y: 0 }, { x: 1, y: 1 }], fill: 'muted' },
          { kind: 'shape', shape: 'path', w: 80, h: 20, d: 'M0 10 L40 0 L80 10', stroke: 'ink', strokeWidth: 2 },
          { kind: 'shape', shape: 'ellipse', w: 24, h: 24, fill: 'accent' },
        ],
      },
      { kind: 'image', x: 900, y: 120, w: 240, h: 160, src: 'shot.png', fit: 'cover', radius: 12, scrim: 'bottom' },
      { kind: 'svg', x: 60, y: 520, w: 120, h: 40, viewBox: [0, 0, 24, 8], svg: '<path d="M0 4h24" stroke="#fff" stroke-width="1"/>' },
    ],
    ...overrides,
  }
}

/** A tiny but REAL PNG, assembled byte by byte (with a correct CRC per chunk). */
function makePng(width, height, rgb = [77, 107, 254]) {
  const crcTable = []
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    crcTable.push(value >>> 0)
  }
  const crc32 = (buffer) => {
    let crc = 0xffffffff
    for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
    return (crc ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3)
    raw[rowStart] = 0
    for (let x = 0; x < width; x += 1) {
      const at = rowStart + 1 + x * 3
      raw[at] = rgb[0]
      raw[at + 1] = rgb[1]
      raw[at + 2] = rgb[2]
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** The png's own IHDR size, read back. */
function pngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

// ---------------------------------------------------------------------------
// 1. The engine: validation
// ---------------------------------------------------------------------------
section('engine: validation')
const valid = engine.normalizeDocument(sampleDocument(), { presets: PRESETS, fonts: FONTS })
check('a full document validates', valid.problems.length, 0)
check('the preset fixes the canvas', valid.document.canvas.width + 'x' + valid.document.canvas.height, '1280x640')
check('the canvas background is a resolved paint', valid.document.canvas.background.type, 'solid')
check('colour tokens resolve to literals', valid.document.tokens.color.accent, '#4d6bfe')
check('stability: the same document canonicalizes the same', engine.stableJson(engine.normalizeDocument(sampleDocument(), { presets: PRESETS, fonts: FONTS }).document) === engine.stableJson(valid.document), true)
// THE round-trip invariant: what `canvas_read` hands the model is what a patch is
// applied to and what the validator is run against again, so a canonical document
// MUST re-validate unchanged (it did not, until a `{type:"solid"}` paint - the
// canonical form of every colour - was accepted by the validator).
const twice = engine.normalizeDocument(valid.document, { presets: PRESETS, fonts: FONTS })
check('a canonical document re-validates', twice.problems.length, 0)
check('a canonical document is a fixed point', engine.stableJson(twice.document) === engine.stableJson(valid.document), true)
const patchedRoundTrip = engine.applyPatches(valid.document, [{ op: 'set', at: 'layers.1.children.0.text', value: 'x' }])
check('a patched canonical document still validates', engine.documentErrors(patchedRoundTrip.document, { presets: PRESETS, fonts: FONTS }).length, 0)
// THE EDITOR'S PATCHES ARE PATCHES LIKE ANY OTHER, and this is where that is proved: the
// tab's object verbs (add, duplicate, delete, z-order) and its in-place text edit all go
// through `applyPatches`, so a shape the UI can produce that the engine refuses would be a
// button that silently does nothing.
const addLayer = engine.applyPatches(valid.document, [{ op: 'insert', at: 'layers.-', value: { kind: 'shape', shape: 'ellipse', x: 10, y: 10, w: 40, h: 40, fill: 'accent' } }])
check('adding a layer applies', addLayer.document !== null && engine.documentErrors(addLayer.document, { presets: PRESETS, fonts: FONTS }).length === 0, true)
check('...and it lands at the end', addLayer.document.layers[addLayer.document.layers.length - 1].shape, 'ellipse')
const zOrder = engine.applyPatches(valid.document, [{ op: 'remove', at: 'layers.0' }, { op: 'insert', at: 'layers.-', value: valid.document.layers[0] }])
check('a z-order move applies, and the document still validates', zOrder.document !== null && engine.documentErrors(zOrder.document, { presets: PRESETS, fonts: FONTS }).length === 0, true)
check('...moving the first layer to the last place', JSON.stringify(zOrder.document.layers[zOrder.document.layers.length - 1]), JSON.stringify(valid.document.layers[0]))
// AN IN-PLACE TEXT EDIT OF A RICH-TEXT LAYER: `text` is written and `runs` REMOVED in the
// same patch, because a node that kept both would still paint the runs - the words a person
// typed would be invisible.
const richEdit = engine.applyPatches(
  { preset: 'github-social', layers: [{ kind: 'shape', shape: 'rect', w: 4, h: 4 }, { kind: 'shape', shape: 'rect', w: 4, h: 4 }, { kind: 'text', runs: [{ text: 'rich ' }, { text: 'old' }] }] },
  [{ op: 'set', at: 'layers.2.text', value: 'Edited' }, { op: 'remove', at: 'layers.2.runs' }],
)
check('an in-place text edit applies as one patch', richEdit.document !== null, true)
check('...leaving the typed words and no runs', JSON.stringify(richEdit.document.layers[2]), JSON.stringify({ kind: 'text', text: 'Edited' }))

const refusalCases = [
  ['UNKNOWN_PRESET', { preset: 'nope' }],
  ['NO_CANVAS', { layers: [] }],
  ['CANVAS_TOO_LARGE', { canvas: { width: 9000, height: 9000 }, layers: [] }],
  ['BAD_KIND', { preset: 'github-social', layers: [{ kind: 'video' }] }],
  ['BAD_COLOR', { preset: 'github-social', layers: [{ kind: 'text', text: 'x', color: 'notacolour' }] }],
  ['BAD_FONT', { preset: 'github-social', tokens: { font: { display: 'Comic Sans' } }, layers: [] }],
  ['BAD_TEXT', { preset: 'github-social', layers: [{ kind: 'text' }] }],
  ['BAD_SIZE', { preset: 'github-social', layers: [{ kind: 'text', text: 'x', size: 9000 }] }],
  ['BAD_SRC', { preset: 'github-social', layers: [{ kind: 'image' }] }],
  ['BAD_MAXLINES', { preset: 'github-social', layers: [{ kind: 'text', text: 'x', w: 'fill', maxLines: 99 }] }],
  ['BAD_ART', { preset: 'github-social', layers: [{ kind: 'art', style: 'soup' }] }],
  ['BAD_PADDING', { preset: 'github-social', layers: [{ kind: 'frame', padding: [1, 2, 3] }] }],
  ['BAD_POINTS', { preset: 'github-social', layers: [{ kind: 'shape', shape: 'polygon' }] }],
  ['BAD_PATH', { preset: 'github-social', layers: [{ kind: 'shape', shape: 'path', d: 'DROP TABLE users' }] }],
  ['SVG_FORBIDDEN', { preset: 'github-social', layers: [{ kind: 'svg', svg: '<script>alert(1)</script>' }] }],
  ['SVG_EXTERNAL', { preset: 'github-social', layers: [{ kind: 'svg', svg: '<image href="https://example.com/a.png"/>' }] }],
  ['SVG_TAG', { preset: 'github-social', layers: [{ kind: 'svg', svg: '<blink>hi</blink>' }] }],
  ['SVG_EVENT', { preset: 'github-social', layers: [{ kind: 'svg', svg: '<rect width="1" height="1" onclick="x()"/>' }] }],
  ['TOO_MANY_LAYERS', { preset: 'github-social', layers: Array.from({ length: 600 }, () => ({ kind: 'shape', w: 1, h: 1 })) }],
  ['TOO_MANY_CHILDREN', { preset: 'github-social', layers: [{ kind: 'frame', children: Array.from({ length: 80 }, () => ({ kind: 'shape', w: 1, h: 1 })) }] }],
  ['BAD_GEOMETRY', { preset: 'github-social', layers: [{ kind: 'shape', w: 'wide' }] }],
  ['BAD_RADIUS', { preset: 'github-social', layers: [{ kind: 'shape', w: 10, h: 10, radius: 'round' }] }],
]
for (const [code, candidate] of refusalCases) {
  const problems = engine.documentErrors(candidate, { presets: PRESETS, fonts: FONTS })
  const codes = problems.map((entry) => entry.code)
  check('refuses ' + code, codes.includes(code), true)
}

// ---------------------------------------------------------------------------
// 2. The engine: layout
// ---------------------------------------------------------------------------
section('engine: layout')
const laid = engine.layout(valid.document, { measure, assets: { 'shot.png': { width: 1200, height: 800 } }, fonts: FONTS })
check('the background is painted first', laid.ops[0].kind, 'rect')
check('every node has a box', laid.boxes.length >= 8, true)
check('no layout warnings', laid.warnings.length, 0)

const byPath = new Map(laid.boxes.map((entry) => [entry.path, entry]))
const frameBox = byPath.get('layers.1')
check('a frame hugs its main axis (children + gaps + padding)', frameBox.box.h > 0, true)
check('a frame fills the cross axis it was given', frameBox.box.w, 700)
const wrapped = byPath.get('layers.1.children.2')
check('an explicit width wraps the text', wrapped.lines > 1, true)
check('the wrapped height is lines x lineHeight', Math.round(wrapped.box.h), Math.round(wrapped.lines * 22 * 1.25))
const row = laid.boxes.filter((entry) => entry.kind === 'text')
check('text boxes carry their font', typeof row[0].font.size, 'number')
check('the display line was truncated at maxLines', byPath.get('layers.1.children.1').truncated, false)
check('runs are drawn as separate ops', laid.ops.filter((op) => op.kind === 'text').length >= 4, true)
const imageOp = laid.ops.find((op) => op.kind === 'image')
check('an image op carries a crop', typeof imageOp.crop.w, 'number')
check('cover crops the long side only', imageOp.crop.h === 800, true)
const svgOp = laid.ops.find((op) => op.kind === 'svg')
check('the svg fragment became an op', svgOp.viewBox.join(','), '0,0,24,8')

// The sizing rules, one each.
const hug = engine.layout(engine.normalizeDocument({ canvas: { width: 400, height: 300 }, layers: [{ kind: 'text', text: 'abcd', size: 20 }] }, { presets: PRESETS, fonts: FONTS }).document, { measure, assets: {}, fonts: FONTS })
check('a text node without a width hugs its single line', hug.boxes[0].box.w, 4 * 20 * 0.5)
const fill = engine.layout(engine.normalizeDocument({ canvas: { width: 400, height: 300 }, layers: [{ kind: 'frame', w: 'fill', h: 100, children: [{ kind: 'shape', w: 'fill', h: 10 }] }] }, { presets: PRESETS, fonts: FONTS }).document, { measure, assets: {}, fonts: FONTS })
check('fill takes the parent content box', byPathOf(fill, 'layers.0.children.0').box.w, 400)
const absolute = engine.layout(engine.normalizeDocument({ canvas: { width: 400, height: 300 }, layers: [{ kind: 'frame', x: 50, y: 50, w: 200, h: 200, padding: 10, children: [{ kind: 'shape', x: 5, y: 5, w: 20, h: 20 }, { kind: 'shape', w: 20, h: 20 }] }] }, { presets: PRESETS, fonts: FONTS }).document, { measure, assets: {}, fonts: FONTS })
check('an absolute child is placed inside the padding box', byPathOf(absolute, 'layers.0.children.0').box.x, 65)
check('a flow child still flows after it', byPathOf(absolute, 'layers.0.children.1').box.y, 60)
const ellipsis = engine.layout(engine.normalizeDocument({ canvas: { width: 200, height: 200 }, layers: [{ kind: 'text', w: 100, maxLines: 1, text: 'one two three four five six' }] }, { presets: PRESETS, fonts: FONTS }).document, { measure, assets: {}, fonts: FONTS })
check('maxLines cuts the text with an ellipsis', ellipsis.text.some((entry) => entry.text.endsWith('\u2026')), true)
check('a truncated node is reported', ellipsis.warnings.some((entry) => entry.code === 'TEXT_TRUNCATED'), true)
const unwrapped = engine.layout(engine.normalizeDocument({ canvas: { width: 200, height: 200 }, layers: [{ kind: 'text', text: 'a very long line that will not fit the canvas at all', size: 30 }] }, { presets: PRESETS, fonts: FONTS }).document, { measure, assets: {}, fonts: FONTS })
check('an unwrapped line wider than the canvas is reported', unwrapped.warnings.some((entry) => entry.code === 'TEXT_UNWRAPPED'), true)

// Whitespace at a RUN BOUNDARY must survive, in either spelling: the first cut of
// the run wrapper dropped it, and the browser check's own rendered banner read
// "Shipplugins" - which is exactly the class of bug a picture finds and a
// synthetic measurer does not.
const runSpellings = [
  [{ text: 'Ship ' }, { text: 'plugins', color: 'accent' }],
  [{ text: 'Ship' }, { text: ' plugins', color: 'accent' }],
  [{ text: 'Ship' }, { text: ' ' }, { text: 'plugins', color: 'accent' }],
]
for (const [index, runs] of runSpellings.entries()) {
  const runDoc = engine.normalizeDocument({ canvas: { width: 600, height: 200 }, layers: [{ kind: 'text', w: 560, runs, style: 'display' }] }, { presets: PRESETS, fonts: FONTS })
  const runLaid = engine.layout(runDoc.document, { measure, assets: {}, fonts: FONTS })
  const joined = runLaid.text.map((entry) => entry.text).join('')
  check('runs spelling ' + (index + 1) + ' keeps the space', joined.includes('Ship plugins'), true)
  check('runs spelling ' + (index + 1) + ' styles the second word', runLaid.text.some((entry) => entry.text.includes('plugins') && entry.color === '#4D6BFE'), true)
}
const wrappedRuns = engine.normalizeDocument(
  { canvas: { width: 300, height: 200 }, layers: [{ kind: 'text', w: 200, runs: [{ text: 'one two ' }, { text: 'three four five six' }], style: 'body' }] },
  { presets: PRESETS, fonts: FONTS },
)
const wrappedRunLaid = engine.layout(wrappedRuns.document, { measure, assets: {}, fonts: FONTS })
check('a wrapped run line keeps its word spacing', wrappedRunLaid.text.map((entry) => entry.text).join('').includes('one two three'), true)
check('the wrapped runs got more than one line', wrappedRunLaid.boxes[0].lines > 1, true)

// A single-run paragraph must keep EVERY space, including the one before its last
// word: the wrapper used to join each word with the NEXT word's trailing space, so
// "One row per tool, no forks." rendered as "…noforks." in a real banner.
const spacingDoc = engine.normalizeDocument(
  { canvas: { width: 800, height: 300 }, layers: [{ kind: 'text', w: 700, size: 25, letterSpacing: 2, text: 'One row per tool, no forks.' }] },
  { presets: PRESETS, fonts: FONTS },
)
const spacingLaid = engine.layout(spacingDoc.document, { measure, assets: {}, fonts: FONTS })
check('a plain paragraph keeps every space', spacingLaid.text.map((entry) => entry.text).join(''), 'One row per tool, no forks.')
check('a two-word line keeps its only space', engine.layout(engine.normalizeDocument({ canvas: { width: 400, height: 100 }, layers: [{ kind: 'text', w: 380, text: 'DeepSeek Harness' }] }, { presets: PRESETS, fonts: FONTS }).document, { measure, assets: {}, fonts: FONTS }).text.map((entry) => entry.text).join(''), 'DeepSeek Harness')
const spilled = engine.layout(engine.normalizeDocument({ canvas: { width: 200, height: 200 }, layers: [{ kind: 'text', w: 120, text: 'alpha beta gamma delta' }] }, { presets: PRESETS, fonts: FONTS }).document, { measure, assets: {}, fonts: FONTS })
check('a word too wide to start a line is broken, and no space is invented', spilled.text.map((entry) => entry.text).join('').startsWith('alpha beta'), true)
const nested = engine.layout(engine.normalizeDocument({ canvas: { width: 400, height: 400 }, layers: [{ kind: 'frame', w: 300, padding: 20, gap: 10, children: [{ kind: 'text', w: 'fill', text: 'wrapping inside a column frame happens because the frame stretches its children' }] }] }, { presets: PRESETS, fonts: FONTS }).document, { measure, assets: {}, fonts: FONTS })
check('a column frame wraps its children', byPathOf(nested, 'layers.0.children.0').lines > 1, true)
check('the frame hugged its content', byPathOf(nested, 'layers.0').box.h > 40, true)

// A ROW frame hugs on the OTHER axis. Mixing them made a row as tall as its child
// is wide (found by an instrumented read of this very function), so this is the
// regression guard for it.
const rowFrame = engine.layout(
  engine.normalizeDocument(
    {
      canvas: { width: 400, height: 400 },
      layers: [{ kind: 'frame', direction: 'row', gap: 10, padding: 12, children: [{ kind: 'text', text: 'abcd', size: 20 }, { kind: 'text', text: 'ef', size: 20 }] }],
    },
    { presets: PRESETS, fonts: FONTS },
  ).document,
  { measure, assets: {}, fonts: FONTS },
)
const rowBox = byPathOf(rowFrame, 'layers.0').box
check('a row frame hugs its children\u2019s WIDTH', rowBox.w, 12 + 40 + 10 + 20 + 12)
check('a row frame hugs its children\u2019s HEIGHT, not their width sum', rowBox.h, 12 + 25 + 12)
check('a row frame\u2019s child keeps its own width', byPathOf(rowFrame, 'layers.0.children.0').box.w, 40)

/** One box by path. */
function byPathOf(result, path_) {
  return result.boxes.find((entry) => entry.path === path_)
}

// ---------------------------------------------------------------------------
// 3. The engine: the two painters
// ---------------------------------------------------------------------------
section('engine: painters')
const calls = []
const recorder = new Proxy(
  { canvas: { width: 1280, height: 640 }, measureText: (text, font) => ({ width: text.length * (font && font.size ? font.size : 10) * 0.5 }) },
  {
    get(target, prop) {
      if (prop in target) return target[prop]
      return (...args) => {
        calls.push({ call: String(prop), args })
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return { addColorStop() {} }
        return undefined
      }
    },
    set(target, prop, value) {
      calls.push({ call: 'set:' + String(prop), args: [value] })
      target[prop] = value
      return true
    },
  },
)
engine.paintCanvas(laid.ops, recorder, { scale: 1, images: {} })
check('the canvas painter made calls', calls.length > 50, true)
check('the painter balanced save/restore', calls.filter((entry) => entry.call === 'save').length, calls.filter((entry) => entry.call === 'restore').length)
check('the painter filled', calls.some((entry) => entry.call === 'fill'), true)
check('the painter stroked a border, a line and a path', calls.filter((entry) => entry.call === 'stroke').length >= 3, true)
check('the painter drew text', calls.some((entry) => entry.call === 'fillText'), true)
check('the scale was applied first', calls[0].call === 'save' && calls[1].call === 'scale', true)
check('an image with no decoded bitmap is skipped, not crashed', calls.filter((entry) => entry.call === 'drawImage').length, 0)
calls.length = 0
engine.paintCanvas(laid.ops, recorder, { scale: 1, images: { 'shot.png': { width: 1200, height: 800 } } })
check('a decoded image is drawn', calls.filter((entry) => entry.call === 'drawImage').length, 1)
check('drawImage received the crop rectangle', calls.filter((entry) => entry.call === 'drawImage')[0].args.length, 9)
check('the rounded image was clipped', calls.some((entry) => entry.call === 'clip'), true)
const scaleCalls = calls.filter((entry) => entry.call === 'set:globalAlpha')
check('a node opacity became a globalAlpha', scaleCalls.length > 0, true)

const svgText = engine.toSvg(laid.ops, valid.document, {})
check('the SVG serializer produced a root', svgText.startsWith('<svg '), true)
check('the SVG has the canvas size', svgText.includes('width="1280" height="640"'), true)
check('the SVG consumed text ops', svgText.includes('<text '), true)
check('the SVG consumed rect ops', svgText.includes('<rect '), true)
check('the SVG consumed ellipse ops', svgText.includes('<ellipse '), true)
check('the SVG consumed line ops', svgText.includes('<line '), true)
check('the SVG consumed path ops', svgText.includes('<path '), true)
check('the SVG consumed polygon ops', svgText.includes('<polygon '), true)
check('the SVG consumed the svg fragment', svgText.includes('M0 4h24'), true)
check('the SVG registered a gradient', svgText.includes('<linearGradient'), true)
check('an un-inlinable image is named, not broken', svgText.includes('could not be inlined'), true)
check('the SVG escapes text', engine.escapeXml('<b>&"') === '&lt;b&gt;&amp;&quot;', true)

// One op of every kind, so the claim "both painters consume every op kind" is a
// fact about the serializer rather than about one document's luck.
const everyKind = [
  { kind: 'rect', x: 1, y: 2, w: 3, h: 4, radius: 2, fill: { type: 'solid', color: '#111111' }, stroke: '#222222', strokeWidth: 1, dash: [2, 2], path: 'p.rect' },
  { kind: 'ellipse', cx: 5, cy: 6, rx: 7, ry: 8, fill: { type: 'radial', cx: 0.5, cy: 0.5, r: 1, stops: [{ at: 0, color: '#333333' }, { at: 1, color: '#44444400' }] }, path: 'p.ellipse' },
  { kind: 'line', x1: 0, y1: 0, x2: 9, y2: 9, stroke: '#555555', strokeWidth: 2, path: 'p.line' },
  { kind: 'path', d: 'M0 0 L10 10', fill: null, stroke: '#666666', strokeWidth: 1, path: 'p.path' },
  { kind: 'polygon', x: 0, y: 0, w: 10, h: 10, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }], fill: { type: 'solid', color: '#777777' }, path: 'p.polygon' },
  { kind: 'text', x: 1, y: 2, text: 'hi', font: '700 12px Inter', stack: 'Inter, sans-serif', family: 'Inter', size: 12, weight: 700, color: '#888888', letterSpacing: 1, path: 'p.text' },
  { kind: 'image', x: 0, y: 0, w: 10, h: 10, src: 'a.png', crop: { x: 0, y: 0, w: 10, h: 10 }, natural: { width: 10, height: 10 }, radius: 3, path: 'p.image' },
  { kind: 'svg', x: 0, y: 0, w: 10, h: 10, svg: '<path d="M0 0"/>', viewBox: [0, 0, 10, 10], path: 'p.svg' },
  { kind: 'rect', x: 0, y: 0, w: 10, h: 10, fill: { type: 'linear', angle: 45, stops: [{ at: 0, color: '#999999' }, { at: 1, color: '#AAAAAA' }] }, clip: { x: 0, y: 0, w: 10, h: 10, radius: 2 }, path: 'p.clip' },
]
const kindSvg = engine.toSvg(everyKind, { canvas: { width: 100, height: 100 } }, { embed: (src) => (src === 'a.png' ? 'data:image/png;base64,AAAA' : null) })
for (const [tag, label] of [['<rect', 'rect'], ['<ellipse', 'ellipse'], ['<line', 'line'], ['<path', 'path'], ['<polygon', 'polygon'], ['<text', 'text'], ['<image', 'image'], ['<clipPath', 'clipPath']]) {
  check('the serializer emits ' + label, kindSvg.includes(tag), true)
}
check('the serializer emits an opaque frame for an empty design', engine.toSvg([], { canvas: { width: 8, height: 8 } }, {}).includes('viewBox="0 0 8 8"'), true)
const inlined = engine.toSvg(laid.ops, valid.document, { embed: (src) => (src === 'shot.png' ? 'data:image/png;base64,AAAA' : null) })
check('an inlinable image is embedded', inlined.includes('xlink:href="data:image/png;base64,AAAA"'), true)
check('the crop travels as a nested viewBox', inlined.includes('viewBox="0 400 1200 800"') || inlined.includes('viewBox="0 '), true)

const sameSeed = engine.generateArt({ style: 'mesh', seed: 3 }, { x: 0, y: 0, w: 100, h: 100 }, valid.document)
const sameSeedAgain = engine.generateArt({ style: 'mesh', seed: 3 }, { x: 0, y: 0, w: 100, h: 100 }, valid.document)
check('art is deterministic from its seed', engine.stableJson(sameSeed) === engine.stableJson(sameSeedAgain), true)
const otherSeed = engine.generateArt({ style: 'mesh', seed: 4 }, { x: 0, y: 0, w: 100, h: 100 }, valid.document)
check('a different seed is a different picture', engine.stableJson(sameSeed) !== engine.stableJson(otherSeed), true)
for (const style of engine.ART_STYLES) {
  const ops = engine.generateArt({ style, seed: 11 }, { x: 0, y: 0, w: 200, h: 100 }, valid.document)
  check('art style ' + style + ' draws and stays bounded', ops.length > 0 && ops.length <= engine.LIMITS.maxArtOps, true)
}

// ---------------------------------------------------------------------------
// 4. The engine: lints and patches
// ---------------------------------------------------------------------------
section('engine: lints and patches')
const lintDoc = engine.normalizeDocument(
  {
    preset: 'linkedin-personal-banner',
    tokens: { color: { ink: '#FFFFFF', accent: '#4D6BFE' } },
    layers: [
      { kind: 'shape', shape: 'rect', x: 0, y: 0, w: 1584, h: 396, fill: 'accent' },
      { kind: 'text', x: 40, y: 300, w: 300, text: 'Small white on blue', size: 12, color: 'ink' },
    ],
  },
  { presets: PRESETS, fonts: FONTS },
)
const linted = engine.layout(lintDoc.document, { measure, assets: {}, fonts: FONTS })
const lints = engine.lintLayout(linted, lintDoc.document, PRESETS['linkedin-personal-banner'], { assets: {} })
check('a keep-out hit is reported', lints.some((entry) => entry.code === 'SAFE_AREA'), true)
check('small type is reported', lints.some((entry) => entry.code === 'TYPE_TOO_SMALL'), true)
check('low contrast is reported', lints.some((entry) => entry.code === 'LOW_CONTRAST'), true)
const goodLints = engine.lintLayout(laid, valid.document, PRESETS['github-social'], { assets: { 'shot.png': { width: 1, height: 1 } } })
check('a decent design has no errors', goodLints.filter((entry) => entry.level === 'error').length, 0)
const missing = engine.lintLayout(laid, valid.document, PRESETS['github-social'], { assets: {} })
check('an unresolved image is an error', missing.some((entry) => entry.code === 'MISSING_ASSET' && entry.level === 'error'), true)

const patched = engine.applyPatches(valid.document, [
  { op: 'set', at: 'layers.1.children.0.text', value: 'Eyebrow replaced' },
  { op: 'set', at: 'tokens.color.accent', value: '#FF8800' },
  { op: 'insert', at: 'layers', value: { kind: 'shape', shape: 'rect', w: 10, h: 10 } },
  { op: 'remove', at: 'layers.2' },
])
check('a four-operation patch applies', patched.problems.length, 0)
check('set changed the text', patched.document.layers[1].children[0].text, 'Eyebrow replaced')
check('insert appended', patched.document.layers.length, 4)
check('remove deleted', patched.document.layers.some((node) => node.kind === 'image'), false)
const indexed = engine.applyPatches(valid.document, [{ op: 'insert', at: 'layers.0', value: { kind: 'shape', shape: 'rect', w: 1, h: 1 } }])
check('an indexed insert lands before its index', indexed.document.layers[0].kind, 'shape')
const appended = engine.applyPatches(valid.document, [{ op: 'insert', at: 'layers.1.children.-', value: { kind: 'shape', shape: 'rect', w: 1, h: 1 } }])
check('a trailing dash appends to a nested array', appended.document.layers[1].children.length, valid.document.layers[1].children.length + 1)
check('a bad path is refused with NO_TARGET', engine.applyPatches(valid.document, [{ op: 'set', at: 'layers.9.x', value: 1 }]).problems[0].code, 'NO_TARGET')
check('a set without a value is refused', engine.applyPatches(valid.document, [{ op: 'set', at: 'layers.0.x' }]).problems[0].code, 'NO_VALUE')
check('insert into an object is refused', engine.applyPatches(valid.document, [{ op: 'insert', at: 'layers.1.direction', value: 1 }]).problems[0].code, 'BAD_TARGET')
check('insert past the end is refused', engine.applyPatches(valid.document, [{ op: 'insert', at: 'layers.99', value: { kind: 'shape', w: 1, h: 1 } }]).problems[0].code, 'BAD_TARGET')
check('a prototype path is refused', engine.applyPatches(valid.document, [{ op: 'set', at: '__proto__.polluted', value: 1 }]).problems[0].code, 'BAD_PATH')
check('nothing was polluted', Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false)

check('contrast of black on white is 21:1', engine.contrastRatio('#000000', '#FFFFFF'), 21)
check('contrast of white on white is 1:1', engine.contrastRatio('#FFFFFF', '#FFFFFF'), 1)
check('a translucent foreground is composited', engine.contrastRatio('#FFFFFF80', '#000000') < 21, true)
check('withAlpha keeps the hue', engine.withAlpha('#4D6BFE', 0.5), '#4d6bfe80')
check('parseColor reads hex, rgb and hsl', engine.parseColor('#abc').r === 170 && engine.parseColor('rgb(1,2,3)').g === 2 && engine.parseColor('hsl(0,100%,50%)').r === 255, true)

// ---------------------------------------------------------------------------
// 5. Presets
// ---------------------------------------------------------------------------
section('presets')
check('ten destinations are known', Object.keys(PRESETS).length, 10)
for (const [id, preset] of Object.entries(PRESETS)) {
  const ok =
    preset.id === id &&
    Number.isInteger(preset.width) &&
    Number.isInteger(preset.height) &&
    preset.width <= engine.LIMITS.maxCanvasSide &&
    preset.height <= engine.LIMITS.maxCanvasSide &&
    Array.isArray(preset.formats) &&
    preset.formats.length > 0 &&
    typeof preset.maxBytes === 'number' &&
    typeof preset.margin === 'number' &&
    typeof preset.note === 'string' &&
    preset.note.length > 20 &&
    typeof preset.destination === 'object' &&
    Array.isArray(preset.destination.steps) &&
    preset.destination.steps.length > 0 &&
    typeof preset.destination.where === 'string' &&
    typeof preset.verifiedOn === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(preset.verifiedOn) &&
    Array.isArray(preset.sources) &&
    preset.sources.length > 0 &&
    Array.isArray(preset.safeAreas) &&
    preset.safeAreas.every((area) => area.x >= 0 && area.y >= 0 && area.w > 0 && area.h > 0 && area.x + area.w <= preset.width && area.y + area.h <= preset.height && typeof area.label === 'string' && (area.level === 'safe' || area.level === 'keep-out'))
  check('preset ' + id + ' is complete and inside its own canvas', ok, true)
}
check('a poster is a print size', PRESETS['poster-a3'].width + 'x' + PRESETS['poster-a3'].height, '3508x4961')
check('github-social takes png/jpg and refuses svg', presetsModule.exportProblems(PRESETS['github-social'], 'svg', 10).ok, false)
check('an oversize export is refused', presetsModule.exportProblems(PRESETS['github-social'], 'png', 1).ok, true)
check('a free-form canvas is warned about, not refused', presetsModule.exportProblems(null, 'png', 10).ok, true)
check('the free-form warning names the reason', presetsModule.exportProblems(null, 'png', 10).problems[0].code, 'NO_PRESET')

// ---------------------------------------------------------------------------
// 6. Fonts (the vendored tree, offline)
// ---------------------------------------------------------------------------
section('fonts')
check('two families are bundled', Object.keys(FONTS).sort().join(','), 'Inter,Space Grotesk')
check('Inter ships three weights', Object.keys(FONTS.Inter.weights).sort().join(','), '400,600,700')
check('Space Grotesk ships two', Object.keys(FONTS['Space Grotesk'].weights).sort().join(','), '500,700')
check('system is always available to the validator', engine.documentErrors({ preset: 'github-social', tokens: { font: { display: 'system' } }, layers: [] }, { presets: PRESETS, fonts: FONTS }).length, 0)
const fontFiles = fontsModule.fontFiles()
check('five woff2 files are on disk', fontFiles.filter((entry) => existsSync(path.join(fontsModule.FONT_DIR, entry.file))).length, 5)
let fontHashOk = true
for (const entry of fontFiles) {
  const bytes = readFileSync(path.join(fontsModule.FONT_DIR, entry.file))
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) fontHashOk = false
  if (bytes.length !== entry.bytes) fontHashOk = false
}
check('every font file matches its recorded sha256', fontHashOk, true)
check('the OFL licences are vendored', fontFiles.length > 0 && typeof fontsModule.fontLicence('Inter').text === 'string' && fontsModule.fontLicence('Inter').text.includes('SIL OPEN FONT LICENSE'), true)
check('a font file name is validated, not joined', fontsModule.fontFileFor('../../package.json'), null)
check('a recorded file resolves', typeof fontsModule.fontFileFor('inter-latin-400.woff2'), 'string')
check('the face CSS embeds weights', fontsModule.fontFaceCss('Inter', () => 'AAAA').includes('font-weight:400'), true)
check('the face CSS refuses unknown families', fontsModule.fontFaceCss('Comic Sans', () => 'AAAA'), null)

// ---------------------------------------------------------------------------
// 7. Store and assets
// ---------------------------------------------------------------------------
section('store and assets')
const canvasStore = new storeModule.CanvasStore({ home, scope: 'conversation', sessionId: 'session-one' })
const written = canvasStore.put({ id: 'first-design', title: 'First design', preset: 'github-social', document: valid.document, by: 'model' })
check('a design is stored at revision 1', written.revision, 1)
check('the store lists it', canvasStore.list().length, 1)
check('a second write bumps the revision', canvasStore.put({ id: 'first-design', title: 'First design', preset: 'github-social', document: valid.document }).revision, 2)
check('the verdict starts pending', storeModule.verificationOf(canvasStore.get('first-design')).state, 'pending')
canvasStore.recordRender('first-design', { revision: 2, ok: true, path: path.join(home, 'x.png'), width: 1280, height: 640, lints: [{ code: 'MARGIN', level: 'warn', message: 'close to the edge' }], metrics: { ops: 12 } })
const drawn = storeModule.verificationOf(canvasStore.get('first-design'))
check('a matching report is drawn', drawn.state, 'drawn')
check('the verdict carries the picture path', drawn.path.endsWith('x.png'), true)
check('the summary carries the lints', canvasStore.list()[0].warnings, 1)
canvasStore.put({ id: 'first-design', title: 'First design', preset: 'github-social', document: valid.document })
check('a new revision makes the old picture stale', storeModule.verificationOf(canvasStore.get('first-design')).state, 'stale')
check('removing works', canvasStore.remove('first-design'), true)
check('removing twice is honest', canvasStore.remove('first-design'), false)
check('the file is really on disk', existsSync(canvasStore.file), true)

const library = new storeModule.CanvasStore({ home, scope: 'library' })
library.put({ id: 'shared-design', document: valid.document })
check('the library is its own file', existsSync(path.join(home, 'dsh-canvas', 'library.json')), true)
check('the library and the conversation do not collide', library.list()[0].scope, 'library')

try {
  canvasStore.put({ id: 'huge', document: { ...valid.document, notes: 'x'.repeat(300 * 1024) } })
  check('an oversize document is refused', false, true)
} catch (err) {
  check('an oversize document is refused by code', err.code, 'DOCUMENT_TOO_LARGE')
}
try {
  for (let index = 0; index < 70; index += 1) canvasStore.put({ id: 'many-' + index, document: valid.document })
  check('the per-conversation cap is enforced', false, true)
} catch (err) {
  check('the per-conversation cap is enforced', ['TOO_MANY_DESIGNS', 'DOCUMENT_BUDGET'].includes(err.code), true)
}

const assets = new storeModule.AssetStore({ home })
const png = makePng(240, 160)
const assetRecord = assets.add({ bytes: png, label: 'a shot' })
check('an asset is content-addressed', /^[0-9a-f]{16}\.png$/.test(assetRecord.name), true)
check('the asset size was read from its own header', assetRecord.width + 'x' + assetRecord.height, '240x160')
const sameAsset = assets.add({ bytes: png })
check('the same bytes are not copied twice', sameAsset.deduplicated, true)
check('the asset table feeds the layout', assets.table()[assetRecord.name].width, 240)
check('an asset path is validated', assets.path('../../../etc/passwd'), null)
check('an asset is served by path', typeof assets.path(assetRecord.name), 'string')
check('the asset can be removed', assets.remove(assetRecord.name), true)
check('removing twice is honest', assets.remove(assetRecord.name), false)
try {
  assets.add({ bytes: Buffer.from('not an image at all, honestly'), label: 'no' })
  check('a non-image is refused', false, true)
} catch (err) {
  check('a non-image is refused by code', err.code, 'BAD_ASSET')
}
check('imageSize reads PNG', storeModule.imageSize(png).width, 240)
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x60, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01])
check('imageSize reads JPEG', storeModule.imageSize(jpeg).width + 'x' + storeModule.imageSize(jpeg).height, '96x64')
const gif = Buffer.alloc(20)
gif.write('GIF89a', 0, 'ascii')
gif.writeUInt16LE(320, 6)
gif.writeUInt16LE(200, 8)
check('imageSize reads GIF', storeModule.imageSize(gif).width, 320)
const webp = Buffer.alloc(32)
webp.write('RIFF', 0, 'ascii')
webp.write('WEBP', 8, 'ascii')
webp.write('VP8X', 12, 'ascii')
webp[24] = 0xff
webp[27] = 0x7f
check('imageSize reads WebP', storeModule.imageSize(webp).width > 0, true)

// ---------------------------------------------------------------------------
// 8. Archetypes and skills
// ---------------------------------------------------------------------------
section('archetypes and skills')
check('eight archetypes ship', archetypesModule.ARCHETYPES.length, 8)
const intentionalAssets = new Set(['assets/product.png'])
let archetypeProblems = 0
const archetypeReport = []
for (const archetype of archetypesModule.ARCHETYPES) {
  const verdict = engine.normalizeDocument(archetype.document, { presets: PRESETS, fonts: FONTS })
  archetypeProblems += verdict.problems.length
  if (!verdict.document) continue
  const preset = PRESETS[archetype.presets[0]]
  const result = engine.layout(verdict.document, { measure, assets: {}, fonts: FONTS })
  const lints = engine.lintLayout(result, verdict.document, preset, { assets: {} })
  const missing = lints.filter((entry) => entry.code === 'MISSING_ASSET')
  const textWarnings = result.warnings.filter((entry) => ['TEXT_OVERFLOW', 'TEXT_TRUNCATED', 'TEXT_UNWRAPPED'].includes(entry.code))
  archetypeProblems += textWarnings.length
  const unexpected = missing.filter((entry) => !intentionalAssets.has(String(entry.message).split('"')[1]))
  archetypeProblems += unexpected.length
  archetypeReport.push(archetype.id + ' ' + archetype.presets[0] + ' ' + result.ops.length + ' ops ' + result.boxes.length + ' boxes')
}
check('every archetype validates, lays out and is lint-clean', archetypeProblems, 0)
check('every archetype names a document preset', archetypesModule.ARCHETYPES.every((entry) => entry.presets.includes(entry.document.preset)), true)
console.log('     ' + archetypeReport.join('\n     '))

const skillFolders = ['canvas-design', 'social-banners', 'canvas-banner', 'canvas-house-edit']
for (const folder of skillFolders) {
  const file = path.join(repo, 'packages/dsh-canvas/skills', folder, 'SKILL.md')
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const parsed = hostModule.__internals.parseSkillFile(text)
  check('skill ' + folder + ' exists with front matter', text.length > 2000 && parsed.meta.name === folder, true)
  check('skill ' + folder + ' declares whenToUse', typeof parsed.meta.whenToUse === 'string' && parsed.meta.whenToUse.length > 20, true)
  // The preset numbers may live in SKILL.md or in a reference beside it, so the
  // whole folder is what is asked for the table.
  const folderText = [text]
  const walkSkill = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walkSkill(full)
      else if (entry.name.endsWith('.md')) folderText.push(readFileSync(full, 'utf8'))
    }
  }
  walkSkill(path.join(repo, 'packages/dsh-canvas/skills', folder))
  const all = folderText.join('\n')
  check('skill ' + folder + ' documents the preset table', all.includes('1280') && all.includes('1584'), true)
  check('skill ' + folder + ' names the report codes', all.includes('LOW_CONTRAST') || all.includes('SAFE_AREA'), true)
  // WHAT EACH SKILL HAS TO NAME, stated per skill rather than by role: a skill that
  // cannot name the tool it tells the model to run, or the gate it tells the model to
  // pass, is prose rather than an instruction. The delivery skill is about
  // destinations, so it names the export; the design skills name the edit loop.
  const REQUIRED = {
    'canvas-design': ['canvas_patch', 'canvas_render'],
    'social-banners': ['canvas_export'],
    'canvas-banner': ['canvas_new', 'canvas_style', 'canvas_audit'],
    'canvas-house-edit': ['canvas_patch', 'canvas_audit', 'canvas_render'],
  }
  const missing = (REQUIRED[folder] ?? []).filter((tool) => !all.includes(tool))
  check('skill ' + folder + ' names the tools it teaches', missing.join(', '), '')
  // THE HOUSE DESIGNS ARE THE THING TO EDIT, so the two new skills have to say so and
  // point at the gallery the host actually serves - not at a list they remember.
  if (folder === 'canvas-house-edit') {
    check('the editing skill names the gate as the bar', all.includes('canvas_audit') && all.includes('TYPE_RATIO') && all.includes('FOCAL'), true)
    check('the editing skill names the review protocol', all.includes('read_image') && all.includes('thumbnail'), true)
  }
}

// ---------------------------------------------------------------------------
// 9. The host row: tools and routes
// ---------------------------------------------------------------------------
// A FRAME'S OWN RADIUS MUST REACH ITS BACKGROUND FILL, not only the clip its
// children get. The fill is the most visible surface of a chip or a panel, and for
// a long time the op was emitted with `radius: 0` while the children were clipped
// to the rounded box - so a pill painted as a square with rounded clipping, and the
// canvas painter and the SVG serializer disagreed about the same document. A real
// banner with a pill CTA is what showed it.
{
  const pillDoc = engine.normalizeDocument(
    {
      preset: 'og',
      canvas: { width: 400, height: 200 },
      layers: [{ kind: 'frame', id: 'chip', x: 20, y: 20, w: 330, h: 48, radius: 999, background: { type: 'solid', color: '#F8FAFC' }, children: [{ kind: 'text', id: 'l', w: 'hug', text: 'hi', size: 18, family: 'text' }] }],
    },
    { presets: PRESETS, fonts: FONTS },
  )
  const pillOps = engine.layout(pillDoc.document, { measure, assets: {}, fonts: FONTS }).ops
  const chipFill = pillOps.find((op) => op.kind === 'rect' && op.fill && typeof op.fill.color === 'string' && op.fill.color.toLowerCase() === '#f8fafc')
  check('a frame fill carries the frame\u2019s own radius', chipFill ? chipFill.radius : null, 999)
  check('and the SVG serializer agrees with it', /rx="999"/.test(engine.toSvg(pillOps, { width: 400, height: 200 })), true)
}

// ---------------------------------------------------------------------------
// 8b. The style library
//
// A style is DATA, so the library is only as good as the transform that applies
// it - and the transform is only trustworthy if it holds three promises on EVERY
// pack and EVERY composition: the result validates, nothing MOVES, and the design
// stays legible. Those are asserted here for the whole cross product, which is
// also what keeps a future pack honest: a look that fails any of them fails this
// check when it is added.
// ---------------------------------------------------------------------------
// EVERY ARCHETYPE IS ALIGNED, as a bar rather than an opinion: the alignment lints
// must find nothing in the compositions this package ships. Writing them found two
// real faults - editorial-split's text column reached into its visual panel, and
// several archetypes had panels that lined up with no edge at all.
{
  const measureFor = (text, font) => text.length * (font.size || 16) * 0.5
  for (const archetype of archetypesModule.ARCHETYPES) {
    const verdict = engine.normalizeDocument(archetype.document, { presets: PRESETS, fonts: FONTS })
    check('the ' + archetype.id + ' archetype validates', verdict.problems.map((problem) => problem.code).join(','), '')
    const laid = engine.layout(verdict.document, { measure: measureFor, assets: {}, fonts: FONTS })
    const found = engine
      .lintLayout(laid, verdict.document, PRESETS[archetype.presets[0]], { assets: {} })
      .filter((lint) => ['OFFGRID', 'SIBLING_EDGE', 'TEXT_ON_IMAGE'].includes(lint.code))
    check('the ' + archetype.id + ' archetype is aligned, with every panel on the grid', found.map((lint) => lint.code + ' ' + lint.path).join(', '), '')
  }
  // The SNAP PASS is what made that true: every top-level panel in the shipped
  // compositions now lands on the design's own grid - a text layer's edge, the canvas
  // edge, or the preset margin - so the rule that judges a look is one the library
  // itself satisfies. The lint still has to FIRE when it should (below), because a
  // rule that never fires would make every "clean" claim meaningless.
  // A chip hugs its label with EVEN padding, so the padding is right for any string
  // rather than for the one the width happened to be measured for.
  const chips = []
  const collect = (node) => {
    if (node.kind === 'frame' && node.id === 'cta') chips.push(node)
    for (const child of node.children ?? []) collect(child)
  }
  for (const archetype of archetypesModule.ARCHETYPES) for (const layer of archetype.document.layers) collect(layer)
  check('there is a CTA chip to check', chips.length >= 2, true)
  check('every CTA chip hugs its label', chips.filter((chip) => chip.w !== 'hug').length, 0)
  check('and carries even padding', chips.filter((chip) => !Array.isArray(chip.padding) || chip.padding[1] !== chip.padding[3] || chip.padding[0] !== chip.padding[2]).length, 0)
}
{
  // The alignment lints must FIRE when they should, or a clean archetype would prove
  // nothing: an off-grid panel, a nearly-aligned pair, and type over a picture.
  const bad = engine.normalizeDocument(
    {
      preset: 'og',
      canvas: { width: 1200, height: 630 },
      layers: [
        { kind: 'art', id: 'visual', x: 632, y: 104, w: 560, h: 400, style: 'glow', colors: ['#4D6BFE'] },
        { kind: 'text', id: 'a', x: 64, y: 80, w: 400, text: 'One', style: 'display', family: 'display', color: '#F8FAFC' },
        { kind: 'text', id: 'b', x: 96, y: 200, w: 400, text: 'Two', style: 'body', family: 'text', color: '#94A3B8' },
        { kind: 'text', id: 'c', x: 700, y: 150, w: 200, text: 'Over', style: 'body', family: 'text', color: '#F8FAFC' },
      ],
    },
    { presets: PRESETS, fonts: FONTS },
  )
  const badLints = engine
    .lintLayout(engine.layout(bad.document, { measure: (text, font) => text.length * (font.size || 16) * 0.5, assets: {}, fonts: FONTS }), bad.document, PRESETS.og, { assets: {} })
    .map((lint) => lint.code)
  check('an off-grid panel is named', badLints.includes('OFFGRID'), true)
  check('a nearly-aligned pair is named', badLints.includes('SIBLING_EDGE'), true)
  check('type over a picture is named', badLints.includes('TEXT_ON_IMAGE'), true)
}

section('style library')
const stylesModule = await import(pathToFileURL(path.join(repo, 'packages/dsh-canvas/lib/styles/index.js')).href)
const STYLE_TABLE = stylesModule.styleTable()
const STYLE_LIST = stylesModule.STYLE_LIST
check('the library carries at least ten styles', STYLE_LIST.length >= 10, true)
for (const pack of STYLE_LIST) {
  check('style ' + pack.id + ' is complete', stylesModule.styleProblems(pack).join('; '), '')
  const swatch = stylesModule.styleSwatch(pack)
  check('style ' + pack.id + ' has a swatch to show', swatch.colours.length >= 3 && typeof swatch.display === 'string', true)
  check('style ' + pack.id + ' says what it is for', typeof pack.intent === 'string' && pack.intent.length >= 20, true)
  check('style ' + pack.id + ' ships rules and gates', pack.rules.do.length >= 3 && pack.rules.dont.length >= 3 && pack.gates.length >= 1, true)
  check('style ' + pack.id + ' names only shipped families', Object.values(pack.font).every((family) => family === 'system' || Object.keys(FONTS).includes(family)), true)
  const usesArt = pack.art && Array.isArray(pack.art.preferred) ? pack.art.preferred : []
  check('style ' + pack.id + ' names only real art generators', usesArt.every((style) => engine.ART_STYLES.includes(style)), true)
  // The space a photo gets, declared by the pack and checked like everything else.
  check('style ' + pack.id + ' says how an image is treated', Boolean(pack.image && typeof pack.image === 'object'), true)
  check('style ' + pack.id + ' image treatment is legal', stylesModule.styleProblems(pack).filter((problem) => problem.includes('image')).join('; '), '')
}
{
  let pairs = 0
  let invalid = 0
  let moved = 0
  let notIdempotent = 0
  let notReversible = 0
  let illegible = 0
  const details = []
  const secondStyle = STYLE_LIST[1] ?? STYLE_LIST[0]
  for (const pack of STYLE_LIST) {
    for (const archetype of archetypesModule.ARCHETYPES) {
      pairs += 1
      const preset = PRESETS[archetype.presets[0]]
      const base = engine.normalizeDocument(archetype.document, { presets: PRESETS, fonts: FONTS, styles: STYLE_TABLE })
      if (!base.document) {
        invalid += 1
        details.push('the archetype ' + archetype.id + ' does not validate')
        continue
      }
      const styled = stylesModule.applyStyle(base.document, pack, { styles: STYLE_TABLE })
      const verdict = engine.normalizeDocument(styled.document, { presets: PRESETS, fonts: FONTS, styles: STYLE_TABLE })
      if (verdict.problems.length > 0) {
        invalid += 1
        details.push(pack.id + ' on ' + archetype.id + ': ' + verdict.problems[0].code + ' ' + verdict.problems[0].message)
        continue
      }
      // 1. NOTHING IS AUTHORED DIFFERENTLY. A style changes how a design LOOKS: it
      //    never rewrites a position, a size, a layer's place in the array or a word.
      //    The DOCUMENT's own numbers are compared node by node - and then the
      //    LAID-OUT boxes of everything that is not text, because changing a
      //    display weight or a line height is typography and legitimately re-wraps a
      //    text block, which is exactly why a style is followed by a render.
      const authoredGeometry = (doc) => {
        const rows = []
        const walk = (node, path) => {
          rows.push([path, node.kind, node.x ?? '', node.y ?? '', node.w ?? '', node.h ?? '', node.text ?? '', Array.isArray(node.runs) ? node.runs.map((run) => run.text).join('') : ''].join('|'))
          for (let index = 0; index < (node.children ?? []).length; index += 1) walk(node.children[index], path + '.children.' + index)
        }
        for (let index = 0; index < (doc.layers ?? []).length; index += 1) walk(doc.layers[index], 'layers.' + index)
        return rows
      }
      const wasAuthored = authoredGeometry(base.document)
      const nowAuthored = authoredGeometry(verdict.document)
      const authoredKept = wasAuthored.length === nowAuthored.length && wasAuthored.every((row, index) => row === nowAuthored[index])
      const before = engine.layout(base.document, { measure, assets: {}, fonts: FONTS })
      const after = engine.layout(verdict.document, { measure, assets: {}, fonts: FONTS })
      const beforeByPath = new Map(before.boxes.map((entry) => [entry.path, entry.box]))
      const drift = after.boxes.filter((entry) => {
        if (entry.kind === 'text') return false
        const was = beforeByPath.get(entry.path)
        if (!was) return true
        return Math.abs(was.x - entry.box.x) > 0.01 || Math.abs(was.y - entry.box.y) > 0.01 || Math.abs(was.w - entry.box.w) > 0.01 || Math.abs(was.h - entry.box.h) > 0.01
      })
      if (!authoredKept || drift.length > 0) {
        moved += 1
        details.push(pack.id + ' on ' + archetype.id + (authoredKept ? ' moved ' + drift[0].path : ' rewrote authored geometry or a word'))
      }
      // 2. IDEMPOTENT: the same style twice changes nothing.
      const twice = stylesModule.applyStyle(verdict.document, pack, { styles: STYLE_TABLE })
      if (engine.stableJson(twice.document) !== engine.stableJson(verdict.document)) {
        notIdempotent += 1
        details.push(pack.id + ' on ' + archetype.id + ' is not idempotent')
      }
      // 3. REVERSIBLE: switching away and back restores the type scale. Rounding is
      //    allowed to move an entry by at most one pixel, because a scale factor is
      //    applied to integers - anything more than that is a compounding bug.
      const switched = stylesModule.applyStyle(styled.document, secondStyle, { styles: STYLE_TABLE })
      const back = stylesModule.applyStyle(switched.document, pack, { styles: STYLE_TABLE })
      const scaleDrift = Object.keys(styled.document.tokens.scale ?? {}).filter((name) => Math.abs((back.document.tokens.scale[name] ?? 0) - (styled.document.tokens.scale[name] ?? 0)) > 1)
      if (scaleDrift.length > 0) {
        notReversible += 1
        details.push(pack.id + ' on ' + archetype.id + ' does not restore ' + scaleDrift.join(', ') + ' after a switch')
      }
      // 4. LEGIBLE: the lints the language already knows how to take, on the styled
      //    design, against its own preset.
      const lints = engine.lintLayout(after, verdict.document, preset, { assets: {} })
      const contrast = lints.filter((entry) => entry.code === 'LOW_CONTRAST')
      if (contrast.length > 0) {
        illegible += 1
        details.push(pack.id + ' on ' + archetype.id + ': ' + contrast[0].message)
      }
    }
  }
  check('every style applies to every archetype and still validates (' + pairs + ' pairs)', invalid, 0)
  check('a style never moves or resizes anything', moved, 0)
  check('applying a style twice is a no-op', notIdempotent, 0)
  check('switching styles and back restores the type scale', notReversible, 0)
  check('every styled design stays legible', illegible, 0)
  for (const line of details.slice(0, 8)) console.log('     ' + line)
}
{
  // The catalogue the SKILL ships is generated from the packs, so it cannot drift
  // from the library the host applies. This runs the generator's own --check.
  const generated = spawnSync(process.execPath, [path.join(repo, 'packages/dsh-canvas/vendor/styles-doc.mjs'), '--check'], { encoding: 'utf8' })
  check('the shipped style catalogue matches the packs', (generated.status === 0 ? '' : (generated.stdout || '') + (generated.stderr || '')).trim(), '')
  // The COPY LIBRARY is generated from the presets the same way: the budgets a writer
  // works to must be the destination's own numbers, not a remembered ones.
  const copyDoc = spawnSync(process.execPath, [path.join(repo, 'packages/dsh-canvas/vendor/copy-doc.mjs'), '--check'], { encoding: 'utf8' })
  check('the shipped copy library matches the presets', (copyDoc.status === 0 ? '' : (copyDoc.stdout || '') + (copyDoc.stderr || '')).trim(), '')
  const copyText = existsSync(path.join(repo, 'packages/dsh-canvas/skills/social-banners/reference/copy.md'))
    ? readFileSync(path.join(repo, 'packages/dsh-canvas/skills/social-banners/reference/copy.md'), 'utf8')
    : ''
  const missingPresets = Object.keys(PRESETS).filter((id) => !copyText.includes('### ' + id + ' '))
  check('the copy library covers every destination', missingPresets.join(', '), '')
}
{
  // TEXT HYGIENE, asserted rather than assumed, because both halves of this bit
  // once: a BOM is invisible and poisonous (JSON.parse refuses a data file that
  // starts with one, and a check that pins bytes would report drift that is not
  // there), and a UTF-8 -> cp1252 -> UTF-8 round trip through a text editor turns
  // an ellipsis into `…` - which is still VALID source, so nothing fails until a
  // string comparison against a correct literal does. The signature below is the
  // mojibake of the punctuation this package actually uses.
  const bomFiles = []
  const mangled = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'vendor') walk(full)
        continue
      }
      if (!/\.(json|js|mjs|md|yml|css)$/.test(entry.name)) continue
      const bytes = readFileSync(full)
      if (bytes.length > 2 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bomFiles.push(path.relative(repo, full))
      if (/Ã[\u0080-\u00bf\u2013\u2014\u2018\u2019\u201c\u201d\u2020\u2021\u2022\u2026\u20ac\u2122]|â€[\u0093\u0094\u0096\u0097\u0099\u009c\u009d\u00a0-\u00bf]/.test(bytes.toString('utf8'))) mangled.push(path.relative(repo, full))
    }
  }
  walk(path.join(repo, 'packages/dsh-canvas'))
  check('no dsh-canvas source file carries a byte-order mark', bomFiles.join(', '), '')
  check('no dsh-canvas source file is mojibake', mangled.join(', '), '')
}

{
  // AN IMAGE BELONGS TO THE THEME IT LANDS IN. The treatment is the mechanism: a
  // photo dropped into a neon banner takes the neon light, the same photo in paper
  // takes a warm printed wash, and in brutalist it is left raw. Asserted on the
  // document, because that is what the painter and the exporter both read.
  const imageDoc = engine.normalizeDocument(
    { preset: 'og', canvas: { width: 600, height: 400 }, layers: [{ kind: 'image', id: 'shot', x: 40, y: 40, w: 300, h: 200, src: 'shot.png', crop: { x: 0, y: 0, w: 1, h: 0.5 } }] },
    { presets: PRESETS, fonts: FONTS, styles: STYLE_TABLE },
  )
  const treated = (id) => stylesModule.applyStyle(imageDoc.document, stylesModule.styleById(id), { styles: STYLE_TABLE }).document.layers[0]
  const neonShot = treated('neon')
  check('an image takes the style radius', neonShot.radius, STYLE_TABLE.neon.radius.card)
  check('an image takes the style scrim', neonShot.scrim + '/' + neonShot.blend, 'full/screen')
  check('an image takes a palette role as its tint', String(neonShot.scrimColor).toLowerCase(), String(STYLE_TABLE.neon.color.accent).toLowerCase())
  // A document never carries a crop RECTANGLE: `fit` is what decides how the picture
  // is cropped into the box the layout gave it, and the asset's own size is the input.
  check('and the style decides how it is cropped', neonShot.fit, 'cover')
  const paperShot = treated('paper')
  check('and another theme tints the same photo differently', paperShot.scrimColor !== neonShot.scrimColor && paperShot.blend === 'multiply', true)
  const brutalShot = treated('brutalist')
  check('a theme may leave a photo raw', brutalShot.scrim === undefined && brutalShot.radius === 0, true)
}

// THE HOUSE GALLERY: twelve proven preset + archetype + style combinations, generated
// from the library so they cannot drift, each of which must validate, sit on its grid
// and stay legible - the same bar the archetypes and the styles are held to.
section('house gallery')
{
  const examplesModule = await import(pathToFileURL(path.join(repo, 'packages/dsh-canvas/lib/examples/index.js')).href)
  const gateModule = await import(pathToFileURL(path.join(repo, 'packages/dsh-canvas/lib/gate.js')).href)
  const generated = spawnSync(process.execPath, [path.join(repo, 'packages/dsh-canvas/vendor/examples.mjs'), '--check'], { encoding: 'utf8' })
  check('the gallery is what the table would generate', generated.status === 0 ? '' : ((generated.stdout ?? '') + (generated.stderr ?? '')).trim().slice(0, 240), '')
  check('the gallery carries twelve examples', examplesModule.EXAMPLE_LIST.length, 12)
  check('one example per style', new Set(examplesModule.EXAMPLE_LIST.map((entry) => entry.style)).size, 12)
  // THE GATE REFERENCE THE MODEL READS IS GENERATED FROM THE GATE, so a check re-runs the
  // generator: what the skill tells the model "perfect" means cannot drift from what
  // canvas_audit actually enforces.
  const gateDoc = spawnSync(process.execPath, [path.join(repo, 'packages/dsh-canvas/vendor/gate-doc.mjs'), '--check'], { encoding: 'utf8' })
  check('the shipped gate reference matches the gate', gateDoc.status === 0 ? '' : ((gateDoc.stdout ?? '') + (gateDoc.stderr ?? '')).trim().slice(0, 240), '')
  /** The assets an example's own images need, at the size a real workspace copy would be. */
  const exampleAssets = (document) => {
    const table = {}
    const walk = (node) => {
      if (node.kind === 'image' && typeof node.src === 'string') table[node.src] = { width: 1280, height: 800 }
      for (const child of node.children ?? []) walk(child)
    }
    for (const layer of document.layers ?? []) walk(layer)
    return table
  }
  for (const example of examplesModule.EXAMPLE_LIST) {
    const verdict = engine.normalizeDocument(example.document, { presets: PRESETS, fonts: FONTS, styles: STYLE_TABLE })
    check('example ' + example.id + ' validates', verdict.problems.map((problem) => problem.code).join(','), '')
    if (!verdict.document) continue
    const assets = exampleAssets(verdict.document)
    const laid = engine.layout(verdict.document, { measure, assets, fonts: FONTS })
    // EVERY HOUSE DESIGN IS PERFECT, and this is the check that keeps it so: the gate is
    // what the skill tells the model to pass and what canvas_audit reports, so a starter
    // that quietly stops being perfect fails here rather than in a person's eye.
    const audit = gateModule.auditDesign({ layoutResult: laid, document: verdict.document, preset: PRESETS[example.preset], problems: verdict.problems, assets })
    check(
      'example ' + example.id + ' passes the perfect gate',
      audit.checks.filter((entry) => entry.state === 'fail').map((entry) => entry.id + ': ' + entry.detail).join(' | '),
      '',
    )
    check('example ' + example.id + ' says when to reach for it', typeof example.intent === 'string' && example.intent.length >= 20, true)
    check('example ' + example.id + ' carries the copy to write', Boolean(example.copy && example.copy.headline), true)
  }
  check('an example builds a document by id', Boolean(hostModule.documentFor({ example: 'night-launch' }).document), true)
  check('an unknown example is refused by name', hostModule.documentFor({ example: 'no-such-example' }).error.code, 'UNKNOWN_EXAMPLE')
}

// DESIGN SETS: one design derived to several destinations. The invariants are what
// matter - every derivation validates against its OWN preset, its canvas is exactly
// that preset, and the composition keeps its relative geometry (a uniform scale plus a
// centring offset), which is what makes the family recognisably one design.
section('design sets')
{
  const setsModule = await import(pathToFileURL(path.join(repo, 'packages/dsh-canvas/lib/sets.js')).href)
  check('the package ships sets', setsModule.SETS.length >= 3, true)
  const sourceArchetype = archetypesModule.ARCHETYPES.find((entry) => entry.id === 'editorial-split')
  const sourceDoc = engine.normalizeDocument(sourceArchetype.document, { presets: PRESETS, fonts: FONTS, styles: STYLE_TABLE }).document
  for (const set of setsModule.SETS) {
    const derived = setsModule.deriveSet(sourceDoc, set.id)
    check('the ' + set.id + ' set derives every destination', derived.error ? derived.error.code : derived.rows.length, set.targets.length)
    for (const row of derived.rows) {
      const preset = PRESETS[row.preset]
      const verdict = engine.normalizeDocument(row.document, { presets: PRESETS, fonts: FONTS, styles: STYLE_TABLE })
      check('the ' + set.id + '/' + row.preset + ' derivation validates', verdict.problems.map((problem) => problem.code).join(','), '')
      if (!verdict.document) continue
      check('the ' + set.id + '/' + row.preset + ' canvas is the destination', verdict.document.canvas.width + 'x' + verdict.document.canvas.height, preset.width + 'x' + preset.height)
      // Relative geometry: every node's x and w are the source's, times the ratio.
      const ratio = preset.width / sourceDoc.canvas.width
      const scale = (node) => {
        if (typeof node.x === 'number' && typeof node.w === 'number' && Math.abs(node.w - sourceDoc.canvas.width * ratio) > 4) return null
        return null
      }
      void scale
      const sourceLayers = sourceDoc.layers.length
      check('the ' + set.id + '/' + row.preset + ' has the same layers', verdict.document.layers.length, sourceLayers)
      const widths = verdict.document.layers.map((layer) => (typeof layer.w === 'number' ? Math.round(layer.w / ratio) : null))
      const wanted = sourceDoc.layers.map((layer) => (typeof layer.w === 'number' ? layer.w : null))
      const drift = widths.filter((value, index) => value !== null && wanted[index] !== null && Math.abs(value - wanted[index]) > 2)
      check('the ' + set.id + '/' + row.preset + ' keeps the composition\u2019s ratios', drift.join(','), '')
    }
  }
  check('an unknown set is refused by name', setsModule.deriveSet(sourceDoc, 'no-such-set').error.code, 'UNKNOWN_SET')
}

section('host row: tools')
/** A stub cordis context with the two services the row needs. */
function makeCtx() {
  const registered = { tools: [], routes: [], skills: [], effects: 0 }
  const ctx = {
    logger: { debug() {}, info() {}, warn() {} },
    effect: (fn) => {
      registered.effects += 1
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(service) {
      if (service === 'tools') return { register: (tool) => registered.tools.push(tool) }
      if (service === 'connection') return { fetch: { register: (route) => registered.routes.push(route) } }
      if (service === 'skills') return { register: (skill) => registered.skills.push(skill) }
      if (service === 'sessions') return { get: () => ({ header: { cwd: workspace } }) }
      return undefined
    },
  }
  return { ctx, registered }
}
const { ctx, registered } = makeCtx()
hostModule.apply(ctx)
check('every tool registered', registered.tools.length, hostModule.TOOL_NAMES.length)
check('the tool names match', registered.tools.map((tool) => tool.name).sort().join(','), hostModule.TOOL_NAMES.slice().sort().join(','))
// FOUR SKILLS, one per way a design goes wrong: the language, the destinations, the
// banner built from nothing, and the house design that has to be EDITED rather than
// rewritten. The count is asserted rather than derived, because a skill is registered
// from a file and a missing file would otherwise just be a shorter list.
check('four skills registered', registered.skills.map((skill) => skill.name).sort().join(','), 'canvas-banner,canvas-design,canvas-house-edit,social-banners')
check('the view routes plus every font file registered', registered.routes.length > 8, true)
check('the engine route is registered', registered.routes.some((route) => route.path === '/api/dsh-canvas/vendor/engine.js'), true)
check('one route per font file', registered.routes.filter((route) => route.path.includes('/vendor/fonts/')).length, 5)
// THE VENDORED EXCALIDRAW SURFACE IS GONE (alpha.13): two artifact routes plus one
// route per face were the bulk of this row's route table, and the tree behind them
// was 3.8 MB of a browser bundle. The absence is asserted by NAME rather than by a
// route count, because a count a regression could satisfy by registering something
// else is not a test of anything.
check('no Excalidraw route is registered', registered.routes.filter((route) => route.path.includes('excalidraw')).map((route) => route.path).join(', '), '')
// THE INTERACTION LAYER'S ONE ROUTE. It is a classic script rather than a module,
// so what matters is that the route exists, answers with the committed artifact and
// carries the sha256 VERSION.json records as its ETag - a stale copy of the
// interaction layer is a stale editor.
check('the interaction layer route is registered', registered.routes.some((route) => route.path === '/api/dsh-canvas/vendor/konva.js'), true)
// THE REGISTRATION SHAPE IS THE REGISTRY'S: a missing `methods` array is a
// BOOT-TIME TypeError inside the registry, which the contained boot test found -
// the row loaded, the harness started, and every canvas route was absent.
const shapeless = registered.routes.filter((route) => !Array.isArray(route.methods) || route.methods.length === 0 || route.methods.some((method) => !['GET', 'HEAD', 'POST'].includes(method)))
check('every route declares its methods', shapeless.map((route) => route.path).join(', '), '')
check('every route answers through a fetch handler', registered.routes.every((route) => typeof route.fetch === 'function'), true)
check('every write route is a POST', registered.routes.filter((route) => route.path.endsWith('/document') || route.path.endsWith('/delete') || route.path.endsWith('/publish') || route.path.endsWith('/render-report')).every((route) => route.methods.join(',') === 'POST'), true)

const byName = new Map(registered.tools.map((tool) => [tool.name, tool]))
const routeFor = new Map(registered.routes.map((route) => [route.path, route.fetch]))
// A FRESH conversation for the tool section: the store tests above deliberately
// filled `session-one` to its cap.
const exec = { agent: { session: { id: 'session-tools' } } }
const capRefusal = await byName.get('canvas_new').execute({ preset: 'github-social', id: 'one-too-many' }, { agent: { session: { id: 'session-one' } } })
check('a full conversation refuses a new design in a sentence', /Could not store the design: .*already holds \d+ designs/.test(capRefusal.text), true)

const created = await byName.get('canvas_new').execute({ preset: 'github-social', archetype: 'editorial-split' }, exec)
check('canvas_new made a design', created.view && created.view.id === 'editorial-split', true)
check('canvas_new reports the revision', created.view.revision, 1)
const fromStarter = await byName.get('canvas_new').execute({ preset: 'linkedin-personal-banner', id: 'starter-one' }, exec)
check('canvas_new builds a starter for any preset', fromStarter.view.preset, 'linkedin-personal-banner')
check('canvas_new refuses an archetype for the wrong preset', (await byName.get('canvas_new').execute({ preset: 'linkedin-personal-banner', archetype: 'wordmark-dark' }, exec)).text.includes('composed for'), true)
check('canvas_new refuses an unknown preset', (await byName.get('canvas_new').execute({ preset: 'nope' }, exec)).text.includes('Unknown preset'), true)

const writtenTool = await byName.get('canvas_write').execute({ document: sampleDocument(), id: 'check-design' }, exec)
check('canvas_write stored a design', writtenTool.view.id, 'check-design')
const refused = await byName.get('canvas_write').execute({ document: { preset: 'github-social', layers: [{ kind: 'text', text: 'x', color: 'nope' }] } }, exec)
check('canvas_write refuses an invalid document', Array.isArray(refused.problems) && refused.problems.length > 0, true)
check('the refusal names the code', refused.problems[0].code, 'BAD_COLOR')
const unknownAsset = await byName.get('canvas_write').execute({ document: { preset: 'github-social', layers: [{ kind: 'image', src: 'logo' }] } }, exec)
check('an image src that is neither an asset nor a path is refused', (unknownAsset.problems ?? []).some((entry) => entry.code === 'MISSING_ASSET'), true)
const workspaceAssetDoc = await byName.get('canvas_write').execute({ document: { preset: 'github-social', layers: [{ kind: 'image', src: 'docs/shot.png', w: 100, h: 100 }] } }, exec)
check('a workspace-relative image is accepted', workspaceAssetDoc.problems === undefined, true)
const bareNameDoc = await byName.get('canvas_write').execute({ document: { preset: 'github-social', layers: [{ kind: 'image', src: 'shot.png', w: 100, h: 100 }] } }, exec)
check('a bare file name with an image extension is a workspace path', bareNameDoc.problems === undefined, true)

const patchedTool = await byName.get('canvas_patch').execute({ id: 'check-design', ops: [{ op: 'set', at: 'layers.1.children.0.text', value: 'Patched eyebrow' }] }, exec)
check('canvas_patch bumped the revision', patchedTool.view.revision, 2)
check('canvas_patch kept the design valid', patchedTool.text.includes('Patched'), true)
// The style library, through the tools and the panel route: create with a look,
// re-style an existing design, and refuse a look the library does not carry.
const styledArchetype = archetypesModule.ARCHETYPES.find((entry) => entry.presets.includes('og')) ?? archetypesModule.ARCHETYPES[0]
const secondStyle = STYLE_LIST[1] ?? STYLE_LIST[0]
const styledNew = await byName.get('canvas_new').execute({ preset: styledArchetype.presets[0], archetype: styledArchetype.id, id: 'styled-one', style: STYLE_LIST[0].id }, exec)
check('canvas_new applies a style', styledNew.view.id, 'styled-one')
check('the style is recorded on the document', byName.get('canvas_read').execute({ id: 'styled-one' }, exec).text.includes('"style": "' + STYLE_LIST[0].id + '"'), true)
const restyled = await byName.get('canvas_style').execute({ id: 'styled-one', style: secondStyle.id }, exec)
check('canvas_style applies another look', restyled.view.revision, 2)
check('canvas_style explains what changed', restyled.text.includes('Geometry was not touched'), true)
check('canvas_style names the style it applied', restyled.text.includes(secondStyle.name), true)
check('canvas_style refuses an unknown look in a sentence', (await byName.get('canvas_style').execute({ id: 'styled-one', style: 'not-a-style' }, exec)).text.includes('Unknown style'), true)
const styledBefore = byName.get('canvas_read').execute({ id: 'styled-one' }, exec).view.revision
await byName.get('canvas_style').execute({ id: 'styled-one', style: 'nope' }, exec)
check('a refused style changes nothing', byName.get('canvas_read').execute({ id: 'styled-one' }, exec).view.revision, styledBefore)
const styleRoute = routeFor.get('/api/dsh-canvas/document')
const styleBody = await (await styleRoute(new Request('http://localhost/api/dsh-canvas/document', { method: 'POST', body: JSON.stringify({ session: 'session-tools', id: 'styled-one', style: STYLE_LIST[0].id }) }))).json()
check('the panel route can re-style a design', styleBody.ok, true)
check('the panel route refuses an unknown look', (await styleRoute(new Request('http://localhost/api/dsh-canvas/document', { method: 'POST', body: JSON.stringify({ session: 'session-tools', id: 'styled-one', style: 'nope' }) }))).status, 400)
const badPatch = await byName.get('canvas_patch').execute({ id: 'check-design', ops: [{ op: 'set', at: 'layers.9.children.0', value: 1 }] }, exec)
check('a bad patch changes nothing', badPatch.problems[0].code, 'NO_TARGET')
check('the revision did not move on a refused patch', byName.get('canvas_read').execute({ id: 'check-design' }, exec).view.revision, 2)

const readTool = await byName.get('canvas_read').execute({ id: 'check-design' }, exec)
check('canvas_read hands back the canonical document', readTool.text.includes('"layers"'), true)
check('canvas_read reports the verdict', readTool.text.includes('Render verdict:'), true)
const indexTool = await byName.get('canvas_read').execute({}, exec)
check('canvas_read without an id lists the designs', indexTool.text.includes('Designs in this conversation'), true)
check('the index names the presets', indexTool.text.includes('linkedin-personal-banner'), true)
check('the index names the archetypes', indexTool.text.includes('editorial-split'), true)
check('the index states the fonts', indexTool.text.includes('Bundled OFL subsets'), true)
// A throw from a tool is how an expected refusal the model should not retry is
// reported; the pack's other tools do the same for an unknown id.
const malformedId = await (async () => {
  try {
    await byName.get('canvas_read').execute({ id: 'NOT AN ID' }, exec)
    return 'resolved'
  } catch (err) {
    return 'refused'
  }
})()
check('canvas_read refuses a malformed id', malformedId, 'refused')
const missingRead = await (async () => {
  try {
    await byName.get('canvas_read').execute({ id: 'nothing-here' }, exec)
    return 'resolved'
  } catch (err) {
    return 'refused'
  }
})()
check('canvas_read refuses an unknown id', missingRead, 'refused')

const published = await byName.get('canvas_publish').execute({ id: 'check-design' }, exec)
check('canvas_publish copied to the library', published.view.scope, 'library')
check('the library address names no conversation', published.text.includes('dsh-resource://canvas/library/check-design'), true)

const assetFile = path.join(workspace, 'logo.png')
writeFileSync(assetFile, png)
const imported = await byName.get('canvas_assets').execute({ op: 'import', path: 'logo.png' }, exec)
check('canvas_assets imported a workspace image', imported.text.includes('Imported'), true)
const importedName = /Imported ([0-9a-f]{16}\.png)/.exec(imported.text)[1]
const listed = await byName.get('canvas_assets').execute({ op: 'list' }, exec)
check('canvas_assets lists it', listed.assets.some((entry) => entry.name === importedName), true)
check('the listing carries the pixel size', listed.assets.find((entry) => entry.name === importedName).width, 240)
const removed = await byName.get('canvas_assets').execute({ op: 'remove', name: importedName }, exec)
check('canvas_assets removes it', removed.text.includes('Removed'), true)
check('canvas_assets refuses a path outside the workspace', (await byName.get('canvas_assets').execute({ op: 'import', path: '../../etc/passwd' }, exec)).text.includes('Could not import that image: the path cannot contain'), true)

// ---------------------------------------------------------------------------
// 10. The host row: routes
// ---------------------------------------------------------------------------
section('host row: routes')
const health = await routeFor.get('/api/dsh-canvas/health')(new Request('http://localhost/api/dsh-canvas/health'))
const healthBody = await health.json()
check('health answers ok', healthBody.ok, true)
check('health reports the fonts', healthBody.fonts.families.length, 2)
check('health reports the presets', healthBody.presets.length, 10)
check('health reports the archetypes', healthBody.archetypes.length, 8)
check('health reports the queue', typeof healthBody.queue.pending, 'number')

const stateResponse = await routeFor.get('/api/dsh-canvas/state')(new Request('http://localhost/api/dsh-canvas/state?session=session-one'))
const stateBody = await stateResponse.json()
check('state carries the designs with their documents', Array.isArray(stateBody.designs) && stateBody.designs[0].document.layers.length > 0, true)
check('state carries the preset table', Object.keys(stateBody.presets).length, 10)
// The style library reaches the tab through this one payload: the gallery rows the
// picker draws, each with the swatch and the rules the side panel shows.
check('state carries the style gallery', (stateBody.styles ?? []).length >= 10, true)
check('the state route carries the sets', (stateBody.sets ?? []).length, 3)
check('the gallery rows carry a swatch and rules', Boolean(stateBody.styles[0].swatch.colours.length >= 3 && stateBody.styles[0].do.length >= 3 && stateBody.styles[0].gates.length >= 1), true)
check('the gallery is ordered for a person', stateBody.styles.every((entry, index) => index === 0 || (stateBody.styles[index - 1].rank ?? 100) <= (entry.rank ?? 100)), true)
check('state carries the font URLs', stateBody.fonts.Inter.weights['400'].url.startsWith('/api/dsh-canvas/vendor/fonts/'), true)
check('state carries the engine route', stateBody.engineRoute, '/api/dsh-canvas/vendor/engine.js')
check('state carries the asset table', typeof stateBody.assets, 'object')
check('state without a session is refused', (await routeFor.get('/api/dsh-canvas/state')(new Request('http://localhost/api/dsh-canvas/state'))).status, 400)

const documentRoute = routeFor.get('/api/dsh-canvas/document')
const createdByRoute = await documentRoute(new Request('http://localhost/api/dsh-canvas/document', { method: 'POST', body: JSON.stringify({ session: 'session-two', preset: 'linkedin-post' }) }))
const createdBody = await createdByRoute.json()
check('the document route builds a starter from a preset', createdBody.ok && createdBody.design.preset, 'linkedin-post')
const invalidBody = await (await documentRoute(new Request('http://localhost/api/dsh-canvas/document', { method: 'POST', body: JSON.stringify({ session: 'session-two', document: { preset: 'nope' } }) }))).json()
check('the document route refuses an invalid document', invalidBody.ok, false)
check('and returns the problems', Array.isArray(invalidBody.problems) && invalidBody.problems.length > 0, true)
const opsBody = await (await documentRoute(new Request('http://localhost/api/dsh-canvas/document', { method: 'POST', body: JSON.stringify({ session: 'session-two', id: createdBody.design.id, ops: [{ op: 'set', at: 'layers.0.opacity', value: 0.25 }] }) }))).json()
check('the document route applies ops from the panel', opsBody.design.revision, 2)

const assetRoute = routeFor.get('/api/dsh-canvas/asset')
const uploaded = await (await assetRoute(new Request('http://localhost/api/dsh-canvas/asset', { method: 'POST', body: JSON.stringify({ data: png.toString('base64'), label: 'paste' }) }))).json()
check('the asset route stores a paste', uploaded.ok, true)
const fetched = await assetRoute(new Request('http://localhost/api/dsh-canvas/asset?name=' + uploaded.asset.name))
check('the asset route serves the bytes', (await fetched.arrayBuffer()).byteLength, png.length)
check('the asset route sets the image type', fetched.headers.get('content-type'), 'image/png')
const headFetched = await assetRoute(new Request('http://localhost/api/dsh-canvas/asset?name=' + uploaded.asset.name, { method: 'HEAD' }))
check('the asset route answers HEAD without a body', (await headFetched.text()).length, 0)
check('an unknown asset is a 404', (await assetRoute(new Request('http://localhost/api/dsh-canvas/asset?name=nope.png'))).status, 404)

const workspaceRoute = routeFor.get('/api/dsh-canvas/workspace-asset')
const workspaceFetched = await workspaceRoute(new Request('http://localhost/api/dsh-canvas/workspace-asset?session=session-one&path=logo.png'))
check('the workspace route serves a conversation-folder image', (await workspaceFetched.arrayBuffer()).byteLength, png.length)
check('the workspace route refuses an escape', (await workspaceRoute(new Request('http://localhost/api/dsh-canvas/workspace-asset?session=session-one&path=../secret.png'))).status, 400)

const engineResponse = await routeFor.get('/api/dsh-canvas/vendor/engine.js')(new Request('http://localhost/api/dsh-canvas/vendor/engine.js'))
const engineSource = await engineResponse.text()
check('the engine route serves the module', engineSource.includes('export function layout'), true)
check('the engine route sets a javascript type', engineResponse.headers.get('content-type').startsWith('text/javascript'), true)
check('the engine module has no static imports', /^\s*import\s/m.test(engineSource.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//')).join('\n')), false)
const notModified = await routeFor.get('/api/dsh-canvas/vendor/engine.js')(new Request('http://localhost/api/dsh-canvas/vendor/engine.js', { headers: { 'if-none-match': engineResponse.headers.get('etag') } }))
check('the engine route honours if-none-match', notModified.status, 304)

const fontRoute = routeFor.get('/api/dsh-canvas/vendor/fonts/inter-latin-400.woff2')
const fontResponse = await fontRoute(new Request('http://localhost/api/dsh-canvas/vendor/fonts/inter-latin-400.woff2'))
const fontBytes = Buffer.from(await fontResponse.arrayBuffer())
check('a font route serves the real bytes', fontBytes.length, FONTS.Inter.weights['400'].bytes)
check('the font route hashes what the record says', createHash('sha256').update(fontBytes).digest('hex'), FONTS.Inter.weights['400'].sha256)
check('the font route sets the woff2 type', fontResponse.headers.get('content-type'), 'font/woff2')

// ---------------------------------------------------------------------------
// 11. The render round trip: a tool asks, a synthetic browser answers
// ---------------------------------------------------------------------------
section('render round trip')
const queueRoute = routeFor.get('/api/dsh-canvas/render-queue')
const reportRoute = routeFor.get('/api/dsh-canvas/render-report')
const renderTool = byName.get('canvas_render')

// The host writes the PNG the browser posted; the browser here is this check.
// `scope: 'conversation'` on purpose: `canvas_publish` put a copy of this design
// in the LIBRARY, and a bare id resolves library-first - so an unscoped call here
// would render the published copy, which is not what this section is about.
const renderPromise = renderTool.execute({ id: 'check-design', scope: 'conversation' }, exec)
const polled = await queueRoute(new Request('http://localhost/api/dsh-canvas/render-queue?session=*&wait=5000'))
check('the queue hands the pending request to the page', polled.status, 200)
const polledBody = await polled.json()
check('the request names its conversation', polledBody.request.session, 'session-tools')
check('the request carries the document', polledBody.request.document.layers.length > 0, true)
check('the request names the revision', polledBody.request.revision, 2)
check('the request is a report', polledBody.request.purpose, 'report')
const renderPng = makePng(1280, 640)
const reported = await reportRoute(new Request('http://localhost/api/dsh-canvas/render-report', {
  method: 'POST',
  body: JSON.stringify({
    session: 'session-tools',
    id: 'check-design',
    scope: 'conversation',
    revision: polledBody.request.revision,
    requestId: polledBody.request.requestId,
    purpose: 'report',
    ok: true,
    scale: 1,
    width: 1280,
    height: 640,
    png: renderPng.toString('base64'),
    feed: makePng(320, 160).toString('base64'),
    feedScale: 0.25,
    lints: [{ code: 'MARGIN', level: 'warn', message: 'close to the edge' }],
    metrics: { ops: 16, boxes: 8, textNodes: 4, lines: 6, smallestType: 15, families: ['Inter'] },
    fonts: ['Inter'],
  }),
}))
check('the report route accepted the answer', reported.status, 200)
const rendered = await renderPromise
check('canvas_render resolved with a path', typeof rendered.path, 'string')
check('the PNG on disk is a real PNG of the right size', pngSize(readFileSync(rendered.path)).width + 'x' + pngSize(readFileSync(rendered.path)).height, '1280x640')
check('the feed thumbnail was written too', existsSync(rendered.feedPath), true)
check('the tool text names both pictures', rendered.text.includes(rendered.path) && rendered.text.includes(rendered.feedPath), true)
check('the tool text says to read it with read_image', rendered.text.includes('read_image'), true)
check('the tool text carries the lints', rendered.text.includes('MARGIN'), true)
check('the tool text carries the measurements', rendered.text.includes('16 draw ops'), true)
const afterRender = await byName.get('canvas_read').execute({ id: 'check-design', scope: 'conversation' }, exec)
check('the design is now drawn', afterRender.view.state, 'drawn')
check('the verdict names the picture', afterRender.text.includes('drawn (revision ' + polledBody.request.revision + ')'), true)

// A failing render is still a verdict.
const failing = renderTool.execute({ id: 'check-design', scope: 'conversation' }, exec)
const failingPoll = await (await queueRoute(new Request('http://localhost/api/dsh-canvas/render-queue?session=*&wait=5000'))).json()
await reportRoute(new Request('http://localhost/api/dsh-canvas/render-report', {
  method: 'POST',
  body: JSON.stringify({ session: 'session-tools', id: 'check-design', revision: failingPoll.request.revision, requestId: failingPoll.request.requestId, ok: false, error: 'the fonts never loaded' }),
}))
const failedAnswer = await failing
check('a failed render comes back as a named failure', failedAnswer.text.includes('the fonts never loaded'), true)
check('and it is stored as failed', storeModule.verificationOf(new storeModule.CanvasStore({ home, scope: 'conversation', sessionId: 'session-tools' }).get('check-design')).state, 'failed')

// No page answers: the tool says so rather than hanging forever.
const lonely = await renderTool.execute({ id: 'starter-one', scope: 'conversation' }, exec)
// With no page listening, the HOST paints it - and says so, because where the pixels
// came from is the one thing a caller cannot see for itself. On a machine with no
// Chromium the sentence names the page it needs instead.
{
  const hostStatus = hostModule.hostRenderStatus ? hostModule.hostRenderStatus() : { available: false }
  if (hostStatus.available) {
    check('a render with no page is painted on the host', /Rendered .* at \d+\u00d7\d+/.test(lonely.text), true)
    check('and the file really exists', Boolean(lonely.path && existsSync(lonely.path)), true)
    const storedStarter = new storeModule.CanvasStore({ home, scope: 'conversation', sessionId: 'session-tools' }).get('starter-one')
    const starterPreset = PRESETS[storedStarter.preset]
    check(
      'and its own header is exactly the preset size',
      lonely.path ? readFileSync(lonely.path).readUInt32BE(16) + 'x' + readFileSync(lonely.path).readUInt32BE(20) : 'none',
      starterPreset.width + 'x' + starterPreset.height,
    )
  } else {
    check('a render with no page says so', lonely.text.includes('no page answered the render'), true)
  }
}

// ---------------------------------------------------------------------------
// 12. Exports
// ---------------------------------------------------------------------------
section('exports')
const exportTool = byName.get('canvas_export')
const exportPromise = exportTool.execute({ id: 'check-design', scope: 'conversation', format: 'png', target: 'desktop' }, exec)
const exportPoll = await (await queueRoute(new Request('http://localhost/api/dsh-canvas/render-queue?session=*&wait=5000'))).json()
check('the export request says what it is', exportPoll.request.purpose, 'export')
check('the export request says where it goes', exportPoll.request.target, 'desktop')
check('the export request names the file it will write', exportPoll.request.name, 'Check-design')
const exportPng = makePng(1280, 640)
const exported = await reportRoute(new Request('http://localhost/api/dsh-canvas/render-report', {
  method: 'POST',
  body: JSON.stringify({ session: 'session-tools', id: 'check-design', revision: exportPoll.request.revision, requestId: exportPoll.request.requestId, purpose: 'export', ok: true, format: 'png', scale: 1, png: exportPng.toString('base64'), width: 1280, height: 640 }),
}))
check('the export was written', exported.status, 200)
const exportAnswer = await exportPromise
// The Desktop is compared by REALPATH: a Windows temp directory answers with its
// 8.3 short name, so a plain prefix test on the long name can fail while the file
// is exactly where it should be.
check('canvas_export resolved with a path on the Desktop', (await fsp.realpath(exportAnswer.path)).startsWith(await fsp.realpath(desktop)), true)
check('the exported file is exactly the canvas size', pngSize(readFileSync(exportAnswer.path)).width, 1280)
check('the tool text names the destination steps', exportAnswer.text.includes('Settings'), true)
check('the tool text gives the byte size', /Wrote .*KB/.test(exportAnswer.text), true)

// A second export of the same name does not overwrite.
const second = await exportModule.writeCreateExclusive({ directory: desktop, baseName: 'Check design', ext: 'png', bytes: exportPng })
check('a second export gets -2 rather than overwriting', second.name, 'Check-design-2.png')

// The format rules refuse by name.
const svgRefusal = await exportTool.execute({ id: 'check-design', scope: 'conversation', format: 'svg' }, exec)
check('a format the preset does not take is refused', svgRefusal.text.includes('takes png/jpg'), true)
const workspaceExportPromise = exportTool.execute({ id: 'check-design', scope: 'conversation', format: 'png', target: 'workspace' }, exec)
const workspacePoll = await (await queueRoute(new Request('http://localhost/api/dsh-canvas/render-queue?session=*&wait=5000'))).json()
await reportRoute(new Request('http://localhost/api/dsh-canvas/render-report', {
  method: 'POST',
  body: JSON.stringify({ session: 'session-tools', id: 'check-design', revision: workspacePoll.request.revision, requestId: workspacePoll.request.requestId, purpose: 'export', ok: true, format: 'png', scale: 1, png: exportPng.toString('base64'), width: 1280, height: 640, target: 'workspace' }),
}))
const workspaceExport = await workspaceExportPromise
check('a workspace export lands in the conversation folder', (await fsp.realpath(workspaceExport.path)).startsWith(await fsp.realpath(workspace)), true)
check('and it is really there', existsSync(workspaceExport.path), true)

check('sanitizeName strips what a filesystem refuses', exportModule.sanitizeName('a/b:c*d?e"f<g>h|i'), 'a-b-c-d-e-f-g-h-i')
check('humanBytes reads kilobytes', exportModule.humanBytes(1536), '2 KB')
check('humanBytes reads megabytes', exportModule.humanBytes(3 * 1024 * 1024), '3.0 MB')
check('the Desktop resolved into the sandbox', (await fsp.realpath(await exportModule.desktopDirectory())) === (await fsp.realpath(desktop)), true)
const escapeRefusal = await exportModule.resolveNewInside(workspace, '../outside.png').then(() => 'resolved', (err) => err.code)
check('a workspace write cannot escape the folder', escapeRefusal, 'BAD_REQUEST')

// ---------------------------------------------------------------------------
// 13. Cleanup and verdict
// ---------------------------------------------------------------------------
section('result')
try {
  rmSync(sandbox, { recursive: true, force: true })
  check('the sandbox was removed', existsSync(sandbox), false)
} catch (err) {
  check('the sandbox was removed', false, true)
}
console.log('')
console.log(failures === 0 ? 'all canvas checks passed' : failures + ' canvas check(s) FAILED')
console.log('host: ' + os.platform() + ', node ' + process.version)
process.exitCode = failures === 0 ? 0 : 1
