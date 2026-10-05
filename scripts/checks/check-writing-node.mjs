// check-writing-node.mjs — drive dsh-writing's whole host half, with no browser
// and no harness: the model, the page breaker, the two containers (ZIP and XML),
// the .docx codec in both directions, the store, and every route.
//
// The important section is the LAST one. A `.docx` this package writes is not
// judged by this file's opinion of itself: every writer claim above is a claim
// about a file format, and the honest judge of a file format is the program that
// has to open it. So the check writes a document, hands the bytes to the SAME
// LibreOffice the harness ships (`@deepseek-ai/libreoffice-kit`, the engine
// behind `@deepseek-ai/dsh-office-to-pdf`, which is what the shipped office
// preview renders a docx with) and asserts that it converts to a PDF. A missing
// part, a mis-typed content type, a mis-escaped run - all of it fails HERE.
// Without the kit on this host that section SKIPS LOUDLY; the rest still runs.
//
// Run:  node scripts/checks/check-writing-node.mjs
export {} // (import-free header: everything below is a dynamic import)

const { promises: fsp, existsSync, readdirSync, readFileSync, statSync } = await import('node:fs')
const os = await import('node:os')
const path = (await import('node:path')).default
const { pathToFileURL, fileURLToPath } = await import('node:url')

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const writingDir = path.join(repo, 'packages', 'dsh-writing')
let failures = 0
function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(52) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}
function skip(label, reason) {
  console.log('SKIP ' + label.padEnd(52) + ' ' + reason)
}

/** Structural equality: key ORDER is not part of a document's meaning. */
function same(left, right) {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => same(value, right[index]))
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  if (leftKeys.join(',') !== rightKeys.join(',')) return false
  return leftKeys.every((key) => same(left[key], right[key]))
}

// ---------------------------------------------------------------------------
// A hermetic home and workspace: nothing here touches the real $DSH_HOME.
// ---------------------------------------------------------------------------
const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-writing-check-'))
const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-writing-ws-'))
process.env.DSH_HOME = home
const SESSION = 'session-check'
// The import/export routes get their OWN conversation: the one above is filled
// to its document cap on purpose, further down.
const IO_SESSION = 'session-io'
const storeRoot = path.join(home, 'dsh-writing')

/**
 * Register the row against a stub context and hand back every route it
 * registered, keyed by path - the same seam `check-node-routes.mjs` uses, so the
 * shipped code path (path resolution, containment, optimistic concurrency, the
 * store budgets) is what runs.
 */
async function capture(modulePath) {
  const module = await import(pathToFileURL(modulePath).href)
  const routes = new Map()
  const tools = []
  const skills = []
  const context = {
    effect: (fn) => fn(),
    logger: { debug() {}, warn() {}, info() {} },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
    get(name) {
      if (name === 'skills') {
        return {
          register(skill) {
            skills.push(skill)
            return () => {}
          },
        }
      }
      if (name === 'tools') return context.tools
      if (name === 'connection') {
        return {
          fetch: {
            register(route) {
              routes.set(route.path, route)
              return () => {}
            },
          },
        }
      }
      if (name === 'sessions') {
        // Two sessions the routes are driven with, and no others: the workspace
        // lookup is what the NO_WORKSPACE branch is checked against.
        return { get: (id) => (id === SESSION || id === IO_SESSION ? { header: { cwd: workspace } } : undefined) }
      }
      return undefined
    },
  }
  // `ctx.config` is NOT available to a row that never declared one, and cordis
  // says so by THROWING. This getter reproduces that refusal exactly: a stub that
  // answers happily is how a host half shipped reading `ctx.config` and answered
  // 500 to every route in the real harness while this check passed.
  Object.defineProperty(context, 'config', {
    get() {
      throw new Error('cannot get property "config" without inject')
    },
  })
  module.apply(context)
  return { module, routes, tools, skills }
}

