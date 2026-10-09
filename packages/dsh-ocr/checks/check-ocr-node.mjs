/**
 * dsh-ocr — the tracked check for this package's host half.
 *
 * Run it with `npm run check` in this folder (`node checks/check-ocr-node.mjs`).
 * It is additional to the pack-wide checks under scripts/checks/, never a
 * replacement for them, and it travels with the package so it is useful outside
 * this repository.
 *
 * What it proves, and how:
 *
 *   - **The pure decisions**, which need no engine at all: language matching
 *     across the two tag spellings tesseract and Windows use, a page selection,
 *     what a file IS from its own first bytes, and the two sentences a reader
 *     gets when nothing can read a file or when the page was blank.
 *   - **The engine path end to end**, on inputs this check BUILDS ITSELF: a
 *     24-bit BMP whose text is drawn from a 5x7 bitmap font this file carries,
 *     and a minimal three-page PDF. Nothing here depends on a fixture that can
 *     rot, and no image library is involved - the pack has no dependencies and
 *     this check has none either.
 *   - **The `ocr` tool as the agent calls it**, through the real `buildTools`
 *     and the real dependency cache: a workspace-relative path, an absolute
 *     path, a missing file, a text file that is not a picture, `pages` used on
 *     an image, and a PDF page range that must NOT return another page's text.
 *
 * The one deliberately tolerant assertion is the recognized TEXT of the
 * synthetic font: OCR is probabilistic and a check that pinned the engine's
 * exact reading of hand-drawn glyphs would fail on a good engine. It requires
 * most of the expected tokens, prints what the engine actually said, and pins
 * the things that are deterministic (the header names the engine, the
 * transcription caveat is present, the page markers are there).
 *
 * A host with no OCR engine SKIPS LOUDLY and exits 0 - and says so, because a
 * green run on such a machine is not evidence that the row works.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  MAX_PAGES,
  chooseLanguage,
  clampDpi,
  engineOrder,
  imageSize,
  languageAliases,
  parsePageSpec,
  parseTesseractLanguages,
  probeEngines,
  scoreLanguage,
  sniffKind,
  tiffPages,
} from '../lib/engines.js'
import { createDeps, engineLine } from '../lib/index.js'
import { noEngineMessage, noLanguageMessage, formatAnswer, formatBytes, buildTools } from '../lib/tools.js'

let failures = 0
let passes = 0

function check(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  if (same) {
    passes += 1
    console.log('  ok   ' + label + ' = ' + JSON.stringify(actual))
  } else {
    failures += 1
    console.log('  FAIL ' + label + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))
  }
}

function ok(label, condition, detail = '') {
  if (condition) {
    passes += 1
    console.log('  ok   ' + label + (detail ? ' (' + detail + ')' : ''))
  } else {
    failures += 1
    console.log('  FAIL ' + label + (detail ? ' (' + detail + ')' : ''))
  }
}

/** The assertion for something that must NOT be there. */
function okNot(label, condition, detail = '') {
  ok(label, !condition, detail)
}

function section(title) {
  console.log('\n' + title)
}

// ---------------------------------------------------------------------------
// Inputs this check builds itself
// ---------------------------------------------------------------------------
/**
 * A 5x7 bitmap font: one entry per glyph, seven rows of five, '#' for ink. Only
 * the characters the test string uses are here, and the builder REFUSES a string
 * it has no glyph for - so a future edit to that string cannot quietly pass by
 * drawing nothing.
 */
const FONT = {
  '0': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
}

/** One glyph's rows, or null when this font has no glyph for that character. */
function glyphRows(character) {
  const rows = FONT[character]
  if (!Array.isArray(rows) || rows.length !== 7 || rows.some((row) => row.length !== 5)) return null
  return rows
}

/**
 * Draw text into a 24-bit BMP, bottom-up, the way the format stores it.
 *
 * @param lines - the lines to draw, top to bottom.
 * @param scale - the pixel size of one font pixel; 12 makes a glyph 60x84.
 * @returns the file's bytes.
 */
