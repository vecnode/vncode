/**
 * dsh-writing/vendor/editorjs/build.mjs - fetch, pin and record the vendored
 * Editor.js surface.
 *
 * WHY EDITOR.JS IS VENDORED. The Writing tab edits a document, and this pack declares
 * ZERO npm dependencies in shipped packages: the profile installs every bundle as a live
 * LINK, so a `dependency` is not installed and a plugin cannot `import` one at runtime.
 * Editor.js is therefore fetched from its own upstream, pinned by hash and committed -
 * the same bargain the vendored Konva, CodeMirror, Mermaid, pdf.js and fonts make.
 *
 * WHY THE TARBALLS RATHER THAN `npm install`. Every Editor.js package publishes a
 * self-contained UMD browser build (`dist/*.umd.js`) whose CSS is injected by the file
 * itself, and the tools' own runtime dependencies (`@codexteam/icons`, `@editorjs/dom`,
 * `@editorjs/caret`, `codex-tooltip`, `codex-notifier`) are already bundled into those
 * files. So an install step would add a dependency tree, a lockfile and a `node_modules`
 * - three things to audit - to copy eleven files out. This script reads them out of the
 * PINNED npm tarballs instead, verifying each tarball's own published sha512 BEFORE
 * anything is extracted, so the bytes have one provenance and one hash.
 *
 * SIX PACKAGES, TWO PINS EACH, AND BOTH MATTER:
 *   - the TARBALL's sha512, hardcoded below, is what the registry publishes for that
 *     version (from the signed packument). A tampered or substituted tarball fails
 *     before a byte is extracted.
 *   - each EXTRACTED file's sha256 is recorded in lib/vendor/editorjs/VERSION.json as it
 *     is written, and `--check` re-hashes the committed bytes against that record
 *     OFFLINE. That is the half a check can run on any machine, and it is what makes a
 *     hand-edited or half-copied bundle a failure instead of a mystery.
 *
 * WHAT IS TRIMMED. Nothing is removed from a bundle: it is upstream's own browser build,
 * byte for byte, with two mechanical normalisations that are recorded in VERSION.json
 * rather than hidden -
 *   - CRLF is normalised to LF, because `.gitattributes` stores text as LF
 *     (`* text=auto eol=lf`) and these files' bytes are hashed: a CRLF-hashed file would
 *     report phantom drift on every clean checkout.
 *   - the trailing newline is made exactly one, so the record and the checkout agree.
 * There is no patch and no fork, so nothing here needs to be re-derived when a package is
 * bumped - and there is no credential to redact: the core is Apache-2.0, the tools are
 * MIT, neither carries a service key, and `check-no-secrets.mjs` scans the artifacts like
 * any other file.
 *
 * Usage:
 *   node build.mjs            fetch the pinned tarballs and (re)write lib/vendor/editorjs/
 *   node build.mjs --check    verify the committed files against VERSION.json (offline)
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..', '..')
const outDir = path.join(packageRoot, 'lib', 'vendor', 'editorjs')
const versionFile = path.join(outDir, 'VERSION.json')
const pins = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8')).pins

/**
 * The six pins. `integrity` is the sha512 the registry publishes for that tarball and it
 * is checked BEFORE extraction; the version also lives in this folder's package.json, so
 * `pins.<name>` is the one place a bump is read from. `licence` and `homepage` are
 * recorded because a distribution ships the artifact and the text that covers it.
 */
