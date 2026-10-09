/**
 * dsh-ocr — the engines this host can recognize text with, and nothing else.
 *
 * OCR is the one thing a text-only model cannot do for itself: `read_image`
 * hands a picture to a model that has eyes, and a model without them gets
 * nothing from it. This file is the mechanism behind the `ocr` tool: which
 * engine exists, what language it can read, and one file in, one string out.
 *
 * TWO ENGINES, and the difference between them is a capability, not a
 * preference:
 *
 *   - **tesseract**, resolved from PATH, on every platform. It reads RASTER
 *     images only. It is preferred for an image because it is explicit about
 *     language and page segmentation; it is not used for a PDF at all, because
 *     a PDF is not a raster image and the pack already has a tesseract route
 *     for one (dsh-pdf's `pdf_scan`, which rasterizes with poppler, mutool or
 *     Ghostscript and then calls tesseract).
 *   - **Windows' own engine** (`Windows.Media.Ocr`), present on any Windows 10
 *     or 11 machine with no install at all, driven through
 *     `lib/win-ocr.ps1`. It reads raster images AND a PDF page, because
 *     `Windows.Data.Pdf` rasterizes one for it - so on Windows a scanned PDF is
 *     readable with nothing installed. It is preferred for a PDF and is the
 *     fallback for an image.
 *
 * The rules every engine here follows, the same ones the pack's other engine
 * paths follow:
 *
 *   - the binary is RESOLVED from PATH (or from the OS's own install location)
 *     and is never installed, downloaded or bundled;
 *   - it is spawned with an ARGV ARRAY and no shell, so no path, language tag or
 *     option is ever interpreted by a command interpreter;
 *   - it runs under a pinned environment (`LC_ALL=C`) with its output capped and
 *     a deadline it is killed at;
 *   - it writes into a PRIVATE temporary directory that is removed afterwards,
 *     so nothing an engine produces can land in the user's folders;
 *   - a missing engine is a plain sentence, never a broken tool.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** How long one recognition may take. A 20-page PDF is seconds, not minutes. */
export const OCR_TIMEOUT_MS = 120_000
/** Asking an engine what it can do is cheap; it gets its own shorter deadline. */
export const PROBE_TIMEOUT_MS = 20_000
/** How much of an engine's own output is kept before the pipe is cut. */
const OUTPUT_CAP = 8 * 1024 * 1024
/** The most pages one call will recognize, on either engine. */
export const MAX_PAGES = 20
/** The most recognized characters one call returns. */
export const MAX_TEXT_CHARS = 200_000
/** Raster sizes a PDF page may be drawn at. */
export const MIN_DPI = 50
export const MAX_DPI = 400
export const DEFAULT_DPI = 200

/** The helper script the Windows engine runs; it sits beside this file. */
export function windowsHelperPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'win-ocr.ps1')
}

/**
 * Look one executable up on PATH, the way a shell would, without a shell.
 *
 * The PATH searched is the one it is HANDED, not the process's: the capability
 * of a host has to be answerable for an environment that is not this process's
 * (a test that takes every engine away, a profile with its own PATH), and a
 * lookup that silently read `process.env` would make that answer a lie.
 */
export function which(name, extraNames = [], env = process.env) {
  const candidates = [name, ...extraNames]
  const exts = process.platform === 'win32' ? String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']
  const dirs = String(env.PATH ?? '').split(path.delimiter).filter((entry) => entry !== '')
  for (const candidate of candidates) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const full = path.join(dir, candidate + ext)
        try {
          if (existsSync(full) && statSync(full).isFile()) return full
        } catch (err) {
          /* an unreadable PATH entry is not a match */
        }
      }
    }
  }
  return null
}

/**
 * The Windows PowerShell that can project the WinRT types this engine needs.
 *
 * 5.1 and not 7, deliberately: PowerShell 7 cannot load `Windows.Media.Ocr`
 * without an extra SDK assembly beside it, while the 5.1 that ships inside
 * Windows has the projection built in. `DSH_OCR_POWERSHELL` overrides the
 * choice for a host where powershell.exe is somewhere unusual.
 */
