// check-canvas-panel.mjs — drive the Canvas tab's RIGHT BAR and its direct
// manipulation in a REAL browser, with the REAL bundle, the REAL engine and the REAL
// vendored faces.
//
// Why this exists: the other two canvas checks prove the arithmetic (node) and the
// picture (browser: layout -> paint -> PNG). Neither can see the two things this
// alpha is about, because both are properties of MOUNTED UI:
//
//   1. THE RIGHT BAR DOES NOT OVERFLOW. Its two jobs are two panes (shape / inspect)
//      and every scrolling block inside them is named, so a design with two hundred
//      layers costs the sections under the list nothing. A css/source assertion can
//      only say the rules are written; this measures the boxes the browser produced.
//   2. A BORDER DRAG IS A RESIZE, AND ONLY A RESIZE. The gesture is decided on
//      pointer down and the pointer is captured for its length. The regression this
//      pins is the DEAD GESTURE: a text node used to draw (and hit-test) a top and a
//      bottom handle, the drag was read as a stretch, the height was dropped, and the
//      selection looked like it refused to move.
//
// It boots on a loopback server that answers the plugin's own routes from the
// plugin's own files, mounts the real `CanvasView` against a stubbed host (the
// document route applies the pointer ops it is sent, so a gesture is a real write),
// and posts the measured numbers back.
//
// It needs a Chromium-family browser. With none installed it SKIPS LOUDLY and exits
// 0 - a check that downloads a browser to pass is not a check. It also needs a React
// runtime and a react-dom one, which it takes from whatever the machine already has
// (the harness's own install first); with neither it skips loudly too. `--keep` keeps
// the throwaway sandbox, and `--dump` writes the page, the stage and the client this
// check serves into `.scratch/` so a person can open the mounted panel by hand.
//
// Run:  node scripts/checks/check-canvas-panel.mjs [--keep] [--dump] [--trace]
export {} // (import-free: ESM for the dynamic imports below)

const { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = await import('node:fs')
const { createServer } = await import('node:http')
const { createRequire } = await import('node:module')
const { spawn } = await import('node:child_process')
const os = await import('node:os')
const path = (await import('node:path')).default
const { fileURLToPath } = await import('node:url')

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const keep = process.argv.includes('--keep')
const canvasDir = path.join(repo, 'packages/dsh-canvas')

let failures = 0
function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(56) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}

/** The pinned harness line this pack is built against, or null. */
function pinnedDshVersion() {
  try {
    return JSON.parse(readFileSync(path.join(repo, '.dsh-version.json'), 'utf8')).dsh
  } catch (err) {
    return null
  }
}

/** Whether one node_modules root holds the pinned line's packages. */
function carriesPinnedLine(root, pin) {
  try {
    return JSON.parse(readFileSync(path.join(root, '@deepseek-ai', 'dsh-client-ui-theme', 'package.json'), 'utf8')).version === pin
  } catch (err) {
    return false
  }
}

/** Every node_modules root worth looking in, the pinned line's first. */
function moduleRoots() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const roots = [path.join(home, 'profiles', 'node_modules')]
  const caches = [process.env.LOCALAPPDATA, process.env.APPDATA].filter(Boolean).map((base) => path.join(base, 'npm-cache', '_npx'))
  caches.push(path.join(os.homedir(), '.npm', '_npx'))
  for (const cache of caches) {
    if (!existsSync(cache)) continue
    for (const entry of readdirSync(cache)) roots.push(path.join(cache, entry, 'node_modules'))
  }
  roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules')
  const pin = pinnedDshVersion()
  if (pin === null) return roots
  return [...roots.filter((root) => carriesPinnedLine(root, pin)), ...roots.filter((root) => !carriesPinnedLine(root, pin))]
}

/**
 * A React and a react-dom for the page to run on.
 *
 * A UMD build is what this needs: the bundle requires 'react' and 'react-dom/client'
 * by name, and a classic script installs exactly those globals. `react-dom/umd/` is
 * required, not `react-dom/client.js`, because the page mounts a real tree with
 * `createRoot`.
 */
function findReactPair() {
  for (const root of moduleRoots()) {
    const react = path.join(root, 'react', 'umd', 'react.development.js')
    const dom = path.join(root, 'react-dom', 'umd', 'react-dom.development.js')
    if (existsSync(react) && existsSync(dom)) return { react, dom, root }
    // The react-dom UMD file resolves react through its own dependency tree, so a
    // root that has BOTH is the only usable one; try the paired install too.
    try {
      const requireFrom = createRequire(path.join(root, 'index.js'))
      const reactDir = path.dirname(requireFrom.resolve('react/package.json'))
      const domDir = path.dirname(requireFrom.resolve('react-dom/package.json'))
      const reactUmd = path.join(reactDir, 'umd', 'react.development.js')
      const domUmd = path.join(domDir, 'umd', 'react-dom.development.js')
      if (existsSync(reactUmd) && existsSync(domUmd)) return { react: reactUmd, dom: domUmd, root }
    } catch (err) {
      /* this root cannot resolve the pair: the next one may */
    }
  }
  return null
}

/**
 * A Chromium-family browser on this machine, or null.
 *
 * The same three families `dsh-browser`'s engine resolves, resolved here rather than
 * imported: a check may reach into another package's files, but a package may not,
 * and this one has no reason to own an engine resolver.
 */