const { module: host, routes, tools: registeredTools, skills: registeredSkills } = await capture(path.join(writingDir, 'lib', 'index.js'))
const R = host.__internals.ROUTES
const request = (routePathWithQuery, init) => {
  // A route is registered at an EXACT path, so the query string is the handler's
  // business and never the map's key - which is also the pack's route rule.
  const pathOnly = routePathWithQuery.split('?')[0]
  const route = routes.get(pathOnly)
  if (!route) throw new Error('route not registered: ' + pathOnly)
  return route.fetch(new Request('http://x' + routePathWithQuery, init))
}
const post = (routePath, body) =>
  request(routePath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

// ---------------------------------------------------------------------------
// The modules under test
// ---------------------------------------------------------------------------
const model = await import(pathToFileURL(path.join(writingDir, 'lib', 'model.js')).href)
const page = await import(pathToFileURL(path.join(writingDir, 'lib', 'page.js')).href)
const zip = await import(pathToFileURL(path.join(writingDir, 'lib', 'zip.js')).href)
const xml = await import(pathToFileURL(path.join(writingDir, 'lib', 'xml.js')).href)
const ooxml = await import(pathToFileURL(path.join(writingDir, 'lib', 'ooxml.js')).href)
const store = await import(pathToFileURL(path.join(writingDir, 'lib', 'store.js')).href)
const fontsModule = await import(pathToFileURL(path.join(writingDir, 'lib', 'fonts.js')).href)
const sheetModule = await import(pathToFileURL(path.join(writingDir, 'lib', 'sheet.js')).href)
const xlsx = await import(pathToFileURL(path.join(writingDir, 'lib', 'xlsx.js')).href)

console.log('--- every route is registered ---')
for (const [name, routePath] of Object.entries({
  state: R.STATE_ROUTE,
  document: R.DOCUMENT_ROUTE,
  delete: R.DELETE_ROUTE,
  publish: R.PUBLISH_ROUTE,
  import: R.IMPORT_ROUTE,
  export: R.EXPORT_ROUTE,
  createFile: R.CREATE_FILE_ROUTE,
  saveFile: R.SAVE_FILE_ROUTE,
  openFile: R.OPEN_FILE_ROUTE,
  outline: R.OUTLINE_ROUTE,
  fonts: R.FONTS_ROUTE,
  page: R.PAGE_ROUTE,
})) {
  const route = routes.get(routePath)
  check('registered: ' + name, Boolean(route && typeof route.fetch === 'function'), true)
}
// The pack's rule: exact paths, GET/HEAD/POST only (the editor's PUT is the one
// exception and it is not this package's). A route that accepted DELETE would
// bypass the session-auth bridge's method list.
check(
  'no route accepts a method outside GET/HEAD/POST',
  [...routes.values()].every((route) => route.methods.every((method) => ['GET', 'HEAD', 'POST'].includes(method))),
  true,
)
check('every route buffers its request body', [...routes.values()].every((route) => route.requestBody === 'buffered'), true)

console.log('')
console.log('--- the model ---')
const blank = model.normalizeBlocks([])
check('an empty document is still one paragraph', blank.length, 1)
check('blocksFromText keeps the blank line', model.blocksFromText('a\n\nb').length, 3)
const markdown = '# Title\n\n- one\n- two\n\n1. first\n\n> quoted\n\n**bold** and *italic* and ~~struck~~ and `code`\n\n```\nconst x = 1\n```\n'
const fromMd = model.blocksFromMarkdown(markdown)
check(
  'markdown: the block types it reads',
  fromMd.map((block) => block.type + (block.type === 'listItem' ? (block.ordered ? ':ol' : ':ul') : '')).join(','),
  'heading,listItem:ul,listItem:ul,listItem:ol,quote,paragraph,code',
)
check(
  'markdown: inline marks',
  fromMd[5].runs.filter((run) => run.marks.length > 0).map((run) => run.text + '=' + run.marks.join('+')).join(' '),
  'bold=b italic=i struck=s code=code',
)
const docForMd = {
  page: page.defaultPage(),
  blocks: [
    { type: 'heading', level: 2, runs: [{ text: 'Two', marks: [] }] },
    { type: 'paragraph', runs: [{ text: 'plain ', marks: [] }, { text: 'bold', marks: ['b'] }] },
    { type: 'listItem', ordered: true, level: 0, runs: [{ text: 'item', marks: [] }] },
    { type: 'pageBreak', runs: [{ text: '', marks: [] }] },
    { type: 'paragraph', runs: [{ text: 'after', marks: [] }] },
  ],
}
const mdBack = model.blocksFromMarkdown(model.documentMarkdown(docForMd))
check('markdown: the round trip keeps the text', same(mdBack.map(model.blockText), ['Two', 'plain bold', 'item', '', 'after']), true)
check('markdown: the round trip keeps the page break', mdBack[3].type, 'pageBreak')
check('markdown: the round trip keeps the marks', same(mdBack[1].runs, docForMd.blocks[1].runs), true)
check('documentText is one line per block', model.documentText(docForMd), 'Two\nplain bold\nitem\n\nafter')
check('documentWords counts words', model.documentWords(docForMd), 5)
check('documentStats reports blocks and characters', model.documentStats(docForMd).blocks, 5)
check('mergeLoss sums the same kind', JSON.stringify(model.mergeLoss([{ kind: 'table', count: 2 }], [{ kind: 'table', count: 1 }, { kind: 'image', count: 1 }])), JSON.stringify([{ kind: 'table', count: 3, note: '' }, { kind: 'image', count: 1, note: '' }]))
check('normalizeDocument bumps the revision', model.normalizeDocument({ title: 'x' }, { existing: { title: 'x', revision: 7, createdAt: 'y', page: null, blocks: null } }).revision, 8)

console.log('')
console.log('--- the page breaker ---')
const blocksOf = (count) => Array.from({ length: count }, () => ({ type: 'paragraph', runs: [{ text: 'line', marks: [] }] }))
const flat = page.paginate({ blocks: blocksOf(9), page: page.defaultPage(), measure: () => 50 })
check('a4 portrait: the usable height is the page less its margins', flat.content.heightMm, 246.2)
check('four 50mm blocks fit on one page', flat.pages[0].blocks.length, 4)
check('nine blocks make three pages', flat.pages.length, 3)
check('the last page holds the remainder', flat.pages[2].blocks.length, 1)
check('every block is placed exactly once', flat.pages.flatMap((entry) => entry.blocks).length, 9)
check('blocks are placed in document order', flat.pages.flatMap((entry) => entry.blocks).map((entry) => entry.index).join(','), '0,1,2,3,4,5,6,7,8')
const withBreak = page.paginate({
  blocks: [{ type: 'paragraph', runs: [{ text: 'a', marks: [] }] }, { type: 'pageBreak', runs: [{ text: '', marks: [] }] }, { type: 'paragraph', runs: [{ text: 'b', marks: [] }] }],
  page: page.defaultPage(),
  measure: () => 50,
})
check('a page break starts a new page', withBreak.pages.length, 2)
check('and consumes no space of its own', withBreak.pages[1].blocks.length, 1)
const leadingBreak = page.paginate({
  blocks: [{ type: 'pageBreak', runs: [{ text: '', marks: [] }] }, { type: 'paragraph', runs: [{ text: 'a', marks: [] }] }],
  page: page.defaultPage(),
  measure: () => 50,
})
check('a break at the very top is not a blank page', leadingBreak.pages.length, 1)
const huge = page.paginate({ blocks: blocksOf(2), page: page.defaultPage(), measure: () => 400 })
check('a block taller than the page is reported, not lost', huge.overflow, 2)
check('and still gets a page of its own', huge.pages.length, 2)
check('landscape swaps the page dimensions', JSON.stringify(page.pageDimensions({ size: 'a4', orientation: 'landscape' })), JSON.stringify({ widthMm: 297, heightMm: 210 }))
check('letter is its own size', page.pageDimensions({ size: 'letter' }).widthMm, 215.9)
check('an unknown size falls back to A4', page.normalizePage({ size: 'a5' }).size, 'a4')
check('margins are clamped and rounded', JSON.stringify(page.normalizePage({ margins: { top: -5, left: 1000, right: 12.345 } }).margins), JSON.stringify({ top: 0, right: 12.3, bottom: 25.4, left: 100 }))
check('a non-finite measurement is a zero-height block', page.paginate({ blocks: blocksOf(1), page: page.defaultPage(), measure: () => Number.NaN }).pages[0].blocks[0].heightMm, 0)
// A block that fits whole is ONE fragment covering it, and `to: null` is how it
// says "to the end of the block".
{
  const whole = page.paginate({ blocks: blocksOf(1), page: page.defaultPage(), measure: () => 50 })
  check('a block that fits is one fragment from the start', whole.pages[0].blocks[0].from, 0)
  check('and says it runs to the end of the block', whole.pages[0].blocks[0].to, null)
  check('and is not flagged as split', whole.pages[0].blocks[0].split, false)
}
// LINE-LEVEL SPLITTING: a paragraph longer than the page continues on the next
// one instead of overflowing it, and the fragments tile the block exactly. This
// is the behaviour a text editor is judged on - "a new page when this one
// finishes" - and it is driven with synthetic line data, because only a browser
// can take the real one.
{
  const noMargins = { size: 'a4', orientation: 'portrait', margins: { top: 0, right: 0, bottom: 0, left: 0 } }
  const lines = { heights: Array.from({ length: 60 }, () => 10), ends: Array.from({ length: 60 }, (_, at) => (at + 1) * 5) }
  const oneLong = [{ type: 'paragraph', runs: [{ text: 'x'.repeat(300), marks: [] }] }]
  const split = page.paginate({ blocks: oneLong, page: noMargins, measure: () => 600, measureLines: () => lines, footerMm: 0 })
  check('a paragraph longer than the page needs several pages', split.pages.length >= 3, true)
  check('the first page holds the lines that fit (29 of 60)', split.pages[0].blocks[0].to, 145)
  check('and the fragment starts at the block\u2019s own start', split.pages[0].blocks[0].from, 0)
  check('the fragment carries the height of the lines it holds', split.pages[0].blocks[0].heightMm, 290)
  check('it is flagged as a split fragment', split.pages[0].blocks[0].split, true)
  // The tiling: from/to run end to end, with no gap and no overlap, and the last
  // one reaches the block's own end.
  const pieces = split.pages.flatMap((entry) => entry.blocks)
  let cursor = 0
  let tiled = true
  for (const piece of pieces) {
    if (piece.from !== cursor) tiled = false
    const end = piece.to === null ? 300 : piece.to
    if (end <= cursor) tiled = false
    cursor = end
  }
  check('the fragments tile the block with no gap and no overlap', tiled, true)
  check('and the last one reaches the block\u2019s end', cursor, 300)
  check('no fragment is left overflowing', split.overflow, 0)
  // A block with no room for even one line moves to the next page rather than
  // leaving a line dangling at the bottom of the old one.
  const pushed = page.paginate({
    blocks: [blocksOf(1)[0], { type: 'paragraph', runs: [{ text: 'y'.repeat(50), marks: [] }] }],
    page: noMargins,
    measure: () => 296,
    measureLines: () => ({ heights: [10, 10], ends: [25, 50] }),
    footerMm: 0,
  })
  check('a block with no room for even one line moves to the next page', pushed.pages.length, 2)
  check('and it is not split there', pushed.pages[1].blocks[0].split, false)
  // ONE line taller than a whole page: it goes where it is and is marked, because
  // there is nowhere else for it to go.
  const enormous = page.paginate({
    blocks: [{ type: 'paragraph', runs: [{ text: 'z'.repeat(40), marks: [] }] }],
    page: noMargins,
    measure: () => 400,
    measureLines: () => ({ heights: [400, 10], ends: [20, 40] }),
    footerMm: 0,
  })
  check('a single line taller than a page is placed and marked', enormous.pages[0].blocks[0].overflow, true)
  check('and the rest still follows on the next page', enormous.pages.length, 2)
  // A measurer that answered nonsense is treated as no measurer at all: the block
  // moves whole rather than the layout dying.
  const nonsense = page.paginate({
    blocks: oneLong,
    page: noMargins,
    measure: () => 600,
    measureLines: () => ({ heights: [10, 10], ends: [30, 20] }),
    footerMm: 0,
  })
  check('line data that does not increase is refused', nonsense.pages.length, 1)
  check('and the block is placed whole, marked', nonsense.pages[0].blocks[0].overflow, true)
  const throwing = page.paginate({
    blocks: oneLong,
    page: noMargins,
    measure: () => 600,
    measureLines: () => {
      throw new Error('a measurer that throws')
    },
    footerMm: 0,
  })
  check('a measurer that throws is a block-level fallback, not a crash', throwing.pages.length, 1)
}

console.log('')
console.log('--- the ZIP container ---')
const archive = zip.zipSync(
  [
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: '<w:document>' + 'x'.repeat(5000) + '</w:document>' },
    { name: 'small.bin', data: Buffer.from([1, 2, 3, 4, 5]) },
  ],
  { date: new Date('2026-01-02T03:04:06Z') },
)
const unpacked = zip.unzipSync(archive)
check('three entries come back', unpacked.size, 3)
check('a text part survives', unpacked.get('[Content_Types].xml').toString('utf8'), '<Types/>')
check('a large part survives', unpacked.get('word/document.xml').toString('utf8').length, 5025)
check('a binary part survives', unpacked.get('small.bin').toString('hex'), '0102030405')
const stored = zip.zipSync([{ name: 'x.txt', data: 'hello' }], { date: new Date('2026-01-02T03:04:06Z') })
check('a part that deflating would grow is stored', (stored.readUInt16LE(8) & 0xffff) === 0 ? 'stored' : 'deflated', 'stored')
const corrupt = Buffer.from(stored)
corrupt[36] = corrupt[36] ^ 0xff
let crcError = null
try {
  zip.unzipSync(corrupt)
} catch (err) {
  crcError = err.code
}
check('a corrupted payload fails its CRC check', crcError, 'BAD_CRC')
let notZip = null
try {
  zip.unzipSync(Buffer.from('this is not an archive at all, not even close'))
} catch (err) {
  notZip = err.code
}
check('garbage is refused as not-a-zip', notZip, 'NOT_A_ZIP')

console.log('')
console.log('--- the XML reader ---')
const tree = xml.parseXml('<a x="1"><b>t&amp;t</b><c/><!-- comment --><![CDATA[<raw>]]></a>')
check('elements parse', xml.childrenNamed(tree, 'a').length, 1)
const a = xml.firstChild(tree, 'a')
check('entity text decodes', xml.textContent(xml.firstChild(a, 'b')), 't&t')
check('attributes are read', xml.attrOf(a, 'x'), '1')
check('an absent attribute reads as undefined', String(xml.attrOf(xml.firstChild(a, 'b'), 'val')), 'undefined')
const namespaced = xml.parseXml('<w:p><w:pPr><w:jc w:val="center"/></w:pPr></w:p>')
check('any attribute namespace prefix is matched by its local name', xml.attrOf(xml.firstChild(xml.firstChild(namespaced, 'p'), 'pPr') ? xml.firstChild(xml.firstChild(xml.firstChild(namespaced, 'p'), 'pPr'), 'jc') : null, 'w:val'), 'center')
check('a node carries its local name', xml.firstChild(namespaced, 'p').local, 'p')
check('CDATA stays literal', xml.textContent(a).includes('<raw>'), true)
check('findAll walks the whole tree', xml.findAll(tree, 'b').length, 1)
let badXml = null
try {
  xml.parseXml('<a><b></a>')
} catch (err) {
  badXml = err.code
}
check('a mismatched closing tag is refused', badXml, 'BAD_XML')
check('escapeXml keeps text safe', xml.escapeXml('a<b>&"c"'), 'a&lt;b&gt;&amp;"c"')

