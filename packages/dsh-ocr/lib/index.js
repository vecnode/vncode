/**
 * dsh-ocr — Node half.
 *
 * One row, one tool, no browser surface and no route: `ocr` is a host question
 * ("what does this picture say?") and the answer is text, so there is nothing
 * for the right bar to draw and nothing to serve. What this row owns is the
 * engine resolution (`engines.js`), the file policy (`paths.js`) and the
 * sentence a reader gets when a machine can read nothing at all.
 *
 * Why it exists at all: core DSH has no OCR. `read_image` returns the picture
 * to a model that has eyes, and a text-only model gets nothing from it; the PDF
 * row's OCR needs tesseract AND a rasterizer installed. So a screenshot, a photo
 * of a page or a scanned PDF was, before this row, unreadable on a machine with
 * none of that - while Windows has had a capable OCR engine built in since
 * Windows 10, needing no install whatsoever.
 *
 * Zero npm dependencies, no engine bundled, no network egress of its own: the
 * engines are the machine's own, resolved from PATH or from the OS install.
 */
import { capabilities as probeCapabilities, probeEngines } from './engines.js'
import { buildTools } from './tools.js'

export const name = 'dsh-ocr'
export const inject = ['tools']

/** Kept in step with package.json by the tracked check. */
export const PLUGIN_VERSION = '0.1.0-alpha.1'

/**
 * The plugin's shared dependencies, one per boot.
 *
 * `enginesNow` is resolved once and cached; a CAPABILITY probe spawns a process,
 * so its answer is cached per engine here too - a conversation that reads five
 * screenshots asks tesseract what languages it has once, not five times.
 *
 * @param ctx - the plugin context (inject: tools).
 * @param options - `{ env, platform }`, for the checks.
 */
export function createDeps(ctx, options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const log = {
    warn: (text) => ctx.logger?.warn?.('[dsh-ocr] ' + text),
    info: (text) => ctx.logger?.info?.('[dsh-ocr] ' + text),
  }
  let probed = null
  const capabilityCache = new Map()
  const enginesNow = () => {
    if (probed === null) probed = probeEngines({ env, platform })
    return probed
  }
  return {
    ctx,
    env,
    platform,
    log,
    enginesNow,
    /**
     * What one engine can actually do here. A probe that FAILS is cached too:
     * an engine with no language data does not grow some by being asked again.
     */
    capabilities: (engine) => {
      const key = engine.name + '\u0000' + engine.file
      if (!capabilityCache.has(key)) capabilityCache.set(key, probeCapabilities(engine))
      return capabilityCache.get(key)
    },
    reprobe: () => {
      probed = null
      capabilityCache.clear()
    },
  }
}

/** The one log line that says what this host can recognize with. */
export function engineLine(engines, platform) {
  const tesseract = engines.tesseract ? 'tesseract at ' + engines.tesseract.file : 'tesseract NOT on PATH'
  let windows
  if (engines.windows) {
    windows = 'Windows OCR available (powershell ' + engines.windows.file + ', languages probed on first use)'
  } else if (platform === 'win32') {
    windows = 'Windows OCR unavailable'
  } else {
    windows = 'Windows OCR not applicable on this platform'
  }
  return tesseract + '; ' + windows
}

/**
 * Activate the row.
 *
 * @param ctx - cordis context (inject: tools).
 */
export function apply(ctx) {
  const deps = createDeps(ctx)
  deps.log.info('active: ' + engineLine(deps.enginesNow(), deps.platform))
  for (const tool of buildTools(deps)) {
    ctx.effect(() => ctx.tools.register(tool), 'dsh-ocr: tool ' + tool.name)
  }
}

/** Exported for the tracked checks: the parts of this row worth driving directly. */
export const __internals = {
  buildTools,
  createDeps,
  engineLine,
  probeEngines,
  probeCapabilities,
}