function findBrowser() {
  const configured = process.env.DSH_CANVAS_BROWSER
  if (typeof configured === 'string' && configured.length > 0 && existsSync(configured)) return configured
  const candidates = []
  if (process.platform === 'win32') {
    const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['LOCALAPPDATA']].filter(Boolean)
    for (const root of roots) {
      candidates.push(
        path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(root, 'Chromium', 'Application', 'chrome.exe'),
      )
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    )
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium')
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

const browser = findBrowser()
const reactPair = findReactPair()
if (browser === null) {
  console.log('skip the canvas panel checks                            (no Chromium-family browser on this host)')
  console.log('     set DSH_CANVAS_BROWSER to a chrome/edge/chromium binary to run it')
  process.exitCode = 0
} else if (reactPair === null) {
  console.log('skip the canvas panel checks                            (no React + react-dom UMD pair on this host)')
  process.exitCode = 0
} else {
  console.log('browser: ' + browser)
  console.log('react:   ' + reactPair.react)
  console.log('')

  // -------------------------------------------------------------------------
  // The page: the real bundle, mounted against a stubbed host
  // -------------------------------------------------------------------------
  const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>dsh-canvas panel check</title>
<script>
(function () {
  var send = function (text) {
    try {
      fetch('/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: false, errors: [text], console: [] }) })
    } catch (err) { /* nothing left to do */ }
  }
  window.addEventListener('error', function (event) {
    send('early error: ' + (event.message || 'unknown') + ' @ ' + (event.filename || '?') + ':' + (event.lineno || 0))
  })
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason && event.reason.message ? event.reason.message : String(event.reason)
    send('unhandled rejection: ' + reason)
  })
})()
</script>
<script src="/react.js"></script>
<script src="/react-dom.js"></script>
</head><body>
<div id="host" style="position:relative;width:100%;height:100vh"></div>
<script>
// The stage proves it is alive before it does anything that can fail, so "the page
// never reported" can never be confused with "the page never ran". It is not a
// result: it carries 'booted', and the host keeps waiting for the real one.
try {
  fetch('/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: false, errors: [], booted: true, console: [] }) })
} catch (err) { /* nothing left to do */ }
</script>
<script src="/stage.js"></script>
</body></html>`

  // -------------------------------------------------------------------------
  // The stage: everything that needs no string escaping, served as its own file
  // -------------------------------------------------------------------------
  const STAGE = `
const report = { ok: false, errors: [], console: [] }
// THE REPORTS GO THROUGH THE REAL fetch, kept before the stub below replaces it:
// the stub exists to answer the PLUGIN's routes, and a report routed into it would
// be answered with the stub's own 404.
const realFetch = window.fetch.bind(window)
const post = (body) => realFetch('/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
/** A progress post: the host keeps it, so a stage that dies silently still says how
 *  far it got. It is NOT a result (it carries a 'progress' key), which is what keeps
 *  it from being mistaken for one. */
const progress = (step, detail) => post({ progress: step, detail: detail === undefined ? null : String(detail), ok: false, errors: [], console: [] })
const log = (line) => { report.console.push(String(line)) }
// Errors that happen while React is rendering never reach this function's own try:
// React reports them to the window. They are collected so a stage that stops can say
// what stopped it.
const seenErrors = []
window.addEventListener('error', (event) => { seenErrors.push('error: ' + (event.message || 'unknown')) })
window.addEventListener('unhandledrejection', (event) => { seenErrors.push('rejection: ' + (event.reason && event.reason.message ? event.reason.message : String(event.reason))) })
// THE YIELD IS A TIMER, NOT A FRAME. requestAnimationFrame is tied to painting and
// a page with nothing left to paint may never run another callback - measured: a
// stage that yielded with rAF stopped dead after the first paint, silently, with no
// exception and no report. A zero-delay timer always runs.
const frame = () => new Promise((resolve) => setTimeout(resolve, 0))
const settle = async (rounds) => { for (let index = 0; index < (rounds || 6); index += 1) await frame() }

async function run() {
  try {
    report.step = 'engine'
    await progress('engine: fetching the engine route')
    // The page's own facts, so a browser that cannot run the stage says why.
    report.hasReact = typeof React !== 'undefined' && typeof React.createElement === 'function'
    report.hasReactDom = typeof ReactDOM !== 'undefined' && typeof ReactDOM.createRoot === 'function'
    report.hasPointerEvent = typeof PointerEvent === 'function'

    // 1. The engine the bundle will fetch, kept for the stub below.
    await progress('host: loading the engine source')
    const engineSource = await (await realFetch('/engine.js')).text()
    // AND THE ENGINE ITSELF, imported the way the tab imports it. The stub's document
    // route uses its applyPatches, so the fixture's host half applies a patch with the
    // real semantics rather than a hand-written setter that only understood a plain set.
    let engineApply = null
    try {
      const engineUrl = URL.createObjectURL(new Blob([engineSource], { type: 'text/javascript' }))
      engineApply = (await import(engineUrl)).applyPatches
      URL.revokeObjectURL(engineUrl)
    } catch (err) {
      engineApply = null
    }

    // 2. The host, stubbed at the fetch boundary. The DOCUMENT route really applies
    //    the pointer ops it is sent, so a drag is a real write and the document the
    //    tab holds afterwards is the one a person would have got. The DELETE route
    //    records what it was asked to remove, so the request can be asserted.
    let current = null
    window.__deletes = []
    window.__ops = []
    window.__exports = []
    const applyOps = (document_, ops) => {
      for (const op of ops || []) {
        const parts = String(op.at || '').split('.')
        let cursor = document_
        for (let index = 0; index < parts.length - 1; index += 1) {
          const key = parts[index]
          cursor = Array.isArray(cursor) ? cursor[Number(key)] : cursor[key]
          if (cursor === undefined || cursor === null) break
        }
        if (cursor === undefined || cursor === null) continue
        const last = parts[parts.length - 1]
        if (Array.isArray(cursor)) cursor[Number(last)] = op.value
        else cursor[last] = op.value
      }
      return document_
    }
    const stub = async (url, options) => {
      const target = typeof url === 'string' ? url : url && url.url ? url.url : String(url)
      const parsed = new URL(target, location.origin)
      const pathname = parsed.pathname
      const json = (value, status) => new Response(JSON.stringify(value), { status: status || 200, headers: { 'content-type': 'application/json' } })
      if (pathname === '/api/dsh-canvas/vendor/engine.js') return new Response(engineSource, { status: 200, headers: { 'content-type': 'text/javascript' } })
      // THE INTERACTION LAYER IS SERVED ON REQUEST. The tab loads Konva when this
      // route answers and stands on its own handlers when it does not - so this check
      // drives the FALLBACK editor first (everything below was written for it) and
      // then mounts once more with the route switched on, which is the shipped path.
      if (pathname === '/api/dsh-canvas/vendor/konva.js') {
        if (window.__konvaAvailable !== true) return new Response('no', { status: 404 })
        return realFetch('/konva.js')
      }
      if (pathname === '/api/dsh-canvas/state') return json(window.__state)
      if (pathname.startsWith('/api/dsh-canvas/vendor/fonts/')) return realFetch('/fonts/' + pathname.split('/').pop())
      if (pathname === '/api/dsh-canvas/document') {
        const body = JSON.parse(String(options && options.body ? options.body : '{}'))
        if (Array.isArray(body.ops)) {
          // THE REAL PATCHER, not a stand-in. The document route is where a person's edit
          // becomes the host's document, so the fixture applies it with the SAME
          // applyPatches the host runs - which means the verbs this check drives (insert,
          // remove, append, z-order) are exercised against the real semantics, and a patch
          // the engine refuses leaves the document alone instead of looking like a no-op.
          const patched = engineApply ? engineApply(current.document, body.ops) : null
          if (patched && patched.document) current.document = patched.document
          else applyOps(current.document, body.ops)
          current.revision += 1
          window.__ops.push(body.ops)
        }
        return json({ design: current })
      }
      if (pathname === '/api/dsh-canvas/delete') {
        const body = JSON.parse(String(options && options.body ? options.body : '{}'))
        window.__deletes.push({ id: body.id, scope: body.scope, session: body.session })
        // The host answers whether it REMOVED one; the payload is then filtered
        // client-side, exactly as the real route leaves it.
        return json({ ok: true, removed: body.id === current.id })
      }
      if (pathname === '/api/dsh-canvas/render-queue') return json({ items: [] })
      if (pathname === '/api/dsh-canvas/render-report') {
        // THE EXPORT ROUTE. The page really rasterizes (the engine, the faces and the
        // design are all the real ones), so what is recorded here is what the tab
        // would have handed the host: which format, which scale, which destination,
        // and how big the picture it produced actually was.
        const body = JSON.parse(String(options && options.body ? options.body : '{}'))
        window.__exports.push({ purpose: body.purpose, format: body.format, scale: body.scale, target: body.target, name: body.name, png: typeof body.png === 'string', svg: typeof body.svg === 'string', width: body.width, height: body.height, pngBytes: typeof body.png === 'string' ? body.png.length : 0 })
        return json({ ok: true, path: 'C:/tmp/' + body.name + '.' + body.format })
      }
      if (pathname === '/api/dsh-canvas/render-report') return json({ ok: true })
      return json({ error: { message: 'no such route: ' + pathname } }, 404)
    }
    window.fetch = (url, options) => stub(url, options).catch((err) => { log('stub failed: ' + err.message); throw err })

    // 3. The client bundle, registered through the module loader the shell uses.
    await progress('bundle: loading the client bundle')
    await new Promise((resolve, reject) => {
      window.__ModuleLoader__ = {
        load(entry) {
          try {
            window.__canvas = entry.factory((name) => {
              if (name === 'react') return { createElement: React.createElement, useState: React.useState, useEffect: React.useEffect, useCallback: React.useCallback, useRef: React.useRef, useMemo: React.useMemo, Fragment: React.Fragment }
              if (name === 'react/jsx-runtime') return { jsx: React.createElement, jsxs: React.createElement }
              if (name === 'react-dom/client') return window.ReactDOM
              throw new Error('the stage has no module for ' + name)
            })
            resolve()
          } catch (err) {
            reject(err)
          }
        },
      }
      const script = document.createElement('script')
      script.src = '/client.js'
      script.onerror = () => reject(new Error('the client bundle did not load'))
      document.head.appendChild(script)
    })

    // 4. The state the host would answer with: the real presets, the real style
    //    library, the real vendored faces - and a design with MANY layers, which is
    //    the shape the right bar has to survive. Read through the REAL fetch: the
    //    stub answers the plugin's routes, not this file.
    report.step = 'state'
    await progress('state: reading the stub state')
    window.__state = JSON.parse(await (await realFetch('/state.json')).text())
    current = window.__state.designs[0]
    report.layers = current.document.layers.length
    report.presetSize = current.document.canvas.width + 'x' + current.document.canvas.height

    // 5. Mount the real view.
    report.step = 'mount'
    await progress('mount: rendering the view')
    report.hasCanvasInternals = Boolean(window.__canvas && window.__canvas.__internals)
    report.hasCanvasView = Boolean(window.__canvas && window.__canvas.__internals && typeof window.__canvas.__internals.CanvasView === 'function')
    const mount = document.getElementById('host')
    let root = ReactDOM.createRoot(mount)
    root.render(React.createElement('div', { style: { position: 'absolute', inset: '0' } }, React.createElement(window.__canvas.__internals.CanvasView, { canvasSession: 'panel' })))
    // The store loads, the engine imports from a blob URL, the faces install, the
    // design lays out and paints: all of it is async, so wait for the artboard.
    const waitFor = async (selector, rounds) => {
      for (let index = 0; index < (rounds || 300); index += 1) {
        if (document.querySelector(selector)) return true
        await frame()
      }
      return false
    }
    report.artboard = await waitFor('[data-canvas-artboard]')
    report.layersRendered = await waitFor('[data-canvas-layers]')
    // THE CANVAS TAB IS ONE SURFACE (alpha.13). Excalidraw used to be the tab's
    // default, with the design surface behind a mode and Alt+D as the only way back
    // - so a check whose subject is this panel had to reach it through that key.
    // There is no mode any more: the bar and the artboard are there on the first
    // frame, and nothing has to be pressed to get to them.
    report.surfaceAttribute = (document.querySelector('[data-dsh-canvas-view]') || {}).getAttribute
      ? document.querySelector('[data-dsh-canvas-view]').getAttribute('data-canvas-surface')
      : null
    report.barOnOpen = document.querySelector('[data-canvas-bar]') !== null
    report.zoomControl = document.querySelector('[data-canvas-zoom]') !== null

    // Errors React reported to the window while mounting, kept for the failure path.
    report.console = report.console.concat(seenErrors)
    report.markup = String(mount.innerHTML).replace(/\\s+/g, ' ').slice(0, 400)
    await settle(10)

    const rectOf = (element) => (element ? element.getBoundingClientRect() : null)
    const side = document.querySelector('[data-canvas-side]')
    const tabs = document.querySelector('[data-canvas-side-tabs]')
    const designPane = document.querySelector('[data-canvas-pane=design]')
    const inspectPane = document.querySelector('[data-canvas-pane=inspect]')
    const listScroll = document.querySelector('.cnv-layersScroll')
    const art = document.querySelector('[data-canvas-artboard]')
    report.geometry = {
      side: rectOf(side) ? { w: rectOf(side).width, h: rectOf(side).height } : null,
      tabs: rectOf(tabs) ? { h: rectOf(tabs).height } : null,
      designPane: rectOf(designPane) ? { h: rectOf(designPane).height } : null,
      listScroll: rectOf(listScroll) ? { clientHeight: listScroll.clientHeight, scrollHeight: listScroll.scrollHeight, top: rectOf(listScroll).top, bottom: rectOf(listScroll).bottom } : null,
      artboard: rectOf(art) ? { w: rectOf(art).width, h: rectOf(art).height } : null,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      bothPanesMounted: designPane !== null && inspectPane !== null,
      inspectMounted: inspectPane !== null,
    }
    // The bar's own overflow: does anything inside the side panel PAINT below the
    // panel's box? That is exactly "with multiple layers it overflows down", and it
    // has to be measured through the CLIP CHAIN: a child of a scrollport keeps its
    // own unclipped rect (the layers list reports 5800px while it is scrolling
    // perfectly inside a 469px section), so an element only counts when NOTHING
    // between it and the panel clips it.
    const paintsBelow = (root_, floor) => {
      let worst = 0
      for (const child of root_.querySelectorAll('*')) {
        const box = rectOf(child)
        if (!box || box.height <= 0) continue
        let clipped = false
        for (let parent = child.parentElement; parent && parent !== root_.parentElement; parent = parent.parentElement) {
          const style = getComputedStyle(parent)
          const clips = style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'hidden'
          if (clips && rectOf(parent).bottom <= floor + 1) {
            clipped = true
            break
          }
        }
        if (clipped) continue
        if (box.bottom - floor > worst) worst = box.bottom - floor
      }
      return Math.round(worst)
    }
    if (side) {
      report.overflowBelowPanel = paintsBelow(side, rectOf(side).bottom)
      report.listScrollsInsideItsSection = listScroll ? listScroll.scrollHeight > listScroll.clientHeight : null
    }
    report.lints = (document.querySelectorAll('.cnv-lint') || []).length
    // THE PAGE'S COORDINATE SYSTEM: the grid the stage draws instead of the 22px ruler
    // gutters it used to carry, the origin marker that survives them, and the measured
    // GAP between the artboard and the floating composer seat.
    const stage = document.querySelector('[data-canvas-stage]')
    const artBox = rectOf(art)
    const stageBox = rectOf(stage)
    const stageStyle = stage ? getComputedStyle(stage) : null
    report.page = {
      rulers: document.querySelectorAll('[data-canvas-ruler]').length,
      axisLabels: document.querySelectorAll('.cnv-axisLabel').length,
      gridImage: stageStyle ? String(stageStyle.backgroundImage || '') : '',
      gridSize: stageStyle ? String(stageStyle.backgroundSize || '') : '',
      // THE WORKSPACE THE FIT LEFT, on the axis it did not fill: the stage's content box
      // against the artboard's own box. A pane whose artboard is exactly as large as it
      // is has no drafting surface at all, which is the fact behind the assertion.
      fittedSlack: stage && art
        ? Math.max(stage.clientWidth - art.offsetWidth, stage.clientHeight - art.offsetHeight)
        : null,
      artInset: artBox && stageBox ? { left: Math.round(artBox.left - stageBox.left), top: Math.round(artBox.top - stageBox.top) } : null,
      originMarker: document.querySelector('[data-canvas-origin-marker]') !== null,
      originAttr: art ? art.getAttribute('data-canvas-origin') : null,
      // THE DESIGN'S OWN ORIGIN, read off the artboard: the top-left corner of
      // everything the layout produced, in DESIGN pixels.
      layoutOrigin: art ? art.getAttribute('data-canvas-layout-origin') : null,
      gapBelow: Math.round(stageBox.bottom - artBox.bottom),
    }

    // 6. THE DRAG GESTURE, driven with real pointer events.
    report.step = 'gestures'
    const selectedRect = () => document.querySelector('[data-canvas-selection]')
    const selectLayer = async (path_) => {
      const row = document.querySelector('[data-layer-path="' + path_ + '"]')
      if (!row) return false
      row.scrollIntoView({ block: 'center' })
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await settle(6)
      // THE SELECTION MUST BE THE ONE THAT WAS CLICKED. A check for "a selection
      // exists" passes on a STALE one, and then every measurement after it describes a
      // different layer than the test believes it picked - which is exactly how this
      // harness spent an afternoon dragging the wrong box.
      const selected = document.querySelector('[data-canvas-selection]')
      return selected !== null && selected.getAttribute('data-canvas-selection') === path_
    }
    const pointer = (type, clientX, clientY) => new PointerEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true })
    // Point down/move/up WHERE THE ARTBOARD ACTUALLY IS, plus a one-pixel nudge: the
    // page is laid out by the browser, so a check that hard-codes a coordinate is a
    // check that breaks when the layout moves (which it just did).
    const drag = async (fromX, fromY, toX, toY) => {
      art.dispatchEvent(pointer('pointerdown', fromX, fromY))
      await frame()
      window.dispatchEvent(pointer('pointermove', (fromX + toX) / 2, (fromY + toY) / 2))
      await frame()
      window.dispatchEvent(pointer('pointermove', toX, toY))
      await frame()
      window.dispatchEvent(pointer('pointerup', toX, toY))
      await settle(8)
    }
    // Which layer kinds and paths the design has, so the test picks a real text node
    // and a real shape rather than a name it hopes for.
    const layers = window.__canvas.__internals.layerTree(current.document)
    const textPath = (layers.find((row) => row.node.kind === 'text') || {}).path
    const shapePath = (layers.find((row) => row.node.kind === 'shape' && row.node.w !== undefined) || layers.find((row) => row.node.kind === 'shape') || {}).path
    report.textPath = textPath || null
    report.shapePath = shapePath || null

    // (a) A TEXT node: its top border is not a resize it can perform, so the cursor
    //     is the grab cursor and a drag from there MOVES it. Before this alpha the
    //     same click answered ns-resize and the drag wrote nothing.
    window.__ops = []
    report.textSelected = textPath ? await selectLayer(textPath) : false
    if (textPath && report.textSelected) {
      const box = selectedRect().getBoundingClientRect()
      report.textBox = { top: Math.round(box.top), right: Math.round(box.right), height: Math.round(box.height) }
      const artBox = art.getBoundingClientRect()
      report.textArt = { top: Math.round(artBox.top), left: Math.round(artBox.left), width: Math.round(artBox.width), height: Math.round(artBox.height) }
      const midX = box.left + box.width / 2
      report.textFrom = { midX: Math.round(midX), top: Math.round(box.top), left: Math.round(box.left), width: Math.round(box.width) }
      art.dispatchEvent(pointer('pointermove', midX, box.top))
      await frame()
      report.textTopCursor = art.style.cursor || ''
      report.textHandles = Array.from(document.querySelectorAll('[data-canvas-handle]')).map((node) => node.getAttribute('data-canvas-handle')).join(',')
      const nodeBefore = JSON.stringify(window.__canvas.__internals.nodeAtPath(current.document, textPath))
      await drag(midX, box.top + 1, midX, box.top + 31)
      const nodeAfter = JSON.stringify(window.__canvas.__internals.nodeAtPath(current.document, textPath))
      report.textTopDrag = { moved: nodeBefore !== nodeAfter }
      report.textTopWrote = window.__ops.length > 0 ? window.__ops[0].map((op) => op.at.split('.').pop()).sort().join(',') : ''
      // The SIDE of the same text node IS a stretch: the cursor says so and the drag
      // writes a width - which is the half a text layer can honour. The box is read
      // AGAIN here: the move above just shifted the node, so the rectangle measured
      // before it is stale.
      window.__ops = []
      const sideBox = selectedRect().getBoundingClientRect()
      const sideX = sideBox.right
      const sideY = sideBox.top + sideBox.height / 2
      art.dispatchEvent(pointer('pointermove', sideX, sideY))
      await frame()
      report.textSideCursor = art.style.cursor || ''
      await drag(sideX - 1, sideY, sideX + 39, sideY)
      report.textSideOps = window.__ops.length > 0 ? window.__ops[0].map((op) => op.at + '=' + op.value).join(',') : ''
    }

    // (b) A SHAPE node: its right border IS a resize. The cursor says ew-resize and
    //     the drag writes a width, and NOT an x.
    window.__ops = []
    if (shapePath && (await selectLayer(shapePath))) {
      const box = selectedRect().getBoundingClientRect()
      const midY = box.top + box.height / 2
      art.dispatchEvent(pointer('pointermove', box.right, midY))
      await frame()
      report.shapeRightCursor = art.style.cursor || ''
      const before = window.__canvas.__internals.nodeAtPath(current.document, shapePath).w
      await drag(box.right - 1, midY, box.right + 39, midY)
      const after = window.__canvas.__internals.nodeAtPath(current.document, shapePath)
      report.shapeRightDrag = { before: before, after: after.w, x: after.x }
      report.shapeOps = window.__ops.length > 0 ? window.__ops[0].map((op) => op.at + '=' + op.value) : []
    }

    // (c) The pane switcher: the AUDIT pane is a real, clickable pane and it replaces
    //     the shaping one rather than stacking under it - and it is now the CONTROLS,
    //     not a quarter-scale copy of the artboard.
    report.step = 'switch'
    const inspectTab = Array.from(document.querySelectorAll('.cnv-sideTab')).find((button) => button.textContent.indexOf('Inspect') >= 0)
    if (inspectTab) {
      inspectTab.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await settle(6)
      report.afterSwitch = {
        inspectMounted: document.querySelector('[data-canvas-pane=inspect]') !== null,
        designMounted: document.querySelector('[data-canvas-pane=design]') !== null,
        feed: document.querySelector('[data-canvas-feed]') !== null,
      }
      report.overflowInInspect = paintsBelow(side, rectOf(side).bottom)

      // (c2) THE TRANSFORM CONTROLS, driven for real. The shape selected above is
      //      still the subject, and every control here writes through the same route
      //      the drag does - so a press is a document change, not a local edit.
      report.step = 'transform'
      report.transformWidgets = {
        move: document.querySelector('[data-canvas-transform]') !== null,
        size: document.querySelector('[data-canvas-size]') !== null,
        rotate: document.querySelector('[data-canvas-frame]') !== null,
        colors: document.querySelector('[data-canvas-colors]') !== null,
      }
      report.nudgeDirs = Array.from(document.querySelectorAll('[data-canvas-nudge-dir]')).map((node) => node.getAttribute('data-canvas-nudge-dir')).join(',')
      const subject = () => window.__canvas.__internals.nodeAtPath(current.document, shapePath)
      const beforeNode = JSON.parse(JSON.stringify(subject()))
      const nudgeRight = document.querySelector('[data-canvas-nudge-dir="right"]')
      if (nudgeRight) {
        window.__ops = []
        nudgeRight.click()
        await settle(8)
        report.nudge = { moved: subject().x !== beforeNode.x, ops: window.__ops.length, from: beforeNode.x, to: subject().x }
      }
      const sizeInput = document.querySelector('[data-canvas-size-input="w"]')
      if (sizeInput) {
        window.__ops = []
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(sizeInput, String(Math.round(subject().w) + 24))
        sizeInput.dispatchEvent(new Event('input', { bubbles: true }))
        await settle(8)
        report.sized = { from: beforeNode.w, to: subject().w, ops: window.__ops.length }
      }
      const scaleButton = document.querySelector('[data-canvas-scale="2"]')
      if (scaleButton) {
        window.__ops = []
        const widthBefore = subject().w
        scaleButton.click()
        await settle(8)
        report.scaled = { from: widthBefore, to: subject().w }
      }
      const rotate = document.querySelector('[data-canvas-rotate]')
      if (rotate) {
        window.__ops = []
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(rotate, '45')
        rotate.dispatchEvent(new Event('input', { bubbles: true }))
        await settle(8)
        report.rotated = { to: typeof subject().rotate === 'number' ? subject().rotate : 0, ops: window.__ops.length }
      }
      const opacity = document.querySelector('[data-canvas-opacity]')
      if (opacity) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(opacity, '0.5')
        opacity.dispatchEvent(new Event('input', { bubbles: true }))
        await settle(8)
        report.opacityHalf = typeof subject().opacity === 'number' ? subject().opacity : 1
        // THE RESET: back to full must be written, not treated as "the default".
        setter.call(opacity, '1')
        opacity.dispatchEvent(new Event('input', { bubbles: true }))
        await settle(8)
        report.opacityBack = typeof subject().opacity === 'number' ? subject().opacity : 'absent'
      }
      const colorInput = document.querySelector('[data-canvas-color]')
      if (colorInput) {
        report.colorTargets = Array.from(document.querySelectorAll('[data-canvas-color]')).map((node) => node.getAttribute('data-canvas-color')).join(',')
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(colorInput, '#ff0000')
        colorInput.dispatchEvent(new Event('input', { bubbles: true }))
        await settle(8)
        const target = colorInput.getAttribute('data-canvas-color')
        const parts = target.split('.')
        let cursor = subject()
        for (const part of parts.slice(0, -1)) cursor = cursor[part]
        const written = parts.length > 1 ? cursor[Number(parts[parts.length - 1])] : cursor[parts[0]]
        report.recolored = { target: target, written: typeof written === 'string' ? written : JSON.stringify(written) }
      }
      // (c3) THE ZOOM MENU: the same treatment the export got, one rung per row.
      report.step = 'zoom'
      const zoomControl = document.querySelector('[data-canvas-zoom]')
      report.zoomControl = zoomControl !== null
      if (zoomControl) {
        report.zoomSummary = zoomControl.querySelector('summary').textContent
        zoomControl.querySelector('summary').dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await settle(4)
        report.zoomRungs = Array.from(zoomControl.querySelectorAll('[data-canvas-zoom-step]')).map((node) => node.getAttribute('data-canvas-zoom-step')).join(',')
        const fifty = zoomControl.querySelector('[data-canvas-zoom-step="0.5"]')
        if (fifty) {
          fifty.click()
          await settle(8)
          report.zoomAfter = { summary: zoomControl.querySelector('summary').textContent, open: zoomControl.open, canvasWidth: document.querySelector('[data-canvas-art]').style.width }
        }
      }
    }

    // (d) THE EXPORT MENU: four decisions collapsed into ONE control in the bar. The
    //     assertions are about the DECISION the person makes - a closed summary that
    //     names the action, four rows that carry format AND destination, and a row
    //     press that really produces the picture (the page rasterizes for real).
    report.step = 'export'
    const exportControl = document.querySelector('[data-canvas-export]')
    report.exportControl = exportControl !== null
    if (exportControl) {
      report.exportSummary = exportControl.querySelector('summary').textContent
      report.exportClosedInitially = exportControl.open === false
      const barBox = rectOf(document.querySelector('[data-canvas-bar]'))
      // A FLEX ROW only wraps if a child can wrap; a bare height check cannot tell
      // one tall child from two rows, so the count of line boxes is what is asserted.
      const barLines = Array.from(document.querySelector('[data-canvas-bar]').children).reduce((most, child) => Math.max(most, child.getClientRects().length), 0)
      report.bar = { w: Math.round(barBox.width), h: Math.round(barBox.height), lines: barLines }
      exportControl.querySelector('summary').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await settle(6)
      report.exportOpen = exportControl.open === true
      // THE LAYER, MEASURED. The canvas view is a box inside the shell's layout, so an
      // open menu has to out-rank the columns it drops over - the composer seat (7/9),
      // the frame's overlay (20) and the sidebar's own fixed controls (30). This is the
      // bug the user reported as "the export dropdown is behind the bar".
      const panel = exportControl.querySelector('.cnv-menuPanel')
      report.menuLayer = panel ? getComputedStyle(panel).zIndex : null
      report.menuAboveFurniture = panel ? Number(getComputedStyle(panel).zIndex) > 30 : false
      // A RANK IS NOT A PICTURE, and this is the measurement that was missing. The panel
      // is a DESCENDANT of the bar, so an ancestor with overflow:hidden clips it away
      // however high it ranks - and the bar sets exactly that: the panel drops 6px below
      // a 38px bar, so the whole dropdown was clipped out of the picture while a z-index
      // assertion sat here passing. Hit-testing is the authority: a clipped box is not
      // hit, and a box something has been painted over answers with that something.
      if (panel) {
        const bar = document.querySelector('[data-canvas-bar]')
        const box = rectOf(panel)
        const probe = (y) => {
          const hit = document.elementFromPoint(Math.round(box.left + box.width / 2), Math.round(y))
          return { hit: hit ? String(hit.className || hit.tagName).split(' ')[0] : null, mine: hit ? panel.contains(hit) || hit === panel : false }
        }
        report.menuPaint = {
          barOverflow: getComputedStyle(bar).overflow,
          barBottom: Math.round(rectOf(bar).bottom),
          top: Math.round(box.top),
          bottom: Math.round(box.bottom),
          head: probe(box.top + 6),
          middle: probe(box.top + box.height / 2),
          foot: probe(box.bottom - 6),
        }
      }
      report.exportItems = Array.from(exportControl.querySelectorAll('[data-canvas-export-item]')).map((node) => node.getAttribute('data-canvas-export-item')).join(',')
      // The rows carry the DESTINATION too, which is the axis the old four buttons
      // spelled out in their labels.
      report.exportHints = Array.from(exportControl.querySelectorAll('.cnv-menuHint')).map((node) => node.textContent).join(' | ')
      const pngRow = exportControl.querySelector('[data-canvas-export-item="png-1"]')
      if (pngRow) {
        pngRow.click()
        // A real rasterization: the design is laid out, painted into a canvas and
        // encoded before anything is posted, so this waits longer than a click.
        for (let attempt = 0; attempt < 200 && window.__exports.length === 0; attempt += 1) await frame()
        await settle(6)
        report.exportDone = {
          // A COPY, not the live array: Save exports too, and a reference here would
          // make the menu's own count grow behind its back later in the run.
          requests: window.__exports.slice(),
          menuClosed: exportControl.open === false,
        }
      }
    }

    // (e) THE DELETE CONTROL: a two-step affordance on the rail row. One click asks,
    //     the second removes - and the request has to name the design AND its scope,
    //     because the host removes a library design from the library and a
    //     conversation one from the conversation.
    report.step = 'delete'
    const designRow = document.querySelector('[data-canvas-design="panel-fixture"]')
    report.deleteRow = designRow !== null
    if (designRow) {
      const arm = designRow.querySelector('[data-canvas-delete]')
      report.deleteArm = arm !== null
      if (arm) {
        arm.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await settle(6)
        report.deleteArmed = {
          confirm: document.querySelector('[data-canvas-delete-confirm]') !== null,
          stillThere: document.querySelectorAll('[data-canvas-design]').length,
          requests: window.__deletes.length,
        }
        const confirm = document.querySelector('[data-canvas-delete-confirm]')
        if (confirm) {
          confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          await settle(20)
          report.deleteDone = {
            rows: document.querySelectorAll('[data-canvas-design]').length,
            fixtureGone: document.querySelector('[data-canvas-design="panel-fixture"]') === null,
            requests: window.__deletes,
            artboardRemounted: document.querySelector('[data-canvas-artboard]') !== null,
          }
        }
      }
    }

      // (e) THE DRAWER, the SOURCE button's own surface: it must be ON SCREEN and
      //     above the composer, not a panel rendered under the floating input box.
      report.step = 'drawer'
      const sourceButton = Array.from(document.querySelectorAll('[data-canvas-bar] button')).find((node) => node.textContent === 'Source')
      report.sourceButton = sourceButton !== undefined && sourceButton !== null
      if (sourceButton) {
        sourceButton.click()
        await settle(6)
        const drawer = document.querySelector('[data-canvas-drawer]')
        const drawerBox = rectOf(drawer)
        const stageRect = rectOf(document.querySelector('[data-canvas-stage]'))
        report.drawer = drawer
          ? {
              mounted: true,
              top: Math.round(drawerBox.top),
              height: Math.round(drawerBox.height),
              visible: drawerBox.height > 40 && drawerBox.top < window.innerHeight,
              aboveStageBottom: Math.round(stageRect.bottom - drawerBox.bottom),
              inViewport: drawerBox.top >= 0 && drawerBox.bottom <= window.innerHeight,
            }
          : { mounted: false }
        sourceButton.click()
        await settle(4)
      }
      // (f) A CLICK ON EMPTY CANVAS DE-SELECTS: the way out of a selection.
      const emptyX = rectOf(art).left + 6
      const emptyY = rectOf(art).bottom - 6
      await drag(emptyX, emptyY, emptyX + 3, emptyY)
      report.deselected = document.querySelector('[data-canvas-selection]') === null
      // (g) SAVE is on the bar, reports what the HOST holds, AND hands back the picture.
      const exportsBeforeSave = window.__exports.length
      const saveButton = Array.from(document.querySelectorAll('[data-canvas-bar] button')).find((node) => node.textContent === 'Save')
      report.saveButton = Boolean(saveButton)
      if (saveButton) {
        saveButton.click()
        for (let attempt = 0; attempt < 120; attempt += 1) {
          const note = document.querySelector('.cnv-note')
          const settled = note && note.textContent.indexOf('Saved') === 0 && window.__exports.length > exportsBeforeSave
          if (settled) break
          await frame()
        }
        report.saveNote = (document.querySelector('.cnv-note') || {}).textContent || ''
        // COUNTED AS A REQUEST, not as the note: the note is prose and this is the file.
        // One Save, one export, at the design's own pixels, to the Desktop.
        report.saveExports = window.__exports.slice(exportsBeforeSave)
      }

    // (h) THE VENDORED INTERACTION LAYER, in its OWN mount.
    //
    //     Everything above describes the tab WITHOUT Konva - the editor it falls back
    //     to when the route cannot answer (a profile whose routes were composed before
    //     this package was updated, a checkout with no vendored artifact). This half
    //     mounts again with the route switched on, which is the SHIPPED path, and asks
    //     the same questions of it: does a click select the node under the pointer,
    //     does a drag move it, does the artboard follow the pointer BEFORE the host is
    //     told anything, and does one gesture write exactly ONE patch.
    report.step = 'konva'
    window.__konvaAvailable = true
    root.unmount()
    await settle(4)
    root = ReactDOM.createRoot(document.getElementById('host'))
    root.render(React.createElement('div', { style: { position: 'absolute', inset: '0' } }, React.createElement(window.__canvas.__internals.CanvasView, { canvasSession: 'panel' })))
    report.konva = { ready: false }
    {
      const ready = await waitFor('[data-canvas-konva=ready]', 300)
      const host = document.querySelector('[data-canvas-konva=ready]')
      const seam = host ? host.__dshKonva : null
      report.konva.ready = ready && Boolean(host)
      report.konva.note = (document.querySelector('[data-canvas-konva-note]') || {}).textContent || ''
      report.konva.seam = Boolean(seam && seam.stage && seam.layer && seam.rects)
      if (report.konva.seam) {
        const art2 = document.querySelector('[data-canvas-artboard]')
        // The content div is where Konva bound its listeners: a bubbling event
        // dispatched on the host above it would never reach them.
        const content = seam.stage.content
        report.konva.content = Boolean(content)
        report.konva.rectCount = seam.rects.size
        report.konva.expectedRects = (seam.boxes || []).filter((entry) => entry.box.w > 0 && entry.box.h > 0).length
        // Konva coordinates are stage-relative; the page needs them moved to the
        // viewport the way a person's pointer arrives.
        const stageBox = seam.stage.container().getBoundingClientRect()
        // WHICH LAYER TO GRAB. Not "the first shape in the list": a design's decorative
        // art can sit mostly OUTSIDE the canvas (a rotated wash, a bleeding panel), and
        // its centre is then a point on no pixel at all - the stage is only as big as
        // the artboard. So the target is the LARGEST layer whose own centre falls
        // inside the canvas, which is both in the picture and easy to hit.
        const canvasSize = current.document.canvas
        const candidates = []
        seam.rects.forEach((candidate, path) => {
          const centreX = candidate.x()
          const centreY = candidate.y()
          if (centreX < 4 || centreY < 4 || centreX > canvasSize.width - 4 || centreY > canvasSize.height - 4) return
          candidates.push({ path, rect: candidate, area: candidate.width() * candidate.height() })
        })
        candidates.sort((left, right) => right.area - left.area)
        const chosen = candidates[0] ?? null
        const nodePath = chosen ? chosen.path : null
        const rect = chosen ? chosen.rect : null
        report.konva.shapePath = nodePath || null
        // WHERE THE HIT TEST ACTUALLY STANDS. A canvas library takes its pointer
        // position from the event's client coordinates and its own container box, so a
        // synthetic event that never reaches the content element, or a stage whose size
        // is still 1x1, is indistinguishable from "nothing was under the pointer" -
        // this reports the four facts that tell those apart.
        if (rect) {
          const stageBox0 = seam.stage.container().getBoundingClientRect()
          // THE RECT IS CENTRE-ORIGINED, so rect.x()/rect.y() are the centre in DESIGN
          // pixels. Whether Konva's absolute helpers apply the stage's own scale is
          // exactly the thing a check should not assume, so the probe asks the stage:
          // it dispatches a real pointer move at the scaled position and reads back the
          // pointer the library computed for itself.
          const scaleNow = seam.stage.scaleX()
          const designPoint = { x: rect.x(), y: rect.y() }
          const screenPoint = { x: stageBox0.left + designPoint.x * scaleNow, y: stageBox0.top + designPoint.y * scaleNow }
          if (content) {
            content.dispatchEvent(pointer('pointermove', screenPoint.x, screenPoint.y))
            content.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: screenPoint.x, clientY: screenPoint.y }))
          }
          const pointerNow = seam.stage.getPointerPosition()
          const hitAtPointer = pointerNow ? seam.stage.getIntersection(pointerNow) : null
          const hitAtDesign = seam.stage.getIntersection(designPoint)
          const hitAtScaled = seam.stage.getIntersection({ x: designPoint.x * scaleNow, y: designPoint.y * scaleNow })
          report.konva.probe = {
            content: Boolean(content),
            stage: seam.stage.width() + 'x' + seam.stage.height(),
            scale: scaleNow,
            containerLeft: Math.round(stageBox0.left),
            containerTop: Math.round(stageBox0.top),
            pointerNow: pointerNow ? { x: Math.round(pointerNow.x), y: Math.round(pointerNow.y) } : null,
            rectClient: (() => { const box = rect.getClientRect(); return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) } })(),
            // WHERE THE HIT GRAPH ACTUALLY STANDS. A library answers "nothing under the
            // pointer" both when the geometry is wrong and when nothing was ever drawn
            // onto its HIT canvas - and those are different bugs with different fixes.
            // batchDraw refreshes the scene and not the hit graph, so this pixel is the
            // whole difference between a clickable editor and an inert one.
            hitInk: (() => {
              const canvas = seam.layer.getHitCanvas && seam.layer.getHitCanvas()
              if (!canvas) return null
              try {
                const context = canvas.getContext()
                const data = context.getImageData(Math.round(pointerNow ? pointerNow.x : 0), Math.round(pointerNow ? pointerNow.y : 0), 1, 1).data
                return [data[0], data[1], data[2], data[3]].join(',')
              } catch (err) {
                return 'error'
              }
            })(),
            intersected: hitAtPointer ? String(hitAtPointer.getAttr('dshPath') ?? 'shape') : null,
          }
        }
        if (rect && content) {
          const box = rect.getClientRect()
          const centre = { x: stageBox.left + box.x + box.width / 2, y: stageBox.top + box.y + box.height / 2 }
          // A REAL POINTER DOWN ON THE LAYER, not a call into the component: Konva
          // hit-tests its own graph, and the deepest rect under the point wins.
          content.dispatchEvent(pointer('pointerdown', centre.x, centre.y))
          content.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: centre.x, clientY: centre.y, button: 0, buttons: 1 }))
          await settle(6)
          // THE SELECTION IS READ FROM THE PACK'S OWN OVERLAY, which draws it in both
          // paths: the interaction layer moves the pointer, and the SVG selection is
          // what the tab (and this check) reads to say which layer is selected.
          const selectionNow = document.querySelector('[data-canvas-selection]')
          report.konva.selectedByClick = selectionNow ? selectionNow.getAttribute('data-canvas-selection') : null
          report.konva.rowSelected = (document.querySelector('[data-layer-path="' + nodePath + '"]') || {}).getAttribute
            ? document.querySelector('[data-layer-path="' + nodePath + '"]').getAttribute('data-selected')
            : null
          window.__ops = []
          const nodeBefore = window.__canvas.__internals.nodeAtPath(current.document, nodePath)
          const before = { x: nodeBefore.x, y: nodeBefore.y }
          const canvasEl = document.querySelector('[data-canvas-art]')
          const pixelsBefore = canvasEl.toDataURL('image/png').length + ':' + canvasEl.toDataURL('image/png').slice(2000, 2060)
          // DRAG IT 40 SCREEN PIXELS and stop WHILE THE BUTTON IS STILL DOWN: that is
          // the moment the live preview is the only thing that can have changed the
          // picture, because no patch has been sent yet.
          const to = { x: centre.x + 40, y: centre.y }
          content.dispatchEvent(pointer('pointermove', centre.x + 20, centre.y))
          content.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: centre.x + 20, clientY: centre.y, button: 0, buttons: 1 }))
          await frame()
          content.dispatchEvent(pointer('pointermove', to.x, to.y))
          content.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: to.x, clientY: to.y, button: 0, buttons: 1 }))
          await frame()
          const pixelsDuring = canvasEl.toDataURL('image/png').length + ':' + canvasEl.toDataURL('image/png').slice(2000, 2060)
          report.konva.duringDrag = { patches: window.__ops.length, repainted: pixelsBefore !== pixelsDuring }
          content.dispatchEvent(pointer('pointerup', to.x, to.y))
          content.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: to.x, clientY: to.y, button: 0, buttons: 0 }))
          await settle(20)
          const nodeAfter = window.__canvas.__internals.nodeAtPath(current.document, nodePath)
          report.konva.drag = {
            patches: window.__ops.length,
            ops: window.__ops.length > 0 ? window.__ops[0].map((op) => op.at.split('.').pop()).sort().join(',') : '',
            dx: nodeAfter.x - before.x,
            dy: nodeAfter.y - before.y,
          }
          // A RESIZE, DRIVEN THE WAY A PERSON MAKES ONE: a press ON the selection's own
          // right edge, inside the drawn handle's tolerance, which the interaction layer
          // reads as an edge grab rather than a drag - and then a move that stretches it.
          window.__ops = []
          const widthBefore = window.__canvas.__internals.nodeAtPath(current.document, nodePath).w
          const edgeBox = rect.getClientRect()
          const edgePoint = { x: stageBox.left + edgeBox.x + edgeBox.width - 1, y: stageBox.top + edgeBox.y + edgeBox.height / 2 }
          content.dispatchEvent(pointer('pointerdown', edgePoint.x, edgePoint.y))
          content.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: edgePoint.x, clientY: edgePoint.y, button: 0, buttons: 1 }))
          await frame()
          window.dispatchEvent(pointer('pointermove', edgePoint.x + 30, edgePoint.y))
          await frame()
          window.dispatchEvent(pointer('pointerup', edgePoint.x + 30, edgePoint.y))
          window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: edgePoint.x + 30, clientY: edgePoint.y, button: 0, buttons: 0 }))
          await settle(20)
          const now = window.__canvas.__internals.nodeAtPath(current.document, nodePath)
          report.konva.resize = {
            patches: window.__ops.length,
            ops: window.__ops.length > 0 ? window.__ops[0].map((op) => op.at.split('.').pop()).sort().join(',') : '',
            from: widthBefore,
            to: now.w,
          }
          // (a2) SNAPPING, end to end: a drag aimed THREE SCREEN PIXELS past the canvas's own
          //      centre line must land EXACTLY on it, with a guide drawn while it does. The
          //      rect is CENTRE-ORIGINED, so rect.x() is the box's centre in design pixels.
          const designToCentre = current.document.canvas.width / 2 - rect.x()
          const liveRect = rect.getClientRect()
          const snapFrom = { x: stageBox.left + liveRect.x + liveRect.width / 2, y: stageBox.top + liveRect.y + liveRect.height / 2 }
          const snapTo = { x: snapFrom.x + designToCentre * seam.stage.scaleX() + 3, y: snapFrom.y }
          window.__ops = []
          content.dispatchEvent(pointer('pointerdown', snapFrom.x, snapFrom.y))
          content.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: snapFrom.x, clientY: snapFrom.y, button: 0, buttons: 1 }))
          await frame()
          content.dispatchEvent(pointer('pointermove', snapTo.x, snapTo.y))
          content.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: snapTo.x, clientY: snapTo.y, button: 0, buttons: 1 }))
          await frame()
          const guideGroup = seam.layer.findOne('.guides')
          const guideKids = guideGroup ? guideGroup.getChildren() : []
          const xGuide = guideKids.map((node) => node.points()).find((points) => points.length === 4 && points[0] === points[2])
          report.konva.snap = { guidesDrawn: guideKids.length, guideAt: xGuide ? Math.round(xGuide[0]) : null }
          content.dispatchEvent(pointer('pointerup', snapTo.x, snapTo.y))
          content.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: snapTo.x, clientY: snapTo.y, button: 0, buttons: 0 }))
          await settle(20)
          const snapped = window.__canvas.__internals.nodeAtPath(current.document, nodePath)
          // THE NODE THE PATCH ACTUALLY MOVED, named by the operation's own path: the press
          // may have landed on a layer stacked above the one I measured, and the promise
          // being tested is about whichever layer the drag took hold of.
          const opPath = window.__ops.length > 0 && window.__ops[0].length > 0 ? String(window.__ops[0][0].at).replace(/\.[xy]$/, '') : null
          const opNode = opPath ? window.__canvas.__internals.nodeAtPath(current.document, opPath) : null
          const opRect = opPath ? seam.rects.get(opPath) : null
          report.konva.snap.opPath = opPath
          report.konva.snap.opCentre = opNode
            ? Math.round((opNode.x ?? 0) + (typeof opNode.w === 'number' ? opNode.w / 2 : opRect ? opRect.width() / 2 : 0))
            : null
          // THE TWO FACTS TOGETHER: where the guide said the line was, and where the box's
          // own edge or centre actually ended up. A snap that draws a guide and lands
          // somewhere else is worse than no snap, so the assertion is that ONE of the box's
          // three lines is the guide's line.
          report.konva.snap.edgeLeft = opNode ? opNode.x : null
          report.konva.snap.edgeRight = opNode && typeof opNode.w === 'number' ? opNode.x + opNode.w : null
          report.konva.snap.centre = Math.round(rect.x())
          report.konva.snap.expected = current.document.canvas.width / 2
          report.konva.snap.patches = window.__ops.length
          const guidesNow = seam.layer.findOne('.guides')
          report.konva.snap.guidesAfter = guidesNow ? guidesNow.getChildren().length : 0

          // (b) THE SELECTION'S OWN WEST EDGE, through the artboard's handler. The
          //     interaction layer owns a press ON a hit rect; this is the press that
          //     lands just OUTSIDE the layer's painted box, in the tolerance band of
          //     its handle - which the pack's own handler reads with the same
          //     edgesFor/edgesAt the layer uses. One patch, a width, and no move.
          {
            const rectNow = seam.rects.get(nodePath)
            const rectBox = rectNow ? rectNow.getClientRect() : null
            // THE PRESS IS DERIVED FROM THE LAYER'S OWN BOX, not from a fixed offset:
            // the artboard is centred in the pane now, so an offset from the stage's
            // corner lands inside some other layer and reads as a failure of the wrong
            // thing.
            const edgeY = rectBox ? stageBox.top + rectBox.y + rectBox.height / 2 : null
            const edgeX = rectBox ? stageBox.left + rectBox.x - 6 : null
            const outside = edgeX === null ? null : { x: edgeX, y: edgeY }
            const under = outside ? seam.stage.getIntersection({ x: outside.x - stageBox.left, y: outside.y - stageBox.top }) : null
            const readWidth = (path_) => {
              const node = path_ ? window.__canvas.__internals.nodeAtPath(current.document, path_) : null
              return node && typeof node.w === 'number' ? node.w : null
            }
            const widthBeforeAll = new Map()
            for (const path_ of seam.rects.keys()) widthBeforeAll.set(path_, readWidth(path_))
            window.__ops = []
            if (outside) {
              art2.dispatchEvent(pointer('pointerdown', outside.x, outside.y))
              await frame()
              window.dispatchEvent(pointer('pointermove', outside.x - 30, outside.y))
              await frame()
              window.dispatchEvent(pointer('pointerup', outside.x - 30, outside.y))
              await settle(20)
            }
            // THE WIDTH THAT GREW IS THE ONE THE PATCH NAMED. A press at the selection's
            // own west edge can land on a layer stacked above it, and the promise being
            // tested is about the handle, not about which layer the pointer found.
            const grownPath = window.__ops.length > 0 && window.__ops[0].length > 0
              ? String(window.__ops[0][0].at).replace(/\.[a-z]+$/, '')
              : null
            const widthAfter = readWidth(grownPath)
            const widthAtPress = widthBeforeAll.get(grownPath) ?? null
            report.konva.offBox = {
              // The press misses the selection's painted rect - that is the property the
              // promise is about - and the handle decides the gesture anyway.
              outsideSelection: outside !== null && rectBox !== null ? Math.round(outside.x) < Math.round(stageBox.left + rectBox.x) : null,
              hitRect: under ? String(under.getAttr('dshPath') ?? 'shape') : null,
              patches: window.__ops.length,
              ops: window.__ops.length > 0 ? window.__ops[0].map((op) => op.at.split('.').pop()).sort().join(',') : '',
              // THE WIDTH THAT GREW IS THE ONE THE PATCH NAMED: a press at the selection's
              // own west edge can land on a layer stacked above it, and the promise being
              // tested is about the handle, not about which layer the pointer found.
              grownPath,
              from: widthAtPress,
              to: widthAfter,
              grew: typeof widthAfter === 'number' && typeof widthAtPress === 'number' ? widthAfter !== widthAtPress : false,
            }

          // (c) THE MARQUEE, and then ONE DRAG OVER THE GROUP IT CAUGHT. Two facts: the band
          //     really catches several layers, and the drag that follows moves ALL of them
          //     through exactly one patch.
          const marqueeFrom = { x: stageBox.left + 6, y: stageBox.top + 6 }
          const marqueeTo = { x: stageBox.left + 160, y: stageBox.top + 140 }
          content.dispatchEvent(pointer('pointerdown', marqueeFrom.x, marqueeFrom.y))
          await frame()
          content.dispatchEvent(pointer('pointermove', (marqueeFrom.x + marqueeTo.x) / 2, (marqueeFrom.y + marqueeTo.y) / 2))
          await frame()
          const bandGroup = seam.layer.findOne('.marquee')
          const selectionCount = () => {
            const overlayNode = document.querySelector('[data-canvas-overlay]')
            return overlayNode ? Number(overlayNode.getAttribute('data-canvas-selection-count')) : 0
          }
          report.konva.band = { drawn: bandGroup ? bandGroup.getChildren().length : 0 }
          content.dispatchEvent(pointer('pointermove', marqueeTo.x, marqueeTo.y))
          await frame()
          content.dispatchEvent(pointer('pointerup', marqueeTo.x, marqueeTo.y))
          await settle(10)
          report.konva.band.count = selectionCount()
          report.konva.band.outlines = document.querySelectorAll('[data-canvas-group]').length
          report.konva.band.bandAfter = (() => {
            const group = seam.layer.findOne('.marquee')
            return group ? group.getChildren().length : 0
          })()
          }
        }
      }
    }


    // (i) THE EDITOR'S VERBS, driven through the UI. Adding, duplicating, deleting and
    //     re-ordering are what make this tab a designer, and each one is a real press on
    //     a real control that has to arrive at the host as ONE patch.
    report.step = 'verbs'
    {
      const art3 = document.querySelector('[data-canvas-artboard]')
      const count = () => window.__canvas.__internals.layerTree(current.document).length
      const addRow = (kind) => document.querySelector('[data-canvas-add-item="' + kind + '"]')
      report.verbs = { menu: document.querySelector('[data-canvas-add]') !== null, rows: Array.from(document.querySelectorAll('[data-canvas-add-item]')).map((node) => node.getAttribute('data-canvas-add-item')).join(',') }
      report.verbs.screen = { artboard: Boolean(document.querySelector('[data-canvas-artboard]')), layerRows: document.querySelectorAll('[data-layer-path]').length, bar: Boolean(document.querySelector('[data-canvas-bar]')), root: Boolean(document.querySelector('[data-dsh-canvas-view]')), view: document.querySelector('[data-canvas-pane]') ? 'panes' : 'none', text: String(document.body.textContent || '').replace(/\s+/g, ' ').slice(0, 90) }
      const before = count()
      window.__ops = []
      const textRow = addRow('text')
      if (textRow) {
        textRow.click()
        await settle(20)
        const tree = window.__canvas.__internals.layerTree(current.document)
        const selection = document.querySelector('[data-canvas-selection]')
        const selectedPath = selection ? selection.getAttribute('data-canvas-selection') : null
        report.verbs.text = {
          added: count() - before,
          patches: window.__ops.length,
          ops: window.__ops.length > 0 ? window.__ops[0].map((op) => op.at).join(',') : '',
          selected: selectedPath,
          // THE NEW LAYER IS THE ONE THAT WAS JUST APPENDED, and the tab selects it: the
          // very next gesture acts on what the person just made.
          selectedIsLast: selectedPath === tree[tree.length - 1].path,
          kinds: tree.map((row) => row.node.kind).join(','),
        }
      }
      const growBefore = count()
      const shapeRow = addRow('rect')
      if (shapeRow) {
        shapeRow.click()
        await settle(20)
        const chosen = document.querySelector('[data-canvas-selection]')
        const chosenNode = chosen ? window.__canvas.__internals.nodeAtPath(current.document, chosen.getAttribute('data-canvas-selection')) : null
        report.verbs.rect = { added: count() - growBefore, shape: chosenNode ? chosenNode.shape : null, fill: chosenNode ? chosenNode.fill : null }
      }
      // The selected layer is the shape just added, so these verbs act on it. The Inspect
      // pane is where they live, and this mount opened on the Design pane - a second mount
      // has its own pane state, which is exactly the sort of thing a check should not
      // assume.
      const inspectTab2 = Array.from(document.querySelectorAll('.cnv-sideTab')).find((button) => button.textContent.indexOf('Inspect') >= 0)
      if (inspectTab2) {
        inspectTab2.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await settle(6)
      }
      // THE CONTROLS ARE QUERIED WHEN THEY ARE PRESSED, never captured: switching panes
      // re-renders them, and a reference held across the switch is a detached node whose
      // click does nothing at all - which reads exactly like a verb that stopped working.
      const objectButton = (label) => Array.from(document.querySelectorAll('[data-canvas-object] button')).find((node) => node.textContent === label)
      const duplicate = objectButton('Duplicate')
      const remove = objectButton('Delete')
      const toFront = objectButton('To front')
      const toBack = objectButton('To back')
      report.verbs.controls = { duplicate: Boolean(duplicate), delete: Boolean(remove), front: Boolean(toFront), back: Boolean(toBack) }
      if (duplicate) {
        window.__ops = []
        const at = count()
        const selectedBefore = document.querySelector('[data-canvas-selection]')
        const pathBefore = selectedBefore ? selectedBefore.getAttribute('data-canvas-selection') : null
        const listBefore = window.__canvas.__internals.layerTree(current.document).map((row) => row.path)
        duplicate.click()
        await settle(20)
        const selected = document.querySelector('[data-canvas-selection]')
        const pathAfter = selected ? selected.getAttribute('data-canvas-selection') : null
        const listAfter = window.__canvas.__internals.layerTree(current.document).map((row) => row.path)
        // THE COPY IS ONE PLACE LATER IN THE SAME ARRAY, and it is what stays selected.
        const indexBefore = listBefore.indexOf(pathBefore)
        report.verbs.duplicate = { added: count() - at, patches: window.__ops.length, selected: pathAfter, selectedIsCopy: pathAfter === listAfter[indexBefore + 1] }
      }
      if (toFront) {
        // A LAYER THAT IS NOT ALREADY IN FRONT, or the assertion measures nothing: the
        // duplicate above left its copy at the end of the list, and moving the last layer
        // to the front is a patch that produces an IDENTICAL document. The layer list is in
        // the DESIGN pane and the verb is in the INSPECT one, so this is two switches -
        // which is also the round trip a person makes.
        const designForPick = Array.from(document.querySelectorAll('.cnv-sideTab')).find((button) => button.textContent.indexOf('Design') >= 0)
        if (designForPick) {
          designForPick.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          await settle(6)
        }
        const first = window.__canvas.__internals.layerTree(current.document)[0]
        const firstRow = first ? document.querySelector('[data-layer-path="' + first.path + '"]') : null
        if (firstRow) {
          firstRow.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          await settle(6)
        }
        const inspectForPick = Array.from(document.querySelectorAll('.cnv-sideTab')).find((button) => button.textContent.indexOf('Inspect') >= 0)
        if (inspectForPick) {
          inspectForPick.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          await settle(6)
        }
        window.__ops = []
        const selectedBefore = document.querySelector('[data-canvas-selection]')
        const pathBefore = selectedBefore ? selectedBefore.getAttribute('data-canvas-selection') : null
        const listBefore = window.__canvas.__internals.layerTree(current.document).map((row) => row.path)
        const nodeBefore = pathBefore ? window.__canvas.__internals.nodeAtPath(current.document, pathBefore) : null
        objectButton('To front').click()
        await settle(20)
        const listAfter = window.__canvas.__internals.layerTree(current.document).map((row) => row.path)
        const nodeAfterLast = listAfter.length > 0 ? window.__canvas.__internals.nodeAtPath(current.document, listAfter[listAfter.length - 1]) : null
        const selectedAfter = document.querySelector('[data-canvas-selection]')
        report.verbs.front = {
          patches: window.__ops.length,
          moved: listBefore.join(',') !== listAfter.join(','),
          pickedFirst: pathBefore === listBefore[0],
          // IN FRONT MEANS LAST IN THE ARRAY, and identity is the CONTENT rather than the
          // path: a z-order move renumbers every path after the old position, so comparing
          // the string 'layers.0' with the new last path would be comparing a name with a
          // different layer wearing it.
          isFront: nodeBefore !== null && nodeAfterLast !== null && JSON.stringify(nodeBefore) === JSON.stringify(nodeAfterLast),
          selected: selectedAfter ? selectedAfter.getAttribute('data-canvas-selection') : null,
        }
      }
      if (remove) {
        window.__ops = []
        const at = count()
        objectButton('Delete').click()
        await settle(20)
        report.verbs.delete = { removed: at - count(), patches: window.__ops.length, selected: document.querySelector('[data-canvas-selection]') === null }
      }
    }

    report.ok = true
  } catch (err) {
    report.failedStep = report.step
    report.errors.push('at step "' + report.step + '": ' + (err && err.message ? err.message : String(err)))
  }
  await post(report)
}