const PACKAGES = [
  {
    name: 'editorjs',
    version: pins.editorjs,
    npm: '@editorjs/editorjs',
    tarball: 'https://registry.npmjs.org/@editorjs/editorjs/-/editorjs-' + pins.editorjs + '.tgz',
    integrity: 'sha512-te4wI1heK3B8s0pz1asyRPEmOglfkb9ex5nvvCN5OUVDLSnohTszI+yyLI73qOIuUWxenIvJYkOuGHzh/a47Hw==',
    licence: 'Apache-2.0',
    homepage: 'https://editorjs.io/',
    global: 'EditorJS',
    tools: [{ from: 'package/dist/editorjs.umd.js', file: 'editorjs.umd.js', note: 'the editor core: the block model, the caret, the toolbar, the block menu, and the CSS, injected by the file itself' }],
    licences: [{ from: 'package/LICENSE', file: 'LICENSE-editorjs.txt', note: 'Editor.js is Apache-2.0; this is the text the distribution ships beside the artifact' }],
  },
  {
    name: 'paragraph',
    version: pins.paragraph,
    npm: '@editorjs/paragraph',
    tarball: 'https://registry.npmjs.org/@editorjs/paragraph/-/paragraph-' + pins.paragraph + '.tgz',
    integrity: 'sha512-qD6bbWvRc4VvP0mXDOm+hOhzzhUYR9ZjcAvgCuKWcCbUMpCvhVF1s8NX40zdjekPi6JEnuHTamCncTrSzVsVhw==',
    licence: 'MIT',
    homepage: 'https://github.com/editor-js/paragraph',
    tools: [{ from: 'package/dist/paragraph.umd.js', file: 'paragraph.umd.js', note: 'the default text block - a single contenteditable, which is why this package replaces it with one that carries this pack\u2019s marks' }],
    licences: [{ from: 'package/LICENSE', file: 'LICENSE-paragraph.txt', note: 'the Paragraph tool is MIT' }],
  },
  {
    name: 'header',
    version: pins.header,
    npm: '@editorjs/header',
    tarball: 'https://registry.npmjs.org/@editorjs/header/-/header-' + pins.header + '.tgz',
    integrity: 'sha512-eBL9/PLDKiE9ADZycmgps3PLz9Lw8w6rPFXr0mfHuhHQI/ynP/q1vLpyruBrRCflTLD2Dlj5nYPoJjL5mP/MFw==',
    licence: 'MIT',
    homepage: 'https://github.com/editor-js/header',
    tools: [{ from: 'package/dist/header.umd.js', file: 'header.umd.js', note: 'the heading block, levels 1-6 - the model\u2019s own heading range' }],
    licences: [{ from: 'package/LICENSE', file: 'LICENSE-header.txt', note: 'the Header tool is MIT' }],
  },
  {
    name: 'list',
    version: pins.list,
    npm: '@editorjs/list',
    tarball: 'https://registry.npmjs.org/@editorjs/list/-/editorjs-list-' + pins.list + '.tgz',
    integrity: 'sha512-rUTgDSt5wygD3Dp24bNyp6vvye/Xf4UWju0ZuvWeP13Z4cu2z1Jb5JFSTEhCou72XUGuf4xVhtsd8cm/bwUS1g==',
    licence: 'MIT',
    homepage: 'https://github.com/editor-js/list',
    tools: [{ from: 'package/dist/editorjs-list.umd.js', file: 'editorjs-list.umd.js', note: 'the list block (ordered and unordered, with nesting) - the largest of the six, because the tool ships its own icons and DOM helpers' }],
    licences: [{ from: 'package/LICENSE', file: 'LICENSE-list.txt', note: 'the List tool is MIT' }],
  },
  {
    name: 'quote',
    version: pins.quote,
    npm: '@editorjs/quote',
    tarball: 'https://registry.npmjs.org/@editorjs/quote/-/quote-' + pins.quote + '.tgz',
    integrity: 'sha512-D01KUMSDj2r+6Z+xjDkQqI+y6URpeHCvj0+P4pah+GtkG040lWjFb2H4pgHFXuol2cbfyAoraYSw85fuPheCvw==',
    licence: 'MIT',
    homepage: 'https://github.com/editor-js/quote',
    tools: [{ from: 'package/dist/quote.umd.js', file: 'quote.umd.js', note: 'the quote block: the text the model holds, plus a caption the model folds into it as a second line' }],
    licences: [{ from: 'package/LICENSE', file: 'LICENSE-quote.txt', note: 'the Quote tool is MIT' }],
  },
  {
    name: 'code',
    version: pins.code,
    npm: '@editorjs/code',
    tarball: 'https://registry.npmjs.org/@editorjs/code/-/code-' + pins.code + '.tgz',
    integrity: 'sha512-c0zyWodNqjL/0WI67sZvACIOFU9IAHG0UeeIpjss8pZGGNBum+UWkh7nKULK0SYvaOrdPdlWWqjuFU1TFA5jUA==',
    licence: 'MIT',
    homepage: 'https://github.com/editor-js/code',
    tools: [{ from: 'package/dist/code.umd.js', file: 'code.umd.js', note: 'the code block: a plain textarea, so a code block round trips as exactly the characters that were typed' }],
    licences: [{ from: 'package/LICENSE', file: 'LICENSE-code.txt', note: 'the Code tool is MIT' }],
  },
]

