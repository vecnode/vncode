/**
 * dsh-ocr — the one tool the agent calls.
 *
 * `ocr` is deliberately a single tool: recognizing text is one question, and
 * every difference between the engines behind it (explicit language instead of
 * the profile's, a page range, a segmentation mode) is an ARGUMENT to it rather
 * than a second tool the model has to pick correctly before it knows whether
 * this host can do any of it.
 *
 * The answer is built here, in `formatAnswer`, because the interesting part is
 * not the string of text - it is the three things a reader needs beside it: which
 * engine actually read the file, which language it read it as, and the reminder
 * that the result is a TRANSCRIPTION whose digits cannot be trusted.
 */
import fsp from 'node:fs/promises'

import {
  MAX_PAGES,
  chooseLanguage,
  clampDpi,
  engineOrder,
  imageSize,
  parsePageSpec,
  recognize,
  sniffKind,
  tiffPages,
} from './engines.js'
import { OcrError, resolveTarget } from './paths.js'

/** The formats the engines can be handed, and what a refusal says. */
export const ACCEPTED = ['png', 'jpeg', 'gif', 'bmp', 'tiff', 'webp', 'heif']
/** Formats only the Windows engine can decode (a codec, not a parser). */
export const WINDOWS_ONLY = ['heif']

const VIEW_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    name: { type: 'string' },
    scope: { type: 'string', enum: ['workspace', 'absolute'] },
    bytes: { type: 'number' },
    format: { type: 'string' },
    engine: { type: 'string' },
    lang: { type: 'string' },
    pages: { type: 'number' },
    chars: { type: 'number' },
    truncated: { type: 'boolean' },
    ms: { type: 'number' },
  },
  required: ['file'],
}

const PATH_SCHEMA = {
  type: 'string',
  description:
    "The file to read: a path inside this conversation's workspace (relative), or an absolute path - a screenshot, a scan or a photo anywhere on this machine, a chat attachment under <DSH_HOME>/attachments/v1/files/..., or a file in Downloads.",
}

/** The session id one tool call belongs to; '' when the call has none. */
export function sessionOf(exec) {
  const session = exec && exec.agent && exec.agent.session
  const id = session ? session.id : undefined
  return typeof id === 'string' ? id : ''
}

/** One file's size as a reader reads it. */
export function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return value + ' B'
  if (value < 1024 * 1024) return (value / 1024).toFixed(value < 10 * 1024 ? 1 : 0) + ' KB'
  return (value / (1024 * 1024)).toFixed(1) + ' MB'
}

/** How long a recognition took, in the unit a person would say it in. */
export function formatMs(ms) {
  const value = Number(ms) || 0
  return value < 1000 ? value + ' ms' : (value / 1000).toFixed(1) + ' s'
}