export function windowsPowershell(env = process.env) {
  const override = typeof env.DSH_OCR_POWERSHELL === 'string' ? env.DSH_OCR_POWERSHELL.trim() : ''
  if (override !== '') {
    try {
      if (existsSync(override) && statSync(override).isFile()) return override
    } catch (err) {
      /* an unusable override falls through to the standard location */
    }
  }
  const root = env.SystemRoot ?? env.windir ?? 'C:\\Windows'
  const standard = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try {
    if (existsSync(standard) && statSync(standard).isFile()) return standard
  } catch (err) {
    /* fall through to PATH */
  }
  return which('powershell.exe', ['powershell'])
}

/**
 * What this host can recognize with. Cheap and idempotent: it reads the file
 * system and resolves binaries, and it spawns nothing - an engine that is
 * present but broken (no language data, no WinRT projection) is discovered by
 * {@link capabilities}, not here.
 *
 * @returns `{ tesseract, windows, checkedAt }`, each `null` when absent.
 */
export function probeEngines(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  let tesseract = null
  const found = which('tesseract', [], env)
  if (found) {
    // tesseract takes the image and writes to stdout: no output file is created
    // and nothing has to be cleaned up.
    tesseract = {
      name: 'tesseract',
      file: found,
      canReadPdf: false,
      args: ({ file, lang, psm }) => [file, 'stdout', '-l', lang || 'eng', '--psm', String(psm)],
    }
  }
  let windows = null
  const helper = windowsHelperPath()
  const shell = platform === 'win32' ? windowsPowershell(env) : null
  if (shell && existsSync(helper)) {
    windows = {
      name: 'windows-ocr',
      file: shell,
      helper,
      canReadPdf: true,
      args: ({ file, lang, pages, dpi, out, probe }) => {
        const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper]
        if (probe) return [...args, '-Probe']
        args.push('-Path', file, '-OutFile', out, '-Dpi', String(dpi))
        if (lang) args.push('-Lang', lang)
        if (Array.isArray(pages) && pages.length > 0) args.push('-Pages', pages.join(','))
        return args
      },
    }
  }
  return { tesseract, windows, checkedAt: new Date().toISOString() }
}

/** One engine invocation: argv only, pinned env, deadline, capped output. */
function run(file, args, { timeoutMs = OCR_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: OUTPUT_CAP,
        windowsHide: true,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
        signal,
      },
      (err, stdout, stderr) => {
        const aborted = Boolean(err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'))
        resolve({
          ok: !err,
          status: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
          killed: Boolean(err && err.killed),
          aborted,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          error: err && !err.killed && !aborted ? String(err.message) : null,
        })
      },
    )
    child.on('error', () => resolve({ ok: false, status: 1, killed: false, aborted: false, stdout: '', stderr: '', error: 'the engine could not be started' }))
  })
}

/** The last JSON object an engine printed, or null when it printed none. */
export function lastJsonLine(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (line === '' || line[0] !== '{') continue
    try {
      const value = JSON.parse(line)
      if (value && typeof value === 'object') return value
    } catch (err) {
      /* not the reporting line; keep walking back */
    }
  }
  return null
}

/** Windows OCR reports one language as a string and two as an array. */
function asStringList(value) {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string' && entry !== '')
  if (typeof value === 'string' && value !== '') return [value]
  return []
}

/** The same shape rule for page numbers, which Windows also hands back bare. */
function asNumberList(value) {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
  return list.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry) && entry > 0)
}

/** The language tags `tesseract --list-langs` reports. */
export function parseTesseractLanguages(text) {
  return [
    ...new Set(
      String(text)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[a-z]{3}(?:_[A-Za-z]+)?(\+[a-z]{3}(?:_[A-Za-z]+)?)*$/.test(line))
        .map((line) => line.toLowerCase()),
    ),
  ].sort()
}

/**
 * What one engine can actually do HERE: the languages it has data for, and the
 * language it would use by default.
 *
 * Best-effort by design. A probe that fails is reported as a failure with the
 * engine's own words, because "tesseract is installed but has no traineddata" is
 * a different problem from "tesseract is not installed", and only one of them is
 * answered by installing it.
 *
 * @returns `{ ok, languages, default, maxDimension, message }`.
 */