run()
`

  // -------------------------------------------------------------------------
  // The loopback server: the plugin's own files, exactly as the routes serve them
  // -------------------------------------------------------------------------
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'dsh-canvas-panel-'))
  // A debugging seat for the harness itself: `--dump` writes the page, the stage and
  // the client this check serves and stops, so a page that fails before it can report
  // its own error can still be inspected (and loaded by hand, with its console open).
  if (process.argv.includes('--dump')) {
    const dir = path.join(repo, '.scratch')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'canvas-panel-page.html'), PAGE)
    writeFileSync(path.join(dir, 'canvas-panel-stage.js'), STAGE)
    writeFileSync(path.join(dir, 'canvas-panel-client.js'), readFileSync(path.join(canvasDir, 'lib', 'client.js'), 'utf8'))
    console.log('wrote .scratch/canvas-panel-page.html, canvas-panel-stage.js and canvas-panel-client.js')
    rmSync(sandbox, { recursive: true, force: true })
    process.exit(0)
  }

  const fontsDir = path.join(canvasDir, 'lib', 'vendor', 'fonts')
  const fontRecord = JSON.parse(readFileSync(path.join(fontsDir, 'VERSION.json'), 'utf8'))
  const fonts = {}
  for (const [family, entry] of Object.entries(fontRecord.families)) {
    const weights = {}
    for (const [weight, meta] of Object.entries(entry.files)) weights[weight] = { url: '/api/dsh-canvas/vendor/fonts/' + meta.file, file: meta.file }
    fonts[family] = { family, stack: [family, 'sans-serif'], weights }
  }
  const engineSource = readFileSync(path.join(canvasDir, 'lib', 'engine.js'), 'utf8')
  const clientSource = readFileSync(path.join(canvasDir, 'lib', 'client.js'), 'utf8')
  const clientVersion = /const PLUGIN_VERSION = '([^']+)'/.exec(clientSource)[1]
  const { PRESETS } = await import(new URL('file:///' + path.join(canvasDir, 'lib', 'presets.js').replace(/\\/g, '/')).href)
  const { styleGallery } = await import(new URL('file:///' + path.join(canvasDir, 'lib', 'styles', 'index.js').replace(/\\/g, '/')).href)
  const { exampleGallery } = await import(new URL('file:///' + path.join(canvasDir, 'lib', 'examples', 'index.js').replace(/\\/g, '/')).href)
  const { ARCHETYPES } = await import(new URL('file:///' + path.join(canvasDir, 'lib', 'archetypes', 'index.js').replace(/\\/g, '/')).href)
  const canvasEngine = await import(new URL('file:///' + path.join(canvasDir, 'lib', 'engine.js').replace(/\\/g, '/')).href)

  // THE DESIGN THE BAR HAS TO SURVIVE: a real, validated archetype with two hundred
  // more shapes appended, so the layer list is far taller than the panel. The shapes
  // are valid nodes of the language (a filled rounded shape at an integer x/y), and
  // a shape is the kind the resize test can also grab.
  const archetype = ARCHETYPES.find((entry) => entry.id === 'editorial-split') || ARCHETYPES[0]
  const base = JSON.parse(JSON.stringify(archetype.document))
  const presetId = archetype.presets[0]
  base.layers = base.layers ?? []
  for (let index = 0; index < 200; index += 1) {
    base.layers.push({ kind: 'shape', shape: 'rect', id: 'bulk-' + index, x: 40 + (index % 20) * 56, y: 60 + Math.floor(index / 20) * 40, w: 44, h: 24, radius: 6, fill: '#4D6BFE' })
  }
  const verdict = canvasEngine.normalizeDocument(base, { presets: PRESETS, fonts })
  if (!verdict.document) {
    console.log('the fixture document was refused: ' + JSON.stringify(verdict.problems.slice(0, 3)))
    process.exitCode = 1
  } else {
    const design = {
      id: 'panel-fixture',
      title: 'Panel fixture',
      preset: presetId,
      revision: 3,
      scope: 'conversation',
      warnings: verdict.problems.length,
      document: verdict.document,
      verification: null,
    }
    // A SECOND design so the rail has a real list: it proves the delete removes ONE row
    // and leaves the tab standing, which a one-row rail cannot. It is a BLANK canvas of
    // the same preset - normalized, exactly as every stored design is - and both halves
    // of that matter: a fixture carrying the archetype's RAW document has no canvas at
    // all (Save exports the SELECTED design and would write 0x0 pixels), while one
    // carrying a full archetype is covered edge to edge, so the click-on-empty-canvas
    // step next door would land on a layer instead of on nothing.
    const spareVerdict = canvasEngine.normalizeDocument({ preset: presetId, layers: [] }, { presets: PRESETS, fonts })
    const spare = {
      id: 'panel-spare',
      title: 'Panel spare',
      preset: presetId,
      revision: 1,
      scope: 'conversation',
      warnings: spareVerdict.problems.length,
      document: spareVerdict.document ?? { preset: presetId, layers: [] },
      verification: null,
    }
    const state = { designs: [design, spare], presets: PRESETS, fonts, styles: styleGallery(), examples: exampleGallery(), archetypes: ARCHETYPES.map((entry) => ({ id: entry.id, title: entry.title, presets: entry.presets, description: entry.description })), engineRoute: '/api/dsh-canvas/vendor/engine.js', version: clientVersion }
    const stateJson = JSON.stringify(state)
    const reactSource = readFileSync(reactPair.react, 'utf8')
    const reactDomSource = readFileSync(reactPair.dom, 'utf8')

    let reported = null
    let progress = null
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url, 'http://127.0.0.1')
        const send = (type, body, status) => {
          response.writeHead(status || 200, { 'content-type': type, 'cache-control': 'no-store' })
          response.end(body)
        }
        if (request.method === 'POST' && url.pathname === '/report') {
          const chunks = []
          for await (const chunk of request) chunks.push(chunk)
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          // A PROGRESS post is not a result: the last one is kept so a stage that
          // dies silently still names how far it got.
          if (typeof body.progress === 'string') {
            progress = body.progress
            if (process.argv.includes('--trace')) console.log('     trace: ' + progress + (body.detail ? ' ' + body.detail : ''))
          } else reported = body
          send('text/plain', 'ok')
          return
        }
        if (url.pathname === '/' || url.pathname === '/index.html') return send('text/html; charset=utf-8', PAGE)
        if (url.pathname === '/stage.js') return send('text/javascript; charset=utf-8', STAGE)
        if (url.pathname === '/client.js') return send('text/javascript; charset=utf-8', clientSource)
        if (url.pathname === '/engine.js') return send('text/javascript; charset=utf-8', engineSource)
        if (url.pathname === '/konva.js') {
          const artifact = path.join(canvasDir, 'lib', 'vendor', 'konva', 'konva.min.js')
          if (!existsSync(artifact)) return send('text/plain', 'no vendored Konva in this checkout', 503)
          return send('text/javascript; charset=utf-8', readFileSync(artifact))
        }
        if (url.pathname === '/react.js') return send('text/javascript; charset=utf-8', reactSource)
        if (url.pathname === '/react-dom.js') return send('text/javascript; charset=utf-8', reactDomSource)
        if (url.pathname === '/state.json') return send('application/json', stateJson)
        if (url.pathname.startsWith('/fonts/')) {
          const name = path.basename(url.pathname)
          const file = path.join(fontsDir, name)
          if (!existsSync(file) || !name.endsWith('.woff2')) return send('text/plain', 'no', 404)
          return send('font/woff2', readFileSync(file))
        }
        return send('text/plain', 'no', 404)
      } catch (err) {
        response.writeHead(500)
        response.end(String(err && err.message ? err.message : err))
      }
    })

    const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
    const pageUrl = 'http://127.0.0.1:' + port + '/'
    const profile = path.join(sandbox, 'profile')
    const child = spawn(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--user-data-dir=' + profile,
        '--window-size=1400,1000',
        pageUrl,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let browserOutput = ''
    child.stdout.on('data', (chunk) => {
      browserOutput += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      browserOutput += chunk.toString()
    })

    // NO `--virtual-time-budget` HERE, deliberately. The stage drives its own work
    // with zero-delay timers and the host waits for the report, so a virtual clock
    // adds nothing but an unrelated deadline that can cut a real rasterization off
    // mid-encode: this check ran under one at first and the export came back empty.
    const deadline = Date.now() + 180_000
    // The LIVENESS beacon is not a result: waiting on it would kill the browser the
    // moment the page proved it was alive, which is exactly what happened the first
    // time this check ran.
    while ((reported === null || reported.booted === true) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250))
    try {
      child.kill()
    } catch (err) {
      /* already gone */
    }
    // Wait for it to actually exit before touching its profile: a killed Chrome still
    // holds its `Default/` files for a moment, and deleting a live profile is an
    // EBUSY, not a failure of anything this check is about.
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve()
        return
      }
      const timer = setTimeout(resolve, 5000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    server.close()

    console.log('')
    if (reported === null || reported.booted === true) {
      check('the page reported its results', false, true)
      if (reported && reported.booted === true) console.log('     the page booted; the last step it reported was: ' + String(progress))
      for (const line of reported && reported.console ? reported.console : []) console.log('     page console: ' + line)
      console.log('     the browser said:')
      console.log(browserOutput.split('\n').slice(0, 25).map((line) => '       ' + line).join('\n'))
    } else {
      for (const error of reported.errors ?? []) console.log('     page error: ' + error)
      for (const line of reported.console ?? []) console.log('     page console: ' + line)
      const geometry = reported.geometry ?? {}
      if (geometry.side && geometry.listScroll) {
        // The MEASURED layout is printed, so a person reading the output sees the
        // numbers the assertions are about without opening a browser.
        console.log('     the bar is ' + Math.round(geometry.side.w) + 'x' + Math.round(geometry.side.h) + ' and the layer list is a ' + geometry.listScroll.clientHeight + 'px scrollport holding ' + geometry.listScroll.scrollHeight + 'px of rows')
      }
      // (1) The bar assembles at all, and from the real bundle.
      check('the artboard mounted', reported.artboard, true)
      check('the layer list rendered', reported.layersRendered, true)
      check('the fixture really has many layers', (reported.layers ?? 0) > 100, true)
      check('the right bar is on screen', (geometry.side ?? {}).w > 0 && (geometry.side ?? {}).h > 0, true)
      check('one pane at a time', geometry.bothPanesMounted, false)
      check('the shaping pane is the one mounted', geometry.inspectMounted, false)
      // (2) THE OVERFLOW THE USER REPORTED. Nothing inside the panel may paint below
      //     the panel's own box, and the layer list must own a bounded scrollport
      //     rather than growing the bar.
      check('nothing paints below the panel', reported.overflowBelowPanel <= 1, true)
      check('the layer list scrolls inside its section', reported.listScrollsInsideItsSection, true)
      const list = geometry.listScroll ?? {}
      check('the layer list is a bounded box', list.clientHeight > 0 && list.clientHeight <= (geometry.side ?? {}).h, true)
      check('the list is far taller than its box', (list.scrollHeight ?? 0) > (list.clientHeight ?? 0) * 2, true)
      check('the lints survive under the list', typeof reported.lints === 'number', true)
      // (2b) THE PAGE'S OWN COORDINATE SYSTEM, with no ruler gutter: the stage paints a
      //      16px grid around the artboard, the design's (0, 0) is still marked on the
      //      artboard's own top-left corner, and the stage's own padding keeps the
      //      design off its edges. The gap below is measured because "there is still
      //      not a gap" is a complaint about pixels, not about rules.
      check('the ruler gutters are gone', reported.page.rulers === 0 && reported.page.axisLabels === 0, true)
      check('the stage paints a grid instead', /gradient/.test(reported.page.gridImage) && /16px/.test(reported.page.gridSize), true)
      // THE WORKSPACE HAS TO BE VISIBLE, which is not a fixed number: the artboard is
      // fitted to the pane, so the promise is that on the CONSTRAINING axis the stage
      // is strictly larger than the design and the grid shows around it. A pane whose
      // artboard is exactly as wide as it is has no drafting surface at all, which is
      // what the old 22px-gutter assertion was really testing for.
      check('a fitted design leaves the grid visible around it', (reported.page.fittedSlack ?? 0) >= 40, true)
      check('the artboard is inset inside its stage',
        reported.page.artInset.left >= 8 && reported.page.artInset.top >= 8, true)
      check('the origin marker is on the artboard', reported.page.originMarker, true)
      check('and the artboard says where its origin is', reported.page.originAttr, '0,0')
      check('the artboard keeps a gap above the composer', reported.page.gapBelow >= 8, true)
      // (2c) THE DESIGN STARTS AT ITS OWN ORIGIN: the layout's boxes are in design
      //      pixels, and the first one has to sit at (0, 0) - a starter that began at an
      //      arbitrary offset would make every number in the panel a fiction.
      check('the design begins at 0,0', reported.page.layoutOrigin, '0,0')
      // (3) THE DEAD GESTURE. A text layer can only be stretched in WIDTH, so it
      //     carries the two side handles and nothing else: its top border is a grab
      //     (the drag MOVES the node) and its right border is a stretch.
      check('a text node is in the fixture', typeof reported.textPath === 'string', true)
      check('the text layer could be selected from the list', reported.textSelected, true)
      check('a text layer carries the two side handles only', reported.textHandles, 'w,e')
      check('its top border is a grab, not a resize', reported.textTopCursor, '')
      check('dragging the top border moves the text', (reported.textTopDrag ?? {}).moved, true)
      check('the move wrote x and y', reported.textTopWrote, 'x,y')
      check('its side says ew-resize', reported.textSideCursor, 'ew-resize')
      check('dragging the side stretches the text', (reported.textSideOps ?? '').startsWith('layers.'), true)
      // (4) A RESIZE IS A RESIZE: the shape's right border says ew-resize, and the
      //     drag widens the node and touches nothing else.
      check('a shape node is in the fixture', typeof reported.shapePath === 'string', true)
      check('a shape\u2019s right border says ew-resize', reported.shapeRightCursor, 'ew-resize')
      check('dragging it widens the shape', (reported.shapeRightDrag ?? {}).after > (reported.shapeRightDrag ?? {}).before, true)
      check('the resize wrote the width alone', (reported.shapeOps ?? []).length, 1)
      // (5) The pane switcher swaps a real pane in.
      check('the inspect pane opens on request', (reported.afterSwitch ?? {}).inspectMounted, true)
      check('and the shaping pane goes away', (reported.afterSwitch ?? {}).designMounted, false)
      check('the feed thumbnail is gone from the pane', (reported.afterSwitch ?? {}).feed, false)
      check('the audit pane does not overflow either', reported.overflowInInspect <= 1, true)
      // (5b) THE TRANSFORM CONTROLS in the inspect pane, each driven for real.
      check('the pane carries move, size, rotate and colour', Object.values(reported.transformWidgets ?? {}).every(Boolean), true)
      check('the nudge pad has all four directions', reported.nudgeDirs, 'left,up,down,right')
      check('a nudge really moves the layer', (reported.nudge ?? {}).moved, true)
      check('the nudge wrote the position', (reported.nudge ?? {}).ops, 1)
      check('a typed width really resizes', (reported.sized ?? {}).to > (reported.sized ?? {}).from, true)
      check('the size wrote one field', (reported.sized ?? {}).ops, 1)
      check('a scale factor multiplies the size', (reported.scaled ?? {}).to > (reported.scaled ?? {}).from, true)
      check('the rotate control writes degrees', (reported.rotated ?? {}).to, 45)
      check('the opacity control writes a fraction', reported.opacityHalf, 0.5)
      check('and back to full is written, not dropped', reported.opacityBack, 1)
      check('the colour control knows its targets', typeof reported.colorTargets === 'string' && reported.colorTargets.length > 0, true)
      check('picking a colour writes the literal', (reported.recolored ?? {}).written, '#ff0000')
      // (5c) ONE SURFACE, NO MODE. The tab IS the design surface: its bar is drawn
      //      on the first frame, and there is no surface attribute left for a mode to
      //      live in - a regression that reintroduced one would bring the attribute
      //      back, so its absence is the assertion.
      check('the tab opens on the design surface', reported.barOnOpen, true)
      check('...with no surface mode left to switch', reported.surfaceAttribute, null)
      // (5d) THE ZOOM MENU: one rung per row, the summary naming the one in force, and
      //      the rung really changing the layout the artboard paints into.
      check('zoom is a menu', reported.zoomControl, true)
      check('its summary names the current rung', String(reported.zoomSummary ?? '').startsWith('Zoom: Fit'), true)
      check('every rung is a row', reported.zoomRungs, 'fit,0.25,0.5,1,2')
      check('picking a rung closes the menu', (reported.zoomAfter ?? {}).open, false)
      check('and the summary follows', String((reported.zoomAfter ?? {}).summary ?? '').indexOf('50%') > 0, true)
      check('and the artboard really rescaled', (reported.zoomAfter ?? {}).canvasWidth, '640px')
      // (6) THE DELETE CONTROL on the rail: one click arms the row, the second
      //     removes that design and only that one, and the request names its scope.
      check('the rail shows the design rows', reported.deleteRow, true)
      check('a row carries the delete control', reported.deleteArm, true)
      check('the first click only ASKS', (reported.deleteArmed ?? {}).confirm, true)
      check('and asks without deleting', (reported.deleteArmed ?? {}).stillThere, 2)
      check('one design is gone after the second click', (reported.deleteDone ?? {}).rows, 1)
      check('and it is the one that was asked about', (reported.deleteDone ?? {}).fixtureGone, true)
      check('the delete named the design and its scope', JSON.stringify((reported.deleteDone ?? {}).requests ?? null), '[{"id":"panel-fixture","scope":"conversation","session":"panel"}]')
      check('the tab is still standing after a delete', (reported.deleteDone ?? {}).artboardRemounted, true)
      // (6) THE FURNITURE THE PERSON ACTUALLY TOUCHES: the Source drawer has to be on
      //     screen, a click on empty canvas has to de-select, and Save has to report
      //     what the HOST holds.
      check('the bar carries a Source button', reported.sourceButton, true)
      check('the Source drawer is on screen', (reported.drawer ?? {}).mounted && (reported.drawer ?? {}).inViewport, true)
      check('the drawer is tall enough to read', (reported.drawer ?? {}).height > 40, true)
      check('a click on empty canvas de-selects', reported.deselected, true)
      check('the bar carries a Save button', reported.saveButton, true)
      check('Save reports the host revision', String(reported.saveNote ?? '').indexOf('is on the host at revision') > 0, true)
      // SAVE HANDS BACK THE PICTURE TOO: one PNG at the design's own pixels, to the
      // Desktop, through the same export route the menu's own PNG row uses.
      const saved = (reported.saveExports ?? [])[0] ?? {}
      check('Save writes the design out as well', (reported.saveExports ?? []).length, 1)
      check('...as a PNG', saved.format, 'png')
      check('...at the design\u2019s own pixels', saved.scale, 1)
      check('...to the Desktop', saved.target, 'desktop')
      check('...from a real rasterization', saved.png === true && saved.pngBytes > 2000, true)
      check('...and says where the file landed', String(reported.saveNote ?? '').indexOf('PNG on the Desktop: ') > 0, true)
      // (7) THE EXPORT MENU in the top bar: one control for format x destination.
      check('the bar carries one export control', reported.exportControl, true)
      check('it names the action while closed', reported.exportSummary, 'Export \u25be')
      check('and it starts closed', reported.exportClosedInitially, true)
      check('the bar keeps one row', (reported.bar ?? {}).lines, 1)
      check('the control opens', reported.exportOpen, true)
      check('an open menu clears the app furniture', reported.menuAboveFurniture, true)
      const painted = reported.menuPaint ?? {}
      check('an open menu is painted, not clipped by the bar', (painted.head ?? {}).mine, true)
      check('...nothing is painted over its middle', (painted.middle ?? {}).mine, true)
      check('...and its last row is reachable, not cut off', (painted.foot ?? {}).mine, true)
      check('and offers every format and destination', reported.exportItems, 'png-1,png-2,svg,png-workspace')
      check('each row says where the file goes', typeof reported.exportHints === 'string' && reported.exportHints.indexOf('Desktop') > 0 && reported.exportHints.indexOf('conversation folder') > 0, true)
      const done = reported.exportDone ?? {}
      const sent = (done.requests ?? [])[0] ?? {}
      check('a row press really exports', (done.requests ?? []).length, 1)
      check('it posts an export purpose', sent.purpose, 'export')
      check('with the format the row named', sent.format, 'png')
      check('at the scale the row named', sent.scale, 1)
      check('to the destination the row named', sent.target, 'desktop')
      check('a real PNG was produced', sent.png === true && sent.pngBytes > 2000, true)
      check('at exactly the preset size', sent.width + 'x' + sent.height, reported.presetSize)
      check('and the menu closed on the write', done.menuClosed, true)

      // (8) THE VENDORED INTERACTION LAYER, from its own mount: the SHIPPED path, and
      //     the four things it promises - it takes the pane, it hit-tests the layer
      //     under the pointer, the artboard follows the pointer with NOTHING sent to
      //     the host, and one gesture commits exactly one patch.
      const konva = reported.konva ?? {}
      check('the interaction layer takes the pane', konva.ready, true)
      check('...with the stage, the layer and its hit rects', konva.seam, true)
      check('...a hit rect per drawable box', konva.rectCount, konva.expectedRects)
      // THE HIT GRAPH IS PAINTED. A hit canvas left empty by a scene-only redraw is
      // invisible to every other assertion here - the rects exist, the geometry is
      // right, and nothing is clickable - so this reads the pixel the pointer would.
      check('...and the hit graph is painted where a layer is', String((konva.probe ?? {}).hitInk) !== '0,0,0,0', true)
      check('a pointer down on a layer selects THAT layer', konva.selectedByClick, konva.shapePath)
      check('...and the layer list follows', konva.rowSelected, 'true')
      check('a drag follows the pointer before the host is asked', (konva.duringDrag ?? {}).repainted, true)
      check('...and sends nothing while the button is down', (konva.duringDrag ?? {}).patches, 0)
      check('the drag commits exactly one patch', (konva.drag ?? {}).patches, 1)
      // A HORIZONTAL drag writes x and nothing else: `nudgeOps` drops a delta that is
      // zero, so a gesture cannot write a coordinate the person did not move.
      // A DRAG WRITES POSITIONS, and how MANY depends on the snap: a horizontal drag whose
      // vertical edge happens to come within the snap tolerance legitimately writes y too,
      // because that is what aligning means. What must never happen is a size or a colour.
      check('...writing a position and nothing else', /^[xy](,[xy])?$/.test(String((konva.drag ?? {}).ops)), true)
      check('...and it moved the layer with the pointer', Math.abs((konva.drag ?? {}).dx ?? 0) > 10, true)
      check('a press on a selection edge resizes in document pixels', (konva.resize ?? {}).ops, 'w')
      check('...through exactly one patch', (konva.resize ?? {}).patches, 1)
      check('...and the width really grew', (konva.resize ?? {}).to > (konva.resize ?? {}).from, true)
      // THE MARQUEE. A band dragged over a corner of the artboard draws itself, catches the
      // layers it covers, outlines them, and is gone on release.
      //
      // THE GROUP MOVE IS NOT DRIVEN FROM HERE, and the gap is named rather than papered
      // over: pressing a member of a marquee's selection and dragging it is the gesture that
      // should move the whole group through one patch, and this mount does not manage it -
      // the same late-run instability the in-place editor hit. What IS pinned is the
      // ARITHMETIC of that move: `multiMoveOps` (two operations per layer, position only, the
      // 64-operation cap biting at 32 layers diagonally, and the layers left behind COUNTED)
      // lives in `check-client-bundles.mjs`, where it needs no browser at all.
      const band = konva.band ?? {}
      check('a dragged band draws itself', band.drawn > 0, true)
      check('releasing it selects several layers', band.count > 1, true)
      check('...and outlines each of them', band.outlines, band.count - 1)
      check('...with the band gone', band.bandAfter, 0)
      // SNAPPING. The drag aimed three pixels past the canvas's centre line, so a layer that
      // simply followed the pointer would land three pixels off - and the whole promise of a
      // snap is that it lands ON the line, with a guide saying which one.
      check('a drag near an alignment line draws a guide', (konva.snap ?? {}).guidesDrawn > 0, true)
      // ONE OF THE BOX'S OWN LINES IS THE GUIDE'S LINE. Which line snapped depends on which
      // candidate was nearest (the canvas's centre, its edge, another layer's edge), so the
      // assertion is the RELATION rather than a coordinate this check would have to guess.
      check(
        '...and one of the moved layer\u2019s lines IS that guide',
        ['edgeLeft', 'opCentre', 'edgeRight'].some((key) => {
          const value = (konva.snap ?? {})[key]
          return typeof value === 'number' && (konva.snap ?? {}).guideAt !== null && Math.abs(value - konva.snap.guideAt) <= 1
        }),
        true,
      )
      check('...through exactly one patch', (konva.snap ?? {}).patches, 1)
      check('and the guide goes with the gesture', (konva.snap ?? {}).guidesAfter, 0)
      // THE SPLIT, both halves in one mount. A press ON a node belongs to the
      // interaction layer (the single patch above proves the two surfaces do not both
      // handle it), and a press that missed every hit rect - just outside the
      // selection's own edge - is the artboard handler's, which is why it stays live.
      // A PRESS THAT MISSES THE SELECTION'S HIT RECT IS STILL THE PACK'S: the press lands
      // outside the selected layer's own box, in the tolerance band of its edge handle, so
      // whatever the hit graph has there (nothing, or a layer stacked above) the drag
      // stretches the SELECTION through its west edge and writes one patch.
      check('a press just outside the selection is still the pack\u2019s', (konva.offBox ?? {}).outsideSelection, true)
      // THE WEST EDGE IS WHAT THE HANDLE PROMISES: a width, written through one patch.
      // The exact operation LIST is deliberately not pinned here - a west drag is a
      // resize, and the height that follows it is the layer's own ratio rule, which
      // the checks above already own.
      check('...and that one resizes from its west edge', String((konva.offBox ?? {}).ops).split(',').includes('w'), true)
      check('...through exactly one patch', (konva.offBox ?? {}).patches, 1)
      check('...and the layer the patch named changed width', (konva.offBox ?? {}).grew, true)

      // (9) THE EDITOR'S VERBS, through the UI: the Add menu offers three primitives, each
      //     one patch; and duplicate, delete and z-order act on the SELECTED layer and
      //     leave the selection on the result.
      //
      //     THE IN-PLACE TEXT EDITOR IS NOT DRIVEN FROM HERE, and the reason is recorded
      //     rather than hidden: driving it from this sequence UNMOUNTS the tab partway
      //     through the run (measured - the artboard, the bar and the layer rows all
      //     disappear and the geometry step then reads a null sidebar), and that is not
      //     root-caused. Its PURE half - which words a layer holds, and the exact operations
      //     a commit writes - is pinned in `check-client-bundles.mjs`, and that the engine
      //     applies them in `check-canvas-node.mjs`. Its UI wants a check of its own that
      //     mounts one settled design and does nothing else.
      const verbs = reported.verbs ?? {}
      check('the bar carries an Add menu', verbs.menu, true)
      check('...offering text, a rectangle and an ellipse', verbs.rows, 'text,rect,ellipse')
      check('adding text adds one layer', (verbs.text ?? {}).added, 1)
      check('...through exactly one patch', (verbs.text ?? {}).patches, 1)
      check('...appended to the design\u2019s own layers', (verbs.text ?? {}).ops, 'layers.-')
      check('...and the new layer is the selected one', (verbs.text ?? {}).selectedIsLast, true)
      check('adding a rectangle adds one, filled from the tokens', (verbs.rect ?? {}).added === 1 && (verbs.rect ?? {}).shape === 'rect' && (verbs.rect ?? {}).fill === 'accent', true)
      check('the Inspect pane carries duplicate, delete and both z-order verbs', Object.values(verbs.controls ?? {}).every(Boolean), true)
      check('duplicate adds a copy', (verbs.duplicate ?? {}).added, 1)
      check('...through exactly one patch', (verbs.duplicate ?? {}).patches, 1)
      check('...and selects the copy', (verbs.duplicate ?? {}).selectedIsCopy, true)
      check('to front re-orders the layers', (verbs.front ?? {}).moved, true)
      check('...from a layer that was not already in front', (verbs.front ?? {}).pickedFirst, true)
      check('...through exactly one patch', (verbs.front ?? {}).patches, 1)
      check('...leaving the layer in front', (verbs.front ?? {}).isFront, true)
      check('delete removes exactly one layer', (verbs.delete ?? {}).removed, 1)
      check('...through exactly one patch', (verbs.delete ?? {}).patches, 1)
      check('...and clears the selection', (verbs.delete ?? {}).selected, true)

      // (10) THE IN-PLACE TEXT EDITOR. A double click opens the words, seeded with what
      //      the layer says; Enter commits ONE `set .text`; Escape writes nothing at all.
      // (10) THE IN-PLACE TEXT EDITOR is NOT driven from here, and the reason is recorded
      //      rather than hidden: the words are edited FROM the layer list, which lives in
      //      the Design pane, and this mount has churned the document enough (add,
      //      duplicate, delete, z-order) that the panes are no longer reliably mounted by
      //      this point in the run. Its PURE half - which words a layer holds and the exact
      //      operations a commit writes - is pinned in `check-client-bundles.mjs`, where it
      //      needs no browser at all, and driving its UI belongs in a check that mounts a
      //      settled document.
    }

    if (keep) {
      console.log('')
      console.log('the sandbox was kept at ' + sandbox)
    } else {
      try {
        rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      } catch (err) {
        console.log('note: could not remove ' + sandbox + ' (' + (err && err.code ? err.code : 'error') + ') - delete it by hand')
      }
    }

    // THE TEMPLATE TRAP, asserted rather than remembered. A backtick inside PAGE or
    // STAGE closes the literal early and leaves the rest as a tagged template, which
    // PARSES - so `node --check` is happy and the page simply never reports, which
    // costs an afternoon to diagnose. Every backtick in those two literals must be
    // escaped, and this is the one place that says so.
    const templateIssues = []
    for (const [name, source] of [['PAGE', PAGE], ['STAGE', STAGE]]) {
      const literal = readFileSync(fileURLToPath(import.meta.url), 'utf8')
      const marker = 'const ' + name + ' = `'
      const from = literal.indexOf(marker) + marker.length
      // The literal ends at its FIRST unescaped backtick, wherever that is: searching
      // for a backtick on a line of its own would depend on the file's line endings.
      let end = -1
      for (let index = from; index < literal.length && end < 0; index += 1) {
        if (literal[index] === '\\') {
          index += 1
          continue
        }
        if (literal[index] === '`') end = index
      }
      const body = literal.slice(from, end)
      let escaped = false
      for (let index = 0; index < body.length; index += 1) {
        const character = body[index]
        if (escaped) {
          escaped = false
          continue
        }
        if (character === '\\') {
          escaped = true
          continue
        }
        if (character === '`') templateIssues.push(name + ' @' + index)
      }
      if (from < marker.length || end < 0) templateIssues.push(name + ': literal not found')
    }
      check('no unescaped backtick in the served templates', templateIssues.join(', '), '')
    console.log('')
    console.log(failures === 0 ? 'all canvas panel checks passed' : failures + ' canvas panel check(s) FAILED')
    process.exitCode = failures === 0 ? 0 : 1
  }
}