function buildBmp(lines, scale = 12) {
  const margin = 20 * scale / 4
  const gap = scale
  const lineHeight = 7 * scale + 3 * scale
  let widest = 0
  for (const line of lines) {
    for (const character of line) if (glyphRows(character) === null) throw new Error('no glyph for "' + character + '" in the check font')
    widest = Math.max(widest, line.length * (5 * scale + gap))
  }
  const width = Math.ceil(widest + margin * 2)
  const height = Math.ceil(lines.length * lineHeight + margin * 2)
  const rowBytes = Math.ceil((width * 3) / 4) * 4
  const pixels = Buffer.alloc(rowBytes * height, 0xff) // white paper

  const put = (x, y, ink) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    // Bottom-up: row 0 of the file is the BOTTOM of the picture.
    const row = height - 1 - y
    const offset = row * rowBytes + x * 3
    const value = ink ? 0x00 : 0xff
    pixels[offset] = value
    pixels[offset + 1] = value
    pixels[offset + 2] = value
  }

  lines.forEach((line, index) => {
    const originY = margin + index * lineHeight
    let originX = margin
    for (const character of line) {
      const rows = glyphRows(character)
      rows.forEach((row, rowIndex) => {
        for (let column = 0; column < row.length; column += 1) {
          if (row[column] !== '#') continue
          for (let dy = 0; dy < scale; dy += 1) {
            for (let dx = 0; dx < scale; dx += 1) {
              put(originX + column * scale + dx, originY + rowIndex * scale + dy, true)
            }
          }
        }
      })
      originX += 5 * scale + gap
    }
  })

  const header = Buffer.alloc(54)
  header.write('BM', 0, 'latin1')
  header.writeUInt32LE(54 + pixels.length, 2)
  header.writeUInt32LE(54, 10)
  header.writeUInt32LE(40, 14)
  header.writeInt32LE(width, 18)
  header.writeInt32LE(height, 22)
  header.writeUInt16LE(1, 26)
  header.writeUInt16LE(24, 28)
  header.writeUInt32LE(0, 30)
  header.writeUInt32LE(pixels.length, 34)
  header.writeInt32LE(2835, 38)
  header.writeInt32LE(2835, 42)
  return Buffer.concat([header, pixels])
}

/** A minimal, valid PDF whose pages draw text in a real font. */
function buildPdf(linesPerPage) {
  const objects = []
  const kids = linesPerPage.map((_entry, index) => 5 + index * 2 + ' 0 R')
  objects.push('1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj')
  objects.push('2 0 obj<</Type/Pages/Kids[' + kids.join(' ') + ']/Count ' + linesPerPage.length + '>>endobj')
  objects.push('3 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj')
  objects.push('4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold>>endobj')
  linesPerPage.forEach((lines, index) => {
    const pageObject = 5 + index * 2
    const contentObject = pageObject + 1
    objects.push(
      pageObject +
        ' 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 3 0 R/F2 4 0 R>>>>/Contents ' +
        contentObject +
        ' 0 R>>endobj',
    )
    let body = ''
    lines.forEach((line, lineIndex) => {
      body += 'BT /F2 34 Tf 60 ' + (740 - lineIndex * 60) + ' Td (' + line + ') Tj ET\n'
    })
    objects.push(contentObject + ' 0 obj<</Length ' + body.length + '>>stream\n' + body + 'endstream endobj')
  })
  let text = '%PDF-1.4\n'
  const offsets = []
  for (const object of objects) {
    offsets.push(text.length)
    text += object + '\n'
  }
  const xref = text.length
  text += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n'
  for (const offset of offsets) text += String(offset).padStart(10, '0') + ' 00000 n \n'
  text += 'trailer<</Size ' + (objects.length + 1) + '/Root 1 0 R>>\nstartxref\n' + xref + '\n%%EOF\n'
  return Buffer.from(text, 'latin1')
}