console.log('')
console.log('--- the .docx writer and reader ---')
const rich = {
  title: 'Chapter One',
  page: { size: 'a4', orientation: 'portrait', margins: { top: 20, right: 15, bottom: 20, left: 15 } },
  blocks: [
    { type: 'heading', level: 1, runs: [{ text: 'Chapter One', marks: [] }] },
    {
      type: 'paragraph',
      align: 'center',
      runs: [
        { text: 'plain ', marks: [] },
        { text: 'bold', marks: ['b'] },
        { text: ' and ', marks: [] },
        { text: 'italic', marks: ['i'] },
        { text: ' and ', marks: [] },
        { text: 'underlined', marks: ['u'] },
        { text: ' and ', marks: [] },
        { text: 'struck', marks: ['s'] },
        { text: ' and ', marks: [] },
        { text: 'code', marks: ['code'] },
      ],
    },
    { type: 'listItem', ordered: false, level: 0, runs: [{ text: 'bullet one', marks: [] }] },
    { type: 'listItem', ordered: true, level: 0, runs: [{ text: 'first', marks: [] }] },
    { type: 'quote', runs: [{ text: 'quoted', marks: [] }] },
    { type: 'code', runs: [{ text: 'const x = 1', marks: [] }] },
    { type: 'paragraph', runs: [{ text: 'soft\nbreak and\ttab', marks: [] }] },
    { type: 'pageBreak', runs: [{ text: '', marks: [] }] },
    { type: 'paragraph', runs: [{ text: 'after the break', marks: [] }] },
  ],
}
const richBytes = ooxml.writeDocx(rich, { title: 'Chapter One', now: new Date('2026-01-02T03:04:06Z') })
const richBack = ooxml.readDocx(richBytes)
check('the writer emits every part a reader looks for', richBack.meta.parts.join(','), '[Content_Types].xml,_rels/.rels,docProps/app.xml,docProps/core.xml,word/_rels/document.xml.rels,word/document.xml,word/numbering.xml,word/styles.xml')
check('the title survives the round trip', richBack.document.title, 'Chapter One')
check('every block type survives', richBack.document.blocks.map((block) => block.type + (block.type === 'listItem' ? (block.ordered ? ':ol' : ':ul') : block.type === 'heading' ? ':' + block.level : '')).join(','), 'heading:1,paragraph,listItem:ul,listItem:ol,quote,code,paragraph,pageBreak,paragraph')
check('the runs and their marks survive byte for byte', same(richBack.document.blocks, rich.blocks), true)
check('the paragraph alignment survives', richBack.document.blocks[1].align, 'center')
check('the page margins survive', JSON.stringify(richBack.document.page.margins), JSON.stringify({ top: 20, right: 15, bottom: 20, left: 15 }))
check('the page size survives', richBack.document.page.size, 'a4')
check('nothing is reported lost for a document this model can hold', richBack.loss.length, 0)
check('a hard line break survives', ooxml.blockLines(richBack.document)[6], 'soft\nbreak and\ttab')
const landscape = ooxml.readDocx(ooxml.writeDocx({ ...rich, page: { size: 'letter', orientation: 'landscape', margins: { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 } } }))
check('landscape Letter survives as landscape Letter', landscape.document.page.size + ':' + landscape.document.page.orientation, 'letter:landscape')
let noPart = null
try {
  ooxml.readDocx(zip.zipSync([{ name: 'word/styles.xml', data: '<w:styles/>' }]))
} catch (err) {
  noPart = err.code
}
check('a zip without the document part is refused by name', noPart, 'NO_DOCUMENT_PART')
let notDocx = null
try {
  ooxml.readDocx(Buffer.from('plain text, definitely not a document'))
} catch (err) {
  notDocx = err.code
}
check('plain text is refused as not-a-zip', notDocx, 'NOT_A_ZIP')