export async function capabilities(engine, options = {}) {
  if (!engine) return { ok: false, languages: [], default: '', maxDimension: null, message: 'no engine' }
  if (engine.name === 'tesseract') {
    const result = await run(engine.file, ['--list-langs'], { timeoutMs: PROBE_TIMEOUT_MS, signal: options.signal })
    const languages = parseTesseractLanguages(result.stdout + '\n' + result.stderr)
    if (languages.length === 0) {
      return {
        ok: false,
        languages: [],
        default: 'eng',
        maxDimension: null,
        message:
          'tesseract is installed at ' +
          engine.file +
          ' but reports no language data' +
          (result.ok ? '.' : ': ' + (result.stderr || result.error || '').trim().split(/\r?\n/)[0]) +
          ' Install the traineddata for the languages to read.',
      }
    }
    return { ok: true, languages, default: 'eng', maxDimension: null, message: '' }
  }
  const result = await run(engine.file, engine.args({ probe: true }), { timeoutMs: PROBE_TIMEOUT_MS, signal: options.signal })
  const report = lastJsonLine(result.stdout)
  if (!report || report.ok !== true) {
    return {
      ok: false,
      languages: [],
      default: '',
      maxDimension: null,
      message:
        'The Windows OCR engine could not be reached' +
        (report && report.message ? ': ' + report.message : result.stderr ? ': ' + result.stderr.trim().split(/\r?\n/)[0] : '.'),
    }
  }
  const languages = asStringList(report.languages)
  if (languages.length === 0) {
    return {
      ok: false,
      languages: [],
      default: '',
      maxDimension: Number(report.maxDimension) || null,
      message:
        'This Windows installation has the OCR engine but no recognizer language installed. ' +
        'Settings > Time & language > Language & region > Add a language, and tick the language pack\'s OCR data ("Optional features"), gives it one.',
    }
  }
  return {
    ok: true,
    languages,
    default: typeof report.default === 'string' ? report.default : '',
    maxDimension: Number(report.maxDimension) || null,
    message: '',
  }
}

// ---------------------------------------------------------------------------
// Language tags
// ---------------------------------------------------------------------------
/**
 * ISO 639-2 (tesseract's tags) and ISO 639-1 (Windows' primary subtags), the
 * languages a document is realistically written in. A tag missing from this
 * table still works when it is spelled the way the chosen engine spells it.
 */
const ISO_639_2_TO_1 = {
  ara: 'ar', bul: 'bg', cat: 'ca', ces: 'cs', chi: 'zh', cze: 'cs', dan: 'da', dut: 'nl', ell: 'el', eng: 'en',
  est: 'et', eus: 'eu', fin: 'fi', fra: 'fr', fre: 'fr', glg: 'gl', ger: 'de', gre: 'el', heb: 'he', hin: 'hi',
  hrv: 'hr', hun: 'hu', ita: 'it', jpn: 'ja', kor: 'ko', lav: 'lv', lit: 'lt', nld: 'nl', nor: 'no', pol: 'pl',
  por: 'pt', ron: 'ro', rum: 'ro', rus: 'ru', slk: 'sk', slo: 'sk', slv: 'sl', spa: 'es', srp: 'sr', swe: 'sv',
  tur: 'tr', ukr: 'uk', vie: 'vi', deu: 'de',
}
const ISO_639_1_TO_2 = (() => {
  const map = {}
  for (const [three, one] of Object.entries(ISO_639_2_TO_1)) if (!map[one]) map[one] = three
  return map
})()

/** Every spelling of one language tag this file will recognize as the same one. */
export function languageAliases(tag) {
  const value = String(tag ?? '').trim().replace(/_/g, '-').toLowerCase()
  if (value === '') return []
  const primary = value.split('-')[0]
  const aliases = new Set([value, primary])
  if (ISO_639_2_TO_1[primary]) aliases.add(ISO_639_2_TO_1[primary])
  if (ISO_639_1_TO_2[primary]) aliases.add(ISO_639_1_TO_2[primary])
  // A tag that also carries a region is still that language: pt-PT and pt-BR
  // are the same "pt" for the purpose of finding data that can read one.
  const region = value.split('-').slice(1).join('-')
  if (region !== '') {
    if (ISO_639_2_TO_1[primary]) aliases.add(ISO_639_2_TO_1[primary] + '-' + region)
    if (ISO_639_1_TO_2[primary]) aliases.add(ISO_639_1_TO_2[primary] + '-' + region)
  }
  return [...aliases]
}

/**
 * How well one available tag answers one requested tag: 3 for the same tag, 2
 * for the same language in another spelling or for another region of it, 0 for a
 * different language.
 */