/** A normalized form of recognized text, for a comparison OCR can survive. */
function normalize(text) {
  return String(text).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// 1. The pure decisions
// ---------------------------------------------------------------------------
section('The pure decisions (no engine involved)')

check('an ISO 639-2 tag finds a Windows tag', scoreLanguage('pt-PT', 'por') > 0, true)
check('a Windows tag finds an ISO 639-2 tag', scoreLanguage('por', 'pt-PT') > 0, true)
check('the same tag scores highest', scoreLanguage('por', 'por'), 3)
check('a region of the same language still matches', scoreLanguage('en-GB', 'en-US'), 2)
check('a different language does not match', scoreLanguage('pt-PT', 'deu'), 0)
ok('every alias of por includes pt', languageAliases('por').includes('pt'), languageAliases('por').join('/'))
check('tesseract is asked for its own spelling', chooseLanguage(['eng', 'por'], 'pt'), { ok: true, tag: 'por' })
check('two languages pass through as one request', chooseLanguage(['eng', 'por'], 'eng+por'), { ok: true, tag: 'eng+por' })
check('a language nobody has is refused', chooseLanguage(['eng'], 'jpn').ok, false)
ok('the refusal names what it CAN read', chooseLanguage(['eng'], 'jpn').message.includes('eng'))
check('no request means the engine default', chooseLanguage(['eng'], ''), { ok: true, tag: '' })

check('a single page', parsePageSpec('3'), { ok: true, pages: [3] })
check('a range', parsePageSpec('1-3'), { ok: true, pages: [1, 2, 3] })
check('a list and a range, sorted and deduplicated', parsePageSpec('4,1-2,1'), { ok: true, pages: [1, 2, 4] })
check('a reversed range is read, not refused', parsePageSpec('5-4'), { ok: true, pages: [4, 5] })
check('"all" is every page', parsePageSpec('all'), { ok: true, pages: null })
check('an empty spec is every page', parsePageSpec(''), { ok: true, pages: null })
check('nonsense is refused', parsePageSpec('one').ok, false)
check('page zero is refused', parsePageSpec('0').ok, false)
check('too many pages are refused', parsePageSpec('1-' + (MAX_PAGES + 1)).ok, false)
check('a resolution below the range clamps up', clampDpi(10), 50)
check('a resolution above the range clamps down', clampDpi(9999), 400)
check('a resolution that is not a number takes the default', clampDpi('wide'), 200)

check('tesseract language output is parsed', parseTesseractLanguages('List of available languages (3):\neng\npor\nosd\n'), ['eng', 'osd', 'por'])
check('a tesseract list with no data parses to nothing', parseTesseractLanguages('Error opening data file'), [])

const bmp = buildBmp(['OCR 2024', 'TOTAL 99'])
const pdf = buildPdf([['INVOICE 4242'], ['SECOND PAGE 777'], ['THIRD PAGE 111']])
check('the built BMP is identified by content, not by name', sniffKind(bmp.subarray(0, 64)), 'bmp')
check('the built BMP states its own size', imageSize(bmp.subarray(0, 64)).height > 0, true)
check('the built PDF is identified by content', sniffKind(pdf.subarray(0, 8)), 'pdf')
check('a PNG header is identified', sniffKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 2])), 'png')
check('a PNG header states its size', imageSize(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 2])), { width: 1, height: 2 })
// A JPEG header: SOI, an APP0/JFIF segment to walk past, then an SOF0 frame
// header stating 300x100. JPEG is the format with no signature beyond two bytes,
// so this is the one that proves the marker walk rather than a magic number.
check(
  'a JPEG header is identified',
  sniffKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x01, 0x2c, 0x03])),
  'jpeg',
)
check(
  'a JPEG header states its size from the frame header',
  imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x01, 0x2c, 0x03])),
  { width: 300, height: 100 },
)
check('a text file is no picture', sniffKind(Buffer.from('hello, this is not an image at all', 'latin1')), null)

// A TIFF header with two IFDs and one with a single IFD, built from bytes: the
// two engines disagree about how much of a multi-page TIFF they read, and the
// note in the answer hangs on this count.
const twoPageTiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
const onePageTiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
check('a two-page TIFF says it has two pages', tiffPages(twoPageTiff), 2)
check('a one-page TIFF says it has one page', tiffPages(onePageTiff), 1)
check('a truncated TIFF chain reports no count rather than a guess', tiffPages(twoPageTiff.subarray(0, 9)), null)
check('a non-TIFF reports no count', tiffPages(bmp.subarray(0, 64)), null)
check('a TIFF is identified as one', sniffKind(twoPageTiff), 'tiff')