/** Every artifact this build writes, in the order the browser loads them. */
const ARTIFACTS = [
  ...PACKAGES[0].tools,
  ...PACKAGES[0].licences,
  ...PACKAGES.slice(1).flatMap((entry) => [...entry.tools, ...entry.licences]),
]

const check = process.argv.includes('--check')

/** sha256 of a buffer, hex. */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** LF-normalised text with exactly one trailing newline. */
function normalise(buffer) {
  const text = buffer.toString('utf8').replace(/\r\n/g, '\n').replace(/\n*$/, '\n')
  return Buffer.from(text, 'utf8')
}

/** A NUL-terminated string out of a tar header field. */
function cstr(buffer, start, end) {
  const slice = buffer.subarray(start, end)
  const nul = slice.indexOf(0)
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8')
}

/**
 * Every regular file in a POSIX tar, as `name -> bytes`.
 *
 * A tar is 512-byte blocks: a header, then the file's bytes padded up to the next block.
 * `x`/`g` records are PAX extended headers - they carry attributes for the NEXT entry (a
 * long path, most often) and their payload is text, so the one field this reader needs
 * from them is `path`. Two zero blocks end the archive, but a shorter read is treated as
 * an error rather than a quiet truncation: a half-read tarball must not produce a
 * half-written artifact.
 */
function untar(buffer) {
  const files = new Map()
  let offset = 0
  let pendingPath = null
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const size = parseInt(cstr(header, 124, 136).trim() || '0', 8)
    const type = String.fromCharCode(header[156])
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    const padded = dataStart + Math.ceil(size / 512) * 512
    if (!Number.isFinite(size) || padded > buffer.length + 512) throw new Error('the tarball is truncated at byte ' + offset)
    if (type === 'x' || type === 'g') {
      const record = buffer.subarray(dataStart, dataEnd).toString('utf8')
      const match = /^\d+ path=(.*)$/m.exec(record)
      if (match) pendingPath = match[1]
    } else if (type === '0' || type === '\u0000') {
      const prefix = cstr(header, 345, 500)
      const raw = cstr(header, 0, 100)
      const name = pendingPath ?? (prefix.length > 0 ? prefix + '/' + raw : raw)
      pendingPath = null
      if (!name.endsWith('/')) files.set(name, buffer.subarray(dataStart, dataEnd))
    }
    offset = padded
  }
  return files
}

/** Read VERSION.json, or null. */
function readVersion() {
  if (!existsSync(versionFile)) return null
  try {
    return JSON.parse(readFileSync(versionFile, 'utf8'))
  } catch (err) {
    return null
  }
}

/** The check: every recorded file is present and hashes to what the record says. */
function runCheck() {
  const record = readVersion()
  if (!record) {
    console.error('FAIL no ' + path.relative(packageRoot, versionFile) + ' - run `node packages/dsh-writing/vendor/editorjs/build.mjs` first')
    process.exitCode = 1
    return
  }
  let failures = 0
  for (const [name, meta] of Object.entries(record.files)) {
    const file = path.join(outDir, name)
    if (!existsSync(file)) {
      console.error('FAIL missing ' + name + ' - the vendored Editor.js surface is not in this checkout')
      failures += 1
      continue
    }
    const bytes = readFileSync(file)
    const digest = sha256(bytes)
    if (digest !== meta.sha256) {
      console.error('FAIL ' + name + ' hashes to ' + digest.slice(0, 16) + ', the record says ' + meta.sha256.slice(0, 16))
      failures += 1
    }
    if (bytes.length !== meta.bytes) {
      console.error('FAIL ' + name + ' is ' + bytes.length + ' bytes, the record says ' + meta.bytes)
      failures += 1
    }
    if (meta.lf === true && bytes.includes(13)) {
      console.error('FAIL ' + name + ' carries CR - .gitattributes stores these text files as LF, so this checkout would report drift forever')
      failures += 1
    }
  }
  if (failures === 0) {
    console.log('ok   ' + Object.keys(record.files).length + ' Editor.js file(s) match ' + path.relative(packageRoot, versionFile))
    console.log('     core ' + record.pins.editorjs + ', tools ' + ['paragraph', 'header', 'list', 'quote', 'code'].map((name) => name + ' ' + record.pins[name]).join(', '))
  } else {
    console.error(failures + ' Editor.js file(s) FAILED')
  }
  process.exitCode = failures === 0 ? 0 : 1
}