export function scoreLanguage(availableTag, requestedTag) {
  const want = String(requestedTag ?? '').trim().replace(/_/g, '-').toLowerCase()
  const have = String(availableTag ?? '').trim().replace(/_/g, '-').toLowerCase()
  if (want === '' || have === '') return 0
  if (want === have) return 3
  const available = new Set(languageAliases(have))
  for (const alias of languageAliases(want)) if (available.has(alias)) return 2
  return 0
}

/**
 * The tag to ask an engine for, given what it says it can read.
 *
 * `eng+por` is tesseract's own way of asking for two languages at once, so a
 * request in that form is matched part by part and passed through as the tags
 * the engine actually uses.
 *
 * @returns `{ ok: true, tag }` (`''` means "the engine's own default") or
 * `{ ok: false, message }`.
 */
export function chooseLanguage(available, requested) {
  const wanted = String(requested ?? '').trim()
  if (wanted === '') return { ok: true, tag: '' }
  const list = Array.isArray(available) ? available : []
  const parts = wanted.split('+').map((part) => part.trim()).filter((part) => part !== '')
  if (parts.length === 0) return { ok: true, tag: '' }
  const chosen = []
  for (const part of parts) {
    let best = null
    let bestScore = 0
    for (const tag of list) {
      const score = scoreLanguage(tag, part)
      if (score > bestScore) {
        best = tag
        bestScore = score
      }
    }
    if (best === null) {
      const shown = list.slice(0, 40)
      return {
        ok: false,
        message:
          'This engine has no data for "' +
          part +
          '". It can read: ' +
          (shown.length > 0 ? shown.join(', ') + (list.length > shown.length ? ', ...' : '') : '(nothing - it reports no language data at all)') +
          '.',
      }
    }
    chosen.push(best)
  }
  return { ok: true, tag: [...new Set(chosen)].join('+') }
}