const noEngine = noEngineMessage({ kind: 'image', failures: ['tesseract at /usr/bin/tesseract: no language data'], platform: 'linux', engines: { tesseract: null, windows: null } })
ok('the no-engine sentence names the engine that failed', noEngine.includes('tesseract'))
ok('the no-engine sentence says what to install', noEngine.includes('tesseract') && noEngine.includes('PATH'))
const noPdf = noEngineMessage({ kind: 'pdf', failures: ['windows-ocr at C:\\powershell.exe: no recognizer language'], platform: 'linux', engines: { tesseract: null, windows: null } })
ok('the PDF sentence points at pdf_scan', noPdf.includes('pdf_scan'))
ok('the PDF sentence explains the rasterizer requirement', noPdf.includes('pdftoppm') && noPdf.includes('Ghostscript'))

const wrongLanguage = noLanguageMessage({
  requested: 'eng',
  languageFailures: ['windows-ocr: This engine has no data for "eng". It can read: pt-PT.'],
  failures: [],
  defaults: ['pt-PT'],
})
okNot('a missing language is never reported as a missing engine', wrongLanguage.includes('No OCR engine is available'))
ok('a missing language is reported as a missing language', wrongLanguage.includes('No engine on this host can read as "eng"'))
ok('the language refusal repeats what the engine CAN read', wrongLanguage.includes('pt-PT'))
ok('the language refusal says what works right now', wrongLanguage.includes('Leave `lang` off'))

const blank = formatAnswer({
  name: 'blank.png',
  file: 'blank.png',
  relative: 'blank.png',
  size: 2048,
  format: 'png',
  kind: 'image',
  result: { ok: true, text: '', engine: 'windows-ocr', lang: 'en-US', pages: 1, total: 1, ms: 120, truncated: false, note: '' },
})
ok('an empty page is an answer, not a failure', blank.includes('found no text'))
ok('an empty page still names the engine', blank.includes('windows-ocr'))
okNot('an empty result does not carry the transcription caveat, which is about text nobody got', blank.includes('RECOGNIZED'))

const answered = formatAnswer({
  name: 'scan.png',
  file: 'scan.png',
  relative: 'scan.png',
  size: 4096,
  format: 'png',
  kind: 'image',
  result: { ok: true, text: 'Factura no 2024\nTotal: 1.234,56', engine: 'tesseract', lang: 'por', pages: 1, total: 1, ms: 1830, truncated: false, note: '' },
})
ok('a real answer names the engine and its language', answered.includes('tesseract') && answered.includes('por'))
ok('a real answer carries the transcription caveat', answered.includes('RECOGNIZED'))
ok('a real answer names the tool that EXTRACTS text instead', answered.includes('pdf_read'))
ok('the recognized text is there verbatim', answered.includes('Factura no 2024\nTotal: 1.234,56'))
check('bytes are said the way a person says them', formatBytes(2048), '2.0 KB')

const tiffEntry = {
  name: 'scan.tif',
  file: 'scan.tif',
  relative: 'scan.tif',
  size: 9000,
  format: 'tiff',
  kind: 'image',
  tiffPages: 4,
}
const frameReader = formatAnswer({ ...tiffEntry, result: { ok: true, text: 'page one', engine: 'windows-ocr', lang: 'pt-PT', pages: 1, total: 1, ms: 400, truncated: false, note: '', skipped: [] } })
ok('a 4-page TIFF read by the frame decoder says only page 1 was read', frameReader.includes('holds 4 pages'))
const allPagesReader = formatAnswer({ ...tiffEntry, result: { ok: true, text: 'page one', engine: 'tesseract', lang: 'por', pages: 1, total: 1, ms: 400, truncated: false, note: '', skipped: [] } })
okNot('tesseract reading the same TIFF gets no such warning, because it reads them all', allPagesReader.includes('holds 4 pages'))

// ---------------------------------------------------------------------------
// 2. The engines on this host
// ---------------------------------------------------------------------------
section('The engines on this host')

const engines = probeEngines({ env: process.env, platform: process.platform })
console.log('  - ' + engineLine(engines, process.platform))

const workdir = mkdtempSync(path.join(os.tmpdir(), 'dsh-ocr-check-'))
const workspace = path.join(workdir, 'workspace')
mkdirSync(workspace, { recursive: true })
writeFileSync(path.join(workspace, 'scan.bmp'), bmp)
writeFileSync(path.join(workspace, 'three-pages.pdf'), pdf)
writeFileSync(path.join(workspace, 'notes.txt'), 'this is a text file, not a picture\n')

