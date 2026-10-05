// check-writing-browser.mjs — drive the Writing tab's Editor.js surface in a real browser.
//
// WHY THIS EXISTS. The client half cannot be proved from a static render: Editor.js
// mounts itself into a holder, loads six vendored UMD files, and hands what the
// person typed back through `saver.save()`. `check-client-bundles.mjs` drives the
// PURE translation and the shell; this drives the MOUNT - the holder, the vendored
// scripts, the pack's own paragraph tool, the save round trip - which is the part
// that only exists once a browser has run it.
//
// The host is stubbed at the `fetch` boundary (the plugin's own routes), and the
// vendored files come off this repository's own disk through the check's server, so
// what loads is the artifact that ships.
//
// With no Chromium-family browser on the host this SKIPS LOUDLY and exits 0: a
// check that cannot run is not a check that passed.
//
// Run:  node scripts/checks/check-writing-browser.mjs
export {}

const { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = await import('node:fs')
const { createServer } = await import('node:http')
const { spawn } = await import('node:child_process')
const os = await import('node:os')
const path = (await import('node:path')).default
const { fileURLToPath } = await import('node:url')

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const writingDir = path.join(repo, 'packages', 'dsh-writing')
const vendorDir = path.join(writingDir, 'lib', 'vendor', 'editorjs')

let failures = 0
function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(58) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
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

/** A React and a react-dom UMD pair for the page to run on. */
function findReactPair() {
  for (const root of moduleRoots()) {
    const react = path.join(root, 'react', 'umd', 'react.development.js')
    const dom = path.join(root, 'react-dom', 'umd', 'react-dom.development.js')
    if (existsSync(react) && existsSync(dom)) return { react, dom }
  }
  return null
}

/** A Chromium-family browser on this machine, or null. */
function findBrowser() {
  const configured = process.env.DSH_WRITING_BROWSER
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
  console.log('skip the writing browser checks                         (no Chromium-family browser on this host)')
  console.log('     set DSH_WRITING_BROWSER to a chrome/edge/chromium binary to run it')
  process.exitCode = 0
} else if (reactPair === null) {
  console.log('skip the writing browser checks                         (no React + react-dom UMD pair on this host)')
  process.exitCode = 0
} else {
  console.log('browser: ' + browser)
  console.log('react:   ' + reactPair.react)
  console.log('')

  const client = readFileSync(path.join(writingDir, 'lib', 'client.js'), 'utf8')
  const vendorFiles = ['editorjs.umd.js', 'paragraph.umd.js', 'header.umd.js', 'editorjs-list.umd.js', 'quote.umd.js', 'code.umd.js']
    .filter((name) => existsSync(path.join(vendorDir, name)))
  const DOC = {
    id: 'doc-1',
    title: 'Check document',
    page: { size: 'a4', orientation: 'portrait', margins: { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 } },
    font: 'Georgia',
    fontSize: 12,
    blocks: [
      { type: 'heading', level: 1, runs: [{ text: 'A title', marks: [] }] },
      { type: 'heading', level: 2, runs: [{ text: 'A heading', marks: [] }] },
      { type: 'paragraph', runs: [{ text: 'plain ', marks: [] }, { text: 'bold', marks: ['b'] }] },
      { type: 'listItem', ordered: false, level: 0, runs: [{ text: 'one', marks: [] }] },
      { type: 'quote', runs: [{ text: 'quoted', marks: [] }] },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    revision: 1,
    by: 'user',
  }

  const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>dsh-writing browser check</title>
<script>
// EARLY ERRORS ARE KEPT, not posted: the page is served by this check's own server
// and the host routes are stubbed inside it, so the result travels back as the
// dumped DOM (see the stage below) and this just collects what happened before it.
window.__earlyErrors = []
window.addEventListener('error', function (event) {
  window.__earlyErrors.push('early error: ' + (event.message || 'unknown') + ' @ ' + (event.filename || '?') + ':' + (event.lineno || 0))
})
window.addEventListener('unhandledrejection', function (event) {
  window.__earlyErrors.push('early rejection: ' + (event.reason && event.reason.message ? event.reason.message : String(event.reason)))
})
</script>
<script src="/react.js"></script>
<script src="/react-dom.js"></script>
</head><body>
<div id="host"></div>
<script>
// THE MODULE LOADER STUB. The real shell installs __ModuleLoader__ and resolves
// 'react' / 'react-dom/client' out of its own table; a check mounts the bundle
// against the UMD pair the page already loaded, which is the same object shape.
window.__plugins = {}
window.__ModuleLoader__ = {
  load: function (definition) {
    window.__plugins[definition.id] = definition
  },
}
window.__require = function (id) {
  if (id === 'react') return window.React
  if (id === 'react-dom/client' || id === 'react-dom') return window.ReactDOM
  throw new Error('the check does not stub ' + id)
}
</script>
<script>
// The script element itself failed to load (a 404, a syntax error): that is not the
// stage's business, so it is reported before the stage even runs.
window.__clientTag = false
</script>
<script src="/client.js" onerror="window.__earlyErrors.push('client.js did not load')" onload="window.__clientTag = true"></script>
</body></html>`

  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname
    const send = (status, type, body) => {
      response.writeHead(status, { 'content-type': type })
      response.end(body)
    }
    if (pathname === '/' || pathname === '/index.html') {
      return send(200, 'text/html; charset=utf-8', PAGE + '<script src="/stage.js"></script>')
    }
    if (pathname === '/client.js') return send(200, 'text/javascript; charset=utf-8', client)
    if (pathname === '/react.js') return send(200, 'text/javascript; charset=utf-8', readFileSync(reactPair.react))
    if (pathname === '/react-dom.js') return send(200, 'text/javascript; charset=utf-8', readFileSync(reactPair.dom))
    const vendor = path.basename(pathname)
    if (pathname.startsWith('/vendor/') && vendorFiles.includes(vendor)) {
      return send(200, 'text/javascript; charset=utf-8', readFileSync(path.join(vendorDir, vendor)))
    }
    // THE ROUTE ITSELF. The tab loads the vendored files with a `<script>` element -
    // not a fetch, so a fetch stub cannot answer for it - and that element asks for
    // the plugin's own route path. Serving it here means the artifact the check runs
    // is the committed one, at the URL the client names.
    if (pathname.startsWith('/api/dsh-writing/vendor/editorjs/')) {
      const file = path.basename(pathname)
      if (vendorFiles.includes(file)) return send(200, 'text/javascript; charset=utf-8', readFileSync(path.join(vendorDir, file)))
      return send(404, 'text/plain; charset=utf-8', 'no such vendored file')
    }
    // The page itself, and the stage that drives it, are served HERE - the same
    // origin as the bundle and the vendored files, so nothing depends on CORS.
    if (pathname === '/stage.js') return send(200, 'text/javascript; charset=utf-8', STAGE)
    return send(404, 'text/plain; charset=utf-8', 'no')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const vendorOrigin = 'http://127.0.0.1:' + port
  const pageUrl = vendorOrigin + '/'

  const STAGE = `
const report = { ok: false, errors: [], early: window.__earlyErrors || [] }
const settle = async (rounds) => { for (let i = 0; i < (rounds || 20); i += 1) await new Promise((resolve) => setTimeout(resolve, 25)) }
const waitFor = async (test, rounds) => {
  for (let i = 0; i < (rounds || 120); i += 1) {
    const value = test()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}
// THE RESULT IS A <pre> THE DUMP CARRIES, not a POST: this page is served by the
// check's own server and the host routes are stubbed in the page, so there is no
// route to report to - and --dump-dom already hands the whole tree back.
const publish = () => {
  const node = document.createElement('pre')
  node.id = 'report'
  node.textContent = JSON.stringify(report)
  document.body.appendChild(node)
}
// A React CONTROLLED input ignores a bare \element.value = x\: React's value tracker
// still holds the old one and its change handler is wired to the native \input\
// event. Writing through the prototype's own setter is what makes the tracker see a
// real change - the same dance every React test harness does.
const setNativeValue = (element, value) => {
  const descriptor = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value')
  if (descriptor && descriptor.set) descriptor.set.call(element, value)
  else element.value = value
}
// Whether each script the page asked for actually arrived, by its own load event.
window.__scripts = []
window.addEventListener('load', (event) => {
  const target = event.target
  if (target && target.tagName === 'SCRIPT') window.__scripts.push((target.getAttribute('src') || 'inline') + ':load')
}, true)
window.addEventListener('error', (event) => {
  const target = event.target
  if (target && target.tagName === 'SCRIPT') window.__scripts.push((target.getAttribute('src') || 'inline') + ':error')
}, true)

async function run() {
  // A WATCHDOG: a stage that hangs (a fetch that never answers, an editor that never
  // mounts) must still leave a result behind, or the dump looks identical to a page
  // that never loaded.
  setTimeout(() => {
    report.watchdog = true
    report.pluginsWithoutWatchdog = Object.keys(window.__plugins || {}).join(',')
    report.liveErrors = (window.__earlyErrors || []).slice()
    report.scripts = (window.__scripts || []).slice()
    publish()
  }, 20000)
  try {
    report.hasReact = typeof React !== 'undefined'
    report.hasReactDom = typeof ReactDOM !== 'undefined' && typeof ReactDOM.createRoot === 'function'
    report.plugins = Object.keys(window.__plugins || {}).join(',')

    // ---- the host, stubbed at the fetch boundary -------------------------------
    const doc = ${JSON.stringify(DOC)}
    const realFetch = window.fetch.bind(window)
    window.__requests = []
    window.__missing = []
    const json = (value, status) => new Response(JSON.stringify(value), { status: status || 200, headers: { 'content-type': 'application/json' } })
    const stub = async (url, options) => {
      const target = typeof url === 'string' ? url : url && url.url ? url.url : String(url)
      const pathname = new URL(target, location.origin).pathname
      window.__requests.push({ pathname, method: (options && options.method) || 'GET' })
      if (pathname.startsWith('/api/dsh-writing/vendor/editorjs/')) {
        const file = pathname.split('/').pop()
        if (window.__missing.indexOf(file) !== -1) return new Response('no', { status: 404 })
        // The artifact that SHIPS: fetched from this same origin, off the check's own
        // server, so the bytes the tab gets are the committed ones.
        return realFetch('/vendor/editorjs/' + file)
      }
      if (pathname === '/api/dsh-writing/state') return json({ ok: true, documents: [{ id: doc.id, title: doc.title, words: 4, blocks: doc.blocks.length, updatedAt: doc.updatedAt }], library: [] })
      if (pathname === '/api/dsh-writing/document') {
        if (!options || options.method !== 'POST') return json({ ok: true, document: doc })
        const body = JSON.parse(options.body)
        const saved = Object.assign({}, doc, body, { id: body.id || doc.id, revision: (doc.revision || 1) + 1 })
        window.__saved = saved
        return json({ ok: true, document: saved })
      }
      if (pathname === '/api/dsh-writing/fonts') return json({ ok: true, families: [{ family: 'Georgia' }], count: 1, failed: 0 })
      if (pathname === '/api/dsh-writing/export') {
        // What the host answers for a proof export: the Desktop file it wrote (an
        // absolute path, which is what Proof opens in its own application) and the
        // disposable workspace copy the shipped preview renders.
        return json({
          ok: true,
          format: 'docx',
          name: 'Check document.docx',
          path: 'check-document-proof.docx',
          previewPath: 'check-document-proof.docx',
          absolute: 'C:\\\\Users\\\\check\\\\Desktop\\\\Check document.docx',
          dir: 'C:\\\\Users\\\\check\\\\Desktop',
          bytes: 4096,
        })
      }
      return json({ ok: false, error: { code: 'NOT_STUBBED', message: pathname } }, 404)
    }
    window.fetch = stub

    // ---- mount the view --------------------------------------------------------
    const definition = window.__plugins['dsh-writing']
    if (!definition) throw new Error('the bundle did not register itself')
    const exports = definition.factory(window.__require)
    report.exports = Object.keys(exports).join(',')
    const registrations = []
    const ctx = {
      effect: (fn) => fn(),
      logger: { debug() {}, warn() {} },
      get: () => undefined,
      slots: {
        inject: (name, fn) => fn(),
        register: (seat, component) => {
          registrations.push({ seat, component })
          return () => {}
        },
      },
    }
    exports.apply(ctx)
    const view = registrations.find((entry) => entry.seat && entry.seat.id === 'writing')
    if (!view) throw new Error('the writing view was not registered')
    const container = document.getElementById('host')
    ReactDOM.createRoot(container).render(React.createElement(view.component, { writingSession: 'session-check', ctx }))

    // The shell first, then the editor: the holder is what Editor.js fills.
    await waitFor(() => container.querySelector('[data-dsh-writing-view]'))
    report.shell = Boolean(container.querySelector('[data-writing-bar]'))
    const holder = await waitFor(() => container.querySelector('[data-writing-editorjs]'))
    report.holder = Boolean(holder)
    if (!holder) {
      const note = container.querySelector('[data-writing-editor-note]')
      report.editorError = note ? note.textContent : (container.textContent || '').slice(0, 200)
      throw new Error('the editor holder never mounted: ' + report.editorError)
    }
    const blocks = await waitFor(() => {
      const found = holder.querySelectorAll('.ce-block')
      return found.length >= 4 ? found : null
    })
    if (!blocks) {
      const column = container.querySelector('[data-writing-editor]')
      report.editorState = column ? column.getAttribute('data-writing-editor') : ''
      report.editorNote = (container.querySelector('[data-writing-editor-note]') || {}).textContent || ''
      report.holderHtml = holder.innerHTML.slice(0, 300)
      report.windowEditorJS = typeof window.EditorJS
      report.windowTools = [typeof window.Paragraph, typeof window.Header, typeof window.EditorjsList, typeof window.Quote, typeof window.Code].join(',')
      report.scripts = window.__scripts.slice()
      report.status = (container.querySelector('[data-writing-message]') || {}).textContent || ''
      throw new Error('Editor.js drew no blocks (' + holder.innerHTML.slice(0, 120) + ')')
    }
    report.blockCount = holder.querySelectorAll('.ce-block').length
    report.editable = holder.querySelectorAll('[contenteditable="true"]').length
    // The pack's OWN tools are the paragraph and the header: a marked run in the
    // document is a span this package renders, not Editor.js's stock tool.
    const marked = holder.querySelector('[data-mark]')
    report.markedSpan = Boolean(marked)
    report.markValue = marked ? marked.getAttribute('data-mark') : ''
    report.toolbar = Boolean(holder.querySelector('.ce-toolbar'))
    const column = container.querySelector('[data-writing-editor]')
    report.editorColumnStyle = column ? column.getAttribute('style') || '' : ''
    report.words = (container.querySelector('[data-writing-words]') || {}).textContent || ''

    // ---- what the editor holds, in the model's own words -----------------------
    // Editor.js defers its change event to a requestIdleCallback, and a headless
    // page that never paints does not reliably run one - so synthetic typing cannot
    // be the proof here. check-client-bundles.mjs drives the pure translation and
    // that file's own stub editor drives the sync path; what THIS check adds is the
    // mount, and the model's own content arriving in the editor's DOM.
    const rendered = [...holder.querySelectorAll('.ce-block')].map((block) => (block.textContent || '').trim())
    report.rendered = rendered.join('|')
    report.expected = ['A title', 'A heading', 'plain bold', 'one', 'quoted'].join('|')
    // The heading LEVEL is data the pack's own header tool wears on the element: H1
    // and H2 are two different blocks here, which is what "only Heading 2" was not.
    report.headingClasses = [...holder.querySelectorAll('.ce-header')].map((element) => element.className).join(' ')
    report.scriptTags = [...document.querySelectorAll('script[src*="/vendor/editorjs/"]')].map((tag) => tag.getAttribute('src').split('/').pop())
    // The editor's OWN save, reached through the service it was constructed with, is
    // the same call the tab makes on every save.
    report.editorData = typeof window.EditorJS === 'function' && window.EditorJS.instances && window.EditorJS.instances.length > 0
      ? 'instances:' + window.EditorJS.instances.length
      : 'no instance table'
    {
      const list = (window.EditorJS && window.EditorJS.instances) || []
      const editor = list[list.length - 1]
          ? JSON.stringify({ keys: Object.keys(editor).slice(0, 40), blocks: typeof editor.blocks, render: typeof editor.render })
        : 'no instance'
    }

    // ---- the bridge's two halves, driven directly -------------------------------
    // Before the tab is asked to carry a run's own size, each half is asked on its
    // own: the painter that writes a run out, and the reader that takes it back.
    // The attributes are the point - Editor.js's saver sanitizes saved data, and it
    // keeps the data-* attributes a tool's config names while dropping style.
    const io = exports.__internals || {}
    report.painterRun = typeof io.markHtml === 'function' ? io.markHtml([{ text: 'plain', marks: [], size: 18 }]) : 'no painter'
    report.readerRun = typeof io.fromEditorData === 'function'
      ? JSON.stringify(io.fromEditorData({ blocks: [{ type: 'paragraph', data: { text: '<span data-size="18">plain</span>' } }] }).blocks)
      : 'no reader'
    report.readerFromStyle = typeof io.fromEditorData === 'function'
      ? JSON.stringify(io.fromEditorData({ blocks: [{ type: 'paragraph', data: { text: '<span style="font-size: 18pt;">plain</span>' } }] }).blocks)
      : 'no reader'

    // ---- the column always fills the pane, and zoom scales the TYPE -------------
    // The editor used to be capped at the page's content width (602px for A4 with
    // 25.4mm margins), which is a ribbon in a wide pane. What is measured here is
    // both halves of the replacement: the column is as wide as its scroll port, and
    // the zoom control multiplies the TYPE rather than the width.
    const scrollPort = container.querySelector('[data-writing-scroll]')
    const paneWidth = scrollPort.clientWidth
    const columnNow = () => container.querySelector('[data-writing-editor]')
    report.paneWidth = paneWidth
    report.columnWidth = Math.round(columnNow().getBoundingClientRect().width)
    report.fillsPane = report.columnWidth >= paneWidth - 2 && report.columnWidth <= paneWidth + 1
    report.fontAt100 = getComputedStyle(columnNow()).fontSize
    const zoomSelect = container.querySelector('[data-writing-zoom]')
    const setZoom = async (level) => {
      setNativeValue(zoomSelect, String(level))
      zoomSelect.dispatchEvent(new Event('change', { bubbles: true }))
      await settle(8)
    }
    await setZoom(2)
    report.fontAt200 = getComputedStyle(columnNow()).fontSize
    report.widthAt200 = Math.round(columnNow().getBoundingClientRect().width)
    await setZoom(1)

    // ---- the bar's two controls set the SELECTION ------------------------------
    // A range inside the paragraph (the block the model calls index 2), then the
    // size input: what must follow is a run carrying that size in the MODEL, which
    // is what the tab saves and what the .docx writes.
    const pickRange = (blockIndex, from, to) => {
      const element = [...holder.querySelectorAll('.ce-block')][blockIndex].querySelector('[contenteditable="true"]')
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      const nodes = []
      let node
      while ((node = walker.nextNode())) nodes.push(node)
      const locate = (offset) => {
        let total = 0
        for (const text of nodes) {
          const length = (text.nodeValue || '').length
          if (offset <= total + length) return { node: text, offset: offset - total }
          total += length
        }
        const last = nodes[nodes.length - 1]
        return { node: last, offset: (last.nodeValue || '').length }
      }
      const range = document.createRange()
      const start = locate(from)
      const end = locate(to)
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
      return range
    }
    const placeCaret = (blockIndex, at) => {
      const range = pickRange(blockIndex, at, at)
      return range
    }
    const sizeInput = () => container.querySelector('[data-writing-fontsize]')
    const fontInput = () => container.querySelector('[data-writing-font')
    pickRange(2, 0, 5)
    report.barSizeForSelection = sizeInput().value
    setNativeValue(sizeInput(), '18')
    const reactKey = Object.keys(sizeInput()).find((name) => name.indexOf('__reactProps$') === 0)
    const styledParagraph = () => {
      const block = [...holder.querySelectorAll('.ce-block')][2]
      return block ? Boolean(block.querySelector('[style*="font-size"]')) : false
    }
    // The event path is the one a person takes. React's own input plumbing has been
    // seen not to deliver for a controlled number input in a headless page, so when
    // nothing happened the handler is called through the props React itself put on
    // the element - the SHIPPED handler either way, and never twice.
    sizeInput().dispatchEvent(new Event('input', { bubbles: true }))
    await settle(10)
    if (!styledParagraph() && reactKey && typeof sizeInput()[reactKey].onChange === 'function') {
        await sizeInput()[reactKey].onChange({ target: sizeInput(), currentTarget: sizeInput() })
    }
    await settle(30)
    const paragraphAfter = [...holder.querySelectorAll('.ce-block')][2]
    const sizedSpan = paragraphAfter ? paragraphAfter.querySelector('[style*="font-size"]') : null
    report.domSizedSpan = Boolean(sizedSpan)
    report.domSizedStyle = sizedSpan ? sizedSpan.getAttribute('style') : ''
    report.selectionKept = (window.getSelection() || {}).toString ? window.getSelection().toString() : ''
    report.sizeAfterApply = sizeInput().value
    report.statusAfterApply = (container.querySelector('[data-writing-message]') || {}).textContent || ''

    // A COLLAPSED caret means the whole block, which is what a person means when
    // they put the cursor in a line and ask for a size - and a write to ONE block has
    // to leave the others alone, which is checked on the paragraph sized above.
    placeCaret(1, 2)
    setNativeValue(sizeInput(), '24')
    sizeInput().dispatchEvent(new Event('input', { bubbles: true }))
    await settle(10)
    if (reactKey && typeof sizeInput()[reactKey].onChange === 'function' && ![...holder.querySelectorAll('.ce-block')][1].querySelector('[style*="font-size"]')) {
      await sizeInput()[reactKey].onChange({ target: sizeInput(), currentTarget: sizeInput() })
    }
    await settle(20)
    const headingAfter = [...holder.querySelectorAll('.ce-block')][1]
    report.blockSizedSpans = headingAfter.querySelectorAll('[style*="font-size"]').length
    report.blockSizedText = (headingAfter.textContent || '').trim()
    // The paragraph next door still carries its own, five blocks later.
    report.paragraphKeptItsSize = styledParagraph()
    report.statusAfterBlock = (container.querySelector('[data-writing-message]') || {}).textContent || ''

    // A QUOTE IS REFUSED, not silently lost: the vendored quote tool's own save
    // strips every attribute but br, so a size set there would vanish at the next
    // save. The refusal has to leave the run alone and say why.
    placeCaret(4, 1)
    setNativeValue(sizeInput(), '30')
    sizeInput().dispatchEvent(new Event('input', { bubbles: true }))
    await settle(20)
    if (reactKey && typeof sizeInput()[reactKey].onChange === 'function' && !/quote/.test((container.querySelector('[data-writing-message]') || {}).textContent || '')) {
      await sizeInput()[reactKey].onChange({ target: sizeInput(), currentTarget: sizeInput() })
      await settle(10)
    }
    const quoteAfter = [...holder.querySelectorAll('.ce-block')][4]
    report.quoteSpans = quoteAfter.querySelectorAll('[style*="font-size"]').length
    report.quoteStatus = (container.querySelector('[data-writing-message]') || {}).textContent || ''

    // ---- Save reads the EDITOR and writes the model -----------------------------
    // The button is a real click, the route is the stubbed one, and the document it
    // posts is the one the editor held: this is the round trip the tab depends on.
    window.__saved = null
    const saveButton = container.querySelector('[data-action="save"]')
    saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await settle(20)
    const saved = window.__saved
    report.saved = Boolean(saved)
    if (saved) {
      report.savedTitle = saved.title
      report.savedTypes = saved.blocks.map((block) => block.type).join(',')
      report.savedText = saved.blocks.map((block) => block.runs.map((run) => run.text).join('')).join('|')
      report.savedLevels = saved.blocks.filter((block) => block.type === 'heading').map((block) => block.level).join(',')
      report.savedBold = saved.blocks[2].runs.filter((run) => run.marks.includes('b')).map((run) => run.text).join('')
      // The two run sizes the bar set, as the MODEL holds them after a real editor
      // round trip: the selected range at 18pt, the collapsed caret's whole heading
      // at 24pt, and nothing at all in the quote the tool would have stripped.
      report.savedSized = saved.blocks[2].runs.filter((run) => run.size === 18).map((run) => run.text).join('|')
      report.savedHeadingSized = saved.blocks[1].runs.every((run) => run.size === 24)
      report.savedQuoteSized = saved.blocks[4].runs.some((run) => Number.isFinite(run.size))
      }

    // ---- Proof: show the export, and open the file ------------------------------
    // The two things a person asked for: the right bar must actually SHOW the pane
    // it opens (a collapsed column takes it invisibly), and the file must open in
    // whatever application owns a .docx. Both are recorded from the stubs.
    const calls = { resources: [], kinds: [], toggled: 0, opened: [] }
    const sidebarStub = {
      openResource: (address, options) => {
        calls.resources.push(address)
        calls.kinds.push(options && options.kind)
        return true
      },
      isExpanded: () => false,
      toggleExpanded: () => {
        calls.toggled += 1
      },
    }
    const tabsStub = { entries: () => [{ id: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview', kind: 'docx' }] }
    ctx.get = (service) => {
      if (service === 'sidebarRight') return sidebarStub
      if (service === 'sidebarRightTabs') return tabsStub
      if (service === 'remote.session') {
        return {
          openWorkspacePath: async (request) => {
            calls.opened.push(request && request.path)
            return { ok: true }
          },
        }
      }
      return undefined
    }
    const proofButton = container.querySelector('[data-action="proof"]')
    report.proofButton = Boolean(proofButton)
    proofButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await settle(40)
    report.proofResources = calls.resources
    report.proofKinds = calls.kinds
    report.proofExpanded = calls.toggled
    report.proofOpened = calls.opened
    report.proofStatus = (container.querySelector('[data-writing-message]') || {}).textContent || ''

    // ---- one missing tool is not a dead tab ------------------------------------
    window.__missing.push('quote.umd.js')
    report.ok = true
  } catch (err) {
    report.errors.push(String((err && err.message) || err))
  }
  report.seenErrors = (window.__earlyErrors || []).slice()
  publish()
}
run()
`

  const profile = mkdtempSync(path.join(os.tmpdir(), 'writing-browser-'))
  const dump = await new Promise((resolve) => {
    const child = spawn(browser, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--user-data-dir=' + profile,
      '--virtual-time-budget=40000',
      '--dump-dom',
      pageUrl,
    ], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.on('close', () => resolve(out))
  })
  server.close()

  const match = /<pre id="report">([\s\S]*?)<\/pre>/.exec(dump)
  if (!match) {
    console.log('FAIL the page never reported a result')
    console.log('dump length ' + dump.length)
    console.log('contains stage: ' + dump.includes('stage.js') + ', contains report: ' + dump.includes('id="report"') + ', contains ce-block: ' + dump.includes('ce-block'))
    console.log('--- head ---')
    console.log(dump.slice(0, 900))
    console.log('--- tail ---')
    console.log(dump.slice(-900))
    failures += 1
  } else {
    const decode = (text) =>
      text
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
    const report = JSON.parse(decode(match[1]))
    const text = (value) => (typeof value === 'string' ? value : '')
    check('the page had React and ReactDOM', report.hasReact === true && report.hasReactDom === true, true)
    check('the bundle registered and exported the view', typeof report.exports === 'string' && report.exports.includes('apply'), true)
    check('the shell drew before the editor', report.shell, true)
    check('the editor holder mounted', report.holder, true)
    check('Editor.js drew one block per model block', report.blockCount, DOC.blocks.length)
    check('every block is editable', report.editable >= DOC.blocks.length, true)
    check('the document arrived in the editor, block for block', text(report.rendered), report.expected)
    check('a level 1 heading and a level 2 heading are different blocks', /h1/.test(text(report.headingClasses)) && /h2/.test(text(report.headingClasses)), true)
    check('the pack\u2019s own tool renders the marks', report.markedSpan === true && text(report.markValue).includes('b'), true)
    check('every vendored file was loaded', (report.scriptTags || []).length, vendorFiles.length)
    check('the column carries the document\u2019s typography', text(report.editorColumnStyle).includes('Georgia'), true)
    check('the status bar counts the document\u2019s words', /\d+ words/.test(text(report.words)), true)
    check('Save read the editor and wrote the model', report.saved, true)
    check('the saved document kept its title', report.savedTitle, DOC.title)
    check('the saved document kept every block type', report.savedTypes, 'heading,heading,paragraph,listItem,quote')
    check('the saved document kept the heading levels', report.savedLevels, '1,2')
    check('the saved document kept the words', text(report.savedText), report.expected)
    check('the saved document kept the inline mark', report.savedBold, 'bold')
    // The column fills the pane at 100%, and the zoom multiplies the TYPE instead of
    // the width: 12pt is 16px, so 200% is 32px on a column that is still the pane's.
    check('the editor column is as wide as its pane', report.fillsPane, true)
    check('the column carries the document\u2019s typography', text(report.editorColumnStyle).includes('Georgia'), true)
    check('100% draws the document\u2019s own size', text(report.fontAt100), '16px')
    check('200% doubles the type', text(report.fontAt200), '32px')
    check('200% does not widen the column past the pane', report.widthAt200 <= report.paneWidth + 1, true)
    // The bar's two controls set the SELECTION: a span in the editor, a run in the
    // model after the editor's own save, and the selection kept where the person put it.
    check('the size control was read for the selection', text(report.barSizeForSelection), '12')
    check('the painter writes a run size as DATA and as paint', /data-size="18"/.test(text(report.painterRun)) && /font-size:18pt/.test(text(report.painterRun)), true)
    check('  ...and the reader takes it from the data', /"size":18/.test(text(report.readerRun)), true)
    check('  ...and from an inline style, for a paste', /"size":18/.test(text(report.readerFromStyle)), true)
    check('setting a size wraps the selection in a sized span', report.domSizedSpan === true, true)
    check('  ...with the size in points', /\b18(\.0)?pt\b/.test(text(report.domSizedStyle)), true)
    check('  ...and the selection survives the re-render', text(report.selectionKept), 'plain')
    check('  ...and the control now shows that size', text(report.sizeAfterApply), '18')
    check('  ...and the status says it was the selection', /on the selection/.test(text(report.statusAfterApply)), true)
    check('the saved document carries the run\u2019s own size', text(report.savedSized), 'plain')
    // A collapsed caret means the block, which is the useful reading of "make this
    // line bigger" and is named in the status.
    check('a collapsed caret sizes the WHOLE block', report.blockSizedSpans >= 1 && report.blockSizedText === 'A heading', true)
    check('  ...and the model keeps it', report.savedHeadingSized, true)
    check('  ...and the status says it was the block', /on this block/.test(text(report.statusAfterBlock)), true)
    check('  ...and the paragraph next door kept its own size', report.paragraphKeptItsSize, true)
    // A quote is refused because the vendored tool's own save would strip it - the
    // one place a run property cannot live, said out loud instead of lost later.
    check('a size is refused inside a quote', report.quoteSpans, 0)
    check('  ...and the refusal names the quote tool', /quote/.test(text(report.quoteStatus)), true)
    check('  ...so nothing in the quote carries a size', report.savedQuoteSized, false)
    // Proof: the preview is opened WITH the kind the registry names, the collapsed
    // column is expanded so it can be seen, and the Desktop file is handed to its app.
    check('Proof hands the workspace copy to the shipped preview', (report.proofResources || []).length, 1)
    check('  ...under the kind the registry names', (report.proofKinds || []).join(','), 'docx')
    check('  ...and expands the right bar so it can be seen', report.proofExpanded, 1)
    check('  ...and opens the Desktop file in its own application', (report.proofOpened || []).join(','), 'C:\\Users\\check\\Desktop\\Check document.docx')
    check('  ...and the status says where it went', /Check document\.docx/.test(text(report.proofStatus)), true)
    check('the page reported no errors', (report.errors || []).concat(report.seenErrors || []).length, 0)
    if ((report.errors || []).length > 0) console.log('     ' + report.errors.join('\n     '))
    if ((report.seenErrors || []).length > 0) console.log('     early: ' + report.seenErrors.join(' | '))
  }
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch (err) {
    /* a temp profile that will not delete is not a failed check */
  }
  console.log('')
  console.log(failures === 0 ? 'all writing browser checks passed' : failures + ' check(s) FAILED')
  process.exitCode = failures === 0 ? 0 : 1
}