/** Fetch the pinned tarballs, verify them, extract what ships and write the record. */
async function runUpdate() {
  mkdirSync(outDir, { recursive: true })
  const recorded = {}
  let total = 0
  for (const entry of PACKAGES) {
    // The tarball URL is read from the PACKUMENT rather than spelled here, so a registry
    // that renames an artifact is a working build, not a 404: the version and the sha512
    // - the two things that decide WHAT is vendored - are still the hardcoded pins.
    const packument = await fetch('https://registry.npmjs.org/' + entry.npm + '/' + entry.version)
    if (!packument.ok) throw new Error('the ' + entry.npm + ' packument answered ' + packument.status + ' for ' + entry.version)
    const meta = await packument.json()
    const url = meta?.dist?.tarball
    if (typeof url !== 'string' || url.length === 0) throw new Error('the ' + entry.npm + ' packument names no tarball for ' + entry.version)
    entry.tarball = url
    const response = await fetch(url)
    if (!response.ok) throw new Error('the ' + entry.npm + ' tarball answered ' + response.status + ' for ' + url)
    const tarball = Buffer.from(await response.arrayBuffer())
    // THE PIN IS CHECKED BEFORE ANYTHING IS EXTRACTED. `integrity` is base64 of the
    // sha512 the registry publishes, so this compares like for like.
    const integrity = 'sha512-' + createHash('sha512').update(tarball).digest('base64')
    if (integrity !== entry.integrity) {
      throw new Error('the ' + entry.npm + ' tarball does not match the pin\n  expected ' + entry.integrity + '\n  got      ' + integrity)
    }
    const files = untar(gunzipSync(tarball))
    for (const artifact of [...entry.tools, ...entry.licences]) {
      const source = files.get(artifact.from)
      if (!source) throw new Error('the ' + entry.npm + ' tarball carries no ' + artifact.from)
      const bytes = normalise(source)
      writeFileSync(path.join(outDir, artifact.file), bytes)
      recorded[artifact.file] = {
        from: artifact.from,
        url: entry.tarball,
        package: entry.npm,
        version: entry.version,
        licence: entry.licence,
        sha256: sha256(bytes),
        bytes: bytes.length,
        lf: true,
        note: artifact.note,
      }
      total += bytes.length
      console.log('ok   ' + artifact.file.padEnd(22) + String(bytes.length).padStart(8) + ' bytes  ' + sha256(bytes).slice(0, 16) + '  ' + entry.npm + '@' + entry.version)
    }
  }
  const digest = sha256(Buffer.from(Object.values(recorded).map((entry) => entry.sha256).sort().join('\n')))
  const record = {
    generatedBy: 'packages/dsh-writing/vendor/editorjs/build.mjs',
    note: 'The vendored Editor.js surface for the Writing tab: the core plus the five block tools this pack maps to its own document model, each upstream\u2019s own self-contained UMD browser build (the core injects its CSS, and every tool bundles its own icons and DOM helpers), taken out of the pinned npm tarballs. Nothing is forked and nothing is patched - the only mechanical change is CRLF-to-LF with one trailing newline, because .gitattributes stores text as LF and these bytes are hashed, so a CRLF-hashed file would report phantom drift on every clean checkout. The core is Apache-2.0 and each tool is MIT; the licence text of each travels beside the bundle it covers. `--check` re-hashes every file OFFLINE from this record; each tarball was verified against the registry\u2019s published sha512 before a byte was extracted.',
    pins: { editorjs: pins.editorjs, paragraph: pins.paragraph, header: pins.header, list: pins.list, quote: pins.quote, code: pins.code },
    integrity: Object.fromEntries(PACKAGES.map((entry) => [entry.npm, entry.integrity])),
    licences: { core: 'Apache-2.0', tools: 'MIT' },
    homepage: 'https://editorjs.io/',
    global: 'EditorJS',
    route: '/api/dsh-writing/vendor/editorjs/',
    files: recorded,
    digest,
  }
  writeFileSync(versionFile, JSON.stringify(record, null, 2) + '\n')
  console.log('')
  console.log('wrote ' + Object.keys(recorded).length + ' file(s), ' + Math.round(total / 1024) + ' KB, digest ' + digest.slice(0, 16))
  console.log('now run: node packages/dsh-writing/vendor/editorjs/build.mjs --check')
}

if (check) runCheck()
else await runUpdate()