const ctx = {
  get: (name) => (name === 'sessions' ? { get: () => ({ header: { cwd: workspace } }) } : undefined),
  logger: { info: () => {}, warn: () => {} },
}
const deps = createDeps(ctx, { env: process.env, platform: process.platform })
const [tool] = buildTools(deps)
const exec = { agent: { session: { id: 'session-check' } } }

const capabilities = {}
for (const engine of [engines.tesseract, engines.windows]) {
  if (engine === null) continue
  capabilities[engine.name] = await deps.capabilities(engine)
  console.log(
    '  - ' + engine.name + ' at ' + engine.file + ': ' + (capabilities[engine.name].ok ? capabilities[engine.name].languages.join(', ') : 'UNUSABLE - ' + capabilities[engine.name].message),
  )
}

check('the tool is named ocr', tool.name, 'ocr')
check('the tool requires a path', tool.parameters.required, ['path'])
ok('the tool declares the transcription caveat to the model', tool.description.includes('TRANSCRIPTION'))
ok('the tool tells the model about read_image', tool.description.includes('read_image'))
ok('the tool tells the model about pdf_read', tool.description.includes('pdf_read'))

// ---------------------------------------------------------------------------
// 3. The tool, driven the way the agent calls it
// ---------------------------------------------------------------------------
section('The tool, driven the way the agent calls it')

const call = (args) => tool.execute(args, exec)

const missing = await call({ path: 'no-such-file.png' })
ok('a missing file is a sentence, not a crash', missing.text.includes('No such file'), missing.text.split('\n')[0])
ok('a refusal still carries a view for the card', missing.view.file.endsWith('no-such-file.png'))

const notAPicture = await call({ path: 'notes.txt' })
ok('a text file is refused by what it IS', notAPicture.text.includes('neither'), notAPicture.text.split('\n')[0])
ok('the refusal points at read for a text file', notAPicture.text.includes('`read`'))

const pagesOnImage = await call({ path: 'scan.bmp', pages: '1-2' })
ok('pages on an image is a stated mistake', pagesOnImage.text.includes('single image'), pagesOnImage.text.split('\n')[0])

const order = engineOrder(engines, 'pdf', 'pdf')
ok('a PDF is only offered to an engine that can rasterize one', order.every((engine) => engine.canReadPdf), order.map((engine) => engine.name).join(',') || '(none)')
const usableImage = [engines.tesseract, engines.windows].filter((engine) => engine && capabilities[engine.name] && capabilities[engine.name].ok)

if (usableImage.length === 0) {
  const refused = await call({ path: 'scan.bmp' })
  ok('with no usable engine the tool says so instead of failing', refused.text.includes('No OCR engine is available'), refused.text.split('\n')[0])
  console.log('\nSKIP: no usable OCR engine on this host, so nothing was actually recognized.')
  console.log('      Both engines are reported above; install tesseract (with traineddata) or run on Windows.')
  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED') + ' (' + passes + ' assertions, engine paths skipped)')
  rmSync(workdir, { recursive: true, force: true })
  process.exit(failures === 0 ? 0 : 1)
}

const image = await call({ path: 'scan.bmp' })
console.log('  - the engine read the built BMP as: ' + JSON.stringify(image.view))
// The recognized text sits between the header and the caveat; the check reads it
// out of the real answer rather than out of the tool's internals.
const imageText = normalize(image.text.slice(image.text.indexOf('\n\n'), image.text.indexOf('This was RECOGNIZED')))
console.log('  - the recognized text was: ' + JSON.stringify(imageText))
ok('the answer separates the header, the text and the caveat', image.text.indexOf('\n\n') > 0 && image.text.indexOf('This was RECOGNIZED') > image.text.indexOf('\n\n'))
console.log('  - the recognized text was: ' + JSON.stringify(imageText))
// What is asserted here is the PIPELINE, not the engine's accuracy. A 5x7
// blocky font at 12x is exactly the kind of input a real OCR engine substitutes
// characters in (a hand-drawn R reads as P, a 0 as O), so this requires the
// reading to carry at least three of the seven characters that were DRAWN -
// enough to prove glyphs became text, and not a pin on which ones.
const drawn = 'OCR2024'
const recovered = [...new Set(drawn.split(''))].filter((character) => imageText.replace(/[^A-Z0-9]/g, '').includes(character))
ok('the engine turned the drawn glyphs into text', recovered.length >= 3, recovered.length + ' of ' + [...new Set(drawn.split(''))].length + ': ' + recovered.join(''))
ok('what came back is words, not noise', /[A-Z0-9]{3}/.test(imageText.replace(/[^A-Z0-9]/g, ' ').replace(/\s+/g, ' ').trim()), JSON.stringify(imageText.slice(0, 60)))
ok('the answer names the engine that read it', image.text.includes(image.view.engine))
ok('the answer says the file was recognized, not extracted', image.text.includes('RECOGNIZED'))
ok('the view records the format and the characters', image.view.format === 'bmp' && image.view.chars > 0)
ok('the recognized text is not empty', imageText.length > 0, JSON.stringify(imageText.slice(0, 80)))