/** The head of a file, for identifying it by content rather than by its name. */
async function readHead(file, length = 1024) {
  const handle = await fsp.open(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * The whole answer, from what was asked and what came back.
 *
 * Exported because this is where the tool's honesty lives and the tracked check
 * drives it directly, with a result it hands in itself.
 *
 * @param entry - `{ name, relative, scope, size, format, kind, pages, result }`.
 * @returns the text the conversation shows.
 */
export function formatAnswer(entry) {
  const { result } = entry
  const where = entry.relative ?? entry.file ?? entry.name
  const lines = []
  const dimensions = entry.dimensions ? entry.dimensions.width + 'x' + entry.dimensions.height + ' px, ' : ''
  if (result.ok) {
    const pages =
      result.pages > 0 && (result.total > 1 || result.pages > 1)
        ? ' (' + result.pages + (result.total > result.pages ? ' of ' + result.total : '') + ' pages)'
        : ''
    lines.push(
      where +
        ' - ' +
        dimensions +
        formatBytes(entry.size) +
        ', ' +
        entry.format +
        '. Recognized with ' +
        result.engine +
        (result.lang ? ' (' + result.lang + ')' : '') +
        ' in ' +
        formatMs(result.ms) +
        pages +
        '.',
    )
    lines.push('')
    if (Array.isArray(result.skipped) && result.skipped.length > 0) {
      const many = result.skipped.length > 1
      lines.push(
        (many ? 'Pages ' : 'Page ') +
          result.skipped.join(', ') +
          (many ? ' do not exist' : ' does not exist') +
          ' in this ' +
          result.total +
          '-page document, so nothing was read from ' +
          (many ? 'them' : 'it') +
          '.',
      )
      lines.push('')
    }
    if (result.text.trim() === '') {
      lines.push('(the engine found no text in this file)')
      lines.push('')
      lines.push(
        'That is an answer, not a failure: the page may be blank, or its text may be too small or too faint for the engine at this size. A PDF page can be drawn larger with `dpi` (up to 400), and a picture that is genuinely tiny should be captured or scanned again at a higher resolution.',
      )
      return lines.join('\n')
    }
    lines.push(result.text.replace(/\s+$/, ''))
    lines.push('')
    if (Number(entry.tiffPages) > 1 && result.engine === 'windows-ocr') {
      lines.push(
        'This TIFF holds ' +
          entry.tiffPages +
          ' pages, and the engine that read it decodes the first frame only, so only page 1 is above. `tesseract`, where it is installed, reads every page of a multi-page TIFF in one call.',
      )
      lines.push('')
    }
    if (result.truncated) {
      lines.push('Only the first ' + result.text.length + ' characters are shown; this file has more text than one answer returns.')
      lines.push('')
    }
    if (result.note) {
      lines.push('The engine also reported: ' + result.note)
      lines.push('')
    }
    lines.push(
      'This was RECOGNIZED, not extracted: OCR misreads digits, names, accents and punctuation, and can drop a column. Quote it as recognized text, and prefer the tool that extracts text when the file has a text layer of its own - `pdf_read` for a PDF, `read` for anything textual.',
    )
    return lines.join('\n')
  }
  lines.push('Could not recognize ' + where + ' (' + formatBytes(entry.size) + ', ' + entry.format + '): ' + result.message)
  return lines.join('\n')
}

/**
 * The sentence for "an engine IS here, and it cannot read that language".
 *
 * A language the host has no data for is a different failure from a host with no
 * engine at all, and saying "no OCR engine is available" when the engine was
 * found and merely lacks the data is a lie the reader would act on. It names the
 * language that was asked for, what each engine CAN read, and the one thing that
 * makes it work right now: leaving `lang` off.
 */
export function noLanguageMessage({ requested, languageFailures, failures, defaults }) {
  const lines = ['No engine on this host can read as "' + requested + '".']
  for (const failure of languageFailures) lines.push(failure)
  const usable = [...new Set(defaults.filter((tag) => typeof tag === 'string' && tag !== ''))]
  lines.push(
    'Leave `lang` off to read with the language this machine does have' +
      (usable.length > 0 ? ' (' + usable.join(', ') + ')' : '') +
      ', or name one of the languages listed above.',
  )
  if (failures.length > 0) lines.push('Also unusable on this host: ' + failures.join('; '))
  return lines.join('\n')
}

/** The sentence that says why nothing here can read this file, and what would. */
export function noEngineMessage({ kind, failures, platform, engines }) {
  const lines = []
  if (kind === 'pdf') {
    lines.push(
      'No engine on this host can read a PDF page. tesseract recognizes an image and cannot rasterize a PDF, and the engine Windows ships - which can - is not available here' +
        (failures.length > 0 ? ': ' + failures.join('; ') : '.'),
    )
    lines.push(
      'Two ways forward: on Windows this tool reads a PDF with the engine Windows itself provides (no install at all); anywhere else, `pdf_scan` (dsh-pdf) recognizes a scanned PDF with tesseract once a rasterizer - poppler `pdftoppm`, `mutool` or Ghostscript - and tesseract with the language data are installed.',
    )
    if (platform !== 'win32' && engines.windows === null) {
      lines.push('A PDF that has a text layer of its own needs no OCR at all: `pdf_read` extracts it.')
    }
    return lines.join('\n')
  }
  lines.push('No OCR engine is available on this host' + (failures.length > 0 ? ': ' + failures.join('; ') : '.'))
  lines.push(
    'Install one and this tool starts working with nothing else to configure: `tesseract` with the traineddata for the languages to read, from PATH. On Windows the engine Windows itself ships is used automatically when tesseract is absent.',
  )
  return lines.join('\n')
}

/**
 * Build the tool.
 *
 * @param deps - `{ ctx, enginesNow, capabilities, log }`.
 * @returns the one tool definition to register.
 */
export function buildTools(deps) {
  const engineFailure = (engine, capabilities) => engine.name + ' at ' + engine.file + ': ' + (capabilities.message || 'it reported no usable language data.')

  const tool = {
    name: 'ocr',
    description: [
      'Read the TEXT in a picture or a scanned document: a screenshot, a photo of a page, a scan, or a PDF page with no text layer of its own. This is how a model without eyes reads an image - `read_image` hands the picture to a vision model and returns nothing a text-only model can use, and `read` refuses a binary file.',
      'A REAL OCR engine does the reading, not a guess: `tesseract` from PATH where it is installed, and on Windows the engine Windows itself ships (Windows.Media.Ocr), which needs no install at all and can also rasterize a PDF page - so a scanned PDF is readable on a machine with no tesseract, no poppler and no Ghostscript. The answer names the engine and the language that actually read the file.',
      'An image is recognized directly (PNG, JPEG, GIF, BMP, TIFF, WebP, and HEIC/AVIF where Windows has the codec). A PDF is read page by page where the Windows engine is available; `pages` chooses which ("3", "1-5", "1,4-6", default every page up to ' + MAX_PAGES + ').',
      'What comes back is a TRANSCRIPTION: OCR misreads digits, names, accents and punctuation, and can drop a column. Say that a passage was recognized rather than extracted, and prefer the tool that EXTRACTS text when the file has a text layer of its own - `pdf_read` for a PDF, `read` for anything textual. A scanned PDF is also what dsh-pdf\'s `pdf_scan` is for, where tesseract and a rasterizer are installed.',
      '`lang` accepts either spelling - tesseract\'s "eng"/"por" and Windows\' "en-US"/"pt-PT" both match the engine\'s own list, and "eng+por" asks tesseract for two at once; a language this machine has no data for is refused with the list of what it CAN read. `psm` (0-13) is tesseract\'s page-segmentation mode for an unusual layout; `dpi` (50-400, default 200) is the resolution a PDF page is drawn at before it is read.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: PATH_SCHEMA,
        lang: { type: 'string', description: 'The language to read as: "eng", "por", "en-US", "pt-PT", or "eng+por" for tesseract. Default: the engine\'s own - tesseract reads "eng", Windows reads the languages on your profile.' },
        pages: { type: 'string', description: 'For a PDF: which pages to recognize - "3", "1-5", "1,4-6", or "all" (default). At most ' + MAX_PAGES + ' pages per call. Ignored for an image.' },
        psm: { type: 'number', description: 'tesseract only: page segmentation mode 0-13 (default 3, fully automatic). 6 reads one uniform block, 11 sparse text, 7 a single line. Ignored by the Windows engine.' },
        dpi: { type: 'number', description: 'For a PDF: the resolution a page is drawn at before it is read, 50-400 (default 200). 300 or more helps small print; ignored by tesseract, which reads the image as it is.' },
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, view: VIEW_SCHEMA }, required: ['text', 'view'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => value.view,
    },
    presentCall: (args) => ({ card: 'generic', title: 'Read ' + (args && args.path ? String(args.path) : 'a file'), kind: 'other' }),
    presentResult: (args, result) => ({
      card: 'generic',
      title: 'OCR ' + (result && result.meta && result.meta.name ? result.meta.name : args && args.path ? String(args.path) : ''),
      content: result && result.text ? result.text : '',
    }),
    async execute(args, exec) {
      const engines = deps.enginesNow()
      let target
      try {
        target = await resolveTarget(deps.ctx, { session: sessionOf(exec), path: args.path })
      } catch (err) {
        const message = err instanceof OcrError || (err && err.message) ? String(err.message) : String(err)
        return { text: message, view: { file: typeof args.path === 'string' ? args.path : '' } }
      }
      const view = { file: target.file, name: target.file.split(/[\\/]/).pop(), scope: target.scope, bytes: target.size }
      const head = await readHead(target.file)
      const format = sniffKind(head)
      const kind = format === 'pdf' ? 'pdf' : 'image'
      if (format === null || (kind === 'image' && !ACCEPTED.includes(format))) {
        return {
          text:
            'OCR reads raster images and PDFs, and ' +
            view.name +
            ' is neither: its first bytes are not a PNG, JPEG, GIF, BMP, TIFF, WebP, HEIC/AVIF or PDF header' +
            (format ? ' (' + format + ')' : '') +
            '. A text file does not need OCR - read it with `read` - and an archive, a spreadsheet or an office document has to be converted to an image or a PDF first.',
          view,
        }
      }
      const dimensions = kind === 'image' ? imageSize(head) : null
      const entry = { ...view, format, kind, dimensions, size: target.size, file: target.file, relative: target.relative }
      // A multi-page TIFF is the one raster case where the two engines disagree
      // about how much of the file they read, so the count goes into the answer.
      if (format === 'tiff') entry.tiffPages = tiffPages(head)
      // A page range is a PDF question; naming one for an image is a mistake
      // worth saying rather than ignoring.
      let pages = null
      const spec = typeof args.pages === 'string' ? args.pages.trim() : ''
      if (kind === 'pdf' && spec !== '') {
        const parsed = parsePageSpec(spec)
        if (!parsed.ok) return { text: parsed.message, view }
        pages = parsed.pages
      } else if (kind === 'image' && spec !== '') {
        return { text: '`pages` chooses pages of a PDF, and ' + view.name + ' is a single image (' + format + '). Drop `pages` to read it.', view }
      }
      const order = engineOrder(engines, kind, format)
      const failures = []
      const languageFailures = []
      const defaults = []
      let capableEngines = 0
      let chosen = null
      let language = { ok: true, tag: '' }
      for (const engine of order) {
        const capabilities = await deps.capabilities(engine)
        if (!capabilities.ok) {
          failures.push(engineFailure(engine, capabilities))
          continue
        }
        // The engine is here and has language data: from this point on, a
        // refusal is about the LANGUAGE, never about the engine's absence.
        capableEngines += 1
        defaults.push(capabilities.default)
        const matched = chooseLanguage(capabilities.languages, args.lang)
        if (!matched.ok) {
          languageFailures.push(engine.name + ': ' + matched.message)
          continue
        }
        chosen = engine
        language = matched
        break
      }
      if (chosen === null) {
        if (capableEngines > 0 && languageFailures.length > 0) {
          return { text: noLanguageMessage({ requested: String(args.lang), languageFailures, failures, defaults }), view }
        }
        return { text: noEngineMessage({ kind, failures, platform: process.platform, engines }), view }
      }
      const result = await recognize(chosen, {
        file: target.file,
        kind,
        lang: language.tag,
        pages,
        psm: args.psm,
        dpi: clampDpi(args.dpi),
        signal: exec ? exec.signal : undefined,
      })
      const text = formatAnswer({ ...entry, result })
      return {
        text,
        view: {
          ...view,
          format,
          engine: result.ok ? result.engine : chosen.name,
          lang: result.ok ? result.lang : language.tag,
          pages: result.ok ? result.pages : 0,
          chars: result.ok ? result.text.length : 0,
          truncated: result.ok ? result.truncated === true : false,
          ms: result.ok ? result.ms : 0,
        },
      }
    },
  }
  return [tool]
}