console.log('')
console.log('--- what the reader cannot hold, it counts ---')
const lossyDocument = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>kept text</w:t></w:r></w:p>
<w:p><w:hyperlink r:id="rId9"><w:r><w:t>a link</w:t></w:r></w:hyperlink><w:ins><w:r><w:t>inserted</w:t></w:r></w:ins><w:del><w:r><w:delText>deleted</w:delText></w:r></w:del></w:p>
<w:p><w:r><w:drawing/></w:r><w:r><w:footnoteReference w:id="2"/></w:r><w:r><w:commentReference w:id="3"/></w:r></w:p>
<w:p><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple><m:oMath/></w:p>
<w:sdt><w:sdtContent><w:p><w:r><w:t>in a control</w:t></w:r></w:p></w:sdtContent></w:sdt>
<tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></tbl>
</w:body></w:document>`
const lossyRead = ooxml.readDocx(zip.zipSync([{ name: 'word/document.xml', data: lossyDocument }]))
const losses = Object.fromEntries(lossyRead.loss.map((entry) => [entry.kind, entry.count]))
check('a table is counted', losses.table, 1)
check('an image is counted', losses.image, 1)
check('a footnote is counted', losses.footnote, 1)
check('a comment is counted', losses.comment, 1)
check('a field is counted', losses.field, 1)
check('an equation is counted', losses.equation, 1)
check('a hyperlink is counted', losses.hyperlink, 1)
check('a tracked change is counted twice (insert and delete)', losses['tracked-change'], 2)
check('a content control is counted', losses['content-control'], 1)
check('every loss entry explains itself', lossyRead.loss.every((entry) => typeof entry.note === 'string' && entry.note.length > 10), true)
check('and the text around them is still read', lossyRead.document.blocks.map(model.blockText).join('|').includes('kept text'), true)
check('the cached field result is still read as text', lossyRead.document.blocks.map(model.blockText).join('|').includes('1'), true)

console.log('')
console.log('--- the store ---')
const writingStore = new store.WritingStore({ root: storeRoot })
const created = writingStore.write(SESSION, { title: 'Notes from Tuesday', blocks: [{ type: 'paragraph', runs: [{ text: 'hello', marks: [] }] }] })
check('a title becomes the id', created.id, 'notes-from-tuesday')
check('the first write is revision 1', created.revision, 1)
check('the list holds it', writingStore.list(SESSION).documents.length, 1)
check('the file is the store\'s own', existsSync(path.join(storeRoot, 'sessions')) && readdirSync(path.join(storeRoot, 'sessions')).length, 1)
const edited = writingStore.write(SESSION, { id: created.id, blocks: [{ type: 'paragraph', runs: [{ text: 'hello again', marks: [] }] }], expectedRevision: 1 })
check('an edit bumps the revision', edited.revision, 2)
check('the id is stable across edits', edited.id, created.id)
let conflict = null
try {
  writingStore.write(SESSION, { id: created.id, blocks: [], expectedRevision: 1 })
} catch (err) {
  conflict = err.code
}
check('a stale revision is refused', conflict, 'CONFLICT')
const second = writingStore.write(SESSION, { title: 'Second', blocks: [{ type: 'paragraph', runs: [{ text: 'two', marks: [] }] }] })
check('a second document gets its own id', second.id, 'second')
check('two documents are listed', writingStore.list(SESSION).documents.length, 2)
check('a document is read back whole', writingStore.get(SESSION, second.id).blocks[0].runs[0].text, 'two')
check('removing one leaves the other', writingStore.remove(SESSION, second.id) && writingStore.list(SESSION).documents.length, 1)
let tooLarge = null
try {
  writingStore.write(SESSION, { title: 'big', blocks: [{ type: 'paragraph', runs: [{ text: 'x'.repeat(600 * 1024), marks: [] }] }] })
} catch (err) {
  tooLarge = err.code
}
check('a document over its own budget is refused', tooLarge, 'TOO_LARGE')
const library = new store.WritingStore({ root: storeRoot, fixedFile: 'library.json' })
library.copyInto(writingStore, SESSION, created.id)
check('publishing copies the document into the library', library.list('library').documents.length, 1)
check('the library entry keeps its id', library.get('library', created.id).title, 'Notes from Tuesday')
check('the library is its own file', existsSync(path.join(storeRoot, 'library.json')), true)
const ids = new Set()
let refused = 0
for (let index = 0; index < 70; index += 1) {
  try {
    const entry = writingStore.write(SESSION, { title: 'filler ' + index, blocks: [{ type: 'paragraph', runs: [{ text: 'f', marks: [] }] }] })
    ids.add(entry.id)
  } catch (err) {
    if (err.code === 'LIMIT') refused += 1
    else throw err
  }
}
check('the per-conversation document cap is enforced', writingStore.list(SESSION).documents.length, store.MAX_DOCUMENTS)
check('and the write past the cap is refused by name', refused, 70 - (store.MAX_DOCUMENTS - 1))
check('every id it handed out was unique', ids.size, 70 - refused)

console.log('')
console.log('--- the routes ---')
// A fresh conversation in the store the ROUTES use (the capture gave them a
// config root; the store above used the same one, so reset it by scope).
const otherSession = 'session-routes'
const stateBody = await (await request(R.STATE_ROUTE + '?session=' + otherSession)).json()
check('state starts empty for a new conversation', stateBody.documents.length, 0)
check('state carries the limits', stateBody.limits.documents, 64)
const createdByRoute = await (await post(R.DOCUMENT_ROUTE, { session: otherSession, title: 'Route Note', blocks: [{ type: 'heading', level: 1, runs: [{ text: 'Route Note', marks: [] }] }, { type: 'paragraph', runs: [{ text: 'written through the route', marks: [] }] }] })).json()
check('the document route creates a document', createdByRoute.ok, true)
check('and answers with its blocks', createdByRoute.document.blocks.length, 2)
check('and with its geometry', createdByRoute.document.widthMm, 210)
const toolReadBack = await (await request(R.DOCUMENT_ROUTE + '?session=' + otherSession + '&id=' + createdByRoute.document.id)).json()
check('the document route reads it back', toolReadBack.document.blocks[1].runs[0].text, 'written through the route')
const saved = await (await post(R.DOCUMENT_ROUTE, { session: otherSession, id: createdByRoute.document.id, title: 'Route Note', blocks: [{ type: 'paragraph', runs: [{ text: 'edited', marks: [] }] }], expectedRevision: createdByRoute.document.revision })).json()
check('a save with the current revision lands', saved.ok, true)
const stale = await post(R.DOCUMENT_ROUTE, { session: otherSession, id: createdByRoute.document.id, blocks: [], expectedRevision: createdByRoute.document.revision })
check('a save with a stale revision is a 409 CONFLICT', stale.status, 409)
check('and names the code', (await stale.json()).error.code, 'CONFLICT')
check('the library scope is its own store', (await (await post(R.DOCUMENT_ROUTE, { scope: 'library', title: 'In the library', blocks: [{ type: 'paragraph', runs: [{ text: 'shared', marks: [] }] }] })).json()).ok, true)
const libraryRead = await (await request(R.DOCUMENT_ROUTE + '?scope=library&id=in-the-library')).json()
check('a library document is readable by id alone', libraryRead.document.blocks[0].runs[0].text, 'shared')
const toolPublished = await (await post(R.PUBLISH_ROUTE, { session: otherSession, id: createdByRoute.document.id })).json()
check('publishing from a conversation answers with the library id', toolPublished.document.scope, 'library')
check('publish copies the CONTENT that was saved', (await (await request(R.DOCUMENT_ROUTE + '?scope=library&id=' + createdByRoute.document.id)).json()).document.blocks[0].runs[0].text, 'edited')

console.log('')
console.log('--- import ---')
const importDocxPath = path.join(workspace, 'imported.docx')
await fsp.writeFile(importDocxPath, ooxml.writeDocx({ ...rich, title: 'Imported' }))
const imported = await (await post(R.IMPORT_ROUTE, { session: IO_SESSION, path: 'imported.docx' })).json()
check('importing a .docx answers with a document', imported.ok, true)
check('the imported text arrives', imported.document.blocks.map(model.blockText)[0], 'Chapter One')
check('the imported page setup arrives', imported.document.page.margins.left, 15)
check('the imported document records where it came from', imported.document.origin.path, 'imported.docx')
check('a faithful .docx reports no loss', imported.loss.length, 0)
await fsp.writeFile(path.join(workspace, 'notes.md'), '# Notes\n\n- one\n')
const importedMd = await (await post(R.IMPORT_ROUTE, { session: IO_SESSION, path: 'notes.md' })).json()
check('importing markdown reads its blocks', importedMd.document.blocks.map((block) => block.type).join(','), 'heading,listItem')
await fsp.writeFile(path.join(workspace, 'plain.txt'), 'two lines\nhere\n')
const importedTxt = await (await post(R.IMPORT_ROUTE, { session: IO_SESSION, path: 'plain.txt' })).json()
check('importing text keeps its lines', importedTxt.document.blocks.length, 3)
await fsp.writeFile(path.join(workspace, 'old.doc'), Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))
const badImport = await post(R.IMPORT_ROUTE, { session: IO_SESSION, path: 'old.doc' })
const badImportBody = await badImport.json()
check('a .doc is refused with a way out', badImport.status, 415)
check('and the message names LibreOffice', /LibreOffice or Word/.test(badImportBody.error.message), true)
const escape = await post(R.IMPORT_ROUTE, { session: IO_SESSION, path: '../outside.docx' })
check('an escaping path is refused', escape.status >= 400 && escape.status < 500, true)
check('a missing file is a 404', (await post(R.IMPORT_ROUTE, { session: IO_SESSION, path: 'nope.docx' })).status, 404)

console.log('')
console.log('--- export ---')
const exported = await (await post(R.EXPORT_ROUTE, { session: SESSION, id: created.id, format: 'docx' })).json()
check('the export answers with a file name', exported.name.endsWith('.docx'), true)
check('and it landed in the conversation folder', existsSync(path.join(workspace, exported.name)), true)
check('the exported bytes are a real .docx', ooxml.readDocx(await fsp.readFile(path.join(workspace, exported.name))).meta.parts.length > 5, true)
check('the exported .docx carries the document\'s text', ooxml.blockLines(ooxml.readDocx(await fsp.readFile(path.join(workspace, exported.name))).document).join('|'), 'hello again')
const exportedAgain = await (await post(R.EXPORT_ROUTE, { session: SESSION, id: created.id, format: 'docx' })).json()
check('a second export does not overwrite the first', exportedAgain.name !== exported.name, true)
check('it takes a numbered name instead', /-2\.docx$/.test(exportedAgain.name), true)
const exportedMd = await (await post(R.EXPORT_ROUTE, { session: SESSION, id: created.id, format: 'md' })).json()
check('markdown exports as markdown', (await fsp.readFile(path.join(workspace, exportedMd.name), 'utf8')).trim(), 'hello again')
const exportedTxt = await (await post(R.EXPORT_ROUTE, { session: SESSION, id: created.id, format: 'txt' })).json()
check('text exports as text', (await fsp.readFile(path.join(workspace, exportedTxt.name), 'utf8')).trim(), 'hello again')
const traversal = await (await post(R.EXPORT_ROUTE, { session: SESSION, id: created.id, format: 'docx', name: '../../escape.docx' })).json()
// The session's folder is resolved with realpath on the host, so the comparison
// is made against the same resolution rather than against the mkdtemp spelling.
const workspaceReal = await fsp.realpath(workspace)
check('an export name cannot leave the folder', path.dirname(traversal.absolute) === workspaceReal, true)
check('and the separators are gone from the name', traversal.name.includes('/') || traversal.name.includes('\\'), false)
check('the exported page keeps the geometry it was saved with', ooxml.readDocx(await fsp.readFile(path.join(workspace, traversal.name))).document.page.size, 'a4')

// ---------------------------------------------------------------------------
// The DESKTOP export, and the proof copy that goes with it.
//
// `target: 'desktop'` writes to `desktopDir()`, which is `os.homedir()/Desktop`.
// A check may not touch somebody's real home, so HOME (and, on Windows, the
// variables os.homedir() reads) are pointed at this check's own temp folder for
// the duration - and the assertion is made against `os.homedir()` rather than
// against a spelling this check guessed, so it holds on both families. No env
// var is left changed.
// ---------------------------------------------------------------------------
{
  const saved = {}
  for (const key of ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH']) {
    saved[key] = process.env[key]
    process.env[key] = key === 'HOMEDRIVE' ? path.parse(home).root.replace(/[\\/]$/, '') : key === 'HOMEPATH' ? home.replace(/^[A-Za-z]:/, '') : home
  }
  try {
    const targetHome = os.homedir()
    await fsp.mkdir(path.join(targetHome, 'Desktop'), { recursive: true })
    // A name no other export in this check could have taken, so "it is not in the
    // workspace" is about the TARGET and not about a collision with an earlier file.
    const desktopOnly = await (await post(R.EXPORT_ROUTE, { session: SESSION, id: created.id, format: 'docx', target: 'desktop', name: 'Desktop only.docx' })).json()
    check('a Desktop export names where it went', typeof desktopOnly.dir === 'string' && desktopOnly.dir.length > 0, true)
    check('and the file is there', existsSync(path.join(targetHome, 'Desktop', desktopOnly.name)), true)
    check('a Desktop export is a real .docx', ooxml.readDocx(await fsp.readFile(path.join(targetHome, 'Desktop', desktopOnly.name))).meta.parts.length > 5, true)
    check('a plain Desktop export leaves no proof copy', desktopOnly.previewPath, null)
    check('and nothing was written into the conversation folder for it', existsSync(path.join(workspace, desktopOnly.name)), false)
    // PROOF: the same bytes land on the Desktop AND as a workspace copy the shipped
    // preview can read, and only the workspace one is handed to the preview.
    const proof = await (await post(R.EXPORT_ROUTE, { session: SESSION, id: created.id, format: 'docx', target: 'desktop', proof: true })).json()
    check('a proof still lands on the Desktop', existsSync(path.join(targetHome, 'Desktop', proof.name)), true)
    check('a proof names a workspace copy to render', typeof proof.previewPath === 'string' && proof.previewPath.endsWith('.docx'), true)
    check('the proof copy is inside the conversation folder', existsSync(path.join(workspace, proof.previewPath)), true)
    check('the proof copy IS the desktop file', (await fsp.readFile(path.join(workspace, proof.previewPath))).equals(await fsp.readFile(path.join(targetHome, 'Desktop', proof.name))), true)
    check('the proof copy is not named like an export', proof.previewPath.includes('-proof-'), true)
    const proofAgain = await (await post(R.EXPORT_ROUTE, { session: SESSION, id: created.id, format: 'docx', target: 'desktop', proof: true })).json()
    check('a second proof does not overwrite the first', proofAgain.previewPath !== proof.previewPath, true)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  check('the check left the home variables as it found them', process.env.HOME, saved.HOME)
}

check('an unknown document is a 404', (await post(R.EXPORT_ROUTE, { session: SESSION, id: 'nope' })).status, 404)
check('an unimportable session is a typed failure', (await post(R.IMPORT_ROUTE, { session: 'no-such-session', path: 'x.docx' })).status, 409)

console.log('')
console.log('--- delete ---')
const doomed = await (await post(R.DOCUMENT_ROUTE, { session: IO_SESSION, title: 'doomed', blocks: [{ type: 'paragraph', runs: [{ text: 'x', marks: [] }] }] })).json()
check('the document to delete exists', (await post(R.DELETE_ROUTE, { session: IO_SESSION, id: doomed.document.id })).status, 200)
check('and is gone afterwards', (await request(R.DOCUMENT_ROUTE + '?session=' + IO_SESSION + '&id=' + doomed.document.id)).status, 404)
check('deleting it twice is a 404', (await post(R.DELETE_ROUTE, { session: IO_SESSION, id: doomed.document.id })).status, 404)

console.log('')
console.log('--- fonts, sized and set ---')
// The document's own defaults and a run that overrides them, through the codec:
// the round trip that says a font chosen in the tab reaches the file.
const typed = {
  title: 'Typed',
  page: page.defaultPage(),
  font: 'Georgia',
  fontSize: 14,
  blocks: [
    { type: 'paragraph', runs: [{ text: 'georgia by default', marks: [] }, { text: ' and Arial 9', marks: [], font: 'Arial', size: 9 }] },
    { type: 'heading', level: 1, runs: [{ text: 'Heading', marks: [] }] },
  ],
}
const typedBytes = ooxml.writeDocx(typed, { title: 'Typed' })
const typedBack = ooxml.readDocx(typedBytes)
check('the document font survives the round trip', typedBack.document.font, 'Georgia')
check('the document size survives the round trip', typedBack.document.fontSize, 14)
check('a run that names its own font keeps it', typedBack.document.blocks[0].runs[1].font, 'Arial')
check('a run that names its own size keeps it', typedBack.document.blocks[0].runs[1].size, 9)
check('a run that says what the document says carries neither', JSON.stringify(typedBack.document.blocks[1].runs), JSON.stringify([{ text: 'Heading', marks: [] }]))
const stylesPart = zip.unzipSync(typedBytes).get('word/styles.xml').toString('utf8')
check('the writer puts the document font in docDefaults', stylesPart.includes('<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Georgia"/>'), true)
check('a size is written in half-points', stylesPart.includes('<w:sz w:val="28"/>'), true)
check('the model rounds a size to half a point', model.normalizeFontSize(12.3), 12.5)
check('the model refuses a nonsense size', model.normalizeFontSize(-4), 12)
check('the model trims a family name', model.normalizeFont('  Georgia  '), 'Georgia')

/** A minimal but structurally valid TrueType font, for the font reader. */
function buildFont({ family, subfamily, bold, weight }) {
  const strings = []
  const records = []
  let offset = 0
  for (const [nameId, text] of [
    [1, family],
    [2, subfamily],
    [4, family + ' ' + subfamily],
  ]) {
    const bytes = Buffer.alloc(text.length * 2)
    for (let index = 0; index < text.length; index += 1) bytes.writeUInt16BE(text.charCodeAt(index), index * 2)
    records.push({ nameId, length: bytes.length, offset })
    strings.push(bytes)
    offset += bytes.length
  }
  const nameHeader = Buffer.alloc(6)
  nameHeader.writeUInt16BE(0, 0)
  nameHeader.writeUInt16BE(records.length, 2)
  nameHeader.writeUInt16BE(6 + records.length * 12, 4)
  const nameRecords = Buffer.concat(
    records.map((record) => {
      const header = Buffer.alloc(12)
      header.writeUInt16BE(3, 0)
      header.writeUInt16BE(1, 2)
      header.writeUInt16BE(0x409, 4)
      header.writeUInt16BE(record.nameId, 6)
      header.writeUInt16BE(record.length, 8)
      header.writeUInt16BE(record.offset, 10)
      return header
    }),
  )
  const nameTable = Buffer.concat([nameHeader, nameRecords, ...strings])
  const os2 = Buffer.alloc(64)
  os2.writeUInt16BE(weight, 4)
  os2.writeUInt16BE(bold ? 0x20 : 0, 62)
  const head = Buffer.alloc(54)
  head.writeUInt16BE(bold ? 1 : 0, 44)
  const tables = [
    { tag: 'name', data: nameTable },
    { tag: 'OS/2', data: os2 },
    { tag: 'head', data: head },
  ]
  const header = Buffer.alloc(12)
  header.writeUInt32BE(0x00010000, 0)
  header.writeUInt16BE(tables.length, 4)
  const directory = Buffer.alloc(tables.length * 16)
  let dataOffset = 12 + tables.length * 16
  const payloads = []
  tables.forEach((table, index) => {
    const at = index * 16
    directory.write(table.tag.padEnd(4, ' '), at, 4, 'latin1')
    directory.writeUInt32BE(dataOffset, at + 8)
    directory.writeUInt32BE(table.data.length, at + 12)
    payloads.push(table.data)
    dataOffset += table.data.length
  })
  return Buffer.concat([header, directory, ...payloads])
}

const syntheticFonts = path.join(home, 'synthetic-fonts')
await fsp.mkdir(syntheticFonts, { recursive: true })
await fsp.writeFile(path.join(syntheticFonts, 'CheckFamily-Regular.ttf'), buildFont({ family: 'Check Family', subfamily: 'Regular', bold: false, weight: 400 }))
await fsp.writeFile(path.join(syntheticFonts, 'CheckFamily-Bold.ttf'), buildFont({ family: 'Check Family', subfamily: 'Bold', bold: true, weight: 700 }))
await fsp.writeFile(path.join(syntheticFonts, 'not-a-font.txt'), 'ignored')
process.env.DSH_WRITING_FONT_DIRS = syntheticFonts
const fontBody = await (await request(R.FONTS_ROUTE + '?refresh=1')).json()
const checkFamily = fontBody.families.find((entry) => entry.family === 'Check Family')
check('the fonts route reads a font directory', Boolean(checkFamily), true)
check('and reports the family\u2019s styles', checkFamily ? checkFamily.styles.join(',') : '', 'regular,bold')
check('the fonts route counts what it parsed', fontBody.parsed >= 2, true)
check('a non-font file in the directory is not a failure', fontBody.failed, 0)
delete process.env.DSH_WRITING_FONT_DIRS
const realList = fontsModule.listFonts({ dirs: fontsModule.fontDirectories({}) })
console.log('     this machine: ' + realList.families.length + ' families from ' + realList.parsed + ' files (' + realList.failed + ' unreadable, ' + realList.skipped + ' skipped)')
check('this machine has fonts at all', realList.families.length > 0, true)
check('every family carries at least one style', realList.families.every((entry) => entry.styles.length > 0), true)

console.log('')
console.log('--- new files, and files written back ---')
const madeFile = await (await post(R.CREATE_FILE_ROUTE, { session: IO_SESSION, format: 'docx', name: 'Chapter One', title: 'Chapter One' })).json()
check('creating a document makes a real file', existsSync(path.join(workspace, madeFile.name)), true)
check('and the bytes are a .docx', ooxml.readDocx(await fsp.readFile(path.join(workspace, madeFile.name))).meta.parts.length > 5, true)
check('and the document is linked to it', madeFile.document.origin.path, madeFile.name)
check('a second file of the same name is numbered', (await (await post(R.CREATE_FILE_ROUTE, { session: IO_SESSION, format: 'docx', name: 'Chapter One' })).json()).name, 'Chapter One-2.docx')
const savedBack = await (await post(R.SAVE_FILE_ROUTE, { session: IO_SESSION, id: madeFile.document.id })).json()
check('saving writes the linked file', savedBack.ok, true)
check('and reports its new stat', Number.isFinite(savedBack.mtimeMs), true)
check('the written file stays a .docx', ooxml.readDocx(await fsp.readFile(path.join(workspace, savedBack.name))).document.title, 'Chapter One')
// The optimistic check: move the file behind the tab's back and the write is
// refused with the current stat rather than clobbering what appeared.
const later = new Date(Date.now() + 5000)
await fsp.utimes(path.join(workspace, savedBack.name), later, later)
const clobber = await post(R.SAVE_FILE_ROUTE, { session: IO_SESSION, id: madeFile.document.id })
check('a file that moved on disk is refused', clobber.status, 409)
check('and the refusal names the code', (await clobber.json()).error.code, 'CHANGED_ON_DISK')
check('forcing the write goes through anyway', (await (await post(R.SAVE_FILE_ROUTE, { session: IO_SESSION, id: madeFile.document.id, force: true })).json()).ok, true)
check('a document with no file cannot be written to one', (await post(R.SAVE_FILE_ROUTE, { session: SESSION, id: 'notes-from-tuesday' })).status >= 400, true)
const opened = await (await post(R.OPEN_FILE_ROUTE, { session: IO_SESSION, path: madeFile.name })).json()
check('opening a file it already links reuses the document', opened.reused, true)
check('and answers with that document', opened.document.id, madeFile.document.id)
const reimported = await (await post(R.OPEN_FILE_ROUTE, { session: IO_SESSION, path: madeFile.name, reload: true })).json()
check('a reload reads the file again', reimported.reused, false)
check('and the document keeps its id', reimported.document.id, madeFile.document.id)
await fsp.copyFile(importDocxPath, path.join(workspace, 'opened-fresh.docx'))
const fresh = await (await post(R.OPEN_FILE_ROUTE, { session: IO_SESSION, path: 'opened-fresh.docx' })).json()
check('opening an unrelated file imports it', fresh.reused, false)
check('and links it to that path', fresh.document.origin.path, 'opened-fresh.docx')
check('an unreadable extension is refused with the way out', (await post(R.OPEN_FILE_ROUTE, { session: IO_SESSION, path: 'old.doc' })).status, 415)

// ---------------------------------------------------------------------------
// A DOCUMENT CREATED ON THE DESKTOP.
//
// `target: 'desktop'` is what the tab's New button sends: the `.docx` is written
// where the person will look for it, and the stored document is linked to THAT
// absolute path - so every later Save writes the file they can open in Word.
// `originFile` is what makes it safe: a relative origin stays inside the workspace,
// an absolute one is only accepted when its own folder IS the Desktop, and anything
// else is a typed refusal rather than a write. `os.homedir()` is pointed at this
// check's temp folder for the duration, as the export block below does.
// ---------------------------------------------------------------------------
{
  const savedEnv = {}
  for (const key of ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH']) {
    savedEnv[key] = process.env[key]
    process.env[key] = key === 'HOMEDRIVE' ? path.parse(home).root.replace(/[\\/]$/, '') : key === 'HOMEPATH' ? home.replace(/^[A-Za-z]:/, '') : home
  }
  try {
    const targetHome = os.homedir()
    const desktop = path.join(targetHome, 'Desktop')
    await fsp.mkdir(desktop, { recursive: true })
    const made = await (await post(R.CREATE_FILE_ROUTE, { session: IO_SESSION, format: 'docx', name: 'On the desktop', title: 'On the desktop', target: 'desktop' })).json()
    check('New writes the document to the Desktop', existsSync(path.join(desktop, made.name)), true)
    check('and names the directory it went to', made.dir, desktop)
    check('the document is linked to that absolute path', made.document.origin.path, path.join(desktop, made.name))
    check('the Desktop file is a real .docx', ooxml.readDocx(await fsp.readFile(path.join(desktop, made.name))).meta.parts.length > 5, true)
    check('and nothing was left in the conversation folder', existsSync(path.join(workspace, made.name)), false)
    // Saving a typed block writes THAT file, not a copy somewhere else.
    const edited = await (await post(R.DOCUMENT_ROUTE, {
      session: IO_SESSION,
      id: made.document.id,
      title: 'On the desktop',
      blocks: [{ type: 'paragraph', runs: [{ text: 'typed on the desktop', marks: [] }] }],
      expectedRevision: made.document.revision,
    })).json()
    check('the Desktop document saves into the store', edited.ok, true)
    const writtenBack = await (await post(R.SAVE_FILE_ROUTE, { session: IO_SESSION, id: made.document.id })).json()
    check('and Save writes the Desktop file', writtenBack.ok, true)
    check('with the text that was typed', ooxml.blockLines(ooxml.readDocx(await fsp.readFile(path.join(desktop, made.name))).document).join('|'), 'typed on the desktop')
    // An absolute path that is NOT the Desktop is refused, not resolved. The rule is
    // driven through `open-file` with an absolute path, because that route reaches the
    // same containment check the write-back uses - and passing an absolute path in
    // `path` is exactly the call a client must not be able to get away with.
    const elsewhere = path.join(targetHome, 'elsewhere')
    await fsp.mkdir(elsewhere, { recursive: true })
    await fsp.writeFile(path.join(elsewhere, 'rogue.docx'), 'not a docx')
    const rogue = await post(R.OPEN_FILE_ROUTE, { session: IO_SESSION, path: path.join(elsewhere, 'rogue.docx') })
    const rogueBody = await rogue.clone().json()
    check('an absolute path outside the Desktop is refused', rogue.status, 403)
    check('and says why', rogueBody.error.code, 'OUTSIDE_WORKSPACE')
    const desktopPath = await post(R.OPEN_FILE_ROUTE, { session: IO_SESSION, path: path.join(desktop, made.name), reload: true })
    check('the Desktop path of a document this package made is honoured', desktopPath.status, 200)
    check('and reads that document back', (await desktopPath.json()).document.origin.path, path.join(desktop, made.name).replaceAll('\\', '/'))
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

console.log('')
console.log('--- the outline ---')
const outlined = await (await request(R.OUTLINE_ROUTE + '?session=' + IO_SESSION + '&id=' + madeFile.document.id)).json()
check('the outline answers for a document', outlined.ok, true)
check('a document with no headings has an empty outline', outlined.headings.length, 0)
const structured = await (await post(R.DOCUMENT_ROUTE, {
  session: IO_SESSION,
  title: 'Structured',
  blocks: [
    { type: 'heading', level: 1, runs: [{ text: 'One', marks: [] }] },
    { type: 'paragraph', runs: [{ text: 'body', marks: [] }] },
    { type: 'heading', level: 2, runs: [{ text: 'One point one', marks: [] }] },
  ],
})).json()
const structuredOutline = await (await request(R.OUTLINE_ROUTE + '?session=' + IO_SESSION + '&id=' + structured.document.id)).json()
check('the outline lists the headings in order', structuredOutline.headings.map((entry) => entry.level + ':' + entry.text).join(','), '1:One,2:One point one')
check('and carries the block index a jump needs', structuredOutline.headings.map((entry) => entry.index).join(','), '0,2')
check('and counts the words', structuredOutline.words, 5)
check('an outline for an unknown document is a 404', (await request(R.OUTLINE_ROUTE + '?session=' + IO_SESSION + '&id=nope')).status, 404)

console.log('')
console.log('--- the workbook ---')
check('a sheet name loses what a workbook forbids', sheetModule.normalizeSheetName('Q1: sales/2026', 0, new Set()), 'Q1- sales-2026')
check('a blank sheet name becomes SheetN', sheetModule.normalizeSheetName('   ', 2, new Set()), 'Sheet3')
check('a duplicate sheet name is numbered', sheetModule.normalizeSheetName('Data', 1, new Set(['data'])), 'Data-2')
check('a sheet name is cut to 31 characters', sheetModule.normalizeSheetName('x'.repeat(60), 0, new Set()).length, 31)
check('a workbook with no sheets gets one', sheetModule.normalizeSheets([]).length, 1)
check('the sheet cap is enforced', sheetModule.normalizeSheets(Array.from({ length: 30 }, (_, index) => ({ name: 'S' + index, rows: [] }))).length, sheetModule.MAX_SHEETS)
check('a ragged grid is padded', JSON.stringify(sheetModule.normalizeSheets([{ name: 'A', rows: [[1], [2, 3]] }])[0].rows), JSON.stringify([[1, null], [2, 3]]))
check('an empty cell is null, never ""', sheetModule.normalizeSheets([{ name: 'A', rows: [['', null, 'x']] }])[0].rows[0][0], null)
check('a formula is kept without its =', JSON.stringify(sheetModule.normalizeSheets([{ name: 'A', rows: [[{ value: '', formula: '=SUM(A1:A2)' }]] }])[0].rows[0][0]), JSON.stringify({ value: '', formula: 'SUM(A1:A2)' }))
check('sheetText is tab separated under a sheet header', sheetModule.sheetText({ sheets: [{ name: 'A', rows: [[1, 'x'], [null, true]] }] }), '# A\n1\tx\n\tTRUE\n')
const madeSheet = await (await post(R.CREATE_FILE_ROUTE, { session: IO_SESSION, format: 'xlsx', name: 'Books', title: 'Books' })).json()
check('creating a workbook makes a real .xlsx', madeSheet.name, 'Books.xlsx')
check('and the document is a workbook', madeSheet.document.kind, 'sheet')
check('and it is linked to the file', madeSheet.document.origin.path, 'Books.xlsx')
check('a fresh workbook has one sheet', madeSheet.document.sheets.length, 1)
const grid = await (await post(R.DOCUMENT_ROUTE, {
  session: IO_SESSION,
  id: madeSheet.document.id,
  kind: 'sheet',
  title: 'Books',
  sheets: [
    { name: 'Sales', rows: [['Region', 'Units'], ['North', 12], ['South', 7], ['Total', { value: '', formula: 'SUM(B2:B3)' }]] },
    { name: 'Notes', rows: [['a note']] },
  ],
  expectedRevision: madeSheet.document.revision,
})).json()
check('a workbook saves through the document route', grid.ok, true)
check('and keeps both sheets', grid.document.sheets.map((sheet) => sheet.name).join(','), 'Sales,Notes')
check('the workbook summary counts filled cells', grid.document.filled, 9)
check('and carries no page blocks, because it is not a page', grid.document.blocks, null)
check('a workbook\u2019s outline is its sheets', (await (await request(R.OUTLINE_ROUTE + '?session=' + IO_SESSION + '&id=' + grid.document.id)).json()).headings.map((entry) => entry.text).join(','), 'Sales,Notes')
const wroteBook = await (await post(R.SAVE_FILE_ROUTE, { session: IO_SESSION, id: grid.document.id })).json()
check('saving writes the .xlsx back to its file', wroteBook.ok, true)
const bookBytes = await fsp.readFile(path.join(workspace, wroteBook.name))
const bookBack = xlsx.readXlsx(bookBytes).workbook
check('and the bytes are a real workbook', bookBack.sheets.map((sheet) => sheet.name).join(','), 'Sales,Notes')
check('with the formula intact and no cached value', JSON.stringify(bookBack.sheets[0].rows[3][1]), JSON.stringify({ value: '', formula: 'SUM(B2:B3)' }))
check('and a value is a NUMBER in the file, not text', bookBack.sheets[0].rows[1][1].value, 12)
check('and a label is a string in the file', bookBack.sheets[0].rows[1][0].value, 'North')
const openedBook = await (await post(R.OPEN_FILE_ROUTE, { session: IO_SESSION, path: 'Books.xlsx' })).json()
check('a workbook opens as a sheet document', openedBook.document.kind, 'sheet')
check('with its grid in the document\'s own cell shape', openedBook.document.sheets[0].rows[1][1], 12)
const exportedBook = await (await post(R.EXPORT_ROUTE, { session: IO_SESSION, id: grid.document.id })).json()
check('a workbook exports as .xlsx by default', exportedBook.format, 'xlsx')
check('and the copy is a workbook too', xlsx.readXlsx(await fsp.readFile(path.join(workspace, exportedBook.name))).workbook.sheets.length, 2)
const exportedText = await (await post(R.EXPORT_ROUTE, { session: IO_SESSION, id: grid.document.id, format: 'txt' })).json()
check('a workbook exports as text when asked', (await fsp.readFile(path.join(workspace, exportedText.name), 'utf8')).includes('North\t12'), true)

// ---------------------------------------------------------------------------
// LibreOffice: the judge of every claim above.
// ---------------------------------------------------------------------------
console.log('')
console.log('--- LibreOffice reads what this package writes ---')
/** Whether one node_modules root holds the pinned harness line's packages. */
function carriesPinnedLine(root, pin) {
  try {
    return JSON.parse(readFileSync(path.join(root, '@deepseek-ai', 'dsh-client-ui-theme', 'package.json'), 'utf8')).version === pin
  } catch (err) {
    return false
  }
}
function moduleRoots() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const roots = [path.join(dshHome, 'profiles', 'node_modules'), path.join(repo, 'node_modules')]
  const caches = [process.env.LOCALAPPDATA, process.env.APPDATA, process.env.npm_config_cache]
    .filter(Boolean)
    .map((base) => path.join(base, 'npm-cache', '_npx'))
  caches.push(path.join(os.homedir(), '.npm', '_npx'))
  for (const cache of caches) {
    if (!existsSync(cache)) continue
    for (const entry of readdirSync(cache)) roots.push(path.join(cache, entry, 'node_modules'))
  }
  roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules')
  let pin = null
  try {
    pin = JSON.parse(readFileSync(path.join(repo, '.dsh-version.json'), 'utf8')).dsh
  } catch (err) {
    pin = null
  }
  if (pin === null) return roots
  return [...roots.filter((root) => carriesPinnedLine(root, pin)), ...roots.filter((root) => !carriesPinnedLine(root, pin))]
}
function findCoreFile(relative) {
  for (const root of moduleRoots()) {
    const candidate = path.join(root, relative)
    if (existsSync(candidate)) return candidate
  }
  return null
}

const kitEntry = findCoreFile('@deepseek-ai/libreoffice-kit/lib/index.js')
if (kitEntry === null) {
  skip('LibreOffice renders our .docx', 'no @deepseek-ai/libreoffice-kit on this host (the pin ships one; install the line to run this)')
} else {
  console.log('     engine: ' + kitEntry)
  const documentPath = path.join(home, 'libreoffice-input.docx')
  const secondPath = path.join(home, 'libreoffice-input-2.docx')
  const outputPath = path.join(home, 'libreoffice-output.pdf')
  const secondOutput = path.join(home, 'libreoffice-output-2.pdf')
  const bookPath = path.join(home, 'libreoffice-input.xlsx')
  const bookOutput = path.join(home, 'libreoffice-output.xlsx.pdf')
  // The page-break pair goes first: the same document with and without its
  // break, so "more pages" means the break was UNDERSTOOD and not that the
  // margins were wrong.
  await fsp.writeFile(documentPath, richBytes)
  await fsp.writeFile(bookPath, xlsx.writeXlsx({ sheets: [{ name: 'Sales', rows: [[{ value: 'Region' }, { value: 'Units' }], [{ value: 'North' }, { value: 12 }], [{ value: 'South' }, { value: 7 }], [{ value: 'Total' }, { value: '', formula: 'SUM(B2:B3)' }]] }] }, { title: 'Check workbook' }))
  // A one-page document with the same writer, so "more pages" means the page
  // break was understood rather than the margins being wrong.
  await fsp.writeFile(
    secondPath,
    ooxml.writeDocx({ ...rich, blocks: rich.blocks.filter((block) => block.type !== 'pageBreak') }, { title: 'One page' }),
  )
  const started = Date.now()
  let rendered = null
  let failure = null
  try {
    const kit = await import(pathToFileURL(kitEntry).href)
    const converter = await kit.createConverter({ fontMetadataCacheDirectory: path.join(home, 'font-cache'), timeoutMs: 120000 })
    try {
      rendered = await converter.render({ inputPath: documentPath, outputPath })
      await converter.render({ inputPath: secondPath, outputPath: secondOutput })
      // The workbook goes through the SAME engine: a `.xlsx` LibreOffice can open
      // and compute is a real `.xlsx`, which is the only claim about a file
      // format worth making.
      await converter.render({ inputPath: bookPath, outputPath: bookOutput })
    } finally {
      await converter.dispose()
    }
  } catch (err) {
    failure = err
  }
  if (failure) {
    // The kit is present, so this is a real failure of the artifact OR of the
    // engine's own runtime on this host; either way it must not read as a pass.
    check('LibreOffice opens the .docx this package writes', 'threw: ' + (failure.message || String(failure)), 'ok')
  } else {
    const pdf = await fsp.readFile(outputPath)
    const onePage = await fsp.readFile(secondOutput)
    check('LibreOffice opens the .docx this package writes', pdf.subarray(0, 5).toString('latin1'), '%PDF-')
    check('and produced a non-trivial PDF', pdf.byteLength > 1000, true)
    check('the engine reports which fonts the document wanted', Array.isArray(rendered.missingFonts), true)
    // Page COUNT, read from the PDF's own page tree: `/Count N` in the root
    // Pages node is what every reader uses, and LibreOffice writes it
    // uncompressed. A document with one page break must have one more page than
    // the same document without it - which is the page break being UNDERSTOOD,
    // not merely tolerated.
    const pageCount = (buffer) => {
      const text = buffer.toString('latin1')
      const counts = [...text.matchAll(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/g)].map((match) => Number(match[1]))
      return counts.length > 0 ? Math.max(...counts) : null
    }
    const withBreak = pageCount(pdf)
    const withoutBreak = pageCount(onePage)
    check('the PDF has a readable page count', Number.isFinite(withBreak), true)
    check('the page break made a second page', withBreak > withoutBreak, true)
    const bookPdf = await fsp.readFile(bookOutput)
    check('LibreOffice opens the .xlsx this package writes', bookPdf.subarray(0, 5).toString('latin1'), '%PDF-')
    // The formula cell has NO cached value in the file, so a PDF that shows
    // anything at all in it is LibreOffice having COMPUTED it - which is the
    // contract this codec was written to (`fullCalcOnLoad`).
    check('and the PDF is not empty', bookPdf.byteLength > 1000, true)
    console.log('     ' + (withBreak - withoutBreak) + ' extra page(s) from the page break; docx ' + pdf.byteLength + ' B, xlsx->pdf ' + bookPdf.byteLength + ' B; ' + ((Date.now() - started) / 1000).toFixed(1) + 's')
  }
}

// ---------------------------------------------------------------------------
// EVERY route, actually CALLED.
//
// This is the sweep that was missing, and its absence is why two bugs reached a
// real harness: a registration count proves a route EXISTS and says nothing
// about whether it RUNS. Both failures were invisible to everything above -
// `ctx.config` on a row that never declared one (cordis refuses the property),
// and a `fileURLToPath` that was never imported (a ReferenceError at call time,
// not at load) - because a route that is merely registered never executes.
//
// Each entry carries a request the route is supposed to ANSWER, and the sweep
// fails on a 500, on an `ok: false`, or on a body that is not JSON at all.
// ---------------------------------------------------------------------------
console.log('')
console.log('--- every route answers when it is called ---')
const sweep = [
  ['state', 'GET', R.STATE_ROUTE + '?session=' + IO_SESSION],
  ['document', 'GET', R.DOCUMENT_ROUTE + '?session=' + SESSION + '&id=' + created.id],
  ['document (library)', 'GET', R.DOCUMENT_ROUTE + '?scope=library&id=' + created.id],
  ['outline', 'GET', R.OUTLINE_ROUTE + '?session=' + SESSION + '&id=' + created.id],
  ['fonts', 'GET', R.FONTS_ROUTE],
  ['page breaker', 'GET', R.PAGE_ROUTE],
  ['document (create)', 'POST', R.DOCUMENT_ROUTE, { session: IO_SESSION, title: 'Sweep', blocks: [{ type: 'paragraph', runs: [{ text: 'sweep', marks: [] }] }] }],
  ['document (sheet save)', 'POST', R.DOCUMENT_ROUTE, { session: IO_SESSION, id: grid.document.id, kind: 'sheet', sheets: [{ name: 'One', rows: [[1]] }], expectedRevision: undefined }],
  ['publish', 'POST', R.PUBLISH_ROUTE, { session: SESSION, id: created.id }],
  ['import', 'POST', R.IMPORT_ROUTE, { session: IO_SESSION, path: 'notes.md' }],
  ['export', 'POST', R.EXPORT_ROUTE, { session: SESSION, id: created.id, format: 'md' }],
  ['create-file', 'POST', R.CREATE_FILE_ROUTE, { session: IO_SESSION, format: 'docx', name: 'Sweep file' }],
  ['save-file', 'POST', R.SAVE_FILE_ROUTE, { session: IO_SESSION, id: madeFile.document.id, force: true }],
  ['open-file', 'POST', R.OPEN_FILE_ROUTE, { session: IO_SESSION, path: madeFile.name }],
  ['delete', 'POST', R.DELETE_ROUTE, { session: IO_SESSION, id: 'sweep' }],
]
for (const [label, method, path, body] of sweep) {
  const answer = method === 'GET' ? await request(path) : await post(path, body)
  const text = await answer.clone().text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    parsed = null
  }
  const isJs = path === R.PAGE_ROUTE
  if (isJs) {
    // The page breaker answers JAVASCRIPT, and the one thing that matters is
    // that it is the module the browser will import: it must export `paginate`.
    check('route answers: ' + label, answer.status === 200 && text.includes('export function paginate'), true)
    continue
  }
  check('route answers: ' + label + ' (status)', answer.status, 200)
  check('route answers: ' + label + ' (ok)', parsed ? parsed.ok === true : text.slice(0, 80), true)
}

console.log('')
console.log('--- the vendored Editor.js surface ---')
// The artifacts the Writing tab edits in are committed and hashed by
// `packages/dsh-writing/vendor/editorjs/build.mjs`. What this drives is the half a
// check can run on any machine with no npm: every recorded file hashes to what the
// record says AND the host serves exactly those names, with the recorded ETag and a
// 304 for a client that already has them.
{
  const vendorDir = path.join(writingDir, 'lib', 'vendor', 'editorjs')
  const record = JSON.parse(await fsp.readFile(path.join(vendorDir, 'VERSION.json'), 'utf8'))
  const { createHash } = await import('node:crypto')
  check('the record names the pinned core', record.pins.editorjs, '2.31.7')
  check('the record carries the tarball integrity of every package', Object.keys(record.integrity).length, 6)
  check('the core is Apache-2.0 and the tools are MIT', record.licences.core + '/' + record.licences.tools, 'Apache-2.0/MIT')
  let hashed = 0
  let wrong = 0
  for (const [name, meta] of Object.entries(record.files)) {
    const bytes = await fsp.readFile(path.join(vendorDir, name))
    const digest = createHash('sha256').update(bytes).digest('hex')
    hashed += 1
    if (digest !== meta.sha256 || bytes.length !== meta.bytes) wrong += 1
  }
  check('every recorded artifact is up to date with its file', wrong, 0)
  check('the record covers the core, five tools and six licences', hashed, 12)
  check('the allowlist is the six scripts the record carries', host.__internals.EDITOR_FILES.length, 6)
  check(
    'every allowlisted name is a recorded file',
    host.__internals.EDITOR_FILES.every((name) => Boolean(record.files[name])) && host.__internals.EDITOR_FILES.every((name) => record.files[name].package.startsWith('@editorjs/')),
    true,
  )
  // The routes: one exact path per file, the recorded bytes, the recorded ETag.
  for (const name of host.__internals.EDITOR_FILES) {
    const routePath = R.EDITOR_ROUTE + name
    const answer = await request(routePath)
    const text = await answer.text()
    check('the editor route answers ' + name, answer.status, 200)
    check('  ...as JavaScript', answer.headers.get('content-type'), 'text/javascript; charset=utf-8')
    check('  ...with the bytes the record hashed', createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'), record.files[name].sha256)
    const etag = answer.headers.get('etag')
    check('  ...and an ETag from the record', etag, '"' + record.files[name].sha256.slice(0, 32) + '"')
    const revalidated = await request(routePath, { headers: { 'if-none-match': etag } })
    check('  ...which revalidates to a 304', revalidated.status, 304)
  }
  // The route is registered at an EXACT path per file, so a name outside the
  // allowlist has no route at all - not a file read that happens to fail. Both
  // halves of that are asserted: nothing else under the prefix is registered, and
  // the allowlist itself is a fixed list.
  const editorRoutes = [...routes.keys()].filter((key) => key.startsWith(R.EDITOR_ROUTE))
  check('one exact route per vendored file, and nothing else', editorRoutes.length, host.__internals.EDITOR_FILES.length)
  check('every editor route is an allowlisted name', editorRoutes.every((key) => host.__internals.EDITOR_FILES.includes(key.slice(R.EDITOR_ROUTE.length))), true)
  check('a traversal-looking name is not in the allowlist', host.__internals.EDITOR_FILES.includes('../package.json'), false)
  const refused = await host.__internals.handleEditorFile('../package.json', new Request('http://x'))
  check('the handler refuses a name outside the allowlist', refused.status, 404)

  // -------------------------------------------------------------------------
  // The model <-> Editor.js bridge: the SAME cases the client's own copy is
  // driven with in `check-client-bundles.mjs`, because the two implementations
  // cannot share code (one bundle has no imports; the other may touch no DOM).
  // -------------------------------------------------------------------------
  console.log('')
  console.log('--- the Editor.js bridge ---')
  const bridge = await import(pathToFileURL(path.join(writingDir, 'lib', 'editorjs.js')).href)
  const dom = bridge.plainTextDom()
  const page = model.defaultPage()
  const bridgeDoc = {
    page,
    font: '',
    fontSize: 12,
    blocks: [
      { type: 'heading', level: 2, runs: [{ text: 'A heading', marks: [] }] },
      { type: 'paragraph', runs: [{ text: 'plain text', marks: [] }] },
      { type: 'listItem', ordered: false, level: 0, runs: [{ text: 'one', marks: [] }] },
      { type: 'listItem', ordered: false, level: 1, runs: [{ text: 'nested', marks: [] }] },
      { type: 'listItem', ordered: false, level: 0, runs: [{ text: 'two', marks: [] }] },
      { type: 'quote', runs: [{ text: 'quoted', marks: [] }] },
      { type: 'code', runs: [{ text: 'const x = 1', marks: [] }] },
      { type: 'pageBreak', runs: [{ text: '', marks: [] }] },
    ],
  }
  const data = bridge.toEditorData(bridgeDoc, dom, 1700000000000)
  check('the bridge stamps the time it is given', data.time, 1700000000000)
  check('the bridge maps every block type', data.blocks.map((block) => block.type).join(','), 'header,paragraph,list,quote,code,delimiter')
  check('the heading carries its level', data.blocks[0].data.level, 2)
  check('the list NESTS the deeper level', data.blocks[2].data.items[0].items.length, 1)
  check('the list keeps the sibling at the root', data.blocks[2].data.items.length, 2)
  check('the code carries its characters', data.blocks[4].data.code, 'const x = 1')
  const back = bridge.fromEditorData(data, dom)
  check('the round trip keeps every block type', back.blocks.map((block) => block.type).join(','), 'heading,paragraph,listItem,listItem,listItem,quote,code,pageBreak')
  check('the round trip keeps the heading level', back.blocks[0].level, 2)
  check('the round trip keeps the nested level', back.blocks[3].level, 1)
  check('the round trip keeps the words', back.blocks.map((block) => (block.runs ?? []).map((run) => run.text).join('')).join('|'), 'A heading|plain text|one|nested|two|quoted|const x = 1|')
  check('a page break is reported, not silently dropped', back.losses.some((entry) => entry.kind === 'page break'), true)
  // A document with no page break reports nothing, and a block the surface does not
  // have is kept as a paragraph WITH its text and reported.
  const plain = bridge.fromEditorData(bridge.toEditorData({ blocks: [{ type: 'paragraph', runs: [{ text: 'x', marks: [] }] }] }, dom), dom)
  check('a document with no loss reports none', plain.losses.length, 0)
  const unknown = bridge.fromEditorData({ blocks: [{ id: 'a', type: 'table', data: { text: 'cells' } }] }, dom)
  check('an unknown block becomes a paragraph', unknown.blocks[0].type, 'paragraph')
  check('an unknown block keeps its text', unknown.blocks[0].runs.map((run) => run.text).join(''), 'cells')
  check('an unknown block is reported', unknown.losses.some((entry) => entry.kind === 'block type the editor does not have'), true)
  // The two halves must agree on the SHAPE the client sends: a document with the
  // document's own typography set and a run that names its own family is exactly
  // what `runTypographyLosses` is for.
  const typed = bridge.runTypographyLosses([{ type: 'paragraph', runs: [{ text: 'x', marks: [], font: 'Georgia', size: 14 }, { text: 'y', marks: [] }] }])
  check('per-run typography is reported as a loss', typed.length > 0 && typed[0].count, 1)
  check('a document with no run typography reports no typography loss', bridge.runTypographyLosses([{ type: 'paragraph', runs: [{ text: 'x', marks: [] }] }]).length, 0)
}

// ---------------------------------------------------------------------------
// The tools and the bundled skill: what this row adds for the AGENT.
//
// The tools are driven through `execute()` with a stub run context, so the REAL
// store the tab reads is what runs - including its budgets, its optimistic
// concurrency and its typed refusals - and the claims asserted here are the ones
// a model would depend on: that a document it wrote is listed, that reading it
// back gives the marks back, and that the things the model cannot express (a
// table, a workbook) are REFUSED out loud rather than silently flattened.
// ---------------------------------------------------------------------------
console.log('')
console.log('--- the model-facing tools ---')
check('three tools are registered', registeredTools.map((entry) => entry.name).join(','), 'writing_list,writing_read,writing_write')
check(
  'every tool declares a JSON-schema surface',
  registeredTools.every(
    (entry) =>
      typeof entry.description === 'string' &&
      entry.description.length > 40 &&
      entry.parameters &&
      entry.parameters.type === 'object' &&
      Object.keys(entry.parameters.properties ?? {}).length > 0 &&
      (entry.parameters.required ?? []).every((key) => Object.hasOwn(entry.parameters.properties, key)) &&
      entry.output &&
      entry.output.schema &&
      typeof entry.output.render === 'function' &&
      typeof entry.execute === 'function',
  ),
  true,
)
const tool = (name) => registeredTools.find((entry) => entry.name === name)
/** The failure message of a call that must fail, or '' when it did not. */
async function fails(fn) {
  try {
    await fn()
    return ''
  } catch (err) {
    return err && err.message ? String(err.message) : String(err)
  }
}

const TOOL_SESSION = 'session-tools'
const exec = { agent: { session: { id: TOOL_SESSION } } }
const toolBody = ['## Findings', '', '- one', '- two', '', 'Some **bold** text.'].join('\n')
const written = await tool('writing_write').execute({ title: 'Tool check', markdown: toolBody }, exec)
check('writing_write creates a document', written.created, true)
check('  ...under the slug of its title', written.id, 'tool-check')
check('  ...and counts its words', written.words, 6)
check('  ...in the conversation store', written.scope, 'conversation')
check('  ...at revision 1', written.revision, 1)

const listed = await tool('writing_list').execute({}, exec)
check('writing_list answers the document', listed.documents.map((entry) => entry.id).join(','), 'tool-check')
check('  ...with its kind', listed.documents[0].kind, 'page')

const writtenBack = await tool('writing_read').execute({ id: 'tool-check' }, exec)
check('writing_read returns the block count', writtenBack.blocks, 4)
check('  ...and the Markdown body', writtenBack.markdown, '## Findings\n- one\n- two\nSome **bold** text.\n')
check('  ...title separate from the body', writtenBack.title, 'Tool check')
const asBlocks = await tool('writing_read').execute({ id: 'tool-check', format: 'blocks' }, exec)
check('  ...and the block model on request', JSON.parse(asBlocks.model).blocks.map((block) => block.type).join(','), 'heading,listItem,listItem,paragraph')

const again = await tool('writing_write').execute({ id: 'tool-check', markdown: 'Rewritten.' }, exec)
check('a second write REPLACES, keeping the id', again.id, 'tool-check')
check('  ...and keeps the title it was not given', again.title, 'Tool check')
check('  ...and moves the revision', again.revision, 2)
check('  ...and reports itself as a replacement', again.created, false)
const conflicted = await fails(() => tool('writing_write').execute({ id: 'tool-check', markdown: 'x', expectedRevision: 1 }, exec))
check('a stale expectedRevision is REFUSED, not clobbered', conflicted.includes('CONFLICT') && conflicted.includes('revision 2'), true)
const missing = await fails(() => tool('writing_read').execute({ id: 'nope' }, exec))
check('reading an unknown id names what the store holds', missing.includes('no document "nope"') && missing.includes('tool-check'), true)

// What the model may NOT express is refused rather than flattened. A Markdown
// table has no block in this model, so it arrives as pipe-delimited paragraphs -
// and the tool description says so, which is the only honest option.
const table = await tool('writing_write').execute({ title: 'Table check', markdown: '| a | b |\n| --- | --- |\n| 1 | 2 |' }, exec)
const tableBlocks = JSON.parse((await tool('writing_read').execute({ id: table.id, format: 'blocks' }, exec)).model).blocks
check('a Markdown table becomes paragraphs, never a table', tableBlocks.map((block) => block.type).join(','), 'paragraph,paragraph,paragraph')
check('  ...with the pipes kept as text', tableBlocks[0].runs.map((run) => run.text).join(''), '| a | b |')

// A workbook is a different surface with a different model: the page tools say so
// instead of writing over its sheets.
host.__internals.stores().conversation.write(TOOL_SESSION, { id: 'book', kind: 'sheet', title: 'Book' })
const workbook = await fails(() => tool('writing_write').execute({ id: 'book', title: 'Nope', markdown: 'x' }, exec))
check('a workbook is refused, and named as one', workbook.includes('WORKBOOK'), true)

// The library scope is the SAME store the tab publishes into.
const freshPublish = await tool('writing_write').execute({ scope: 'library', title: 'Shared note', markdown: 'Shared.' }, exec)
const libraryList = await tool('writing_list').execute({ scope: 'library' }, exec)
check('the library scope publishes to the shared store', libraryList.documents.some((entry) => entry.id === freshPublish.id), true)
check('  ...and the conversation store does not hold it', (await tool('writing_list').execute({}, exec)).documents.some((entry) => entry.id === freshPublish.id), false)

// ---------------------------------------------------------------------------
// The bundled skill: the one METHOD skill this pack ships.
// ---------------------------------------------------------------------------
console.log('')
console.log('--- the bundled research skill ---')
check('one skill is registered', registeredSkills.length, 1)
const skill = registeredSkills[0] ?? {}
check('  ...named research', skill.name, 'research')
check('  ...with a description the model can choose on', typeof skill.description === 'string' && skill.description.length > 200, true)
check('  ...and a whenToUse', typeof skill.whenToUse === 'string' && skill.whenToUse.length > 40, true)
check('  ...registered from its own file', typeof skill.path === 'string' && existsSync(skill.path), true)
check('  ...carrying the rule a review lives by', String(skill.content).includes('No identifier and no link you have not fetched'), true)
check('  ...and the rule that every reference carries a link', /Every reference carries a link/.test(String(skill.content)) || /every reference carries a link/i.test(String(skill.content)), true)
check('  ...and the step that writes the document', String(skill.content).includes('writing_write'), true)
// Every reference file the skill names must be there: a skill that points at a
// document it does not ship sends the agent into an empty read.
const referenced = [...new Set(String(skill.content).match(/reference\/[a-z0-9-]+\.md/g) ?? [])]
check('the skill names its reference files', referenced.length >= 2, true)
check(
  'every referenced file is shipped',
  referenced.every((rel) => existsSync(path.join(path.dirname(skill.path), rel))),
  true,
)
check('the skill is not a page of prose alone', String(skill.content).split('\n').length > 80, true)

// ---------------------------------------------------------------------------
console.log('')
await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
await fsp.rm(workspace, { recursive: true, force: true }).catch(() => {})
console.log(failures === 0 ? 'all writing host checks passed' : failures + ' check(s) FAILED')
process.exitCode = failures === 0 ? 0 : 1