const absolute = await call({ path: path.join(workspace, 'scan.bmp') })
check('an absolute path is read as given', absolute.view.scope, 'absolute')

if (order.length === 0) {
  const refused = await call({ path: 'three-pages.pdf' })
  ok('a PDF with no engine that can read one says so', refused.text.includes('pdf_scan'), refused.text.split('\n')[0])
} else {
  const wholePdf = await call({ path: 'three-pages.pdf' })
  const wholeText = normalize(wholePdf.text)
  ok('the PDF was read page by page', wholePdf.view.pages === 3, 'pages=' + wholePdf.view.pages)
  ok('page 1 was read', wholeText.includes('INVOICE'))
  ok('page 3 was read', wholeText.includes('THIRD'))
  ok('the answer marks each page', wholePdf.text.includes('----- page 1 -----') && wholePdf.text.includes('----- page 3 -----'))

  const secondOnly = await call({ path: 'three-pages.pdf', pages: '2' })
  const secondText = normalize(secondOnly.text)
  check('a page range reads exactly one page', secondOnly.view.pages, 1)
  ok('the page range read page 2', secondText.includes('SECOND'))
  okNot('the page range did NOT read page 1', secondText.includes('INVOICE'))

  const beyond = await call({ path: 'three-pages.pdf', pages: '9' })
  ok('a range entirely past the end is refused by name', beyond.text.includes('3 page') && beyond.text.includes(' 9'), beyond.text.split('\n')[0])

  const partial = await call({ path: 'three-pages.pdf', pages: '2,9' })
  ok('a page that exists is still read', normalize(partial.text).includes('SECOND'), partial.text.split('\n')[0])
  ok('the page that does not exist is named as missing', partial.text.includes('does not exist'), '')

  // The bug this assertion exists for: a language this host has no data for was
  // reported as "no engine can read a PDF", which is false - the engine is here,
  // and the reader would go and install something they already have.
  const wrongLanguage = await call({ path: 'three-pages.pdf', lang: 'xx-XX' })
  if (wrongLanguage.text.includes('no data for')) {
    okNot('a PDF in a missing language is not reported as no engine at all', wrongLanguage.text.includes('No engine on this host can read a PDF page'))
    ok('a PDF in a missing language names the language instead', wrongLanguage.text.includes('xx-XX') && wrongLanguage.text.includes('Leave `lang` off'), wrongLanguage.text.split('\n')[0])
  }
}

const badLanguage = await call({ path: 'scan.bmp', lang: 'xx-XX' })
ok('a language this machine cannot read is refused', badLanguage.text.includes('no data for') || badLanguage.text.includes('No OCR engine'), badLanguage.text.split('\n')[0])
if (badLanguage.text.includes('no data for')) {
  const usable = capabilities[usableImage[0].name]
  okNot('the refusal does not claim there is no engine, which would be a lie', badLanguage.text.includes('No OCR engine is available'))
  ok('the refusal names the language that was asked for', badLanguage.text.includes('xx-XX'))
  ok('the refusal lists the languages this machine CAN read', usable.languages.some((tag) => badLanguage.text.includes(tag)), usable.languages.join(','))
  ok('the refusal says the one thing that works right now - drop lang', badLanguage.text.includes('Leave `lang` off'), '')
}

rmSync(workdir, { recursive: true, force: true })

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED') + ' (' + passes + ' assertions)')
process.exit(failures === 0 ? 0 : 1)