// ---------------------------------------------------------------------------
// The file itself
// ---------------------------------------------------------------------------
/** What a file IS, from its own first bytes - the extension is a claim, not a fact. */
export function sniffKind(head) {
  if (!Buffer.isBuffer(head) || head.length < 4) return null
  const text = (from, to) => head.toString('latin1', from, to)
  if (text(0, 5) === '%PDF-') return 'pdf'
  if (head[0] === 0x89 && text(1, 4) === 'PNG') return 'png'
  if (head[0] === 0xff && head[1] === 0xd8) return 'jpeg'
  if (text(0, 6) === 'GIF87a' || text(0, 6) === 'GIF89a') return 'gif'
  if (text(0, 2) === 'BM') return 'bmp'
  if (text(0, 4) === 'II*\u0000' || text(0, 4) === 'MM\u0000*') return 'tiff'
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return 'webp'
  // HEIC and AVIF are the same ISOBMFF box with a different brand, and they are
  // called 'heif' here because what can read one is a CODEC rather than a
  // parser: the Windows imaging stack reads it only where that codec is
  // installed, and tesseract's own reader does not.
  if (head.length >= 12 && text(4, 8) === 'ftyp' && ['avif', 'avis', 'heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(text(8, 12))) return 'heif'
  return null
}

/** The pixel size a raster header states, or null when this cannot read it. */
export function imageSize(head) {
  if (!Buffer.isBuffer(head)) return null
  const kind = sniffKind(head)
  if (kind === 'png' && head.length >= 24) return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
  if (kind === 'bmp' && head.length >= 26) return { width: head.readInt32LE(18), height: Math.abs(head.readInt32LE(22)) }
  if (kind === 'gif' && head.length >= 10) return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) }
  if (kind === 'jpeg') {
    let offset = 2
    while (offset + 9 < head.length) {
      if (head[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = head[offset + 1]
      const length = head.readUInt16BE(offset + 2)
      // SOF0..SOF15, minus the four markers that are not frame headers.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: head.readUInt16BE(offset + 7), height: head.readUInt16BE(offset + 5) }
      }
      offset += 2 + length
    }
  }
  return null
}

/**
 * How many pages a TIFF holds, from its own IFD chain, or null when the header
 * does not say.
 *
 * This matters because the two engines disagree here: tesseract reads EVERY page
 * of a multi-page TIFF in one call, and the Windows decoder reads the first
 * frame. A scan of ten pages read as one page is exactly the kind of silence a
 * reader would not notice, so the count is read out of the header and the answer
 * says which of the two happened.
 */
export function tiffPages(head) {
  if (!Buffer.isBuffer(head) || head.length < 8) return null
  const little = head.toString('latin1', 0, 2) === 'II'
  const big = head.toString('latin1', 0, 2) === 'MM'
  if (!little && !big) return null
  const read16 = (offset) => (little ? head.readUInt16LE(offset) : head.readUInt16BE(offset))
  const read32 = (offset) => (little ? head.readUInt32LE(offset) : head.readUInt32BE(offset))
  if (read16(2) !== 42) return null
  let offset = read32(4)
  let pages = 0
  // Bounded by the header this was given: an IFD past the end of the head is not
  // a page count this file can honestly report.
  while (offset > 0 && offset + 2 <= head.length && pages < 200) {
    const entries = read16(offset)
    const next = offset + 2 + entries * 12
    if (next + 4 > head.length) {
      // The chain continues but not inside the bytes this was handed: the pages
      // counted so far are real, and whether there is one more is not known.
      return null
    }
    pages += 1
    offset = read32(next)
  }
  return pages > 0 ? pages : null
}

/**
 * A page selection, as the caller wrote it: `"3"`, `"1-5"`, `"1,4-6"`, `"all"`.
 *
 * @returns `{ ok: true, pages }` where `pages` is a sorted list of page numbers
 * or `null` for "every page"; `{ ok: false, message }` for anything else.
 */
export function parsePageSpec(spec) {
  const text = String(spec ?? '').trim()
  if (text === '' || /^all$/i.test(text)) return { ok: true, pages: null }
  const pages = []
  for (const part of text.split(',')) {
    const piece = part.trim()
    if (piece === '') continue
    const single = /^(\d+)$/.exec(piece)
    if (single) {
      if (Number(single[1]) < 1) return { ok: false, message: 'Pages are numbered from 1; "' + piece + '" is not a page.' }
      pages.push(Number(single[1]))
      continue
    }
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(piece)
    if (!range) {
      return { ok: false, message: '"' + piece + '" is not a page or a page range. Write "3", "1-5", "1,4-6" or "all".' }
    }
    let from = Number(range[1])
    let to = Number(range[2])
    if (from > to) [from, to] = [to, from]
    if (from < 1) return { ok: false, message: 'Pages are numbered from 1; "' + piece + '" starts below it.' }
    for (let page = from; page <= to; page += 1) pages.push(page)
  }
  const unique = [...new Set(pages)].sort((left, right) => left - right)
  if (unique.length === 0) return { ok: false, message: 'No page was named. Write "3", "1-5", "1,4-6" or "all".' }
  if (unique.length > MAX_PAGES) {
    return { ok: false, message: 'That is ' + unique.length + ' pages; one call recognizes at most ' + MAX_PAGES + '.' }
  }
  return { ok: true, pages: unique }
}

/** Clamp a requested resolution into the range this plugin will ask for. */
export function clampDpi(value) {
  const dpi = Number(value)
  if (!Number.isFinite(dpi) || dpi <= 0) return DEFAULT_DPI
  return Math.min(MAX_DPI, Math.max(MIN_DPI, Math.round(dpi)))
}

/**
 * The engines that can read this file, in the order they are tried.
 *
 * The order is a capability argument, not a preference. A PDF needs an engine
 * that can rasterize one. A HEIC or an AVIF needs a codec, which only the
 * Windows imaging stack has. An ordinary raster image goes to tesseract first
 * where it is installed, because it is explicit about language and page
 * segmentation and its answer is the same on every platform.
 */
export function engineOrder(engines, kind, format) {
  const list = []
  if (kind === 'pdf') {
    if (engines.windows && engines.windows.canReadPdf) list.push(engines.windows)
    if (engines.tesseract && engines.tesseract.canReadPdf) list.push(engines.tesseract)
    return list
  }
  if (format === 'heif') {
    if (engines.windows) list.push(engines.windows)
    return list
  }
  if (engines.tesseract) list.push(engines.tesseract)
  if (engines.windows) list.push(engines.windows)
  return list
}

/**
 * Recognize one file.
 *
 * @param engine - an entry from {@link probeEngines}.
 * @param options - `{ file, kind, lang, pages, psm, dpi, signal }`.
 * @returns `{ ok, text, engine, lang, pages, total, ms, truncated }` or
 * `{ ok: false, reason, message }`.
 */
export async function recognize(engine, options) {
  if (engine.name === 'windows-ocr') return recognizeWindows(engine, options)
  return recognizeTesseract(engine, options)
}

/** tesseract: the image and `stdout` as its output base, so it writes no file. */
async function recognizeTesseract(engine, options) {
  const started = Date.now()
  const psm = Number.isFinite(Number(options.psm)) && Number(options.psm) >= 0 && Number(options.psm) <= 13 ? Math.round(Number(options.psm)) : 3
  const lang = options.lang || 'eng'
  const result = await run(engine.file, engine.args({ file: options.file, lang, psm }), { timeoutMs: OCR_TIMEOUT_MS, signal: options.signal })
  const text = result.stdout
  if (!result.ok && text.trim() === '') {
    const detail = (result.stderr || result.error || '').trim().split(/\r?\n/).slice(0, 3).join(' ')
    return {
      ok: false,
      reason: result.aborted ? 'aborted' : result.killed ? 'timeout' : 'engine-failed',
      message: result.aborted ? 'The call was cancelled.' : result.killed ? 'tesseract did not finish in ' + Math.round(OCR_TIMEOUT_MS / 1000) + ' seconds and was stopped.' : 'tesseract could not recognize that file: ' + (detail || 'it reported nothing.'),
    }
  }
  return finish({ started, text, engine: engine.name, lang, pages: 1, total: 1, note: result.stderr.trim().split(/\r?\n/)[0] || '' })
}

/** Windows' own engine, through lib/win-ocr.ps1: text to a file, verdict to stdout. */
async function recognizeWindows(engine, options) {
  const started = Date.now()
  const dir = path.join(os.tmpdir(), 'dsh-ocr-' + randomBytes(6).toString('hex'))
  mkdirSync(dir, { recursive: true })
  const out = path.join(dir, 'text.txt')
  try {
    const args = engine.args({
      file: options.file,
      lang: options.lang,
      pages: Array.isArray(options.pages) ? options.pages : null,
      dpi: clampDpi(options.dpi),
      out,
    })
    const result = await run(engine.file, args, { timeoutMs: OCR_TIMEOUT_MS, signal: options.signal })
    const report = lastJsonLine(result.stdout)
    if (!report) {
      const detail = (result.stderr || result.error || '').trim().split(/\r?\n/).slice(0, 3).join(' ')
      return {
        ok: false,
        reason: result.aborted ? 'aborted' : result.killed ? 'timeout' : 'engine-failed',
        message: result.aborted
          ? 'The call was cancelled.'
          : result.killed
            ? 'The Windows OCR engine did not finish in ' + Math.round(OCR_TIMEOUT_MS / 1000) + ' seconds and was stopped.'
            : 'The Windows OCR engine reported nothing' + (detail ? ': ' + detail : '.'),
      }
    }
    if (report.ok !== true) {
      return { ok: false, reason: String(report.code ?? 'engine-failed'), message: String(report.message ?? 'The Windows OCR engine refused that file.') }
    }
    let text = ''
    try {
      text = readFileSync(out, 'utf8')
    } catch (err) {
      return { ok: false, reason: 'no-output', message: 'The Windows OCR engine wrote no text file. Nothing was recognized.' }
    }
    return finish({
      started,
      text,
      engine: engine.name,
      lang: typeof report.lang === 'string' ? report.lang : options.lang,
      pages: Number(report.pages) || 0,
      total: Number(report.total) || 0,
      // A page number past the end is reported as skipped rather than as a page
      // with no text, and ConvertTo-Json hands a single one back as a scalar.
      skipped: asNumberList(report.skipped),
      note: '',
    })
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      /* a temporary directory that will not delete is the OS's problem */
    }
  }
}

/** One recognized text, with the length cap applied and the timing attached. */
function finish({ started, text, engine, lang, pages, total, note, skipped = [] }) {
  const value = String(text ?? '')
  const truncated = value.length > MAX_TEXT_CHARS
  return {
    ok: true,
    text: truncated ? value.slice(0, MAX_TEXT_CHARS) : value,
    truncated,
    engine,
    lang,
    pages,
    total,
    skipped,
    ms: Date.now() - started,
    note,
  }
}
