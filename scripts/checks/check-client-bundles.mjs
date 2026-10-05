// check-client-bundles.mjs - load the pack's browser bundles the way the shell
// does (module table + factory) and drive them with a REAL React runtime.
//
// Why this exists: the client halves have no build step and no type checker, so
// a typo or a wrong hook call is otherwise only found in the running GUI. This
// harness registers each bundle through its own `window.__ModuleLoader__.load`,
// activates it against a stub cordis context, and renders the resulting React
// trees with the machine's own react-dom (server renderer: hooks that need a
// browser - useEffect, useSyncExternalStore without a server snapshot - are
// skipped, exactly like any server render).
//
// Run:  node scripts/checks/check-client-bundles.mjs
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))

/** A React + react-dom pair to render with: the profile's, else any npm cache's. */
/**
 * The harness line this pack is built and tested against: `.dsh-version.json`'s
 * `dsh` pin. It decides which copy of the HARNESS's own bundles these checks may
 * grade against, because several lines can sit on one machine at once - this one
 * has a 0.1.5-rc.1 mirror in `$DSH_HOME/profiles/node_modules` beside the pinned
 * 0.2.0-rc.2 in the npx cache, and the mirror is what a plain "first root that
 * has the file" search finds. Grading a fork against the line it was NOT forked
 * from is worse than skipping: the assertions would pass while the app breaks.
 * @returns {string|null} the pinned version, or null when the manifest is unreadable.
 */
function pinnedDshVersion() {
  try {
    return JSON.parse(readFileSync(path.join(repo, '.dsh-version.json'), 'utf8')).dsh
  } catch (err) {
    return null
  }
}

/** Whether one node_modules root holds the pinned harness line's packages. */
function carriesPinnedLine(root, pin) {
  try {
    return JSON.parse(readFileSync(path.join(root, '@deepseek-ai', 'dsh-client-ui-theme', 'package.json'), 'utf8')).version === pin
  } catch (err) {
    return false
  }
}

function moduleRoots() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const roots = [path.join(home, 'profiles', 'node_modules')]
  // npm's on-demand cache: the Local/AppData folders on Windows, ~/.npm/_npx
  // on macOS/Linux. Global installs are the other place a pair can live.
  const caches = [process.env.LOCALAPPDATA, process.env.APPDATA]
    .filter(Boolean)
    .map((base) => path.join(base, 'npm-cache', '_npx'))
  caches.push(path.join(os.homedir(), '.npm', '_npx'))
  for (const cache of caches) {
    if (!existsSync(cache)) continue
    for (const entry of readdirSync(cache)) roots.push(path.join(cache, entry, 'node_modules'))
  }
  roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules')
  // The pinned line first, everything else after it as a fallback (a host that
  // has no install of the pin still runs these checks against whatever core
  // bundle it can find - the core-dependent sections already skip loudly when
  // there is none at all).
  const pin = pinnedDshVersion()
  if (pin === null) return roots
  return [...roots.filter((root) => carriesPinnedLine(root, pin)), ...roots.filter((root) => !carriesPinnedLine(root, pin))]
}

/**
 * One file inside the HARNESS's own installed packages, or `null` when this host
 * has none (the checks then skip that section loudly instead of passing).
 * @param relative - path inside a node_modules root, e.g. `@scope/pkg/lib/x.js`.
 * @returns the absolute path, or null.
 */
function findCoreFile(relative) {
  for (const root of moduleRoots()) {
    const candidate = path.join(root, relative)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function loadReact() {
  const roots = moduleRoots()
  for (const root of roots) {
    try {
      const requireFrom = createRequire(path.join(root, 'index.js'))
      const React = requireFrom('react')
      const server = requireFrom('react-dom/server')
      if (typeof server.renderToStaticMarkup === 'function') {
        return { React, jsxRuntime: requireFrom('react/jsx-runtime'), renderToStaticMarkup: server.renderToStaticMarkup }
      }
    } catch (err) {
      /* try the next root */
    }
  }
  throw new Error('no react + react-dom pair found (looked in the profile and the npm caches)')
}

const { React, jsxRuntime, renderToStaticMarkup } = loadReact()
const h = React.createElement
let failures = 0
// The last Menu the stand-in primitives rendered, so a check can read the props
// a bundle handed it (its items and its onSelect) instead of only the markup.
let lastMenuProps = null
// ... and the same for the primitives whose interesting half is a PORTAL the
// server renderer cannot follow (dsh-canvas's own figures).
function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(30) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}

/**
 * A CSSOM-shaped inline style: a browser's own element style object answers
 * `setProperty` / `removeProperty` and reflects the value as a property, which
 * is how the page-zoom control writes (and the check reads) the level.
 */
function fakeInlineStyle() {
  const style = {}
  Object.defineProperty(style, 'setProperty', {
    value: (name, value) => {
      style[name] = String(value)
    },
  })
  Object.defineProperty(style, 'removeProperty', {
    value: (name) => {
      delete style[name]
    },
  })
  Object.defineProperty(style, 'getPropertyValue', {
    value: (name) => (Object.prototype.hasOwnProperty.call(style, name) ? style[name] : ''),
  })
  return style
}

/** A DOM stand-in: enough for the style-tag injection and detached elements. */
function fakeDocument() {
  const element = () => {
    // Attributes are RECORDED, not swallowed: the page-zoom control marks the
    // document element while a level is in force (alpha.16), and the right-bar
    // seam override is gated on that marker, so a check has to be able to read
    // it back the way a browser's CSS would.
    const attributes = {}
    return {
      dataset: {},
      style: fakeInlineStyle(),
      children: [],
      textContent: '',
      value: '',
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute(name, value) {
        attributes[name] = String(value)
      },
      removeAttribute(name) {
        delete attributes[name]
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null
      },
      hasAttribute(name) {
        return Object.prototype.hasOwnProperty.call(attributes, name)
      },
      addEventListener() {},
      removeEventListener() {},
      appendChild(child) {
        this.children.push(child)
        return child
      },
      insertBefore(child) {
        this.children.push(child)
        return child
      },
      remove() {},
      focus() {},
      select() {},
      querySelector: () => null,
      parentNode: null,
    }
  }
  return {
    // Style tags land here, so a check can inspect what a bundle injected.
    head: {
      children: [],
      appendChild(child) {
        this.children.push(child)
        return child
      },
    },
    body: element(),
    // The page-zoom control writes its level here (and nowhere else).
    documentElement: element(),
    // The theme package's own stylesheets; a check fills this in (CSSOM shape).
    styleSheets: [],
    querySelector: () => null,
    createElement: () => element(),
    addEventListener() {},
    removeEventListener() {},
    activeElement: null,
    contains: () => false,
  }
}

/** Capture one module-table bundle's factory and run it. */
function loadBundle(relative, extraRequire) {
  // An absolute path is honoured so a check can load one of the HARNESS's own
  // client bundles (see the extension-theme section: the real ui-theme runtime is
  // what proves an extension theme is not discarded by its `adopt()`).
  const file = path.isAbsolute(relative) ? relative : path.join(repo, relative)
  // A stand-in for the browser's own storage. The page-zoom control remembers
  // its level there (per origin, exactly like the browser zoom it mirrors), so
  // the harness has to be able to hand one back and read what was written.
  const storage = {
    map: {},
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(this.map, key) ? this.map[key] : null
    },
    setItem(key, value) {
      this.map[key] = String(value)
    },
    removeItem(key) {
      delete this.map[key]
    },
  }
  const window = { __ModuleLoader__: {}, localStorage: storage }
  const document = fakeDocument()
  let entry = null
  window.__ModuleLoader__.load = (value) => {
    entry = value
  }
  new Function('window', 'document', 'console', readFileSync(file, 'utf8'))(window, document, console)
  if (entry === null) throw new Error('bundle did not register with the module loader: ' + relative)
  const require = (name) => {
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return jsxRuntime
    if (name === 'react-dom/client') return extraRequire.reactDomClient
    // Seeded by the shell in the real app; stubbed here.
    if (name === '@deepseek-ai/dsh-client-store') {
      // The engine's products are bare observables - `subscribe`/`getSnapshot`/
      // `update`/`set` - which is the shape the vendored 0.2.0-rc.2 bundles drive
      // (`getSnapshot`, and `persist` folded in by the real store when a caller
      // asks for it). `get` is kept beside `getSnapshot` because this pack's own
      // hand-written halves were built against the earlier spelling and both must
      // resolve here; nothing asserts WHICH one a bundle uses.
      return {
        createSnapshotStore: (initial, opts) => {
          let value = typeof initial === 'function' ? initial() : initial
          const listeners = new Set()
          const write = (next) => {
            value = typeof next === 'function' ? next(value) : next
            for (const listener of [...listeners]) listener()
            return value
          }
          return {
            get: () => value,
            getSnapshot: () => value,
            set: write,
            update: write,
            subscribe(listener) {
              listeners.add(listener)
              return () => listeners.delete(listener)
            },
            // Persistence is localStorage-backed in the real store; the stub
            // records the request so a bundle cannot silently lose it, and the
            // checks that care about persistence read `localStorage` directly.
            persist: opts && opts.persist ? opts.persist.name : undefined,
          }
        },
        // The real ui-theme builds its two Settings rows from this (see the
        // extension-theme section, which loads that bundle); a handle-shaped
        // stub is enough because those rows are never mounted here.
        defineStore: (spec) => ({
          ...spec,
          create: () => ({
            getSnapshot: () => (typeof spec.init === 'function' ? spec.init() : {}),
            subscribe: () => () => {},
            actions: {},
          }),
        }),
        notifySubscribers() {},
      }
    }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      const Null = () => null
      // Menu renders its anchor (the trigger); Tooltip renders its child. Both
      // are enough for a static render to reach the markup a bundle builds, and
      // the Menu's props are kept so a check can drive its entries.
      const Anchor = (props) => {
        lastMenuProps = props
        return props && props.anchor !== undefined ? props.anchor : null
      }
      const Child = (props) => (props && props.children !== undefined ? props.children : null)
      // MarkdownText renders its text: the editor's rendered-view body draws it.
      // IT IS `React.memo`-WRAPPED ON PURPOSE, because the shipped primitive is
      // (`const MarkdownText = React.memo(...)`) and a memo component is an
      // OBJECT, not a function. A plain-function stub let a `typeof x ===
      // 'function'` guard pass HERE while rejecting the REAL export in the
      // browser, so dsh-skills alpha.2 shipped showing source where the document
      // belonged. The stub must have the shape the guard sees at runtime.
      // A bundle that GUARDS its use of the primitive (dsh-skills does) is loaded
      // against an engine without it too, so this knob drops the export: the
      // fallback must be a working pane, not a crash at module scope.
      const Text =
        extraRequire && extraRequire.withoutMarkdownText === true
          ? undefined
          : React.memo((props) => props.text)
      // Modal renders nothing while closed and its title / description / body /
      // footer when open, like the real one (which portals to document.body).
      const Dialog = (props) => {
        if (!props || props.open !== true) return null
        return React.createElement(React.Fragment, null, props.title, props.description, props.children, props.footer)
      }
      // Button renders its children, so a footer's label reaches the markup.
      const Push = (props) => (props && props.children !== undefined ? props.children : null)
      // Pill renders its label, and carries the `active` flag as an attribute so
      // a check can read WHERE a chip is on or off (dsh-cmdbar's bar, alpha.15).
      const Chip =
        extraRequire && extraRequire.withoutPill === true
          ? undefined
          : (props) => {
              const rest = Object.assign({}, props)
              delete rest.children
              delete rest.active
              return React.createElement(
                props && props.onClick ? 'button' : 'span',
                Object.assign({ 'data-active': props && props.active === true ? 'true' : 'false' }, rest),
                props && props.children !== undefined ? props.children : null,
              )
            }
      // The Pill is alpha.15's one new primitive, and it can be DROPPED
      // (`withoutPill`), because the bundle guards it: a root-scoped slot ABDICATES
      // on a render throw, so `h(undefined, ...)` on an older engine would cost the
      // whole panel. The fallback has to be a working bar.
      const Clip = async () => true
      // The clipboard helper the pinned line really exports
      // (`writeClipboard(text)`, which answers whether the host accepted the
      // write): a stub poorer than the package it stands in for would let an
      // unqualified call in a bundle look like a call to an absent primitive - a
      // quiet no-op here - while throwing a ReferenceError in the browser.
      return {
        Menu: Anchor,
        Tooltip: Child,
        Pill: Chip,
        MarkdownText: Text,
        Modal: Dialog,
        Button: Push,
        writeClipboard: Clip,
        // The toast portals a message anchored to a control; a static render only
        // needs it to exist (it is rendered after an attempt, never at rest).
        Toast: Null,
        // THE GLYPH NAMES ARE THE PINNED LINE'S, SPELLING INCLUDED, and that is
        // load-bearing: this list used to carry the `…16` names of an older line,
        // so dsh-themes could read `primitives.IconDownloadOutline16` here - and
        // render a download button - while the real 0.2.0-rc.2 primitives had no
        // such export at all, `h(undefined)` threw, and the slots core ABDICATED
        // the seat, bringing the shipped three-dot menu back. A stub that is
        // richer than the package it stands in for hides exactly this class of
        // bug, which is why the old spellings are gone rather than kept beside
        // the new ones. (Medium is here because the real ui-theme reads it.)
        IconChevronDownOutlineRegular: Null,
        IconChevronUpOutlineRegular: Null,
        IconLightOutlineRegular: Null,
        IconLightOutlineMedium: Null,
        IconDarkOutlineRegular: Null,
        IconDarkOutlineMedium: Null,
        IconFollowsystemOutlineRegular: Null,
        IconFollowsystemOutlineMedium: Null,
        IconDownloadOutlineRegular: Null,
        IconCheckOutlineRegular: Null,
        IconWarningOutlineRegular: Null,
      }
    }
    throw new Error('unexpected require in a client bundle: ' + name)
  }
  return { id: entry.id, exports: entry.factory(require), document, window, storage }
}

// ---------------------------------------------------------------- dsh-modal
const captured = {}
const modal = loadBundle('packages/dsh-modal/lib/client.js', {
  reactDomClient: {
    createRoot(container) {
      captured.container = container
      return {
        render(element) {
          captured.element = element
        },
        unmount() {},
      }
    },
  },
})
const provided = {}
modal.exports.apply({
  reflect: {
    provide(name, value) {
      provided[name] = value
      return () => {}
    },
  },
  get: () => undefined,
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
check('modal bundle id', modal.id, 'dsh-modal')
check('modals service provided', typeof provided.modals, 'object')
check('modals api', Object.keys(provided.modals).sort().join(','), 'alert,close,confirm,isOpen,open,prompt')
check('body-level host created', captured.container && captured.container.dataset.dshModalHost !== undefined)
check('idle render is empty', renderToStaticMarkup(captured.element), '')

const modals = provided.modals
const pending = modals.open({
  title: 'Save new file',
  message: 'Saved in the conversation folder.',
  fields: [{ name: 'path', label: 'File name (with extension)', value: 'untitled.txt', hint: 'Example: src/app.ts', required: true }],
  validate: () => '',
  confirmLabel: 'Save',
  busyLabel: 'Saving\u2026',
})
const markup = renderToStaticMarkup(captured.element)
check('dialog renders title', markup.includes('Save new file'))
check('dialog renders field', markup.includes('File name (with extension)') && markup.includes('value="untitled.txt"'))
check('dialog renders buttons', markup.includes('>Save<') && markup.includes('>Cancel<'))
check('dialog is modal', markup.includes('aria-modal="true"'))
modals.close(null)
check('cancel resolves null', await pending, null)
check('closed render is empty', renderToStaticMarkup(captured.element), '')
check('isOpen after close', modals.isOpen(), false)
const promptPromise = modals.prompt({ title: 'Name', label: 'Name', value: 'abc' })
check('prompt opens a dialog', modals.isOpen())
modals.close({ value: 'typed' })
check('prompt resolves the value', await promptPromise, 'typed')
const alertPromise = modals.alert('Done')
const alertMarkup = renderToStaticMarkup(captured.element)
check('alert has one button', alertMarkup.includes('>OK<') && !alertMarkup.includes('>Cancel<'))
modals.close()
await alertPromise

// The RICH dialog (alpha.2): `content` is a render function handed `{ close }`
// that owns the whole body, for a dialog that is a browser rather than a
// question. What makes it a different shape, and what is pinned here: the roomy
// frame, no form and no action row (the content drives its own work), and a mask
// that does NOT close it - a rich dialog can hold unfinished work.
let richClosedWith = 'not closed'
const richPromise = modals.open({
  title: '',
  size: 'lg',
  content: (helpers) => {
    richHelpers = helpers
    return h('div', { className: 'rich-body' }, 'rich content', h('button', { type: 'button', onClick: () => helpers.close('done') }, 'Finish'))
  },
})
let richHelpers = null
const richMarkup = renderToStaticMarkup(captured.element)
check('rich dialog uses the large frame', richMarkup.includes('class="dsm-panel dsm-lg"'))
check('rich dialog renders the content', richMarkup.includes('class="rich-body"') && richMarkup.includes('rich content'))
check('rich dialog has no form or action row', !richMarkup.includes('dsm-form') && !richMarkup.includes('dsm-actions'))
check('rich dialog content can close it', typeof richHelpers.close === 'function')
richHelpers.close('done')
richClosedWith = await richPromise
check('rich dialog resolves what the content passed', richClosedWith, 'done')
check('rich dialog closed cleanly', renderToStaticMarkup(captured.element), '')

// -------------------------------------------------------------- dsh-skills
const skills = loadBundle('packages/dsh-skills/lib/client.js', {})
const skillsCssTag = skills.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-skills/skills.css').pop()
const skillsCss = skillsCssTag ? skillsCssTag.textContent : ''
const skillsSource = readFileSync(path.join(repo, 'packages/dsh-skills/lib/client.js'), 'utf8')
check('skills bundle id', skills.id, 'dsh-skills')
check('skills inject', JSON.stringify(skills.exports.inject), '["slots"]')
check(
  'skills stylesheet injected',
  skillsCss.includes('.dsk-button{') && skillsCss.includes('.dsk-list{') && skillsCss.includes('.dsk-editor{'),
)
const skillsSeats = {}
const skillsClicks = []
skills.exports.apply({
  slots: {
    inject: (name, fn) => fn(),
    register(spec, component) {
      skillsSeats[spec.name] = { spec, component }
      return () => {}
    },
  },
  get: () => undefined,
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
check('skills takes one seat', Object.keys(skillsSeats).join(','), 'conversation.session.header.utilities')
const skillsSeat = skillsSeats['conversation.session.header.utilities']
check('skills button id', skillsSeat.spec.id, 'dsh-skills')
// THE SEAT: -50 is one step LEFT of the page-zoom control (-40), which is where
// it was asked to be; the list renders ascending, so nothing else may take it.
check('skills button order is left of the zoom control', skillsSeat.spec.order, -50)
const skillsMarkup = renderToStaticMarkup(h(skillsSeat.component, { sessionId: 'sess-1' }))
check('skills button renders its glyph', skillsMarkup.includes('data-dsh-skills="button"') && skillsMarkup.includes('aria-label="Skills"'))
// The modal is opened on the pack's shared surface in its RICH form, and its
// absence is a sentence rather than a crash.
check(
  'the button opens the shared dialog in its rich form',
  skillsSource.includes("const MODAL_SERVICE = 'modals'") &&
    skillsSource.includes("size: 'lg'") &&
    skillsSource.includes('content: (helpers) => h(SkillsBrowser'),
)
check('a missing modal service is handled', skillsSource.includes('is not mounted in this profile'))

// The browser mounts and draws its first frame (a static render runs no effect,
// so this is the loading state - the whole tree still has to survive building).
const skillsBrowser = renderToStaticMarkup(
  h(skills.exports.__internals.SkillsBrowser, { sessionId: 'sess-1', close: () => {} }),
)
check(
  'the browser draws its frame before the catalog arrives',
  skillsBrowser.includes('Skills') && skillsBrowser.includes('Reading the skill catalog') && skillsBrowser.includes('>Close<'),
)

// The pure half, driven directly: the grouping a reader sees and the label an
// unknown bucket gets.
const internals = skills.exports.__internals
check('source labels are the reader-facing ones', internals.sourceLabel('project-dsh'), 'Project \u00b7 .dsh/skills')
check('an unknown source is shown as itself', internals.sourceLabel('something-new'), 'something-new')
check('the known buckets keep the documented order', internals.SOURCE_ORDER.join(','), 'project-dsh,project-agents,custom,user-dsh,user-agents,bundled,runtime')
check('an unknown bucket groups apart', internals.groupKeyOf({ source: 'something-new' }), 'other')
check('a known bucket groups by itself', internals.groupKeyOf({ source: 'user-dsh' }), 'user-dsh')
check(
  'a row names its provider and its shape',
  internals.metaOf({ provider: 'dsh-pdf', kind: 'bundle', bytes: 2048 }) === 'dsh-pdf \u00b7 SKILL.md folder \u00b7 2.0 KB',
)
check('a runtime row says it has no file', internals.metaOf({ provider: 'some-plugin', kind: 'runtime', bytes: null }).includes('no file'))
check('sizes read as sizes', internals.formatBytes(512) === '512 B' && internals.formatBytes(4096) === '4.0 KB' && internals.formatBytes(3 * 1024 * 1024) === '3.0 MB')

// THE LOAD-BEARING RULE OF THE SAVE: the client names a SKILL, never a path -
// the host writes the file the registry resolved. Pinned from the source, since
// a static render runs no handler.
const skillsPayload = /const payload = \{([\s\S]*?)\n          \}/.exec(skillsSource)
check('the save payload exists', skillsPayload !== null)
check(
  'the save payload carries no path',
  skillsPayload !== null && skillsPayload[1].includes('session: sessionId') && skillsPayload[1].includes('name: doc.data.name') && skillsPayload[1].includes('expected:') && !skillsPayload[1].includes('path'),
)
check(
  'an edit is only offered for a file-backed skill',
  skillsSource.includes('doc.data !== null && doc.data.editable') && skillsSource.includes("draft === null ? 'Edit' : 'Stop editing'"),
)
check(
  'the routes match the host half',
  ['/list', '/body', '/save'].every((suffix) => skillsSource.includes("API_ROOT + '" + suffix + "'")),
)

// THE RESTING VIEW IS THE RENDERED DOCUMENT, not the source: the SAME primitive
// the right bar's Markdown view draws, inside the SAME `data-document-markdown`
// container dsh-themes keys its white Markdown paper on (`body
// [data-document-markdown]`). The SOURCE belongs to Edit alone.
const skillsDocument = renderToStaticMarkup(
  h(internals.SkillDocument, { text: '---\nname: demo\n---\n\n# Heading\n\nBody **bold**.\n' }),
)
check(
  'the read view is the rendered Markdown document',
  skillsDocument.includes('data-document-markdown="true"') && skillsDocument.includes('# Heading'),
)
check('the read view is on the paper scrollport', skillsDocument.includes('class="dsk-doc dsk-paper"'))
check('the read view draws no source', !skillsDocument.includes('dsk-md"') && !skillsDocument.includes('<pre'))
// THE GUARD'S SHAPE, pinned from the source, because the check's stub is what
// makes the two checks above meaningful: `React.memo` returns an OBJECT, so a
// `typeof ... === 'function'` presence test rejects the real primitive. That is
// the alpha.2 bug - the modal kept drawing the source - and it is silent, so it
// gets its own assertion rather than relying on the stub alone.
check(
  'the primitive guard tests presence, not function shape',
  !/typeof primitives\.MarkdownText === 'function'/.test(skillsSource) &&
    skillsSource.includes('exported !== undefined && exported !== null'),
)
check(
  'the rendered view resets the plain-text whitespace',
  skillsCss.includes('.dsk-mdview{min-width:0;white-space:normal;') && skillsCss.includes('.dsk-doc.dsk-paper{padding:0}'),
)
// The primitive is drawn WITH its chrome labels: the engine reads
// `labels.footnotes` whenever a document has footnotes, so an absent object
// would crash on exactly those documents.
check(
  'the primitive is handed its labels',
  internals.MARKDOWN_LABELS.code.copyLabel === 'Copy' &&
    internals.MARKDOWN_LABELS.code.copiedLabel === 'Copied' &&
    internals.MARKDOWN_LABELS.footnotes === 'Footnotes',
)
// An engine whose primitives export no MarkdownText still gets a working pane.
const skillsNoPrimitive = loadBundle('packages/dsh-skills/lib/client.js', { withoutMarkdownText: true })
const skillsFallback = renderToStaticMarkup(
  h(skillsNoPrimitive.exports.__internals.SkillDocument, { text: '# Heading\n' }),
)
check(
  'a build without the primitive falls back to text',
  skillsFallback.includes('<pre class="dsk-md">') && skillsFallback.includes('# Heading'),
)
check(
  'the fallback is not on the paper',
  !skillsFallback.includes('data-document-markdown') && !skillsFallback.includes('dsk-paper'),
)

// --------------------------------------------------------------- dsh-editor
const editor = loadBundle('packages/dsh-editor/lib/client.js', {})
// The editor's stylesheet, injected at module scope: the alpha.8 resets of what
// the preview's plain-text scrollport imposes on the rendered Markdown page.
const editorCssTag = editor.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-editor/editor.css').pop()
const editorCss = editorCssTag ? editorCssTag.textContent : ''
check('md paper resets whitespace', editorCss.includes('.dse-mdviewPaper{flex:1;min-height:0;white-space:normal}'))
check('edit pill keeps the app font', editorCss.includes('var(--dsw-font-family,inherit)') && editorCss.includes('.dse-mdviewEdit{'))
// The toolbar IS the tab's top bar (alpha.9): 38px with box-sizing:border-box is
// the box the shipped Files tab and the document preview use, so this pane's
// first hairline lands on the y=76 line the 38px docking strip and the
// conversation header (min-height:76px) draw. It was 8px + 26px + 8px = 42.5px.
check(
  'editor top bar is the 38px pane header',
  editorCss.includes('.dse-tools{flex:none;display:flex;align-items:center;gap:6px;box-sizing:border-box;height:38px;padding:0 10px 0 12px;') &&
    editorCss.includes('.dse-find{flex:1;min-width:0;height:24px;') &&
    editorCss.includes('gap:6px;height:24px;box-sizing:border-box;border:0;') &&
    editorCss.includes('.dse-preview{flex:none;display:inline-flex;align-items:center;height:24px;'),
)
check('editor bundle id', editor.id, 'dsh-editor')
check('editor inject', JSON.stringify(editor.exports.inject), '["locale","slots","sidebarRightTabs"]')
// The language map is internal (the tab builds the extension when a file opens),
// so it is asserted from the source: alpha.10 added the three shell languages and
// alpha.11 Rust and TOML - none of the five has a Lezer parser among the vendored
// packages, so all five ride on StreamLanguage. Without a map entry a
// .bat/.sh/.ps1/.rs/.toml drew as ONE flat colour in the light theme.
const editorSource = readFileSync(path.join(repo, 'packages/dsh-editor/lib/client.js'), 'utf8')
check(
  'editor maps the shell extensions',
  ['sh', 'bash', 'zsh', 'ksh', 'dash', 'ps1', 'psm1', 'psd1', 'bat', 'cmd'].every((ext) => editorSource.includes("case '" + ext + "':")) &&
    editorSource.includes("streamLanguage(CM, 'shell')") &&
    editorSource.includes("streamLanguage(CM, 'powerShell')") &&
    editorSource.includes("streamLanguage(CM, 'batch')"),
)
check(
  'editor maps the rust and toml extensions',
  ['rs', 'toml'].every((ext) => editorSource.includes("case '" + ext + "':")) &&
    editorSource.includes("streamLanguage(CM, 'rust')") &&
    editorSource.includes("streamLanguage(CM, 'toml')"),
)
// A mode the LOADED ENGINE does not carry must degrade, not throw. The engine is
// one artifact on one route and need not be the one this bundle was built with,
// and alpha.11 proved what that costs: a bundle newer than its engine asked for
// `rust`, `StreamLanguage.define(undefined)` dereferenced it, and the tab died
// with "Cannot read properties of undefined (reading 'languageData')" instead of
// opening the file unhighlighted. alpha.12 guarded the five STREAM modes and left
// the seven Lezer ones able to kill a tab the same way (`CM.yaml is not a
// function`), so alpha.13 put EVERY lookup behind one guard: `engineLanguage`
// answers null for a name the engine does not export, and `lezerLanguage` /
// `streamLanguage` are the only two ways a language is built.
check(
  'a missing engine language degrades instead of throwing',
  editorSource.includes('function engineLanguage(CM, name)') &&
    editorSource.includes('function lezerLanguage(CM, name, options)') &&
    editorSource.includes('function streamLanguage(CM, name)') &&
    editorSource.includes("const factory = CM[name]") &&
    editorSource.includes('if (typeof factory !== \'function\')') &&
    !editorSource.includes('CM.StreamLanguage.define(CM.') &&
    // No language is built from the engine anywhere but through the guard: a bare
    // `CM.<name>(...)` call is what a future mapping would add back by accident.
    !/return CM\.[A-Za-z]+\(/.test(editorSource),
)
// The guard is TWO lookups, because the engine answers in two SHAPES: a Lezer
// language is a factory function, a CM5-style legacy mode is a StreamParser
// OBJECT with a `token()`. alpha.13 sent the five stream modes through the
// function test as well - so the engine was asked for `rust()` where it exports
// an object, every stream mode resolved to null, and .sh/.ps1/.bat/.rs/.toml all
// opened with no language while the engine carried every one of them.
check(
  'the stream modes are looked up as mode objects, not factories',
  editorSource.includes('function engineStreamMode(CM, name)') &&
    editorSource.includes("typeof mode.token !== 'function'") &&
    editorSource.includes('const mode = engineStreamMode(CM, name)') &&
    !editorSource.includes('const mode = engineLanguage(CM, name)'),
)
check(
  'the guarded lookup reports the REBUILD, not a restart',
  editorSource.includes('The route re-reads and re-ETags that artifact per request, so REBUILD it') &&
    editorSource.includes('Restarting `dsh web` neither helps nor is needed') &&
    editorSource.includes('RESTART `dsh web`') === false &&
    editorSource.includes('caches the artifact in memory') === false,
)
// ...and the request for that engine is VERSION-QUALIFIED, so a browser cannot
// hand this bundle an engine it cached under the same stable URL yesterday.
check('the engine request carries this bundle\'s version', editorSource.includes("fetch(VENDOR_ROUTE + '?v=' + encodeURIComponent(PLUGIN_VERSION)"))
// ...and that version is the PACKAGE's, read here rather than trusted: the URL
// qualifier is only worth anything while the two agree, and alpha.10 shipped a
// client whose constant said alpha.9.
const editorVersion = JSON.parse(readFileSync(path.join(repo, 'packages/dsh-editor/package.json'), 'utf8')).version
check('the client version constant is the package version', editorSource.includes("PLUGIN_VERSION = '" + editorVersion + "'"))
// ...and the generated bundle must actually CARRY those names, which is the
// half a source-only assertion cannot see: a stale cm6.min.js whose entry.js was
// updated but never rebuilt fails here. `window`/`document` are passed as
// UNDEFINED on purpose - the bundle probes for them (`typeof document`) and falls
// back to inert stubs, while handing it a half-built object makes that probe
// succeed and the load throw on a missing `.documentElement.style`.
const cmVendor = new Function(
  'window',
  'document',
  'console',
  readFileSync(path.join(repo, 'packages/dsh-editor/lib/vendor/cm6.min.js'), 'utf8') + '\nreturn DSHEditorCM',
)(undefined, undefined, console)
check(
  'editor engine carries the stream languages',
  cmVendor &&
    typeof cmVendor.StreamLanguage === 'function' &&
    typeof cmVendor.StreamLanguage.define === 'function' &&
    // The exact call the client makes for each extension: a mode the bundle names
    // but StreamLanguage cannot wrap is still a broken file.
    ['shell', 'powerShell', 'batch', 'rust', 'toml'].every(
      (name) => cmVendor[name] && typeof cmVendor[name].token === 'function' && Boolean(cmVendor.StreamLanguage.define(cmVendor[name])),
    ),
)
check(
  'editor engine carries the Lezer languages too',
  // The other half of the mapping: these are called through the same guard, so a
  // generated artifact missing one of them has to fail here rather than in a tab.
  ['javascript', 'json', 'markdown', 'python', 'html', 'css', 'yaml'].every((name) => typeof cmVendor[name] === 'function'),
)
// ...and the guard must ACCEPT what the engine really answers with, which is the
// assertion whose absence let alpha.13 ship: the source-shape checks above were
// satisfied by a function-only lookup while the artifact exports objects for all
// five stream modes. The client's own lookup functions are therefore extracted
// from the SHIPPED source and run against the SHIPPED engine - the two halves a
// source-only or engine-only assertion can never compare.
const editorLookups = new Function(
  'CM',
  'reportMissingMode',
  editorSource.slice(
    editorSource.indexOf('function engineLanguage(CM, name)'),
    editorSource.indexOf('function languageExtensionFor(CM, fileName)'),
  ) + '\nreturn { engineLanguage, engineStreamMode, lezerLanguage, streamLanguage }',
)(cmVendor, () => {})
check(
  'the editor\'s own lookup accepts every language the engine carries',
  ['shell', 'powerShell', 'batch', 'rust', 'toml'].every((name) => Boolean(editorLookups.streamLanguage(cmVendor, name))) &&
    ['javascript', 'json', 'markdown', 'python', 'html', 'css', 'yaml'].every((name) => Boolean(editorLookups.lezerLanguage(cmVendor, name))) &&
    // ...and still answers null, rather than throwing, for a name no engine has.
    editorLookups.streamLanguage(cmVendor, 'notAMode') === null &&
    editorLookups.lezerLanguage(cmVendor, 'notALanguage') === null,
)
const registered = {}
const types = []
const previewCalls = []
const editorLocales = {}
const tabTypes = {
  register(definition) {
    types.push(definition)
    return () => {}
  },
  entries: () => [
    { id: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview', kind: 'renamed-preview' },
    { id: 'dsh-editor', kind: 'editor' },
  ],
}
editor.exports.apply({
  get: (name) =>
    name === 'modals' ? modals : name === 'sidebarRight' ? { openResource: (address, options) => previewCalls.push({ address, options }) } : name === 'sidebarRightTabs' ? tabTypes : undefined,
  slots: {
    inject: (name, fn) => fn(),
    register(spec, component) {
      registered[spec.name + (spec.key ? '#' + spec.key : '')] = { spec, component }
      return () => {}
    },
  },
  locale: {
    register(namespace, dictionaries) {
      editorLocales[namespace] = dictionaries
      return () => {}
    },
  },
  sidebarRightTabs: tabTypes,
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
check('tab type registered', types.length === 1 && types[0].id + '/' + types[0].kind, 'dsh-editor/editor')
check('page title', types[0].title('sidebar://editor'), 'Editor')
check('file title', types[0].title('dsh-resource://file/session/s1/src/app.ts'), 'app.ts')
check('claims a text file', types[0].canOpen('dsh-resource://file/session/s1/src/app.ts'), true)
check('claims markdown', types[0].canOpen('dsh-resource://file/session/s1/readme.md'), true)
check('vetoes html', types[0].canOpen('dsh-resource://file/session/s1/page.html'), false)
check('vetoes absolute', types[0].canOpen('dsh-resource://file/session/s1/C:/x.ts'), false)
check('guide entry', types[0].guide.map((entry) => entry.title()).join(','), 'Editor')
const editorSeats = Object.keys(registered).sort().join(',')
check(
  'editor seats',
  editorSeats,
  'sidebar.right.pane.tab#dsh-editor,sidebar.right.pane.tab.title#dsh-editor,sidebar.right.tab.document#@deepseek-ai/dsh-client-ui-sidebar-documentpreview/markdown',
)
const facade = registered['sidebar.right.pane.tab#dsh-editor'].spec.inject()
check('body resolves modals lazily', facade.getModals(), modals)
facade.openPreview('dsh-resource://file/session/s1/readme.md', 'tab2')
check('preview names the registry kind', previewCalls[0].options.kind, 'renamed-preview')
check('preview replaces the editor tab', previewCalls[0].options.replaceTab, 'tab2')
check('preview keeps the address', previewCalls[0].address, 'dsh-resource://file/session/s1/readme.md')

// The rendered Markdown body shadows the shipped one (lower priority renders) and
// carries the Edit toggle back into the editor.
const markdownSeat = registered['sidebar.right.tab.document#@deepseek-ai/dsh-client-ui-sidebar-documentpreview/markdown']
check('shadow body priority', markdownSeat.spec.priority < 0, true)
check('shadow body locale', markdownSeat.spec.locale, 'dsh-editor.markdown')
check('markdown dictionaries', Object.keys(editorLocales).join(','), 'dsh-editor.markdown')
const markdownInjected = markdownSeat.spec.inject()
check('shadow body injects edit', typeof markdownInjected.edit, 'function')
previewCalls.length = 0
markdownInjected.edit('dsh-resource://file/session/s1/readme.md', 'tab7')
check('edit reopens the file in the editor', previewCalls[0].options.kind, 'editor')
check('edit replaces the preview tab', previewCalls[0].options.replaceTab, 'tab7')
const markdownCopy = {
  'md.edit': 'Edit',
  'md.editTitle': 'Edit this file in the editor',
  'md.copy': 'Copy',
  'md.copied': 'Copied',
  'md.footnotes': 'Footnotes',
}
const markdownT = (key) => (markdownCopy[key] === undefined ? key : markdownCopy[key])
const MarkdownPreviewBody = markdownSeat.component
const renderedMarkdown = renderToStaticMarkup(
  h(MarkdownPreviewBody, {
    t: markdownT,
    content: { kind: 'text', text: '# Title', eof: true },
    resourceAddress: 'dsh-resource://file/session/s1/readme.md',
    useTabInfo: () => ({ tab: { id: 'tab7' } }),
    edit: markdownInjected.edit,
  }),
)
check('rendered body draws the page', renderedMarkdown.includes('data-document-markdown') && renderedMarkdown.includes('# Title'))
check('rendered body offers Edit', renderedMarkdown.includes('data-markdown-edit') && renderedMarkdown.includes('>Edit<'))
check('rendered body ignores non-text', renderToStaticMarkup(h(MarkdownPreviewBody, { t: markdownT, content: { kind: 'image' } })), '')
const Body = registered['sidebar.right.pane.tab#dsh-editor'].component
const blankTab = { id: 'tab1', contentId: 'sidebar://editor', title: 'Editor', navigation: { revision: 0 } }
const fileTab = { id: 'tab2', contentId: 'dsh-resource://file/session/s1/src/app.ts', title: 'app.ts', navigation: { revision: 3 } }
check(
  'blank page tab renders',
  renderToStaticMarkup(h(Body, { useTabInfo: () => ({ tab: blankTab }), sessionId: 's1', getModals: () => modals })).includes(
    'data-editor-tab="tab1"',
  ),
)
check(
  'file tab renders',
  renderToStaticMarkup(h(Body, { useTabInfo: () => ({ tab: fileTab }), sessionId: 's1', getModals: () => modals })).includes(
    'data-editor-tab="tab2"',
  ),
)

// A registry without the preview type (a deployment that never mounted it):
// "Preview" still names a kind instead of throwing a bare TypeError.
const editorBare = loadBundle('packages/dsh-editor/lib/client.js', {})
const bareCalls = []
const editorBareSeats = {}
editorBare.exports.apply({
  get: (name) => (name === 'sidebarRight' ? { openResource: (address, options) => bareCalls.push(options) } : undefined),
  slots: {
    inject: (name, fn) => fn(),
    register(spec) {
      editorBareSeats[spec.name + (spec.key ? '#' + spec.key : '')] = { spec }
      return () => {}
    },
  },
  locale: { register: () => () => {} },
  sidebarRightTabs: { register: () => () => {}, entries: () => [] },
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
editorBareSeats['sidebar.right.pane.tab#dsh-editor'].spec.inject().openPreview('dsh-resource://file/session/s1/readme.md', 'tab9')
check('preview falls back to the pinned kind', bareCalls[0].kind, 'text')

// ---------------------------------------------------------- dsh-open-in-app
// 0.2.0-rc.2 grew this bundle: it now registers SIX slot occupants (the header's
// Open In split button, the Files tab's and the document tab's action rows, the
// unpreviewable-document fallback, and both deliverables action lists), reads
// its own translations through `ctx.locale.bind(NS)` instead of a bound
// `t` handed in from outside, and installs a workspace shortcut through
// `ctx.shortcuts`. The stub below therefore carries those two services - the
// alternative was a check that crashes on the first `require`d call and reports
// nothing about the route split it exists to pin.
const openInApp = loadBundle('packages/dsh-open-in-app/lib/client.js', {})
check('open-in-app bundle id', openInApp.id, 'dsh-open-in-app')
const oiaRegistered = {}
openInApp.exports.apply({
  get: () => undefined,
  remote: {},
  slots: {
    inject: (name, fn) => fn(),
    register(spec, component) {
      oiaRegistered[spec.name] = { spec, component }
      return () => {}
    },
  },
  locale: { register: () => () => {}, bind: () => (key) => key },
  shortcuts: { register: () => () => {}, catalog: {} },
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
check(
  'open-in-app slots',
  Object.keys(oiaRegistered).join(','),
  'conversation.session.header.utilities,sidebar.right.tab.files.actions,sidebar.right.tab.document.actions,sidebar.right.tab.document.unpreviewable,deliverables.file.actions,deliverables.review.file.actions',
)
const launch = oiaRegistered['conversation.session.header.utilities'].spec.inject().launch
const calls = []
globalThis.location = { origin: 'http://127.0.0.1:3099' }
// The route the bundle hands its fetcher is BROWSER-RELATIVE in 0.2.0-rc.2
// (`open-in-app/open`), and the browser is what resolves it against the page
// origin - so this double does the same instead of parsing it as absolute, which
// is what the earlier line held. The pack's own route is absolute and rides the
// same call unchanged, which is the whole point of the split asserted below.
globalThis.fetch = async (url, init) => {
  calls.push({ path: new URL(String(url), globalThis.location.origin).pathname, body: init && init.body })
  return { ok: true, status: 200, json: async () => ({ ok: true }) }
}
await launch('vscode', 'C:/work')
await launch('explorer', 'C:/work')
await launch('gitbash', 'C:/work')
check(
  'file managers take the pack route',
  calls.map((call) => call.path).join(','),
  '/open-in-app/open,/api/dsh-open-in-app/open,/open-in-app/open',
)
check('launch bodies unchanged', calls[1].body, '{"app":"explorer","path":"C:/work"}')

// --------------------------------------------------------------- dsh-themes
const themes = loadBundle('packages/dsh-themes/lib/client.js', {})
check('themes bundle id', themes.id, 'dsh-themes')
check('themes inject', JSON.stringify(themes.exports.inject), '["slots","locale"]')
let themeSnapshot = {
  preference: 'dark',
  active: { id: 'dark', colorScheme: 'dark' },
  themes: [
    { id: 'light', colorScheme: 'light', tokens: {} },
    { id: 'dark', colorScheme: 'dark', tokens: {} },
  ],
  revision: 3,
}
const themeWrites = []
// alpha.12: the registry's own write entry. The package registers its palettes
// through it (`ctx.theme.register` - ui-theme's documented third-party surface)
// and the control's menu reads the registry back through `snapshot.themes`.
const themeRegistrations = []
const themeService = {
  getTheme: () => themeSnapshot,
  register(definition) {
    themeRegistrations.push(definition)
    themeSnapshot = { ...themeSnapshot, themes: [...themeSnapshot.themes, definition], revision: themeSnapshot.revision + 1 }
    return () => {}
  },
  setTheme(id) {
    themeWrites.push(id)
    themeSnapshot = {
      ...themeSnapshot,
      preference: id,
      active: { id: 'system', colorScheme: 'light' },
      revision: themeSnapshot.revision + 1,
    }
  },
}
const themeEvents = []
// The package registers FOUR occupants of the same list slot (the page-zoom
// control, the screenshot control, the Themes control and the Session-log
// download seat), so the stand-in keys by slot#id and the order below is the
// order the package registers them in.
const themesSeats = {}
const themeLocales = {}
// A stand-in for the shipped export controller's store - the shape the renderer
// binds a selector Hook from (`getSnapshot` / `subscribe`).
let logEntry = undefined
const logStore = {
  getSnapshot: () => ({ bySession: { s1: logEntry } }),
  subscribe: () => () => {},
}
const downloadCalls = []
const logController = {
  store: logStore,
  download: (sessionId) => downloadCalls.push(sessionId),
  dismiss: () => {},
}
themes.exports.apply({
  get: (name) => (name === 'theme' ? themeService : name === 'sessionLogDownload' ? logController : undefined),
  on: (event, listener) => {
    if (event === 'theme/change') themeEvents.push(listener)
    return () => {}
  },
  slots: {
    inject: (name, fn) => fn(),
    register(spec, component) {
      themesSeats[spec.name + '#' + spec.id] = { spec, component }
      return () => {}
    },
  },
  locale: {
    register(namespace, dictionaries) {
      themeLocales[namespace] = dictionaries
      return () => {}
    },
  },
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
check(
  'themes header seats',
  Object.keys(themesSeats).join(','),
  'conversation.session.header.utilities#dsh-themes,conversation.session.header.utilities#dsh-themes-screenshot,conversation.session.header.utilities#dsh-themes-zoom,conversation.session.header.utilities#session-log-download',
)
const themesSpec = themesSeats['conversation.session.header.utilities#dsh-themes'].spec
check('themes seat id', themesSpec.id, 'dsh-themes')
check('themes sits left of Open In', themesSpec.order < -10, true)
check('themes dictionaries', Object.keys(themeLocales).join(','), 'themes')
const themesFacade = themesSpec.inject()
check('themes state is a snapshot source', typeof themesFacade.themeState.getSnapshot, 'function')
check('themes reads the service snapshot', themesFacade.themeState.getSnapshot().preference, 'dark')
const themesCopy = {
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'theme.system': 'System',
  'theme.nord': 'Nord',
  'theme.monokai': 'Monokai',
  'theme.hacker': 'Hacker',
  'theme.cyber': 'Cyber',
  'theme.current': 'Theme: {name}',
  'theme.unavailable': 'The theme service is unavailable',
  'download.title': 'Download session log',
  'download.busy': 'Preparing the session archive',
  'download.unavailable': 'Session export is unavailable',
  'download.preparingTitle': 'Exporting Session',
  'download.preparingDescription': 'Preparing a ZIP containing this Session, its sub-Sessions, and attachments.',
  'download.successTitle': 'Session download started',
  'download.successDescription': 'The browser is downloading the Session ZIP.',
  'download.errorTitle': 'Session export failed',
  'download.close': 'Close',
  'download.commandFailed': 'Could not start the Session export.',
  'screenshot.title': 'Screenshot to the Desktop',
  'screenshot.busy': 'Capturing the window',
  'screenshot.saved': 'Screenshot saved to {path}',
  'screenshot.downloaded': 'Screenshot handed to the browser download',
  'screenshot.failed': 'The screenshot failed',
  'screenshot.unsupported': 'This browser cannot capture the page here (HTTPS or localhost is required)',
  'screenshot.cancelled': 'The screenshot was cancelled',
  'zoom.current': 'Page zoom: {percent}%',
  'zoom.level': 'Current {percent}%',
  'zoom.in': 'Zoom in',
  'zoom.out': 'Zoom out',
}
const themesT = (key, vars) => {
  const text = themesCopy[key] === undefined ? key : themesCopy[key]
  return vars ? text.replace(/\{(\w+)\}/g, (match, name) => String(vars[name] === undefined ? '' : vars[name])) : text
}
const ThemesAction = themesSeats['conversation.session.header.utilities#dsh-themes'].component
const themesMarkup = renderToStaticMarkup(h(ThemesAction, { t: themesT, themeState: themesFacade.themeState }))
// The server snapshot is the product default (`system`); the live snapshot the
// button paints in the browser is the service's own ('dark' above).
check('themes button renders', themesMarkup.includes('class="dst-button"') && themesMarkup.includes('aria-haspopup="menu"'))
check('themes button is not disabled', themesMarkup.includes('disabled'), false)
themesFacade.themeState.setTheme('light')
check('themes writes through the service', themeWrites.join(','), 'light')
check('themes adopts the written value', themesFacade.themeState.getSnapshot().preference, 'light')
for (const listener of themeEvents) listener({ preference: 'system', active: { id: 'system', colorScheme: 'dark' }, revision: 9 })
check('themes follows theme/change', themesFacade.themeState.getSnapshot().preference, 'system')

// ------------------------------------- the theme extensions (Nord, Monokai, Hacker, Cyber)
// alpha.12: this package REGISTERS its own palettes into the shipped registry
// and the control's menu is built FROM that registry, so a theme this pack adds
// becomes selectable by being registered - there is no second list to keep in
// step. Nord rides the dark base palette and recolors the alias layer only;
// Monokai (alpha.13) sits after it in THEME_EXTENSIONS, Hacker (alpha.19) after
// Monokai and Cyber (alpha.24) after Hacker - that is the order the registration
// loop walks and therefore the order the menu draws. Hacker and Cyber are the
// two high-contrast programmer palettes and must stay each their own: the check
// below pins both pages, not just one.
const nord = themeRegistrations.find((theme) => theme.id === 'nord')
const monokai = themeRegistrations.find((theme) => theme.id === 'monokai')
const hacker = themeRegistrations.find((theme) => theme.id === 'hacker')
const cyber = themeRegistrations.find((theme) => theme.id === 'cyber')
check(
  'the registered themes are nord, monokai, hacker then cyber',
  themeRegistrations.map((theme) => theme.id).join(','),
  'nord,monokai,hacker,cyber',
)
check('nord rides the dark base palette', nord && nord.colorScheme, 'dark')
check(
  'nord overrides token variables only',
  nord &&
    Object.keys(nord.tokens).every(
      (name) => name.startsWith('--dsw-alias-') || name.startsWith('--dsw-specific-') || name.startsWith('--shiki-token-'),
    ),
  true,
)
check('nord paints the Polar Night page', nord && nord.tokens['--dsw-alias-bg-base'], '#2e3440')
check('nord paints the Snow Storm text', nord && nord.tokens['--dsw-alias-label-primary'], '#eceff4')
check('nord paints the Frost accent', nord && nord.tokens['--dsw-alias-brand-primary'], '#88c0d0')
check('nord keeps the sidebar on the page colour', nord && nord.tokens['--dsw-specific-sidebar-fill'], '#2e3440')
check('nord brings its own copy', themeLocales.themes.en['theme.nord'], 'Nord')
check('nord copy is in both dictionaries', themeLocales.themes.zh['theme.nord'], 'Nord')
check('monokai rides the dark base palette', monokai && monokai.colorScheme, 'dark')
check(
  'monokai overrides token variables only',
  monokai &&
    Object.keys(monokai.tokens).every(
      (name) => name.startsWith('--dsw-alias-') || name.startsWith('--dsw-specific-') || name.startsWith('--shiki-token-'),
    ),
  true,
)
check('monokai paints the classic near-black page', monokai && monokai.tokens['--dsw-alias-bg-base'], '#272822')
check('monokai paints the off-white body', monokai && monokai.tokens['--dsw-alias-label-primary'], '#f8f8f2')
check('monokai paints the keyword pink accent', monokai && monokai.tokens['--dsw-alias-brand-primary'], '#f92672')
check(
  'monokai keeps the sidebar on the page colour',
  monokai && monokai.tokens['--dsw-specific-sidebar-fill'],
  '#272822',
)
check('monokai paints the classic comment grey', monokai && monokai.tokens['--shiki-token-comment'], '#75715e')
check('monokai brings its own copy', themeLocales.themes.en['theme.monokai'], 'Monokai')
check('monokai copy is in both dictionaries', themeLocales.themes.zh['theme.monokai'], 'Monokai')
check('hacker rides the dark base palette', hacker && hacker.colorScheme, 'dark')
check(
  'hacker overrides token variables only',
  hacker &&
    Object.keys(hacker.tokens).every(
      (name) => name.startsWith('--dsw-alias-') || name.startsWith('--dsw-specific-') || name.startsWith('--shiki-token-'),
    ),
  true,
)
check('hacker paints the near-black green-cast page', hacker && hacker.tokens['--dsw-alias-bg-base'], '#0a0e0a')
check('hacker paints the phosphor body', hacker && hacker.tokens['--dsw-alias-label-primary'], '#d8ffe0')
check('hacker paints the signal-green accent', hacker && hacker.tokens['--dsw-alias-brand-primary'], '#00ff41')
check(
  'hacker keeps the sidebar on the page colour',
  hacker && hacker.tokens['--dsw-specific-sidebar-fill'],
  '#0a0e0a',
)
check('hacker paints the dim green comments', hacker && hacker.tokens['--shiki-token-comment'], '#3f6b4a')
check('hacker brings its own copy', themeLocales.themes.en['theme.hacker'], 'Hacker')
check('hacker copy is in both dictionaries', themeLocales.themes.zh['theme.hacker'], 'Hacker')
check(
  'hacker is its own palette, not a Monokai copy',
  hacker && monokai && hacker.tokens['--dsw-alias-bg-base'] !== monokai.tokens['--dsw-alias-bg-base'],
  true,
)
check('cyber rides the dark base palette', cyber && cyber.colorScheme, 'dark')
check(
  'cyber overrides token variables only',
  cyber &&
    Object.keys(cyber.tokens).every(
      (name) => name.startsWith('--dsw-alias-') || name.startsWith('--dsw-specific-') || name.startsWith('--shiki-token-'),
    ),
  true,
)
check('cyber paints the blue-cast near-black page', cyber && cyber.tokens['--dsw-alias-bg-base'], '#04060d')
check('cyber paints the near-white body', cyber && cyber.tokens['--dsw-alias-label-primary'], '#f0f6ff')
check('cyber paints the neon magenta accent', cyber && cyber.tokens['--dsw-alias-brand-primary'], '#ff2e88')
check('cyber links take the cyan', cyber && cyber.tokens['--dsw-alias-link'], '#00e5ff')
check(
  'cyber keeps the sidebar on the page colour',
  cyber && cyber.tokens['--dsw-specific-sidebar-fill'],
  '#04060d',
)
check('cyber paints the magenta keywords', cyber && cyber.tokens['--shiki-token-keyword'], '#ff2e88')
check('cyber paints the cyan functions', cyber && cyber.tokens['--shiki-token-function'], '#00e5ff')
check('cyber brings its own copy', themeLocales.themes.en['theme.cyber'], 'Cyber')
check('cyber copy is in both dictionaries', themeLocales.themes.zh['theme.cyber'], 'Cyber')
// The two high-contrast programmer palettes must not converge: a different page
// AND a different brand, so "like Hacker but not Hacker" is a real difference
// rather than a claim in a comment.
check(
  'cyber is its own palette, not a Hacker copy',
  cyber &&
    hacker &&
    cyber.tokens['--dsw-alias-bg-base'] !== hacker.tokens['--dsw-alias-bg-base'] &&
    cyber.tokens['--dsw-alias-brand-primary'] !== hacker.tokens['--dsw-alias-brand-primary'],
  true,
)
check(
  'the registered themes cover the same token names',
  JSON.stringify(Object.keys(monokai.tokens).sort()) === JSON.stringify(Object.keys(nord.tokens).sort()) &&
    JSON.stringify(Object.keys(hacker.tokens).sort()) === JSON.stringify(Object.keys(nord.tokens).sort()) &&
    JSON.stringify(Object.keys(cyber.tokens).sort()) === JSON.stringify(Object.keys(nord.tokens).sort()),
  true,
)
// The button wears ONE static appearance mark: it used to paint the active
// preference's own sun/moon, which left a registered theme with nothing to draw.
// A static render answers from `getServerSnapshot` (the service is browser-side),
// so the mark - preference-independent by design - is what the markup can prove;
// the control's STATE is where the registered theme and its words are asserted.
for (const listener of themeEvents) listener({ preference: 'nord', active: nord, themes: themeSnapshot.themes, revision: 11 })
const nordMarkup = renderToStaticMarkup(h(ThemesAction, { t: themesT, themeState: themesFacade.themeState }))
check('the control reads the registered theme', themesFacade.themeState.getSnapshot().themes.some((theme) => theme.id === 'nord'))
check(
  'the control reads the second registered theme',
  themesFacade.themeState.getSnapshot().themes.some((theme) => theme.id === 'monokai'),
)
check(
  'the control reads the third registered theme',
  themesFacade.themeState.getSnapshot().themes.some((theme) => theme.id === 'hacker'),
)
check(
  'the control reads the fourth registered theme',
  themesFacade.themeState.getSnapshot().themes.some((theme) => theme.id === 'cyber'),
)
check('themes button wears the static mark', nordMarkup.includes('M8 2.4A5.6 5.6 0 0 1 8 13.6Z'))
// The menu's entries reach a render as elements, so a glyph is only CREATED,
// never drawn - a theme whose icon function threw would pass every check above
// and break the menu in the browser. The stub Menu keeps the props of the last
// render, so each registered theme's entry is rendered here for real: an svg
// carrying the mark's own geometry, not an empty box. A stand-in state is passed
// because the SERVER snapshot (which a static render uses) carries the shipped
// pair only - the registry is browser-side - so the extension entries would not
// otherwise be in the list at all.
{
  const menuSnapshot = { preference: 'cyber', active: cyber, themes: themeSnapshot.themes, revision: 12 }
  const menuState = {
    subscribe: () => () => {},
    getSnapshot: () => menuSnapshot,
    getServerSnapshot: () => menuSnapshot,
    available: () => true,
    setTheme: () => {},
  }
  renderToStaticMarkup(h(ThemesAction, { t: themesT, themeState: menuState }))
  const entries = lastMenuProps && Array.isArray(lastMenuProps.items) ? lastMenuProps.items : []
  const drawn = (id, marker) => {
    const item = entries.find((entry) => entry.id === id)
    return item === undefined ? false : renderToStaticMarkup(item.icon).includes(marker)
  }
  check(
    'every registered theme has a menu entry',
    entries.filter((entry) => ['nord', 'monokai', 'hacker', 'cyber'].includes(entry.id)).length,
    4,
  )
  check('Nord draws the snowflake', drawn('nord', 'M8 2.6v10.8'), true)
  check('Monokai draws the braces', drawn('monokai', 'M6.5 2.5c-1.5'), true)
  check('Hacker draws the prompt', drawn('hacker', 'M3.2 4.6 6.2 8l-3 3.4'), true)
  check('Cyber draws the chip', drawn('cyber', 'M6.4 2.4v2'), true)
}
// The dictionaries really carry the download copy (the renders below use the
// registered English dictionary, so this is what the app would show).
check('download copy is registered', themeLocales.themes.en['download.title'], 'Download session log')
check('download dialog copy is registered', themeLocales.themes.en['download.errorTitle'], 'Session export failed')

// ------------------------------------------- the Session-log download seat
// The shipped browser half put a three-dot "more actions" button in this same
// header slot whose only menu item was the download. The package's second
// occupant registers the SHIPPED seat id one priority lower (`lowest renders` in
// a list slot), so the ellipsis stops rendering and one download icon button
// takes the seat; the export itself stays the shipped controller's job.
const downloadSpec = themesSeats['conversation.session.header.utilities#session-log-download'].spec
check('download seat shadows the shipped id', downloadSpec.id, 'session-log-download')
check('download seat renders below the shipped one', downloadSpec.priority < 0, true)
check('download seat keeps the shipped order', downloadSpec.order, 0)
const downloadFacade = downloadSpec.inject()
check('download seat follows the shipped store', downloadFacade.hooks.sessionLogDownload === logStore, true)
check('download seat reached the shipped controller', downloadFacade.available, true)
downloadFacade.request('s1')
check('download seat downloads on request', downloadCalls.join(','), 's1')
const DownloadAction = themesSeats['conversation.session.header.utilities#session-log-download'].component
// A renderer-bound stand-in for the Hook the host builds out of the inject face.
const useLog = (selector) => selector(downloadFacade.hooks.sessionLogDownload.getSnapshot())
const renderSeat = () =>
  renderToStaticMarkup(
    h(DownloadAction, {
      sessionId: 's1',
      t: themesT,
      request: downloadFacade.request,
      dismiss: downloadFacade.dismiss,
      available: true,
      useSessionLogDownload: useLog,
    }),
  )
const seatMarkup = renderSeat()
check(
  'download seat renders one download button',
  seatMarkup.includes('class="dst-button"') &&
    seatMarkup.includes('data-dsh-session-log-download') &&
    seatMarkup.includes('aria-label="Download session log"'),
)
check('download seat renders no ellipsis', seatMarkup.includes('aria-haspopup="menu"'), false)
check('download seat is enabled while idle', seatMarkup.includes('disabled'), false)
check('download seat is not busy while idle', seatMarkup.includes('aria-busy="false"'))
check('download seat draws no dialog while idle', seatMarkup.includes('Exporting Session'), false)
// The state machine is the shipped controller's: `downloading` disables the
// button, and the seat's own dialog describes the state.
logEntry = { open: true, status: 'downloading', error: null }
const busySeat = renderSeat()
check('download seat reports the export in flight', busySeat.includes('aria-busy="true"') && busySeat.includes('disabled'))
check('download seat draws the shipped dialog', busySeat.includes('Exporting Session'))
logEntry = { open: true, status: 'success', error: null }
check('download seat draws the success state', renderSeat().includes('Session download started'))
logEntry = { open: true, status: 'error', error: 'HTTP 500' }
check('download seat draws the error state', renderSeat().includes('HTTP 500'))
logEntry = undefined

// ------------------------------------------------------ the screenshot control
// alpha.10: one more occupant of the same list, one order step LEFT of the
// Themes control. It captures the tab with `getDisplayMedia` and hands the PNG
// to the package's host route (the browser download is the fallback), so the
// static checks here are about the seat, the dress and the copy - the capture
// itself needs a real browser surface.
const shotSpec = themesSeats['conversation.session.header.utilities#dsh-themes-screenshot'].spec
check('screenshot seat id', shotSpec.id, 'dsh-themes-screenshot')
check('screenshot sits left of the theme control', shotSpec.order < themesSpec.order, true)
check('screenshot shares the header locale namespace', shotSpec.locale, 'themes')
const ScreenshotAction = themesSeats['conversation.session.header.utilities#dsh-themes-screenshot'].component
const shotMarkup = renderToStaticMarkup(h(ScreenshotAction, { t: themesT }))
check('screenshot button renders', shotMarkup.includes('class="dst-button"') && shotMarkup.includes('data-dsh-screenshot'))
check('screenshot button is labelled', shotMarkup.includes('aria-label="Screenshot to the Desktop"'))
check('screenshot button is idle at rest', shotMarkup.includes('aria-busy="false"') && shotMarkup.includes('disabled'), false)
check('screenshot button opens no menu', shotMarkup.includes('aria-haspopup="menu"'), false)
check('screenshot button draws no toast at rest', shotMarkup.includes('Screenshot saved'), false)
check('screenshot copy is registered', themeLocales.themes.en['screenshot.title'], 'Screenshot to the Desktop')
check(
  'screenshot copy carries the saved path',
  themeLocales.themes.en['screenshot.saved'].includes('{path}') && themeLocales.themes.zh['screenshot.saved'].includes('{path}'),
)

// ------------------------------------------------------ the page-zoom control
// alpha.15: the fourth occupant of the same list, one more order step LEFT. It
// is the pack's own PAGE ZOOM - `zoom` on the document element, Chrome's own
// ladder, the level remembered in localStorage - because the keyboard gesture it
// mirrors (Ctrl+ / Ctrl-) belongs to the browser, and the desktop launcher's
// native window (a Tauri shell over the same `dsh web`) has none. The stepping
// is driven through the Menu's own props, which the stand-in records, and the
// document element it writes is the fake one.
const zoomSpec = themesSeats['conversation.session.header.utilities#dsh-themes-zoom'].spec
check('zoom seat id', zoomSpec.id, 'dsh-themes-zoom')
check('zoom sits left of the capture control', zoomSpec.order < shotSpec.order, true)
check('zoom shares the header locale namespace', zoomSpec.locale, 'themes')
const ZoomAction = themesSeats['conversation.session.header.utilities#dsh-themes-zoom'].component
const zoomRoot = themes.document.documentElement
const ZOOM_STORE = 'dsh-themes.page-zoom'
themes.storage.removeItem(ZOOM_STORE)
const zoomMarkup = renderToStaticMarkup(h(ZoomAction, { t: themesT }))
check('zoom button renders', zoomMarkup.includes('class="dst-button"') && zoomMarkup.includes('data-dsh-page-zoom="100"'))
check('zoom button opens a menu', zoomMarkup.includes('aria-haspopup="menu"'))
check('zoom button is labelled with its level', zoomMarkup.includes('aria-label="Page zoom: 100%"'))
check('zoom button draws the magnifier', zoomMarkup.includes('M10.1 10.1 14.3 14.3'))
check('zoom writes no declaration at rest', zoomRoot.style.zoom === undefined)
check('zoom btn sits left of the theme btn', zoomSpec.order < themesSpec.order, true)
check(
  'zoom menu holds the level and two steps',
  lastMenuProps.items.map((item) => item.id).join(','),
  'zoom-level,zoom-in,zoom-out',
)
check('zoom menu names the level', lastMenuProps.items[0].text, 'Current 100%')
check(
  'zoom menu labels the two steps',
  lastMenuProps.items[1].label + '/' + lastMenuProps.items[2].label,
  'Zoom in/Zoom out',
)
check(
  'the steps are live in the middle of the ladder',
  lastMenuProps.items[1].disabled === false && lastMenuProps.items[2].disabled === false,
)
check('zoom menu asks for no selection pill', lastMenuProps.selectedId === undefined)
// One step, the way a reader takes it: render (which reads the remembered
// level), then select from THAT render. The ladder is Chrome's own, the
// declaration is one inline `zoom` on <html>, and the level is remembered.
/** The level the button is showing, read out of its own markup. */
function zoomLevel() {
  const markup = renderToStaticMarkup(h(ZoomAction, { t: themesT }))
  const found = /data-dsh-page-zoom="(\d+)"/.exec(markup)
  return found === null ? null : Number(found[1])
}
function zoomStep(id) {
  zoomLevel()
  lastMenuProps.onSelect(id)
}
zoomStep('zoom-in')
check('zoom in paints the document element', zoomRoot.style.zoom, '1.1')
check('zoom in marks the document element', zoomRoot.getAttribute('data-dsh-page-zoomed'), '')
check('zoom in remembers the level', themes.storage.getItem(ZOOM_STORE), '110')
check('zoom button reports the new level', zoomLevel(), 110)
zoomStep('zoom-in')
check('a second step reaches 125%', zoomRoot.style.zoom, '1.25')
zoomStep('zoom-out')
// Back to the resting level: the DECLARATION IS REMOVED rather than written as
// `zoom:1`, so a page nobody has zoomed keeps the style attribute the harness
// shipped. The marker goes with it (alpha.16): the seam override is gated on
// that attribute, so its absence is what makes the override inert at 100%.
zoomStep('zoom-out')
check('the resting level removes the declaration', zoomRoot.style.zoom === undefined)
check('the resting level clears the marker', zoomRoot.getAttribute('data-dsh-page-zoomed'), null)
check('the resting level is remembered', themes.storage.getItem(ZOOM_STORE), '100')
for (let step = 0; step < 5; step += 1) zoomStep('zoom-out')
check('the bottom of the ladder is 50%', zoomRoot.style.zoom, '0.5')
zoomStep('zoom-out')
check('the bottom of the ladder is the clamp', zoomLevel(), 50)
check('the clamp greys out the step that cannot move', lastMenuProps.items[2].disabled === true && lastMenuProps.items[1].disabled === false)
themes.storage.setItem(ZOOM_STORE, '200')
zoomStep('zoom-in')
check('the top of the ladder is the clamp', zoomLevel(), 200)
check('the top greys out Zoom in only', lastMenuProps.items[1].disabled === true && lastMenuProps.items[2].disabled === false)
// A level that is not on the ladder (nothing this control writes) is refused
// rather than applied: the button reads the resting level instead.
themes.storage.setItem(ZOOM_STORE, '123')
check('an off-ladder stored level is ignored', zoomLevel(), 100)
themes.storage.removeItem(ZOOM_STORE)
check('zoom copy is registered', themeLocales.themes.en['zoom.in'], 'Zoom in')
check('zoom copy is in both dictionaries', themeLocales.themes.zh['zoom.in'], '放大')
check(
  'zoom labels carry the level',
  themeLocales.themes.en['zoom.current'].includes('{percent}') && themeLocales.themes.zh['zoom.level'].includes('{percent}'),
)
// The two zoom dictionaries describe the same control: a key in one and not the
// other is copy the interface would render as a raw key.
check(
  'the zoom copy agrees across languages',
  JSON.stringify(Object.keys(themeLocales.themes.en).filter((key) => key.startsWith('zoom.')).sort()) ===
    JSON.stringify(Object.keys(themeLocales.themes.zh).filter((key) => key.startsWith('zoom.')).sort()),
)

// A profile that never mounts ui-theme: the control still renders (disabled,
// with its own copy) instead of taking the header down.
const bareSeats = {}
themes.exports.apply({
  get: () => undefined,
  on: () => () => {},
  slots: {
    inject: (name, fn) => fn(),
    register(spec, component) {
      bareSeats[spec.name + '#' + spec.id] = { spec, component }
      return () => {}
    },
  },
  locale: { register: () => () => {} },
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
const bareState = bareSeats['conversation.session.header.utilities#dsh-themes'].spec.inject().themeState
const bareMarkup = renderToStaticMarkup(h(bareSeats['conversation.session.header.utilities#dsh-themes'].component, { t: themesT, themeState: bareState }))
check('themes survives a missing service', bareMarkup.includes('disabled') && bareMarkup.includes('aria-haspopup="menu"'))
check('themes reports the missing service', bareMarkup.includes('The theme service is unavailable'))
let refused = false
try {
  bareState.setTheme('dark')
} catch (err) {
  refused = true
}
check('themes refuses to write without the service', refused)
// A profile without the shipped export row: the button says so instead of
// pretending, and the Hook still reads a real (constant) source.
const bareDownload = bareSeats['conversation.session.header.utilities#session-log-download'].spec.inject()
check('download seat reports a missing export service', bareDownload.available, false)
check('download seat survives a missing service', typeof bareDownload.hooks.sessionLogDownload.subscribe, 'function')
let bareThrew = false
try {
  bareDownload.request('s1')
} catch (err) {
  bareThrew = true
}
check('download seat requests nothing without the service', bareThrew, false)
const bareSeatMarkup = renderToStaticMarkup(
  h(bareSeats['conversation.session.header.utilities#session-log-download'].component, {
    sessionId: 's1',
    t: themesT,
    request: bareDownload.request,
    dismiss: bareDownload.dismiss,
    available: false,
    useSessionLogDownload: (selector) => selector(bareDownload.hooks.sessionLogDownload.getSnapshot()),
  }),
)
check('download seat disables the button without the service', bareSeatMarkup.includes('disabled'))
check('download seat says the export is unavailable', bareSeatMarkup.includes('Session export is unavailable'))

// The Markdown paper: it copies ui-theme's own LIGHT declarations onto the
// rendered Markdown root. Fake stylesheets in the shape the CSSOM exposes.
function fakeStyle(pairs) {
  const values = {}
  const style = {
    length: pairs.length,
    getPropertyValue: (name) => (Object.prototype.hasOwnProperty.call(values, name) ? values[name] : ''),
  }
  pairs.forEach(([name, value], index) => {
    values[name] = value
    style[index] = name
  })
  return style
}
themes.document.styleSheets = [
  {
    ownerNode: { dataset: { pluginCss: '@deepseek-ai/dsh-client-ui-theme/design-platform.css' } },
    cssRules: [
      {
        selectorText: 'body',
        style: fakeStyle([
          ['--dsw-static-neutral-bluish-900', '#151517'],
          ['--dsw-alias-label-primary', 'var(--dsw-static-neutral-bluish-900)'],
          ['--dsl-code-block-background', '#f7f7f8'],
        ]),
      },
      { selectorText: 'body[data-ds-dark-theme]', style: fakeStyle([['--dsw-alias-label-primary', '#f5f5f5']]) },
      // An engine that does not enumerate custom properties: text only.
      { selectorText: ':root', cssText: ':root{--shiki-token-keyword:#d6336c;--shiki-token-string:#2f9e44}' },
    ],
  },
  {
    ownerNode: { dataset: { plugin: 'another-plugin' } },
    cssRules: [{ selectorText: 'body', style: fakeStyle([['--dsw-alias-label-primary', '#ff00ff']]) }],
  },
]
themes.exports.apply({
  get: () => undefined,
  on: () => () => {},
  slots: { inject: (name, fn) => fn(), register: () => () => {} },
  locale: { register: () => () => {} },
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
const paperTag = themes.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-themes/markdown-paper.css').pop()
const paper = paperTag ? paperTag.textContent : ''
check('paper rule injected', paper.includes('background:#fff') && paper.includes('data-document-markdown'))
check('paper also paints the scrollport', paper.includes('[data-textpreview-body]:has([data-document-markdown])'))
check('paper copies the light aliases', paper.includes('--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-900)'))
check('paper copies the light statics', paper.includes('--dsw-static-neutral-bluish-900:#151517'))
check('paper copies the light shiki tokens', paper.includes('--shiki-token-keyword:#d6336c'))
check('paper reads a text-only rule too', paper.includes('--shiki-token-string:#2f9e44'))
check('paper copies other light sheets', paper.includes('--dsl-code-block-background:#f7f7f8'))
check('paper skips the dark palette', paper.includes('#f5f5f5'), false)
check('paper skips other plugins', paper.includes('#ff00ff'), false)

// The Markdown chrome override (alpha.3): its own tag, independent of the paper.
const chromeTag = themes.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-themes/markdown-chrome.css').pop()
const chrome = chromeTag ? chromeTag.textContent : ''
check('chrome rule injected', chrome.includes('[data-document-viewer-menu]{display:none}'))
check('chrome scoped to markdown', chrome.includes('body [data-document-preview="@deepseek-ai/dsh-client-ui-sidebar-documentpreview/markdown"]'))

// The left column's top bar override (alpha.4, centred on the top row since
// alpha.27): its own tag again. The band is the row's whole 76px from the
// frame's top edge - the sidebar's own 6px top padding is folded into it, so the
// 76px hairline the conversation header and the right column's tab header
// already draw does not move - and the row's 30px content strip is centred on
// the frame's y=20, the middle of the top row above the y=40 mid-band line, in
// both the wide row and the rail.
const topBarTag = themes.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-themes/left-topbar.css').pop()
const topBar = topBarTag ? topBarTag.textContent : ''
check('top bar rule injected', topBar.includes('height:76px'))
check('the band starts at the frame\'s top edge', topBar.includes(':not([data-windows-titlebar]) .hHd-Xa_root{padding-top:0}'))
check('the row\'s content is centred on the frame\'s y=20', topBar.includes('padding:5px 12px 40.5px 16px'))
check('top bar bleeds to both edges', topBar.includes('margin:0 -12px'))
check('top bar clears New session', topBar.includes('margin:0 -12px 8px'))
check('top bar draws the header hairline', topBar.includes('border-bottom:.5px solid var(--dsw-alias-border-l3'))
check('top bar centres the rail\'s 36px square too', topBar.includes('.hHd-Xa_root.hHd-Xa_collapsed .hHd-Xa_logoRow{margin:0 -10px 12px;padding:2px 10px 37.5px}'))
check('top bar is engine-neutral', topBar.includes(':has('), false)

// The VN branding on that same row (alpha.6). The mark and the name are SLOTS the
// harness's own brand plugin occupies, so the art is hidden whatever the occupant
// is - wordmark, fish, or the layout's own fallback label - and the replacements
// are drawn on top: a plain black disc at the slot's 24px, and the product text.
check(
  'branding hides whatever occupies the brand slots',
  topBar.includes('.hHd-Xa_brandMark>*,html .hHd-Xa_root .hHd-Xa_brandName>*,html .hHd-Xa_root .hHd-Xa_railMark>*{display:none!important}'),
)
// alpha.8: the mark is the app ICON - `assets/vncode.svg` at the pack root -
// inlined as a data URI. The artwork carries a 1px transparent margin inside its
// 24px box, because the mark sits in boxes painted with `overflow:hidden` (the
// sidebar's brand button is exactly 24px tall) where an edge-to-edge circle loses
// a fraction of a pixel on each side, which is what alpha.7's disc looked like.
// The comparison below is against that asset, so the inlined copy cannot drift.
const iconMatch = /background:url\("data:image\/svg\+xml,([^"]+)"\)/.exec(topBar)
const inlinedIcon = iconMatch === null ? '' : decodeURIComponent(iconMatch[1])
const iconGeometry = (svg) => {
  const box = /viewBox="([^"]+)"/.exec(svg)
  const circle = /<circle[^>]*cx="([^"]+)"[^>]*cy="([^"]+)"[^>]*r="([^"]+)"[^>]*fill="([^"]+)"/.exec(svg)
  if (box === null || circle === null) return null
  return { box: box[1], cx: Number(circle[1]), cy: Number(circle[2]), r: Number(circle[3]), fill: circle[4] }
}
const assetIcon = iconGeometry(readFileSync(path.join(repo, 'assets/vncode.svg'), 'utf8'))
const shippedIcon = iconGeometry(inlinedIcon)
console.log('     icon inlined from the asset: ' + JSON.stringify(shippedIcon))
check('branding inlines the app icon', shippedIcon !== null)
check('the inlined icon matches assets/vncode.svg', JSON.stringify(shippedIcon) === JSON.stringify(assetIcon))
check('the icon is a circle centred in its box', shippedIcon !== null && shippedIcon.cx * 2 === 24 && shippedIcon.cy * 2 === 24)
check('the icon keeps a margin inside its box', shippedIcon !== null && shippedIcon.r < 12)
check('the icon is black', shippedIcon !== null && shippedIcon.fill === '#000000')
check('the mark draws the icon at 24px', topBar.includes('.hHd-Xa_brandMark::before,html .hHd-Xa_root .hHd-Xa_railMark::before{content:"";width:24px;height:24px'))
check('the icon is not stretched', topBar.includes('center/contain no-repeat'))
// The empty conversation's hero ("Into the Unknown") draws the same whale from its
// own single slot, so it gets the same treatment.
check(
  'the hero whale is replaced by the icon',
  topBar.includes('.pXSMma_fishHitbox>*{display:none!important}') && topBar.includes('.pXSMma_fishHitbox::before{content:"";width:26px;height:26px'),
)
check('branding draws the product name', topBar.includes('.hHd-Xa_brandName::before{content:"vncode"}'))
// The product text wears the conversation TITLE's type: ui-conversation's current
// crumb is 14px/20px at weight 500, while the shipped brand name is 18px/600 in
// the same 30px strip - they read as different sizes a few pixels apart.
check(
  'branding wears the chat title\'s type',
  topBar.includes('.hHd-Xa_brandName{font-size:14px;font-weight:500;line-height:20px;letter-spacing:0}'),
)
check('branding covers the collapsed rail too', topBar.includes('.hHd-Xa_railMark::before'))
// alpha.25: the left column's half of the MID-BAND line. The row now starts at
// the frame's top edge (alpha.27 folded the root's own 6px top padding into the
// row's 76px height), so a rule 40px into that row is the
// frame's y=40 - the y the conversation header's own new line sits at, which is
// the only reason the number is 40. It is the band's own `.5px` border on a
// zero-height pseudo (so it weighs what the band's bottom hairline weighs and
// costs no layout), and it is drawn in the WIDE column only: the rail's icon
// button is a 36px square (`.hHd-Xa_collapsed .hHd-Xa_iconButton`) that fills
// its whole 36px strip, y=2..38, so a line at 40 would cross it.
check(
  'the branding row carries the mid-band line',
  topBar.includes('.hHd-Xa_root:not(.hHd-Xa_collapsed) .hHd-Xa_logoRow::after{content:"";position:absolute;left:0;right:0;top:40px;height:0'),
)
check(
  'the mid-band line is the band hairline, not a new colour',
  topBar.includes('border-top:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18));pointer-events:none}'),
)
check('the branding row is the line\'s positioning context', topBar.includes('.hHd-Xa_logoRow{position:relative;height:76px'))
check('the rail is left out of the mid-band line', topBar.includes(':not(.hHd-Xa_collapsed) .hHd-Xa_logoRow::after'))

// alpha.25: the band's second hairline, and alpha.27: the centre of the 40px top
// row that line creates. The middle column's line is drawn by the tabs row:
// `margin-top:0` plus `padding-top:10px` is exactly the 10px of space that
// margin was, so the tab text does not move by a pixel, and the line itself is a
// `.5px` border on a zero-height pseudo - the band's own weight, and no layout at
// all (a `border-top` on the row would have made the header 76.5px and pushed
// everything below it down half a pixel, measured in a real browser). The
// negative inline margins - against the header's own 20px and 28px padding - run
// the line to both column edges like the band's own. The band's top row is
// therefore the frame's y=0..40, and the three columns' furniture in it is
// centred on its middle, y=20: the middle column's title row takes the header's
// own 10px of `padding-top` and grows to 40px (the sessionless header, whose
// empty title row IS that padding, is scoped out of both rules), and the right
// bar's dock strip carries the 4px it needs below its chips as `padding-bottom`
// while `[data-dockkit-strip]` - the dock's own marker on that box - keeps its
// 38px total, so the tab body below it and the y=40 line on that body do not
// move. The right bar's Start tab (the shipped guide) is the one tab whose body
// has no tool bar: this gives it the same 38px bar every other tab draws, with
// the same `.5px` border on the pseudo whose containing block starts at the
// transparent border's bottom edge - y=76, where every other tab's tool bar
// draws its own.
const bandTag = themes.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-themes/band-lines.css').pop()
const bandLines = bandTag ? bandTag.textContent : ''
check('band-lines rule injected', bandLines.includes('.wSkVaW_tabs{margin-top:0;'))
check(
  'the header hands its top padding to the title row',
  bandLines.includes('html .wSkVaW_header:not(.wSkVaW_headerSessionless){padding-top:0}'),
)
check(
  'the middle column\'s title row is the whole 40px top row',
  bandLines.includes('.wSkVaW_header:not(.wSkVaW_headerSessionless) .wSkVaW_titleRow{min-height:40px}'),
)
check(
  'the sessionless header keeps its shipped height',
  bandLines.includes('.wSkVaW_headerSessionless){padding-top:0}') &&
    bandLines.includes('.wSkVaW_headerSessionless) .wSkVaW_titleRow{min-height:40px}') &&
    bandLines.match(/\.wSkVaW_header:not\(\.wSkVaW_headerSessionless\)/g).length === 2,
)
check(
  'the dock strip centres its chips on the same y=20',
  bandLines.includes('html [data-dockkit-strip]{padding-top:6px;padding-bottom:4px}'),
)
check('the tabs row does not move when the line arrives', bandLines.includes('padding:10px 28px 0}'))
check(
  'the mid-band line is a .5px border on a zero-height pseudo',
  bandLines.includes('.wSkVaW_tabs::before{content:"";position:absolute;left:0;right:0;top:0;height:0;border-top:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18))}'),
)
check('the mid-band line runs to both column edges', bandLines.includes('margin-left:-20px;margin-right:-28px'))
// alpha.26: the right bar's own mid-band line, at the SAME y=40 the middle and
// left columns' lines sit at, and the surface for the row below it. That band's
// own rows do not divide at 40 - the tab strip is 38px (6px of padding above
// 28px of tab chips, 4px below, since alpha.27) - so the line is drawn 2px into
// the row below the strip, on
// the tab body's own box, which is what spans that row on every tab; the band
// under it then measures 40 + 36 like the other two columns'. The same box is
// given the bar's surface, because the right bar is an OVERLAY: the surface that
// makes it opaque is painted by the forked bar's stylesheet on the dock box, so a
// row the open tab paints nothing on was a real hole (the conversation behind the
// Start tab's empty 38px bar). The token is the one the fork already paints the
// dock with, with the dark palette's own literal as the fallback.
check(
  'the right bar\'s line hangs on the row below the strip',
  bandLines.includes('html .P3OORG_tabBody{position:relative;background:var(--dsw-alias-bg-base,#151517)}'),
)
check(
  'the right bar\'s line sits on the frame\'s y=40, like the other two columns\'',
  bandLines.includes('html .P3OORG_tabBody::before{content:"";position:absolute;left:0;right:0;top:2px;height:0;border-top:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18))}'),
)
check(
  'the row below the strip is the bar\'s own surface',
  bandLines.includes('background:var(--dsw-alias-bg-base,#151517)}'),
)
// The strip is only ever given padding (alpha.27, to centre its chips): the line
// itself hangs on the tab body below it, never on the strip, whose own edge is
// 2px above the frame's y=40.
check('the strip carries padding, not the line', bandLines.includes('[data-dockkit-strip]{padding-top:6px;padding-bottom:4px}'))
check('no hairline hangs on the strip', /\[data-dockkit-strip\][^{]*\{[^}]*border/.test(bandLines), false)
check(
  'the Start tab\'s bar is that surface, not a hole',
  bandLines.includes('.geFEbW_guide{position:relative;border-top:38px solid var(--dsw-alias-bg-base,#151517)}'),
)
check(
  'the Start tab gets the bar it was missing',
  bandLines.includes('.P3OORG_tabBody .geFEbW_guide{position:relative;border-top:38px solid'),
)
check(
  'the Start tab\'s line lands where every other tab\'s does',
  bandLines.includes('.geFEbW_guide::before{content:"";position:absolute;left:0;right:0;top:0;height:0;border-top:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18))}'),
)
check('band-lines is engine-neutral', bandLines.includes(':has('), false)
check('band-lines adds no size of its own to the guide', bandLines.includes('height:38px'), false)

// alpha.22: the global panel rows at the column's FOOT. `SidebarRoot` is a flex
// column, so three `order` declarations move the rows without touching the DOM:
// the workspaces/sessions region takes the seat the panel rows vacate (under
// "New Session"), Plugins comes to rest immediately above Settings, and the
// region keeps its `flex:1` so the rows below it stay pinned to the bottom. The
// three values are pinned one by one, so a rule that stops moving a row - or one
// that lands the region BELOW the foot - fails here rather than in the eye.
const orderTag = themes.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-themes/sidebar-order.css').pop()
const panelOrder = orderTag ? orderTag.textContent : ''
check('panel-order rule injected', panelOrder.includes('.hHd-Xa_panelList{order:2}'))
check('the workspaces region takes the panel rows\' seat', panelOrder.includes('.hHd-Xa_regionArea{order:1}'))
check('the foot (Settings) stays last', panelOrder.includes('.hHd-Xa_footArea{order:3}'))
check('panel-order is engine-neutral', panelOrder.includes(':has('), false)
// alpha.23: the two rows now sit side by side at the foot, so they must MEASURE
// the same. The shell draws a panel row 36px tall and the Settings trigger 42px,
// which read as "the Plugins button is smaller"; the rule gives the panel row the
// Settings box - and only while the column is wide, because both collapse to the
// same 36px square in the rail.
check('the panel row wears the Settings row\'s box', panelOrder.includes('.hHd-Xa_panelRow{height:42px;min-height:42px'))
check(
  'and only while the column is wide',
  panelOrder.includes(':not(.hHd-Xa_collapsed) .hHd-Xa_panelList .hHd-Xa_panelRow'),
)

// alpha.9: the header's icon-button RING. The pack's own header buttons draw it
// themselves, so this package's copy is pinned here; the shipped right-bar toggle
// in the header corner cannot (it lives in a GENERATED fork), so one rule keyed
// on the header's stable corner marker gives it the same outline. The marker is
// asserted to be a `data-` attribute rather than the hashed class names the top
// bar above is pinned to on purpose.
const themesCssTag = themes.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-themes/themes.css').pop()
const themesCss = themesCssTag ? themesCssTag.textContent : ''
check(
  'theme button wears the header ring',
  themesCss.includes('.dst-button{width:28px;height:28px;box-sizing:border-box;') &&
    themesCss.includes('border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:28px'),
)
// alpha.11: the captured frame is the interface as it stands, so the pack's own
// controls STAY in it (alpha.10 hid them, which left a hole in the record). The
// ONE thing left out of the frame is the open tooltip bubble, and that rule is
// keyed on the shipped Tooltip's own semantic `role="tooltip"` marker - never a
// hashed class, and never one of the pack's own class names.
check(
  'capture rule keeps the pack controls in the shot',
  themesCss.includes('html[data-dsh-screenshot] [role=tooltip]{visibility:hidden}') &&
    themesCss.includes('html[data-dsh-screenshot] .dst-button') === false &&
    themesCss.includes('html[data-dsh-screenshot] .dst-slot') === false,
)
// And the button that starts the capture closes its OWN tooltip for the frame,
// through the shipped Tooltip's `disabled` prop (its close-and-stay-closed
// switch), so the bubble is gone rather than merely invisible.
const themesSource = readFileSync(path.join(repo, 'packages/dsh-themes/lib/client.js'), 'utf8')
// The MENU is the registry's own list, not a copy of it: the control iterates
// `snapshot.themes` and appends the `system` preference last, so the shipped
// trio keeps its places and a registered theme lands between Dark and System.
check(
  'the menu is built from the registry',
  themesSource.includes('Array.isArray(snapshot.themes)') && themesSource.includes('ids.map(themeMeta)'),
)
check('the menu keeps system last', themesSource.includes("concat([themeMeta('system')])"))
check('the button names the active theme', themesSource.includes('const active = themeMeta(preference)'))
check(
  'the button no longer picks a per-preference glyph',
  themesSource.includes('const Glyph = entry.Icon') === false && themesSource.includes("h(IconThemeOutline16, { size: 16 })"),
)
check(
  'the clicked button closes its own tooltip while it captures',
  themesSource.includes("{ label: label, side: 'bottom', delayMs: 500, disabled: busy }"),
)
// The zoom ladder is Chrome's own rungs CUT AT BOTH ENDS, and the cut is the
// point: the control lives inside the page it zooms, so a rung high enough to
// push the header's utilities row past the (shrunken) layout viewport would hide
// the only way back down - measured on the real shell, where 300% still fits and
// 400% does not. A later edit that widens it fails here and has to argue.
check(
  'the zoom ladder is Chrome\'s rungs cut at 50 and 200',
  themesSource.includes('const ZOOM_STEPS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200]'),
)
check(
  'the resting level unsets the declaration',
  themesSource.includes("root.style.removeProperty('zoom')") && themesSource.includes("root.style.setProperty('zoom', String(percent / 100))"),
)
const ringTag = themes.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-themes/header-ring.css').pop()
const headerRing = ringTag ? ringTag.textContent : ''
check('header ring rule injected', headerRing.includes('html [data-conversation-header-corner] button{'))
check('header ring uses the same hairline', headerRing.includes('border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3))'))
check('header ring keeps the box 28px', headerRing.includes('border-radius:28px;box-sizing:border-box'))
check('header ring keys on a stable marker', headerRing.includes('_root') === false && headerRing.includes('.P3OORG_') === false)
// The right bar's outer resize seam under a page zoom (alpha.16). A root `zoom`
// scales the rect the frame measures its columns from while the seam's `left` is
// layout pixels, so with a level in force the seam slid off the right column's
// edge and the bar could not be dragged - measured in the desktop window at 80%,
// where it sat 288px away. The override places it from the LAYOUT instead, and
// the two things that make that safe are pinned here: it is GATED on the marker
// a live zoom writes (so a page at 100% keeps the frame's own inline `left`), and
// it keys on ui-layout's stable `data-rightbar-col` marker rather than a hashed
// class, so a harness bump cannot turn it into a rule that silently matches
// nothing while still looking right.
const seamTag = themes.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-themes/zoom-seam.css').pop()
const zoomSeam = seamTag ? seamTag.textContent : ''
check('zoom seam rule injected', zoomSeam.includes('[data-rightbar-col]{anchor-name:--dsh-themes-rightbar-seam}'))
check(
  'the seam is placed at the anchor, beating the inline left',
  zoomSeam.includes('[data-rightbar-col]~[data-side="rightbar"]{left:anchor(--dsh-themes-rightbar-seam left)!important}'),
)
check(
  'the seam override is inert at the resting level',
  zoomSeam.split('html[data-dsh-page-zoomed]').length - 1 === 4 && zoomSeam.replace(/html\[data-dsh-page-zoomed\]/g, '').includes('html[') === false,
)
check('the seam keys on a stable marker', zoomSeam.includes('_handle') === false && zoomSeam.includes('pI_x6G') === false)
// alpha.22, the SAME zoom fact one box over: the fullscreen panel's width. The
// fork sizes it with an inline `width:100vw`, and a viewport LENGTH is not
// zoom-adjusted (only `auto`/percentages are exempt from the `zoom` multiplier),
// so at the 90% this machine runs the panel painted at 90% of the app viewport
// and - anchored `right:0` - left a 10% strip of the left bar uncovered. The
// repair gives it a PERCENTAGE of the frame instead: with the column static
// while a fullscreen panel exists, the panel's containing block is the frame,
// the one box that IS the whole viewport at any zoom. Three things are pinned:
// the percentage (which must beat the inline width), the containment change it
// depends on, and that the change is scoped to FULLSCREEN - a blanket
// `[data-rightbar-col]{position:static}` would also move the push-mode panel out
// of the column that dsh-cmdbar shortens while the command dock is open.
check(
  'the fullscreen panel sizes against the frame, not the viewport',
  zoomSeam.includes('[data-rightbar-col]:has([data-sidebar-right-panel=fullscreen]){position:static}'),
)
check(
  'the fullscreen panel width is a percentage, beating the inline 100vw',
  zoomSeam.includes('[data-sidebar-right-panel=fullscreen]{width:100%!important}'),
)
check(
  'the push-mode panel keeps its containing block',
  zoomSeam.includes('[data-rightbar-col]{position:static}') === false,
)
// The account menu's shipped **Feedback** row (alpha.21). vncode does not ask
// its users for feedback, and that one row is the only control in the app that
// opens an EXTERNAL form in a new window - the Feishu questionnaire
// @deepseek-ai/dsh-client-ui-settings-account's `contactUrl()` builds with the
// uid, the locale, the harness version and the device info attached. There is no
// row to disable (the item is hardcoded in that package's AccountMenu), so the
// row is hidden by one rule. What is pinned here is that the rule keys on the
// ICON's path data rather than on a hashed class (a rebuild renames the classes
// and leaves the artwork alone), that it hides the row in BOTH the shape the
// primitive renders today and the bare-button shape it would fall back to, and
// that it is scoped to a menu row - the same paper-plane artwork is also drawn by
// the chat's turn-trigger notice and by the Session-export header button, and
// hiding either of those would be a real regression.
const accountTag = themes.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-themes/account-menu.css').pop()
const accountMenu = accountTag ? accountTag.textContent : ''
check('account menu override injected', accountTag !== undefined)
check(
  'account menu: the Feedback row is hidden in both shapes',
  accountMenu.includes('[role="menu"]>div:has(>button[role="menuitem"] svg path[d^="M4.74024 9.11029"]){display:none}') &&
    accountMenu.includes('[role="menu"] button[role="menuitem"]:has(svg path[d^="M4.74024 9.11029"]){display:none}'),
)
check(
  'account menu: the rule is scoped to a menu row, never to the artwork alone',
  (accountMenu.match(/\[role="menu"\]/g) || []).length === 2 && accountMenu.includes('[role="menuitem"]'),
)
check(
  'account menu: the rule pins no hashed class',
  /[._][A-Za-z0-9]{5,}_/.test(accountMenu) === false && accountMenu.includes('data-menu-item') === false,
)

// --------------------------------------------------------------- dsh-gittree
const gitTree = loadBundle('packages/dsh-gittree/lib/client.js', {})
const gitCssTag = gitTree.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-gittree/gittree.css').pop()
const gitCss = gitCssTag ? gitCssTag.textContent : ''
check('gittree bundle id', gitTree.id, 'dsh-gittree')
check('gittree inject', JSON.stringify(gitTree.exports.inject), '["slots","sidebarRightTabs"]')
check('gittree stylesheet injected', gitCss.includes('.dsg-root{') && gitCss.includes('.dsg-badge[data-st="m"]'))
// The tools bar is the History tab's own top bar (alpha.4), the same 38px
// border-box pane header the Files tab, the document preview and the editor use,
// so all four hairlines sit on the y=76 line the other columns draw.
check(
  'gittree top bar is the 38px pane header',
  gitCss.includes('.dsg-tools{flex:none;display:flex;align-items:center;gap:6px;box-sizing:border-box;height:38px;padding:0 10px 0 12px;') &&
    gitCss.includes('.dsg-btn{flex:none;display:inline-flex;align-items:center;height:24px;'),
)
const gitTypes = []
const gitSeats = {}
const gitTabTypes = { register: (definition) => (gitTypes.push(definition), () => {}), entries: () => [] }
gitTree.exports.apply({
  slots: {
    inject: (name, fn) => fn(),
    register(spec, component) {
      gitSeats[spec.name + (spec.key ? '#' + spec.key : '')] = { spec, component }
      return () => {}
    },
  },
  sidebarRightTabs: gitTabTypes,
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
check('gittree type registered', gitTypes.length === 1 && gitTypes[0].id + '/' + gitTypes[0].kind, 'dsh-gittree/gittree')
// A page type: no `patterns`, so it never competes for a file address.
check('gittree is a page type', gitTypes[0].patterns === undefined)
check('gittree chip title', gitTypes[0].title('sidebar://gittree'), 'History')
check('gittree guide entry', gitTypes[0].guide.map((entry) => entry.order + ':' + entry.title()).join(','), '30:History')
check(
  'gittree seats',
  Object.keys(gitSeats).sort().join(','),
  'sidebar.right.pane.tab#dsh-gittree,sidebar.right.pane.tab.title#dsh-gittree',
)
const GitTreeBody = gitSeats['sidebar.right.pane.tab#dsh-gittree'].component
const gitTab = { id: 'tab9', contentId: 'sidebar://gittree', title: 'History', navigation: { revision: 0 } }
const gitMarkup = renderToStaticMarkup(h(GitTreeBody, { useTabInfo: () => ({ tab: gitTab }), sessionId: 's1' }))
check('gittree body renders', gitMarkup.includes('data-gittree-tab="tab9"') && gitMarkup.includes('data-gittree-state="loading"'))
// Derived, never a literal: the pack-wide check at the end of this file compares
// every bundle's constant with its own package.json, and a literal here would only
// go stale on the next version bump.
const gitTreeVersion = JSON.parse(readFileSync(path.join(repo, 'packages/dsh-gittree/package.json'), 'utf8')).version
check(
  'gittree body is history-only',
  gitMarkup.includes('data-gittree-reload') &&
    gitMarkup.includes('data-gittree-address="sidebar://gittree"') &&
    gitMarkup.includes('dsh-gittree ' + gitTreeVersion),
)
check(
  'gittree has no file-tree view',
  gitMarkup.includes('data-gittree-view') === false &&
    gitMarkup.includes('data-gittree-filter') === false &&
    gitMarkup.includes('data-gittree-changed') === false,
)
check(
  'gittree title seat draws the chip',
  renderToStaticMarkup(h(gitSeats['sidebar.right.pane.tab.title#dsh-gittree'].component, {})),
  '<span class="dsg-title">History</span>',
)

// ------------------------------------------------ dsh-gittree: the commit rail
// alpha.5 draws the graph. Its arithmetic is the half a markup check cannot see,
// so the bundle hands its pure half over as `__internals` and the layout is
// driven directly - and the ONE coupling that can silently rot (the CSS row box
// the rail's node height is derived from) is read back out of the stylesheet.
const gitSource = readFileSync(path.join(repo, 'packages/dsh-gittree/lib/client.js'), 'utf8')
const gitInternals = gitTree.exports.__internals
check(
  'gittree rail styles are injected',
  gitCss.includes('.dsg-rail{position:absolute;left:0;top:0;bottom:0;') &&
    gitCss.includes('.dsg-lane{position:absolute;width:1.5px;') &&
    gitCss.includes('.dsg-elbow{position:absolute;box-sizing:border-box}') &&
    gitCss.includes('.dsg-node{position:absolute;'),
)
const gitRowHeight = /\.dsg-commitRow\{[^}]*?height:(\d+)px/.exec(gitCss)
check('gittree row box is the rail height', gitRowHeight === null ? null : Number(gitRowHeight[1]), gitInternals.ROW_HEIGHT)
check('gittree node sits on the row centre', gitInternals.NODE_Y * 2, gitInternals.ROW_HEIGHT)
check(
  'gittree lane geometry',
  [gitInternals.laneX(0, 2), gitInternals.laneX(1, 2), gitInternals.railWidth(2), gitInternals.railWidth(6), gitInternals.laneColour(5)].join(','),
  [9, 21, 30, 63, 'var(--dsg-lane-0)'].join(','),
)
check(
  'gittree rail measures nothing',
  gitSource.includes('new ResizeObserver(') === false && gitSource.includes('getBoundingClientRect(') === false,
)
// A straight line: one lane, every commit on it, and nothing else to draw.
const gitChain = [
  { sha: 'a'.repeat(40), subject: 'third', parents: ['b'.repeat(40)] },
  { sha: 'b'.repeat(40), subject: 'second', parents: ['c'.repeat(40)] },
  { sha: 'c'.repeat(40), subject: 'first', parents: [] },
]
const gitChainGraph = gitInternals.graphLayout(gitChain)
check('gittree: a linear history is one lane', [gitChainGraph.laneCount, gitChainGraph.rows.map((row) => row.lane).join('')].join('/'), '1/000')
check(
  'gittree: the line runs through every row',
  gitChainGraph.rows.map((row) => (row.entering[0] === null ? '.' : 'i') + (row.leaving[0] === null ? '.' : 'o')).join(' '),
  'io io i.',
)
// A MERGE: the merge commit opens a second lane, the branch's own commit keeps it,
// and the lane collapses back into the node of the commit both parents descend
// from. That collapse is the curve the rail draws beside that row.
const gitMerged = [
  { sha: 'm'.repeat(40), subject: 'Merge pull request #12 from ana/branch', parents: ['a'.repeat(40), 'f'.repeat(40)], refs: ['HEAD -> main'] },
  { sha: 'a'.repeat(40), subject: 'third', parents: ['b'.repeat(40)], refs: [] },
  { sha: 'f'.repeat(40), subject: 'Add the thing (#12)', parents: ['b'.repeat(40)], refs: ['feature'] },
  { sha: 'b'.repeat(40), subject: 'first', parents: [], refs: [] },
]
const gitMergeGraph = gitInternals.graphLayout(gitMerged)
check('gittree: a merge opens a second lane', [gitMergeGraph.laneCount, gitMergeGraph.rows.map((row) => row.lane).join('')].join('/'), '2/0010')
check(
  'gittree: the merge edges to both parents',
  gitMergeGraph.rows[0].edges.map((edge) => edge.lane + ':' + edge.kind).join(','),
  '0:first,1:merge',
)
check('gittree: the branch lane collapses at the shared parent', gitMergeGraph.rows[3].collapsed.join(','), '1')
// A parent the page does not carry (the log's own limit, or a workspace-scoped
// log) ends the lane instead of inventing a commit for it.
const gitScoped = gitInternals.graphLayout([
  { sha: 'x'.repeat(40), subject: 'tip', parents: ['y'.repeat(40)] },
  { sha: 'y'.repeat(40), subject: 'cut', parents: ['z'.repeat(40)] },
])
check('gittree: a parent outside the page ends the lane', gitScoped.rows[1].leaving[0], null)
// A hard refresh against a Node half that has NOT been restarted answers without
// `parents` at all (the field arrived with the rail). Drawing that as all-roots
// would be a rail of disconnected stubs, so the list's own order stands in - and a
// host that does carry the field is never second-guessed.
check(
  'gittree: an un-restarted host still draws a connected line',
  JSON.stringify(gitInternals.withParents([{ sha: 'b' }, { sha: 'a' }]).map((commit) => commit.parents)),
  '[["a"],[]]',
)
check(
  'gittree: a host that carries the parents keeps them',
  JSON.stringify(gitInternals.withParents([{ sha: 'b', parents: ['z'] }, { sha: 'a', parents: [] }]).map((commit) => commit.parents)),
  '[["z"],[]]',
)
check('gittree: a pull request is read from a merge subject', JSON.stringify(gitInternals.pullRequestOf(gitMerged[0])), '{"number":"12","source":"subject"}')
check('gittree: a pull request is read from a squash subject', JSON.stringify(gitInternals.pullRequestOf(gitMerged[2])), '{"number":"12","source":"subject"}')
check('gittree: a pull request is read from a fetched ref', gitInternals.pullRequestOf({ subject: 'x', refs: ['refs/pull/31/head'] }).number, '31')
check('gittree: an ordinary commit names no pull request', gitInternals.pullRequestOf(gitMerged[1]), null)
check(
  'gittree: ref chips put HEAD first and collapse the rest',
  JSON.stringify(gitInternals.refChips({ refs: ['HEAD -> main', 'origin/main', 'feature'] })),
  JSON.stringify([
    { kind: 'head', text: 'main', title: 'HEAD is on main' },
    { kind: 'branch', text: 'origin/main', title: 'ref origin/main' },
    { kind: 'more', text: '+1', title: 'feature' },
  ]),
)
// ...and what a person actually sees: the rendered rows.
const gitRailMarkup = renderToStaticMarkup(
  h(gitInternals.HistoryView, {
    history: { phase: 'ready', commits: gitMerged, error: null, empty: false },
    selected: null,
    detail: { phase: 'idle', data: null, error: null },
    onPick() {},
    onOpen() {},
  }),
)
check('gittree: every row is drawn beside a rail', gitRailMarkup.split('data-gittree-rail=').length - 1, 4)
check('gittree: the rail is as wide as its lanes', gitRailMarkup.includes('width:30px') && gitRailMarkup.includes('padding-left:30px'))
check('gittree: the merge sits on the first lane and branches', gitRailMarkup.includes('data-gittree-lane="0" data-gittree-branches="2"'))
check('gittree: the branch commit is drawn on the second lane', gitRailMarkup.includes('data-gittree-lane="1"'))
check('gittree: a merge wears a hollow node', gitRailMarkup.includes('data-gittree-node-merge="1"') && gitRailMarkup.includes('background:var(--dsw-alias-bg-base,#fff)'))
check('gittree: the node HEAD points at wears a halo', gitRailMarkup.includes('data-gittree-node-head="1"'))
check('gittree: both curves are drawn', gitRailMarkup.split('dsg-elbow').length - 1, 2)
check('gittree: the node sits on the lane at the row centre', gitRailMarkup.includes('left:21px') && gitRailMarkup.includes('top:10.5px'))
check('gittree: the pull request wears its chip', gitRailMarkup.includes('data-gittree-pr="12"') && gitRailMarkup.includes('>#12<'))
check('gittree: the branch HEAD points at wears a chip', gitRailMarkup.includes('data-kind="head"') && gitRailMarkup.includes('data-gittree-ref="main"'))
check('gittree: a plain branch wears a chip', gitRailMarkup.includes('data-gittree-ref="feature"'))

// -------------------------------------------------------------- dsh-cmdbar
const cmdbar = loadBundle('packages/dsh-cmdbar/lib/client.js', {})
// The SAME bundle against an engine whose primitives have no Pill. It is a second
// load and not a footnote because the failure it guards is the abdicating one:
// `h(undefined, …)` inside a root-scoped slot does not cost a chip, it retires the
// whole dock for the life of the page.
const cmdbarNoCard = loadBundle('packages/dsh-cmdbar/lib/client.js', { withoutPill: true })
const cmdbarCssTag = cmdbar.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-cmdbar/cmdbar.css').pop()
const cmdbarCss = cmdbarCssTag ? cmdbarCssTag.textContent : ''
check('cmdbar bundle id', cmdbar.id, 'dsh-cmdbar')
check('cmdbar inject', JSON.stringify(cmdbar.exports.inject), '["slots"]')
check(
  'cmdbar stylesheet injected',
  cmdbarCss.includes('.dsc-dock{position:fixed;') &&
    cmdbarCss.includes('.dsc-dock[data-open]:not([data-suspended]){display:flex}') &&
    cmdbarCss.includes('.dsc-grip{'),
)
const cmdbarSeats = {}
cmdbar.exports.apply({
  slots: {
    inject: (name, fn) => fn(),
    register(spec, component) {
      cmdbarSeats[spec.name] = { spec, component }
      return () => {}
    },
  },
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
check(
  'cmdbar seats',
  Object.keys(cmdbarSeats).sort().join(','),
  'conversation.session.header.utilities,shell.overlay',
)
check('cmdbar button id', cmdbarSeats['conversation.session.header.utilities'].spec.id, 'dsh-cmdbar')
// Right of Open In... (-10) and left of the right bar's own toggle in the corner.
check('cmdbar button order', cmdbarSeats['conversation.session.header.utilities'].spec.order, 30)
check('cmdbar dock rides the overlay list', cmdbarSeats['shell.overlay'].spec.id, 'dsh-cmdbar')
const cmdbarButtonMarkup = renderToStaticMarkup(h(cmdbarSeats['conversation.session.header.utilities'].component, { sessionId: 's1' }))
check(
  'cmdbar button renders',
  cmdbarButtonMarkup.includes('data-dsh-cmdbar-toggle') && cmdbarButtonMarkup.includes('aria-label="The agent\u2019s commands"'),
)
check('cmdbar button reports its state', cmdbarButtonMarkup.includes('aria-pressed="false"'))
// The dock is always mounted (so its effects own the geometry); `data-open` is
// the intent flag and must be absent while it is closed.
const cmdbarDockMarkup = renderToStaticMarkup(h(cmdbarSeats['shell.overlay'].component, {}))
check('cmdbar dock renders closed', cmdbarDockMarkup.includes('data-dsh-cmdbar-dock') && cmdbarDockMarkup.includes('role="region"'))
check('cmdbar dock closed by default', cmdbarDockMarkup.includes('data-open') === false)
check('cmdbar dock draws the kit', cmdbarDockMarkup.includes('class="dsc-grip"') && cmdbarDockMarkup.includes('class="dsc-bar"'))
// alpha.12: the dock draws ONE view and nothing else, and a static render can see
// all of it - no chip strip, no "+", no Agent toggle (there is no second view to
// toggle to), and no emulator host even before mount.
check('cmdbar dock has no xterm before mount', cmdbarDockMarkup.includes('xterm') === false)
check(
  'cmdbar dock carries no chip strip and no add control',
  cmdbarDockMarkup.includes('dsc-chips') === false && cmdbarDockMarkup.includes('dsc-chip') === false && cmdbarDockMarkup.includes('dsc-nav') === false,
)
check('cmdbar dock has no view toggle any more', cmdbarDockMarkup.includes('dsc-actToggle') === false)
check(
  'cmdbar dock names the Agent view and wears its state',
  cmdbarDockMarkup.includes('>Agent<') && cmdbarDockMarkup.includes('data-state="idle"') && cmdbarDockMarkup.includes('class="dsc-spacer"'),
)
// Two behaviours that only exist after mount, pinned at the source level because
// a static render runs no effects:
//
//  1. the dock takes its room from the MIDDLE and RIGHT columns only. Shrinking
//     the frame instead shortens its single grid row, which shortens the left bar
//     too - its content visibly slid up the moment the dock opened (alpha.1), and
//     the left bar must look exactly the same with the dock open;
//  2. the panel IS the body, so nothing about it depends on a second view.
const cmdbarSource = readFileSync(path.join(repo, 'packages/dsh-cmdbar/lib/client.js'), 'utf8')
check('cmdbar never resizes the frame', /frame(El)?\.style\.height\s*=/.test(cmdbarSource), false)
check('cmdbar insets the two columns it spans', cmdbarSource.includes('previousElementSibling') && cmdbarSource.includes('frame.children[0]'))
check('cmdbar gives room by column height', cmdbarSource.includes("'calc(100% - ' + String(dock.height) + 'px)'"))
//  3. the LEFT BAR is animated: collapsing it rewrites the grid tracks once and
//     then transitions them, so a MutationObserver on that write reads the
//     PRE-transition value and is never called again - the dock stood at the old
//     left edge. What changes on every frame of that transition is the SIZE of
//     the columns the dock spans, which is what a ResizeObserver reports.
check('cmdbar tracks the animated left bar', cmdbarSource.includes('new ResizeObserver(') && cmdbarSource.includes('columnObserver.observe(column)'))
check('cmdbar also snaps on transitionend', cmdbarSource.includes("frame.addEventListener('transitionend', onTransitionEnd)"))
//  alpha.6: placing the dock and FOLLOWING the frame are two effects. As one,
//  keyed on the height, every frame of a dock drag disconnected a
//  MutationObserver and a ResizeObserver and built them again, and their pending
//  notifications landed on the fresh observers. The tracking effect is now keyed
//  on `open` alone (the `|| !open` guard is its tell) and reads `dock.height` at
//  call time; a drag only ever runs the two-write placement effect.
check(
  'cmdbar installs its frame observers once per open, not per height',
  cmdbarSource.includes('// Geometry, part one: PLACE the dock') &&
    cmdbarSource.includes('// Geometry, part two: FOLLOW the app frame') &&
    cmdbarSource.includes('if (node === null || !open) return undefined') &&
    cmdbarSource.includes('const refit = () => {') &&
    cmdbarSource.includes('observer = new MutationObserver(refit)'),
)
//  alpha.6: the drag itself. The height comes from the POINTER, never from the
//  dock's rect (the grip moves as the dock moves, so a handler that measured it
//  would chase itself); moves coalesce to one per animation frame; the drag
//  closes on `pointercancel` as well as `pointerup`, because a cancelled drag
//  used to leave its listeners attached and the dock still following the mouse.
//  alpha.12 removed the third rule it used to assert here - the PTY size message
//  it throttled - because there is no shell to size any more.
check(
  'cmdbar drag is frame-coalesced, capturable and cancellable',
  cmdbarSource.includes('requestAnimationFrame(apply)') &&
    cmdbarSource.includes('setPointerCapture') &&
    cmdbarSource.includes("window.addEventListener('pointercancel', finish)") &&
    cmdbarSource.includes("document.body.classList.add('dsc-dragging')") &&
    cmdbarCss.includes('body.dsc-dragging{'),
)
check(
  'cmdbar settles the HEIGHT on release and sizes nothing',
  cmdbarSource.includes('flushSharedHeight()') &&
    cmdbarSource.includes('runtime.settle()') === false &&
    cmdbarSource.includes('SIZE_WIRE_MS') === false,
)
// alpha.12: THE TERMINAL HALF IS GONE, and it is gone from this bundle rather
// than merely hidden. Each of these was a real mechanism through alpha.11 - a
// socket, a vendored engine, an emulator registry, a sentinel view index, a
// second column of UI - and 0.2's right Sidebar ships terminal tabs of its own,
// so their return would be a regression rather than a feature.
check(
  'cmdbar half is gone from the browser bundle',
  cmdbarSource.includes('new WebSocket(') === false &&
    cmdbarSource.includes('DSHTerminal') === false &&
    cmdbarSource.includes('/api/dsh-cmdbar/pty') === false &&
    cmdbarSource.includes('revealDelta') === false &&
    cmdbarSource.includes('ACTIVITY_VIEW') === false &&
    cmdbarSource.includes('DockRuntime') === false &&
    cmdbarSource.includes('onRunInTerminal') === false &&
    cmdbarSource.includes('MAX_TERMINALS') === false &&
    cmdbarSource.includes('dsc-chips') === false,
)
// alpha.6: the shared section may only move the dock when the value is NEWS. The
// dock's height rides a queued, non-optimistic wire write, and the scope
// re-announces on every accepted view, so an accept handler that re-adopts the
// section unconditionally hands the dock a height the drag has already left
// behind - once per accepted write, for as long as the queue of
// one-write-per-pointer-move takes to drain. That is the "the size glitches and I
// have to hide it" report in arithmetic, so it is pinned behaviourally rather
// than by the source shapes that let it ship.
const adoptDecision = cmdbar.exports.__internals.adoptDecision
const adopt = (input) =>
  adoptDecision(Object.assign({ ready: true, dragging: false, pending: 0, shared: 400, known: null, current: 280 }, input))
check('cmdbar adopt: news moves the dock', adopt({}), 400)
check('cmdbar adopt: the pointer owns the height', adopt({ dragging: true }), null)
check('cmdbar adopt: our own echo is not news', adopt({ shared: 400, known: 400 }), null)
check('cmdbar adopt: a write of ours still on the wire is not news', adopt({ pending: 1, shared: 300, known: 400 }), null)
check('cmdbar adopt: a height already in force moves nothing', adopt({ shared: 280, current: 280 }), null)
check('cmdbar adopt: an unready section waits', adopt({ ready: false }), null)
check('cmdbar adopt: an absent value is not a height of zero', adopt({ shared: null }), null)
check('cmdbar adopt: another window still moves the dock', adopt({ shared: 350, known: 400, current: 280 }), 350)
// alpha.15: the version left the bar for the BRAND's tooltip - a 24-character
// build string was a third of the header row's right-hand half - so the check
// reads it where a reader finds it now: in the title a hover opens. It is ALSO on
// the dock ROOT as `data-dsh-cmdbar-version`, and that is not decoration: a PAGE
// can be older than the host it talks to (it holds whatever bundle it fetched,
// and a document served with no cache headers need not revalidate), so "which
// bundle is this page running?" is a real question this package has to let a
// reader answer from the page - see the alpha.16 note below for how the host
// itself does and does not republish a change.
check(
  'cmdbar dock names the version',
  cmdbarDockMarkup.includes('dsh-cmdbar 0.1.0-alpha.17') &&
    cmdbarDockMarkup.includes('title="dsh-cmdbar 0.1.0-alpha.17"') &&
    cmdbarDockMarkup.includes('data-dsh-cmdbar-version="0.1.0-alpha.17"'),
)
// alpha.16: WHAT ACTUALLY REPUBLISHES A CLIENT BUNDLE. alpha.15 asserted, in the
// bundle's own comment, that the host snapshots every `client.js` at boot and that
// a page refresh cannot pick up an edit - advice that sent its reader looking for a
// restart it did not need. Measured against a running host: `dsh-client-hmr`
// stat-polls every graph row's bundle every 500 ms and republishes through
// `clientModules.rebuilt(id)`, which re-reads the file, so an edit reaches a page on
// a RELOAD. dsh-editor already pinned the same rule ("Restarting `dsh web` neither
// helps nor is needed"); this check keeps the two halves of the pack from
// disagreeing about it again.
check(
  'cmdbar reports which build is running without asking for a restart',
  cmdbarSource.includes('dsh-client-hmr') &&
    cmdbarSource.includes('rebuilt(id)') &&
    cmdbarSource.includes('Restarting `dsh web` neither helps nor is needed') &&
    cmdbarSource.includes('only a host restart') === false &&
    cmdbarSource.includes('SNAPSHOTS each') === false,
)
check('cmdbar bar no longer prints the version as text', cmdbarDockMarkup.includes('>dsh-cmdbar 0.1.0-alpha.17<') === false && cmdbarSource.includes('dsc-ver') === false)
// alpha.14: the RENAME. The bundle, its row id, its two seats, the one route it
// reads and the data-* attributes a person or a test can find it by all moved
// from `dsh-terminal` to `dsh-cmdbar`, because the old name described the
// emulator alpha.12 deleted and collided with the harness's own
// `@deepseek-ai/dsh-terminal` PTY seam. The CSS prefix moved with it (`dst-` ->
// `dsc-`), which also ends the accident that dsh-themes' own `.dst-button` and
// this package's `.dst-btn` shared a namespace.
check(
  'cmdbar carries its new name everywhere a name is read',
  cmdbarSource.includes("id: 'dsh-cmdbar'") &&
    cmdbarSource.includes("const ACTIVITY_ROUTE = '/api/dsh-cmdbar/activity'") &&
    cmdbarSource.includes("const STORAGE_KEY = 'dsh-cmdbar.dockHeight'") &&
    cmdbarSource.includes("const CSS_TAG = 'dsh-cmdbar/cmdbar.css'") &&
    cmdbarSource.includes("'data-dsh-cmdbar-dock'") &&
    cmdbarSource.includes("'data-dsh-cmdbar-toggle'") &&
    cmdbarSource.includes("'data-dsh-cmdbar-cmd'") &&
    cmdbarSource.includes("'dsh-cmdbar ' + PLUGIN_VERSION") &&
    // ... and the one name that deliberately did NOT move: the pack's own shared
    // `dockHeight` field, whose rename would have thrown away the height every
    // reader had already chosen.
    cmdbarSource.includes("sharedState.get('dockHeight')") &&
    cmdbarSource.includes('dst-dock') === false &&
    cmdbarCss.includes('.dsc-dock{position:fixed;'),
)
check(
  'cmdbar does not rename the harness packages it only mentions',
  cmdbarSource.includes('dsh-terminal-bash') &&
    cmdbarSource.includes('@deepseek-ai/dsh-client-ui-sidebar-terminal') &&
    // The one harness TOOL this log reads by name is untouched.
    cmdbarSource.includes('terminal_send'),
)

// ------------------------------------------------------ the agent's own commands
// The panel is a TRANSCRIPT of what the conversation recorded, read from this
// package's own host route. Everything it claims is arithmetic over that log, so
// the arithmetic is driven below with hand-built events - the shapes are the ones
// the harness's own assembler reads (`event.data.message.content[0]` for a
// result, `event.data.source.kind === 'user'` for a prompt).
//
// alpha.12 removed the view TOGGLE: with the terminals gone there is one view, so
// the state a button used to wear (the running pulse, the failure count, the
// unreadable warning) is the bar's own brand and facts line.
check(
  'cmdbar bar wears the log state without a toggle',
  cmdbarCss.includes('.dsc-warn{') &&
    cmdbarCss.includes('.dsc-pulse{') &&
    cmdbarCss.includes('.dsc-badge{') &&
    cmdbarSource.includes('activityUnreadable') &&
    cmdbarSource.includes('activityFactsTitle(activity)') &&
    cmdbarSource.includes("'data-state': activityTone") &&
    cmdbarSource.includes('const showActivityView') === false,
)
// alpha.11: the counts the bar's badge and the header dot are made of are the
// COMMANDS' (the fold decides that, below), and the bar's own facts line adds the
// other family's running/failed rows back only while "All tools" can DRAW them.
// alpha.15 moved this arithmetic OUT of the view and into `Dock`, because the
// chips that set those filters are in the bar now - the same three expressions,
// reading the model the dock holds as `activity`.
check(
  'cmdbar bar counts the commands, plus the rest only under All tools',
  cmdbarSource.includes('if (allTools && activity.counts.other > 0) facts.push(String(activity.counts.other) + \' other\')') &&
    cmdbarSource.includes('const running = activity.counts.running + (allTools ? activity.counts.otherRunning || 0 : 0)') &&
    cmdbarSource.includes('const failed = activity.counts.failed + (allTools ? activity.counts.otherFailed || 0 : 0)'),
)
// alpha.15: ONE header row, and the overlap it repaired is a FLEX property, not a
// spacing one - so it is pinned as CSS. The counts are the row's only shrinkable
// item (they ellipsise); everything beside them refuses to shrink and refuses to
// wrap; and the row itself cannot wrap at all. The version span and the view's
// toolbar row are gone with the second header.
check(
  'cmdbar has ONE header row',
  cmdbarCss.includes('.dsc-bar{flex:none;display:flex;flex-wrap:nowrap;') &&
    cmdbarCss.includes('.dsc-ver') === false &&
    cmdbarCss.includes('.dsc-actBar') === false &&
    cmdbarCss.includes('.dsc-mini') === false &&
    cmdbarDockMarkup.split('class="dsc-bar"').length === 2,
)
check(
  'cmdbar bar cannot overlap itself',
  cmdbarCss.includes('.dsc-facts{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;') &&
    cmdbarCss.includes('.dsc-brand{flex:none;display:inline-flex;align-items:center;gap:6px;min-width:0;white-space:nowrap;') &&
    cmdbarCss.includes('.dsc-filters{flex:none;display:inline-flex;align-items:center;gap:6px}'),
)
check(
  'cmdbar activity styles are injected',
  cmdbarCss.includes('.dsc-activity{position:absolute;inset:0;') &&
    cmdbarCss.includes('.dsc-cmd{') &&
    cmdbarCss.includes('@keyframes dsc-pulse{') &&
    cmdbarCss.includes('.dsc-pulse{') &&
    cmdbarCss.includes('.dsc-badge{') &&
    // The shared notice is absolute/inset:0, so the body it sits in must be its
    // containing block or "no commands yet" would cover the bar that says why.
    cmdbarCss.includes('.dsc-actBody{position:relative;'),
)
// alpha.9: a command row has to be readable at a glance, in EVERY theme. Both
// side rails carry the status colour - the exit-0 GREEN included, not only a
// failure's red - and the row's own head (the clickable line that drops the
// output down) wears a LIGHT wash of the same colour, so the command lines a
// reader scans stand out from their output without the output losing contrast.
// The tone is ONE custom property per status, so the rails, the wash and the
// pill cannot drift apart; the wash is mixed with `transparent`, which lightens
// a light theme and darkens a dark theme and leaves the label colour alone.
check(
  'cmdbar command rows wear the status on both rails and on the head',
  cmdbarCss.includes('.dsc-cmd{--dsc-accent:var(--dsw-alias-state-success-primary,#2f9e44)') &&
    cmdbarCss.includes('border-left:2px solid var(--dsc-accent);border-right:2px solid var(--dsc-accent)') &&
    cmdbarCss.includes('.dsc-cmd[data-status=running]{--dsc-accent:var(--dsw-alias-state-warning-primary,#d29922)}') &&
    cmdbarCss.includes('.dsc-cmd[data-status=failed],.dsc-cmd[data-status=signal],.dsc-cmd[data-status=error]{--dsc-accent:var(--dsw-alias-state-error-primary,#d3382c)}') &&
    cmdbarCss.includes('background:color-mix(in srgb,var(--dsc-accent) 14%,transparent)') &&
    cmdbarCss.includes('.dsc-cmdHead:hover{background:color-mix(in srgb,var(--dsc-accent) 26%,transparent)}'),
)
check(
  'cmdbar header control shows agent activity',
  cmdbarSource.includes("h('span', { className: 'dsc-headDot'") &&
    cmdbarSource.includes("'data-agent-state'") &&
    cmdbarCss.includes('.dsc-headDot{') &&
    cmdbarCss.includes('.dsc-headDot[data-state=running]{'),
)
// The read lives on the HOST: a browser-side session window has to be STAGED
// first, which is exactly what left the panel on "Reading the conversation..."
// until something else moved the session along. The client's job is: ask this
// package's own read-only route for a filtered tail, fold it with the pure fold
// below, and stop asking when nobody is watching or the tab is hidden.
check(
  'cmdbar reads the conversation from its own route',
  cmdbarSource.includes("const ACTIVITY_ROUTE = '/api/dsh-cmdbar/activity'") &&
    cmdbarSource.includes("fetch(ACTIVITY_ROUTE + '?session=' + encodeURIComponent(sessionId)") &&
    cmdbarSource.includes('buildActivityFromEvents(entries)') &&
    cmdbarSource.includes('serviceNow(') === false,
)
check(
  'cmdbar polls only while something watches, and not in a hidden tab',
  cmdbarSource.includes('const hidden = () =>') &&
    cmdbarSource.includes('if (disposed || listeners.size === 0 || hidden()) return') &&
    cmdbarSource.includes("document.addEventListener('visibilitychange', onVisible)") &&
    cmdbarSource.includes('if (listeners.size === 0 && timer !== null)'),
)
// alpha.11, the startup half of "the notification follows the conversation".
// The conversation on screen is attached by the host as the app opens it, so the
// FIRST read can race that attach and answer NOT_LIVE; at the steady 6 s cadence a
// restored conversation then says "not readable here" for up to six seconds after
// every reload. A few brisk attempts close that window, and a log that is still
// unreadable falls back to the steady cadence rather than polling at 1.5 s for
// ever - so the retry is BOUNDED and the answer RESETS it.
check(
  'cmdbar retries a log that has not answered yet, then settles',
  cmdbarSource.includes('const ACTIVITY_RETRY_MS = 1500') &&
    cmdbarSource.includes('const ACTIVITY_RETRY_ATTEMPTS = 4') &&
    cmdbarSource.includes('if (model.available !== true && retries < ACTIVITY_RETRY_ATTEMPTS) return ACTIVITY_RETRY_MS') &&
    /if \(body !== null && body\.ok === true\) \{[\s\S]{0,240}?retries = 0[\s\S]{0,80}?absorb\(body\)/.test(cmdbarSource) &&
    // ... and BOTH a fresh answer and a fresh subscription (the conversation
    // coming back on screen) reset the budget, so the retry is never spent once.
    (cmdbarSource.match(/retries = 0/g) || []).length >= 2 &&
    /const unavailable = \(reason\) => \{\n\s*retries \+= 1/.test(cmdbarSource),
)
// The dock is root-scoped and always mounted, so the conversation it BELONGS to
// is the only thing that keeps its feed (and its numbers) on the conversation in
// front of the reader: a closed dock used to hold `dock.sessionId` from the
// conversation it was last opened in and keep polling that one (alpha.11).
//
// alpha.13 moved the rule from "a change closes the panel" to "a change
// RE-POINTS it", and the two ways the old shape failed were both invisible in
// source: an empty id returned early, so a NEW conversation (no session id yet)
// or a screen whose header had gone away left the panel drawing the previous
// conversation's commands, counts and poll. The four fields of `followDecision`
// are driven below, and the source shape is asserted only for the part no
// behaviour can show - that the panel is now closed by the READER's own control
// and by nothing else (two `dock.open = false`, both of them user-facing).
check(
  'cmdbar dock follows the conversation instead of closing itself',
  /function adoptSession\(sessionId\)[\s\S]*?followDecision\(\{ open: dock\.open, current: dock\.sessionId, next: sessionId \}\)[\s\S]*?dock\.sessionId = next/.test(cmdbarSource) &&
    /function releaseSession\(sessionId\)[\s\S]*?dock\.sessionId !== sessionId\) return[\s\S]*?dock\.sessionId = null/.test(cmdbarSource) &&
    (cmdbarSource.match(/dock\.open = false/g) || []).length === 2,
)
// alpha.15 moved the facts line's arithmetic into the dock (the chips that set
// the filters are up there with it), so what this pins is the alpha.13 rule it
// still has to hold: with NO conversation the line is EMPTY - no "0 commands" -
// and the body says why. The counts themselves are still `activityFactsTitle`'s.
check(
  'cmdbar dock says why it is empty with nothing on screen',
  cmdbarSource.includes("hint('No conversation open'") &&
    cmdbarSource.includes('const facts = []') &&
    cmdbarSource.includes('if (sessionId !== null) {') &&
    cmdbarSource.includes('activityFactsTitle(activity)') &&
    cmdbarDockMarkup.includes('class="dsc-facts"'),
)
// alpha.13: the sentence that used to open the facts line is gone; the counts are
// the whole of it (pinned as text below, on both models).
check(
  'cmdbar facts line carries the counts alone',
  cmdbarSource.includes('The agent\u2019s own commands in this conversation') === false,
)

const { parseExecCall, parseExitMarker, stripAnsi, buildActivityFromEvents, activitySignature, filterActivity, formatDuration, activityFactsTitle, followDecision, commandBody, commandTooltip } =
  cmdbar.exports.__internals

const shellCall = parseExecCall('bash', '{"command":"ls -la","description":"list files"}')
check('activity: a shell call keeps its command', shellCall.command, 'ls -la')
check('activity: a described shell call is not persistent', shellCall.persistent, false)
check('activity: a missing description marks the persistent shell', parseExecCall('pwsh', '{"command":"pwd"}').persistent, true)
const workdirCall = parseExecCall('bash', '{"command":"npm test","description":"t","workdir":"/tmp/x","run_in_background":true}')
check('activity: a workdir and a background flag survive', workdirCall.workdir + '|' + String(workdirCall.background), '/tmp/x|true')
check('activity: terminal_send is a command', parseExecCall('terminal_send', '{"text":"ls\\n"}').family, 'terminal')
check('activity: a non-command tool is not a command', parseExecCall('read', '{"file_path":"a.txt"}'), null)
check('activity: a malformed call is not a command', parseExecCall('bash', '{oops'), null)
check('activity: an empty command is not a command', parseExecCall('bash', '{"command":"  ","description":"d"}'), null)
check('activity: exit markers are consumed', JSON.stringify(parseExitMarker('done\n[exit code: 3]')), '{"body":"done","exitCode":3}')
check('activity: a signal marker is not an exit code', parseExitMarker('x\n[killed by signal: SIGKILL]').signal, 'SIGKILL')
check('activity: output without a marker is a clean exit', parseExitMarker('hello').exitCode, 0)
check('activity: marker-like text mid-output is left alone', parseExitMarker('a [exit code: 9] b').body, 'a [exit code: 9] b')
check('activity: ansi is stripped', stripAnsi('\u001b[31mred\u001b[0m'), 'red')
check('activity: an OSC title is stripped', stripAnsi('\u001b]0;title\u0007ok'), 'ok')
check('activity: a bare carriage return becomes a newline', stripAnsi('a\rb'), 'a\nb')
check(
  'activity: duration reads as a duration',
  [formatDuration(900), formatDuration(1500), formatDuration(65000), formatDuration(null)].join('/'),
  '900ms/1.5s/1m05s/',
)

/** One `{ type: 'event', event }` window entry, the shape the source publishes. */
const ev = (seq, type, data, time) => ({ type: 'event', event: { type, seq, time: time === undefined ? 1000 + seq : time, data } })
const promptEvent = (seq, text) => ev(seq, 'user/message', { id: 'm' + seq, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const callEvent = (seq, callId, command, name) =>
  ev(seq, 'tool/call', { turn: 1, step: 1, callId, name: name === undefined ? 'bash' : name, arguments: JSON.stringify({ command, description: 'run' }) })
const resultEvent = (seq, callId, text, isError) =>
  ev(seq, 'tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'user',
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: isError === true }],
    },
  })

const log = [promptEvent(1, 'do the thing'), callEvent(2, 'c1', 'npm test'), resultEvent(3, 'c1', 'FAIL\n[exit code: 1]'), callEvent(4, 'c2', 'git status --short')]
const activityModel = buildActivityFromEvents(log)
check('activity: one group per prompt', activityModel.groups.length, 1)
check('activity: the prompt captions the group', activityModel.groups[0].prompt, 'do the thing')
check('activity: both commands are in the group', activityModel.groups[0].commands.length, 2)
check('activity: a settled failure says so', activityModel.groups[0].commands[0].status, 'failed')
check('activity: the exit code is read off the marker', activityModel.groups[0].commands[0].exitCode, 1)
check('activity: the marker leaves the body', activityModel.groups[0].commands[0].output, 'FAIL')
check('activity: a call with no result is still running', activityModel.groups[0].commands[1].status, 'running')
check('activity: counts separate commands from failures', JSON.stringify(activityModel.counts), '{"shell":2,"other":0,"running":1,"failed":1,"otherRunning":0,"otherFailed":0}')
// alpha.11: the numbers the Agent control WEARS are the COMMANDS'. A conversation
// whose only tool call was a `read` - and had it fail - used to paint the red
// failure badge and the red header dot ("1 failed") while its own tooltip said
// "0 commands, 1 failed, nothing run yet" in one breath. The other family's own
// running/failed rows are counted separately, so "All tools" stays describable.
const nonCommandLog = [
  promptEvent(1, 'read that file'),
  ev(2, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"missing.txt"}' }),
  resultEvent(3, 'c1', 'ENOENT: no such file', true),
]
const nonCommandModel = buildActivityFromEvents(nonCommandLog)
check(
  'activity: a failed non-command lights no badge',
  JSON.stringify(nonCommandModel.counts),
  '{"shell":0,"other":1,"running":0,"failed":0,"otherRunning":0,"otherFailed":1}',
)
check('activity: the failure badge counts commands only', nonCommandModel.counts.failed, 0)
check('activity: a failed non-command is still a failure', nonCommandModel.groups[0].commands[0].status, 'error')
check(
  'activity: a running non-command is not the terminal working',
  buildActivityFromEvents([ev(4, 'tool/call', { turn: 1, step: 1, callId: 'c2', name: 'read', arguments: '{"file_path":"a/b.ts"}' })]).counts.running,
  0,
)
check('activity: a failed command still counts', activityModel.counts.failed, 1)
// The tooltip is where the counts reach a reader as WORDS, and the alpha.11 bug
// read there first: "0 commands, 1 failed, nothing run yet" in one breath.
// alpha.13 removed the sentence that used to precede them, so these two strings
// are now the whole line - the bar's facts line and the control's tooltip alike.
check(
  'activity: the tooltip counts commands, not every tool',
  activityFactsTitle(nonCommandModel),
  '0 commands, nothing run yet',
)
check(
  'activity: the tooltip reports what the commands did',
  activityFactsTitle(activityModel),
  '2 commands, 1 running, 1 failed',
)
// ... and the sentence is gone from BOTH the tooltip and the dock's bar.
check('activity: no model, no line', activityFactsTitle(null), '')
// alpha.13: the panel follows the conversation in front of the reader. An OPEN
// panel re-points and keeps its place; a closed one only forgets (alpha.11); and
// an ABSENT id - a new conversation before it has a session, or a screen whose
// header has gone - is a CHANGE, not the no-op that used to leave the previous
// conversation's commands, counts and poll on screen.
check('cmdbar follow: an open panel re-points at the new conversation', followDecision({ open: true, current: 'a', next: 'b' }), 'b')
check('cmdbar follow: an open panel with nothing on screen points at nothing', followDecision({ open: true, current: 'a', next: null }), null)
check('cmdbar follow: a new conversation with no id yet is a change, not a no-op', followDecision({ open: true, current: 'a', next: '' }), null)
check('cmdbar follow: a closed panel just forgets', followDecision({ open: false, current: 'a', next: 'b' }), null)
check('cmdbar follow: the same conversation moves nothing', followDecision({ open: true, current: 'a', next: 'a' }), 'a')
check('cmdbar follow: nothing on screen and nothing held', followDecision({ open: true, current: null, next: null }), null)
check('cmdbar follow: a missing state is not a crash', followDecision(undefined), null)
const pagedOut = buildActivityFromEvents([resultEvent(9, 'gone', 'out\n[exit code: 0]')])
check('activity: a result whose call was paged out is kept', pagedOut.groups[0].commands.length, 1)
// The exit marker is read ONLY for a tool we know is a foreground shell: the
// marker vocabulary belongs to those renderers, and a result whose `tool/call`
// is outside the loaded window names no tool at all. Rather than guess, the row
// keeps the rendered text the model actually saw, marker included.
check('activity: an unnamed result keeps its marker text', pagedOut.groups[0].commands[0].output, 'out\n[exit code: 0]')
check('activity: an unnamed result claims no exit status', String(pagedOut.groups[0].commands[0].exitCode), 'null')
// A persistent shell (the same wire tool with no `description`) settles with no
// single process exit status, so it must claim none.
const persistentCall = ev(5, 'tool/call', { turn: 1, step: 1, callId: 'p1', name: 'pwsh', arguments: JSON.stringify({ command: 'pwd' }) })
const persistentModel = buildActivityFromEvents([persistentCall, resultEvent(6, 'p1', '/home/x')])
check('activity: a persistent shell claims no exit status', String(persistentModel.groups[0].commands[0].exitCode), 'null')
check('activity: a persistent shell settles as done', persistentModel.groups[0].commands[0].status, 'ok')
const infraModel = buildActivityFromEvents([callEvent(7, 'e1', 'boom'), resultEvent(8, 'e1', 'spawn failed', true)])
check('activity: an infrastructure failure is an error', infraModel.groups[0].commands[0].status, 'error')
const steeringLog = buildActivityFromEvents([promptEvent(1, 'first'), callEvent(2, 'c1', 'a'), promptEvent(3, 'second'), callEvent(4, 'c2', 'b')])
check('activity: a second prompt opens a second group', steeringLog.groups.length, 2)
check('activity: the second group is captioned too', steeringLog.groups[1].prompt, 'second')
check(
  'activity: injected context does not open a group',
  buildActivityFromEvents([ev(1, 'user/message', { id: 'c', role: 'user', content: [{ type: 'text', text: 'ctx' }], source: { kind: 'plugin', plugin: 'x' } }), callEvent(2, 'c1', 'a')]).groups.length,
  1,
)
const mixedLog = [promptEvent(1, 'x'), callEvent(2, 'c1', 'ls'), ev(3, 'tool/call', { turn: 1, step: 1, callId: 'c9', name: 'read', arguments: '{"file_path":"a/b.ts"}' })]
const mixedModel = buildActivityFromEvents(mixedLog)
check('activity: a non-command row summarizes itself', mixedModel.groups[0].commands[1].summary, 'a/b.ts')
const countOf = (groups) => groups.reduce((total, group) => total + group.commands.length, 0)
check('activity: the default filter is commands only', countOf(filterActivity(mixedModel.groups, {})), 1)
check('activity: the All-tools filter adds the rest', countOf(filterActivity(mixedModel.groups, { allTools: true })), 2)
check('activity: empty groups are dropped', countOf(filterActivity(buildActivityFromEvents([promptEvent(1, 'nothing ran')]).groups, {})), 0)
check(
  'activity: the failures filter keeps what failed',
  countOf(filterActivity(activityModel.groups, { failuresOnly: true })),
  1,
)
// The signature is what keeps a streamed token from re-folding the log.
const signature = activitySignature(log)
check('activity: an unchanged log keeps its model', activitySignature(log) === signature)
check(
  'activity: a streamed assistant token is not a change',
  activitySignature(log.concat([ev(5, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [], source: { kind: 'model' } }, stream: [] })])) === signature,
)
check(
  'activity: a transient entry is never a change',
  activitySignature(log.concat([{ type: 'transient', event: { type: 'assistant/live-chunk', seq: 99, time: 1, data: {} } }])) === signature,
)
check('activity: a new result IS a change', activitySignature(log.concat([resultEvent(6, 'c2', 'ok\n[exit code: 0]')])) !== signature)

// The panel itself. The switch is off by default, so a static render of the dock
// can never reach a row - the view is rendered here with a hand-built log, which
// is what proves a command, its exit pill, its working folder, the output clamp
// and the actions actually draw.
const ActivityView = cmdbar.exports.__internals.ActivityView
const renderActivityView = (entries, props) =>
  renderToStaticMarkup(
    h(
      ActivityView,
      Object.assign(
        {
          sessionId: 's1',
          model: Object.assign(buildActivityFromEvents(entries), { hasMore: false, available: true, reason: null, revision: 1 }),
          onRunInTerminal: () => {},
          canRunInTerminal: true,
        },
        props,
      ),
    ),
  )
const activityLongOutput = Array.from({ length: 20 }, (unused, index) => 'line ' + String(index + 1)).join('\n')
const activityViewMarkup = renderActivityView([promptEvent(1, 'run the tests'), callEvent(2, 'c1', 'npm test'), resultEvent(3, 'c1', 'FAIL\n[exit code: 1]'), callEvent(4, 'c2', 'build'), resultEvent(5, 'c2', activityLongOutput + '\n[exit code: 0]')])
check('activity view: the prompt captions the group', activityViewMarkup.includes('run the tests'))
check('activity view: the group names its turn', activityViewMarkup.includes('turn 1'))
check('activity view: a command draws', activityViewMarkup.includes('npm test') && activityViewMarkup.includes('data-dsh-cmdbar-cmd="c1"'))
check('activity view: the exit pill draws', activityViewMarkup.includes('exit 1') && activityViewMarkup.includes('exit 0'))
// 20 output lines (the exit marker is consumed), so the first 12 draw and line 13
// must not - with the count of what is hidden offered as the way to see it.
check(
  'activity view: long output is clamped with a way to see it',
  activityViewMarkup.includes('Show all 20 lines') && activityViewMarkup.includes('line 12') && activityViewMarkup.includes('line 13') === false,
)
// alpha.12: the row offers copying and NOTHING that runs. "Run in Terminal" typed
// a command into a PTY this package owned; with the terminals gone there is no
// shell of ours to type into.
check(
  'activity view: the actions draw, and none of them runs anything',
  activityViewMarkup.includes('Copy command') &&
    activityViewMarkup.includes('Copy output') &&
    activityViewMarkup.includes('Run in Terminal') === false,
)
// alpha.15: THE FILTERS ARE IN THE BAR, not in a second toolbar row. The view
// draws the log and nothing else; the dock's bar draws the chips, as the app's
// own Pill primitive, and the view is told what they say.
check(
  'cmdbar view draws no toolbar of its own',
  activityViewMarkup.includes('dsc-actBar') === false && activityViewMarkup.includes('dsc-mini') === false && activityViewMarkup.includes('>Commands<') === false,
)
check(
  'cmdbar bar draws the filters as the app\u2019s own chips',
  cmdbarDockMarkup.includes('All tools') &&
    cmdbarDockMarkup.includes('Failures') &&
    cmdbarDockMarkup.includes('class="dsc-filters"') &&
    cmdbarDockMarkup.includes('class="dsc-pillSeat"') &&
    cmdbarSource.includes("const Pill = typeof primitives.Pill === 'function' ? primitives.Pill : null") &&
    cmdbarSource.includes("h('button', Object.assign({ type: 'button', className: 'dsc-btn'"),
)
// alpha.15, the SECOND pass on the same row: the reader measured the first cut
// (a 31px row, the app's 24px Pill untouched) and said it was still too tall, so
// the row's height became ONE knob - `--dsc-control-h:20px` on `.dsc-dock`, which
// is `primitives.Tag`'s own density rather than an invented number - and the app's
// chip is resized STRUCTURALLY, through a wrapper this package owns. Never by a
// hashed class name: the app's bundler renames those, so a rule keyed on one would
// break on the next harness release, and the seat is not named after its occupant
// for the alpha.12 reason above it.
//
// alpha.16: the seat's rule carries TWO classes, and the check reads both. The
// shipped chip's own rule is `.pill{height:24px}` - a single class, in the shell's
// static stylesheet - so `.dsc-pillSeat>*` had the SAME specificity as the rule it
// is meant to override, and which of the two won was decided by whichever
// stylesheet the browser injected last. `.dsc-dock .dsc-pillSeat>*` decides it in
// any order, which is what makes "a 25px row" a fact about this stylesheet instead
// of a fact about load order.
check(
  'cmdbar bar controls wear the app\u2019s own dense scale',
  cmdbarCss.includes('--dsc-control-h:20px') &&
    cmdbarCss.includes('.dsc-dock .dsc-pillSeat>*{height:var(--dsc-control-h,22px);padding:0 8px;font-size:11px;line-height:17px}') &&
    // ...and no LINE may open the same rule with one class, which is the tie the
    // extra class exists to break (the substring alone matches both spellings).
    /^\.dsc-pillSeat>\*\{/m.test(cmdbarCss) === false &&
    cmdbarCss.includes('.dsc-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;height:var(--dsc-control-h,22px);') &&
    cmdbarCss.includes('.dsc-btnIcon{width:var(--dsc-control-h,22px);padding:0}') &&
    cmdbarCss.includes('.dsc-bar{flex:none;display:flex;flex-wrap:nowrap;align-items:center;gap:8px;min-width:0;padding:2px 8px 2px 10px;') &&
    // The dense chip is still the SHIPPED primitive, wrapped - not a lookalike.
    cmdbarSource.includes("return h('span', { className: 'dsc-pillSeat' }, h(Pill, props, label))"),
)
// The chips are STATEFUL, and the state is the dock's: `active` is what the
// shipped Pill paints, and the aria-pressed a reader's screen reader hears. Both
// are OFF in a fresh render - the store is not persisted, deliberately - and the
// source is what pins that a click moves them.
check(
  'cmdbar bar wears which filter is on',
  cmdbarDockMarkup.includes('data-active="false"') &&
    cmdbarDockMarkup.includes('aria-pressed="false"') &&
    cmdbarSource.includes('active: allTools') &&
    cmdbarSource.includes('active: failuresOnly') &&
    cmdbarSource.includes('const [allTools, setAllTools] = useState(false)') &&
    cmdbarSource.includes('const [failuresOnly, setFailuresOnly] = useState(false)') &&
    cmdbarSource.includes('onClick: () => setAllTools((prev) => !prev)') &&
    cmdbarSource.includes('onClick: () => setFailuresOnly((prev) => !prev)'),
)
// ... and the three belong to the conversation they were set in (alpha.13), which
// alpha.15 had to keep when it moved them one component up: the effect resets them
// on the same change the view's own key resets its expanded rows.
check(
  'cmdbar filters belong to the conversation',
  /useEffect\(\(\) => \{\n\s*setAllTools\(false\)\n\s*setFailuresOnly\(false\)\n\s*setFollow\(true\)\n\s*\}, \[sessionId\]\)/.test(cmdbarSource) &&
    cmdbarSource.includes('allTools, failuresOnly, follow, onFollowChange: setFollow'),
)
// The FALLBACK bar, rendered for real: an engine without the app's chip primitive
// gets outlined buttons instead of a vanished panel.
{
  const seats = {}
  cmdbarNoCard.exports.apply({
    slots: {
      inject: (name, fn) => fn(),
      register(spec, component) {
        seats[spec.name] = { spec, component }
        return () => {}
      },
    },
    effect: (fn) => fn(),
    logger: { debug() {}, warn() {} },
  })
  const fallbackMarkup = renderToStaticMarkup(h(seats['shell.overlay'].component, {}))
  check(
    'cmdbar bar still draws without the app\u2019s chips',
    fallbackMarkup.includes('>Agent<') && fallbackMarkup.includes('All tools') && fallbackMarkup.includes('Failures') && fallbackMarkup.includes('class="dsc-btn"'),
  )
  check('cmdbar fallback chips name their state', fallbackMarkup.includes('data-on') === false || fallbackMarkup.includes('dsc-btn'))
}
const activityMultiLineMarkup = renderActivityView([callEvent(1, 'm1', 'npm run a\nnpm run b'), resultEvent(2, 'm1', 'ok\n[exit code: 0]')])
// A multi-line command is drawn like any other now: the `multi-line` note existed
// only to explain why Run in Terminal was withheld, and there is nothing to withhold.
// The row is COLLAPSED here, so the full command is not in this markup at all -
// it appears on expand, which is driven directly below.
check(
  'activity view: a multi-line command is drawn like any other',
  activityMultiLineMarkup.includes('multi-line') === false && activityMultiLineMarkup.includes('Run in Terminal') === false,
)
// ... and the line the row draws really wears it. The tooltip is a plain `title`,
// so the row's own static render answers for it - this is not the pure decision
// called by hand.
check(
  'activity view: the row puts the WHOLE command in the line\u2019s tooltip',
  activityMultiLineMarkup.includes('title="npm run a\nnpm run b"'),
)
// alpha.14: THE CLICK THAT KILLED THE DOCK. Expanding a row asked for `multiLine`,
// an identifier this bundle NEVER declared, so the first click on a command line
// threw `ReferenceError: multiLine is not defined` out of the row's render - and
// the shell's slot error boundary answers a root-scoped entry's crash with
// `{ abdicate: true }`, which RETIRES the entry for the life of the page. The dock
// did not merely fail to expand: it disappeared and the header button could not
// bring it back, which is exactly what a reader reported. No static render can
// click, and a collapsed row short-circuits before the identifier is read, so the
// decision now lives in a pure function and is DRIVEN here - and the row is pinned
// to it, because the free identifier must never come back.
check('activity: a collapsed row draws no command body', commandBody({ command: 'a\nb' }, false), null)
check('activity: a single-line command has nothing extra to show', commandBody({ command: 'npm test' }, true), null)
check('activity: an expanded multi-line command is drawn in full', commandBody({ command: 'npm run a\nnpm run b' }, true), 'npm run a\nnpm run b')
check('activity: a command-less entry is not a crash', commandBody({ command: undefined }, true), null)
check('activity: no entry at all is not a crash', commandBody(null, true), null)
check(
  'activity: the row draws its command body from the pure decision',
  cmdbarSource.includes('const fullCommand = commandBody(entry, expanded)') &&
    cmdbarSource.includes("fullCommand === null ? null : h('pre', { className: 'dsc-out dsc-outCmd' }, fullCommand)") &&
    // Outside prose (doc lines start with ` * `), the free identifier is gone.
    /[^\w.]multiLine\b/.test(cmdbarSource.replace(/^[ \t]*\*.*$/gm, '')) === false,
)
// alpha.17: THE WHOLE COMMAND IN THE BROWSER'S OWN TOOLTIP. alpha.15 answered the
// clipped line with the shipped HoverCard; the reader who asked for that then asked
// for the DEFAULT tooltip instead - plainer, selectable, and with nothing to dismiss
// before a row can be expanded - so the line carries `title` and the card, its
// portal, its content box and its hover state are gone. Driven in all four cases,
// because the wrong answer here is the one alpha.14 shipped: the agent's DESCRIPTION
// ("run the unit tests") where the command was asked for.
check('activity: a command line wears the WHOLE command as its tooltip', commandTooltip({ command: 'npm run a\nnpm run b' }), 'npm run a\nnpm run b')
check('activity: a row with no command wears no tooltip', commandTooltip({ command: '' }), null)
check('activity: a command-less entry wears no tooltip', commandTooltip({ command: undefined }), null)
check('activity: no entry at all wears no tooltip', commandTooltip(null), null)
check(
  'activity: no styled hover card is left behind',
  cmdbarSource.includes('primitives.HoverCard') === false &&
    cmdbarSource.includes('function commandCard') === false &&
    cmdbarSource.includes('widthAnchorRef') === false &&
    cmdbarCss.includes('.dsc-hoverCmd') === false,
)
check(
  'activity: the row names its tooltip from the pure decision',
  cmdbarSource.includes('const tooltip = commandTooltip(entry)') &&
    cmdbarSource.includes("h('span', { className: 'dsc-cmdLine', title: tooltip === null ? undefined : tooltip }") &&
    // The description is NOT the tooltip: it was the wrong answer in alpha.14.
    cmdbarSource.includes("entry.description === '' ? entry.command : entry.description") === false,
)
// ... and the SECOND free identifier of that release, found by auditing the
// bundle for names it references but never declares. The row's two actions called
// `writeClipboard(text)` BARE - the name of a `@deepseek-ai/dsh-client-ui-primitives`
// export this bundle already requires for `Tooltip` - so clicking **Copy command**
// or **Copy output** threw `ReferenceError: writeClipboard is not defined` and the
// abdicating slot boundary took the whole panel away, exactly like the expand
// click. The write now goes through the qualified primitive (which the pack-wide
// primitive scan at the end of this file checks against the REAL pinned package),
// it is guarded for an engine without the helper, and "Copied" is shown only for a
// write the host actually accepted.
check(
  'activity: the copy buttons call the clipboard PRIMITIVE, qualified',
  cmdbarSource.includes("typeof primitives.writeClipboard !== 'function'") &&
    cmdbarSource.includes('const write = primitives.writeClipboard(text)') &&
    cmdbarSource.includes('if (accepted !== true) return') &&
    /[\w$]writeClipboard/.test(cmdbarSource.split('primitives.writeClipboard').join('').replace(/^[ \t]*\*.*$/gm, '')) === false,
)
const activityRunningMarkup = renderActivityView([callEvent(1, 'r1', 'sleep 30')])
check('activity view: a running command says so', activityRunningMarkup.includes('>running<') && activityRunningMarkup.includes('Running'))
const activityUnavailableMarkup = renderToStaticMarkup(
  h(ActivityView, {
    sessionId: 's1',
    model: { groups: [], counts: { shell: 0, other: 0, running: 0, failed: 0, otherRunning: 0, otherFailed: 0 }, hasMore: false, available: false, reason: 'no reader here', revision: 1 },
    onRunInTerminal: () => {},
    canRunInTerminal: false,
  }),
)
check('activity view: an unreadable conversation says why', activityUnavailableMarkup.includes('Agent activity is not readable here') && activityUnavailableMarkup.includes('no reader here'))
// "Nothing has run" and "the first read is still in flight" are different things
// to a reader, and the model tells them apart by whether it has a reason yet.
check('activity view: a log with nothing run says so', renderActivityView([], {}).includes('No commands yet'))
check(
  'activity view: a read still in flight says so',
  renderToStaticMarkup(
    h(ActivityView, {
      sessionId: 's1',
      model: { groups: [], counts: { shell: 0, other: 0, running: 0, failed: 0, otherRunning: 0, otherFailed: 0 }, hasMore: false, available: false, reason: null, revision: 0 },
      onRunInTerminal: () => {},
      canRunInTerminal: false,
    }),
  ).includes('Reading the conversation'),
)

// -------------------------------------------------------------- dsh-rightbar
// The right bar is a GENERATED fork, so these are source-level checks (like the
// terminal's): what the fork must - and must not - contain once
// `sync-vendored.ps1` has rebuilt it from the core bundle plus its patch list.
// The dock's ceiling belongs to the kit (`MAX_DOCK_PANES = 4`, and the kit's own
// `canSplit` means "fewer than four"); the core bundle caps it at TWO in five
// places, which is what these assert the fork no longer does. A hand edit that
// skipped the patch list would show up here on the next re-sync.
const barSource = readFileSync(path.join(repo, 'packages/dsh-rightbar/lib/client.js'), 'utf8')
const syncSource = readFileSync(path.join(repo, 'scripts/sync-vendored.ps1'), 'utf8')
check('right bar has no two-pane cap', /dockPaneIds\)\((?:state|layout|surface\.layout)\)\.length [<>]=? 2/.test(barSource), false)
const dockTreeSource = readFileSync(path.join(repo, 'packages/dsh-rightbar/vendor/dock-tree.js'), 'utf8')
// alpha.3, and the reason the cap lift alone was not enough: the kit RENDERS a
// docked layout with `DockLayout`, which draws one pane or two side by side and
// THROWS on every other shape ("DockLayout requires one pane or two horizontally
// split panes"). A stacked pane - the 2x2 the top/bottom bands exist for - reached
// the shell's slot boundary as a crash, and an abdicated entry took the whole bar
// away until a reload. The fork renders the kit's recursive `DockSurface` instead,
// through its ONE hand-written component (packages/dsh-rightbar/vendor/dock-tree.js,
// spliced in by the sync script), keeping the four things the flat renderer gave
// for free: the `data-dockkit-host` box its own stylesheet hides the bar with, the
// kit's FloatLayer, the `active` / `expanded` gates, and `keepMounted`.
check(
  'right bar renders the recursive surface, and the flat renderer only as a fallback',
  barSource.includes('DockTree, {') &&
    barSource.includes('const Surface = dockkit.DockSurface;') &&
    barSource.includes('const Float = dockkit.FloatLayer;') &&
    // The flat renderer stays reachable for a kit line that has no surface - and
    // then the top/bottom bands go with it, because it cannot draw a stack.
    barSource.includes('if (typeof Surface !== "function")') &&
    barSource.includes('dropZones: "horizontal"') &&
    barSource.includes('dropZones: "edges",'),
)
check(
  'right bar keeps the four things the flat renderer provided',
  // 1. the bar's own stylesheet hides and slides the docked content through this -
  //    and turns the PANEL's pointer events OFF, which the flat renderer's per-tab
  //    hosts restored and the surface's panes do not (without it the whole bar is
  //    deaf to the mouse: measured in a real browser, every click passed through)
  barSource.includes('"data-dockkit-host": "dock"') &&
    barSource.includes('pointerEvents: "auto"') &&
    // 2. floats: the flat renderer drew them as grid cells, the surface does not
    barSource.includes('canCloseTab: props.canCloseTab') &&
    // 3. an off-screen session's panel, or a collapsed bar, mounts nothing
    barSource.includes('props.active !== false') &&
    barSource.includes('state.expanded === true') &&
    // 4. a retained tab (the shipped Browser type) stays mounted once shown
    barSource.includes('typeof keepMounted === "function"') &&
    barSource.includes('dockkit.findTabPane(state, tab.id)'),
)
check('right bar hands the limit to the kit', barSource.includes('canSplit: (0, _deepseek_ai_dsh_client_ui_dockkit.canSplit)(surface.layout),'))
check(
  'right bar names the four-pane ceiling',
  barSource.includes('"dock.splitPaneDisabled": "Four panes is the limit",') &&
    barSource.includes('"dock.splitPaneDisabled": "\u5df2\u8fbe\u56db\u683c\u4e0a\u9650",'),
)
// WHAT THE FLAT RENDERER'S TAB HOST GAVE THE DOCKED SURFACE, and the two things
// the renderer swap above took away with the 2x2. Both hang off markup only the
// FLAT renderer emits:
//
//   ._tabHost_<hash>:not(._float_<hash>)   {background:var(--dsw-alias-bg-base)}
//   ._tabCell_<hash>[data-dockkit-host=dock][data-dockkit-column="0"]>._tabHost_<hash>
//     {border-left:.5px solid var(--dsw-alias-border-l4)}
//
// `DockSurface` renders a bare `_pane_` with NO background and NEITHER attribute,
// so a surface-rendered bar is TRANSPARENT and has no left boundary. The seam was
// the visible one (two `--dsw-alias-bg-base` columns with no line between them);
// the missing FILL is invisible in push mode and only shows in FULLSCREEN, because
// that is the one state where the panel overlays something it is not the same
// colour as - the conversation - so every pixel the active tab does not paint
// itself shows the chat through it (the editor and the PDF viewer paint their own
// background; the History tab paints none, which is why it looked like a tab that
// "sometimes does not cover"). `DockTree` re-emits `data-dockkit-host="dock"` on a
// real box, so both declarations are pinned to that box - in the fork's
// stylesheet, and in the patch list a re-sync rebuilds it from.
check(
  'right bar draws its own left seam AND an opaque fill on the DockTree wrapper',
  // panelBody's first child is that wrapper, and the flat fallback renders no
  // such box - so neither declaration can double the kit's own.
  barSource.includes('.P3OORG_panelBody>[data-dockkit-host=dock]{background:var(--dsw-alias-bg-base);border-left:.5px solid var(--dsw-alias-border-l3)}') &&
    // ... and the OPEN gate is what keeps both off a COLLAPSED bar: closed, that
    // same box is translated out of the frame and `visibility:hidden`, so the fill
    // cannot paint a one-bar-wide rectangle over the conversation.
    barSource.includes('.P3OORG_panel[data-sidebar-right-open] [data-dockkit-host=dock]'),
)
check(
  'right bar cap lift, renderer, seam and fill are recorded patches',
  syncSource.includes('lift the two-pane cap') &&
    syncSource.includes('offer every drop band a pane has') &&
    syncSource.includes('draw the tree the kit plans, not the flat grid that refuses it') &&
    syncSource.includes('vendor/dock-tree.js') &&
    syncSource.includes('give the DockTree wrapper what the flat tab host provided'),
)
// THE FULLSCREEN BAR'S LAYER, and the third thing the renderer swap took away.
// `.P3OORG_panel` is `position:absolute` with `z-index:auto`, so it paints above
// the chat's in-flow content and UNDER every positioned element the app gives a
// positive z-index - the composer seat (`position:sticky; bottom:0; z-index:7`,
// 9 with a trigger menu open, on a gradient that fades to transparent over its
// top 36px), the frame's overlay layer (20), its leading seat (15) and its column
// resize handles (11), and the sidebar's fixed controls (30). The kit's own answer
// was the fullscreen dock layer - `--dsh-dockkit-dock-layer:40`, the z-index of
// its tab CELLS, ordered in the root stacking context because the panel does not
// create one - and `DockSurface` draws no tab cell, so the surface path lost that
// too. The layer is on the PANEL now: it covers the bar's own fill, and it keeps
// the float layer inside the panel's stacking context.
check(
  'right bar fullscreen panel carries the dock layer',
  /\[data-sidebar-right-panel=fullscreen\]\{--dsh-dockkit-dock-layer:40;z-index:40\}/.test(barSource),
)
// ... and 40 is not a taste: measured against the PINNED line, it is above every
// layer the shell's own bundles declare for persistent chrome, so the composer and
// the header seats can no longer sit on top of a fullscreen bar. The numbers are
// read back rather than restated, so a harness bump that moves the ladder shows up
// here instead of shipping a bar under the input box.
{
  const barLayer = /\[data-sidebar-right-panel=fullscreen\]\{[^}]*z-index:(\d+)/.exec(barSource)
  const chromeFiles = [
    ['layout', '@deepseek-ai/dsh-client-ui-layout/lib/client.js'],
    ['sidebar', '@deepseek-ai/dsh-client-ui-sidebar/lib/client.js'],
  ]
  const found = chromeFiles.map(([label, relative]) => {
    const file = findCoreFile(relative)
    if (file === null) return null
    const values = [...readFileSync(file, 'utf8').matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1]))
    return { label, max: values.length === 0 ? 0 : Math.max(...values) }
  })
  if (barLayer === null || found.includes(null)) {
    console.log('skip the fullscreen bar sits above the shell chrome (no pinned core bundle on this host)')
  } else {
    const highest = Math.max(...found.map((entry) => entry.max))
    check(
      'the fullscreen bar sits above the shell own chrome',
      Number(barLayer[1]) > highest
        ? 'bar ' + barLayer[1] + ' > ' + found.map((entry) => entry.label + ' ' + entry.max).join(', ')
        : 'bar ' + barLayer[1] + ' <= ' + found.map((entry) => entry.label + ' ' + entry.max).join(', '),
      'bar 40 > ' + found.map((entry) => entry.label + ' ' + entry.max).join(', '),
    )
  }
}
check(
  'right bar fullscreen layer and wrapper fill are recorded patches',
  syncSource.includes('put the fullscreen bar on the dock layer above the shell chrome') &&
    syncSource.includes('give the DockTree wrapper what the flat tab host provided'),
)
// The generated fork's one hand-written component must BE the fragment beside the
// patch list, byte for byte: a hand edit in either place would otherwise drift
// silently, which is exactly what the fork/patch-list split exists to prevent.
{
  const vendorComponent = dockTreeSource.slice(dockTreeSource.indexOf('\t\t/**')).replace(/\r\n/g, '\n').trimEnd()
  const from = barSource.indexOf('\t\t/**\n\t\t * The dock renderer')
  const to = barSource.indexOf('\n\t\tfunction intentsFor(', from)
  const forkComponent = from < 0 || to < 0 ? '' : barSource.slice(from, to)
  check(
    'the renderer in the fork is byte-for-byte the vendor fragment',
    forkComponent === vendorComponent ? 'same' : String(forkComponent.length) + ' vs ' + String(vendorComponent.length),
    'same',
  )
}

// -------------------------------------------------------------- dsh-browser
// The Browser tab, and the REPLACEMENT for the shipped iframe one. This bundle
// is hand-written (no generated fork), so these are source-level pins on the two
// things that would quietly undo the package's whole point: a remote frame
// reappearing, and the master layer re-enabling the row the package disabled.
{
  const browserSource = readFileSync(path.join(repo, 'packages/dsh-browser/lib/client.js'), 'utf8')
  check(
    'browser tab keeps the replaced package identity',
    browserSource.includes("const TYPE_ID = '@deepseek-ai/dsh-client-ui-sidebar-browser'") &&
      browserSource.includes("const KIND = 'browser'") &&
      browserSource.includes("'sidebar://' + KIND"),
  )
  // The shipped tab's entire design was one <iframe src=the site>; this one must
  // never CONSTRUCT a frame, so the site's own code can never run in this origin.
  // (The prose in the file may name the tag; only construction is refused.)
  check(
    'browser tab builds no frame at all',
    browserSource.includes("createElement('iframe')") === false &&
      browserSource.includes("'<iframe") === false &&
      browserSource.includes('"<iframe') === false &&
      browserSource.includes('srcDoc') === false,
  )
  check(
    'browser tab draws four views from one render',
    ['visual', 'reader', 'metrics', 'policy'].every((view) => browserSource.includes("'" + view + "'")),
  )
  check(
    'browser tab states the parked live mode and the untrusted-data rule',
    browserSource.includes('LIVE_PARKED') && browserSource.includes('data, not instructions'),
  )
  check(
    'browser tab registers a toolview card per tool',
    browserSource.includes("const TOOL_NAMES = ['browser_render', 'browser_query', 'browser_text']") &&
      browserSource.includes("const TOOLVIEW_SLOT = 'tool.call.toolview'"),
  )
  check(
    'browser tab discards a render the reader moved past',
    browserSource.includes('const mine = ++token.current') && browserSource.includes('if (mine !== token.current) return'),
  )
  check(
    'browser tab is a module-table bundle with a pure half for the check',
    browserSource.includes('window.__ModuleLoader__.load({') &&
      browserSource.includes("id: 'dsh-browser'") &&
      browserSource.includes('exports.__internals'),
  )
  // ... and the bundle is LOADED and RENDERED, not merely grepped: a tab that
  // crashes on mount would otherwise ship, because the source pins above cannot
  // see a bad prop, a missing import or a hook used outside a component.
  const browserBundle = loadBundle('packages/dsh-browser/lib/client.js', {})
  check('browser bundle id', browserBundle.id, 'dsh-browser')
  check('browser bundle inject', JSON.stringify(browserBundle.exports.inject), '["slots","sidebarRightTabs"]')
  const browserTypes = []
  const browserSeats = {}
  browserBundle.exports.apply({
    slots: {
      inject: (_name, fn) => fn(),
      register(spec, component) {
        browserSeats[spec.name + '#' + String(spec.key)] = { spec, component }
        return () => {}
      },
    },
    sidebarRightTabs: {
      register(definition) {
        browserTypes.push(definition)
        return () => {}
      },
    },
    get: () => undefined,
    effect: (fn) => {
      const off = fn()
      return typeof off === 'function' ? off : () => {}
    },
    logger: { debug: () => {}, warn: () => {}, info: () => {} },
  })
  const TAB_KEY = 'sidebar.right.pane.tab#@deepseek-ai/dsh-client-ui-sidebar-browser'
  check('browser registers exactly one tab type', browserTypes.length, 1)
  check(
    'browser tab type keeps the replaced identity and is multiple',
    browserTypes[0].id + '/' + browserTypes[0].kind + '/' + String(browserTypes[0].multiple) + '/' + browserTypes[0].priority,
    '@deepseek-ai/dsh-client-ui-sidebar-browser/browser/true/builtin',
  )
  check('browser guide entry keeps the Start page slot at 30', browserTypes[0].guide.map((entry) => entry.order).join(','), '30')
  check(
    'browser seats register: the body, the title and one card per tool',
    Object.keys(browserSeats).sort().join(','),
    [
      'sidebar.right.pane.tab#@deepseek-ai/dsh-client-ui-sidebar-browser',
      'sidebar.right.pane.tab.title#@deepseek-ai/dsh-client-ui-sidebar-browser',
      'tool.call.toolview#browser_query',
      'tool.call.toolview#browser_render',
      'tool.call.toolview#browser_text',
    ]
      .sort()
      .join(','),
  )
  const BrowserBody = browserSeats[TAB_KEY].component
  const emptyMarkup = renderToStaticMarkup(h(BrowserBody, { sessionId: 'sess-1' }))
  check('browser body mounts and draws the first-run state', emptyMarkup.includes('dsb-address') && emptyMarkup.includes('renders on the host'), true)
  check('browser body builds no frame', emptyMarkup.includes('<iframe'), false)
  const BrowserTitleSeat = browserSeats['sidebar.right.pane.tab.title#@deepseek-ai/dsh-client-ui-sidebar-browser'].component
  check('browser title reads Browser before an address', renderToStaticMarkup(h(BrowserTitleSeat, { sessionId: 'sess-1' })).includes('Browser'), true)
  // Every view, over one manufactured render result: the four code paths run.
  const internals = browserBundle.exports.__internals
  const tabState = internals.stateFor('tab-under-test')
  tabState.url = 'https://example.com/'
  tabState.report = {
    ok: true,
    request: { url: 'https://example.com/', width: 1440, height: 900, dpr: 1 },
    finalUrl: 'https://example.com/',
    title: 'Example Domain',
    image: { id: 'b'.repeat(24), width: 1440, height: 900, bytes: 20000, clipped: false },
    scroll: { width: 1440, height: 2600 },
    counts: { elements: 12, links: 1, images: 0, forms: 0, fonts: 1 },
    loadEvent: true,
    timing: { totalMs: 1200, navigateMs: 700 },
    pageHosts: ['example.com'],
    pageRequests: 4,
    text: 'This domain is for use in documentation examples.',
    links: [{ text: 'More information', href: 'https://iana.org/domains/example' }],
    engine: { kind: 'chrome', file: 'chrome.exe', source: 'install' },
    gate: { port: 1234, tunnels: 3, challenges: 12, refused: 1, bytesDown: 12000, allowed: [{ host: 'example.com', address: '93.184.216.34' }], refusals: [{ host: 'tracker.example', code: 'DESTINATION_NOT_PUBLIC', reason: '' }] },
  }
  const views = {}
  for (const view of ['visual', 'reader', 'metrics', 'policy']) {
    tabState.view = view
    views[view] = renderToStaticMarkup(h(BrowserBody, { tabId: 'tab-under-test' }))
  }
  check('browser draws every view without a frame', Object.values(views).every((markup) => markup.includes('dsb-') && markup.includes('<iframe') === false), true)
  check('browser visual view draws the artifact through the image route', views.visual.includes('/api/dsh-browser/image?id=' + 'b'.repeat(24)), true)
  check('browser reader view draws the rendered text and its links', views.reader.includes('documentation examples') && views.reader.includes('iana.org'), true)
  check('browser metrics view draws the page numbers', views.metrics.includes('1440') && views.metrics.includes('2600'), true)
  check('browser policy view names the gate, its refusals and the engine probe', views.policy.includes('Tunnels opened') && views.policy.includes('DESTINATION_NOT_PUBLIC'), true)
  const card = browserSeats['tool.call.toolview#browser_render'].component
  const cardMarkup = renderToStaticMarkup(h(card, { result: { view: internals.stateFor('tab-under-test').report && { ok: true, url: 'https://example.com/', title: 'Example Domain', imageId: 'c'.repeat(24), width: 1440, height: 900, tunnels: 3, refused: 0, viewport: { width: 1440, height: 900 } } } }))
  check('a tool card draws the screenshot and the egress facts', cardMarkup.includes('/api/dsh-browser/image?id=' + 'c'.repeat(24)) && cardMarkup.includes('3 tunnel(s)') && cardMarkup.includes('Open the Browser tab'), true)
  // The master-layer rule, kept beside the load test.
  const masterPatch = readFileSync(path.join(repo, 'packages', 'dsh-vn-master', 'cordis.patch.yml'), 'utf8')
  check('the master does not re-enable the browser row', /- id: ui-sidebar-browser\s*\n\s+disabled: false/.test(masterPatch), false)
  const browserManifest = JSON.parse(readFileSync(path.join(repo, 'packages', 'dsh-browser', 'package.json'), 'utf8'))
  check(
    'the browser bundle declares its patch, its client half and its skills',
    browserManifest.dsh?.bundle?.patch === './cordis.patch.yml' &&
      browserManifest.dsh?.client?.platform === 'web' &&
      browserManifest.files.includes('skills'),
  )
}

// ------------------------------------------------------------- dsh-diagrams
// The diagrams bundle registers TWO tab types (one per diagram, plus the
// conversation index whose guide entry opens it), their keyed bodies and
// titles, and one conversation card per diagram tool. These checks drive the
// real factory with a stub ctx and render the seats the shell would render.
const diagrams = loadBundle('packages/dsh-diagrams/lib/client.js', {})
check('diagrams bundle id', diagrams.id, 'dsh-diagrams')
check(
  'diagrams inject',
  JSON.stringify(diagrams.exports.inject),
  '["slots","sidebarRightTabs"]',
)
const diagTypes = []
const diagSeats = {}
const openedTabs = []
const diagTabTypes = { register: (definition) => (diagTypes.push(definition), () => {}), entries: () => [] }
diagrams.exports.apply({
  slots: {
    inject: (name, fn) => fn(),
    register(spec, component) {
      diagSeats[spec.name + (spec.key ? '#' + spec.key : '')] = { spec, component }
      return () => {}
    },
  },
  sidebarRightTabs: diagTabTypes,
  get: (name) => (name === 'sidebarRight' ? { openResource: (address) => openedTabs.push(address) } : undefined),
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
check('diagrams registers two tab types', diagTypes.length, 2)
// The stylesheet is injected when the row activates (apply), so it is read
// here rather than at load time.
const diagCssTag = diagrams.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-diagrams/diagrams.css').pop()
const diagCss = diagCssTag ? diagCssTag.textContent : ''
check(
  'diagrams stylesheet injected',
  diagCss.includes('.dsd-root{') &&
    diagCss.includes('.dsd-card{') &&
    diagCss.includes('.dsd-pill[data-status="ok"]') &&
    diagCss.includes('.dsd-svg svg{') &&
    diagCss.includes('.dsd-zoomBox{') &&
    diagCss.includes('.dsd-zoomBar{'),
)
// The panel's toolbar is the same 38px border-box top bar the Files tab, the
// document preview, the editor and the History tab use, so every right-column
// pane draws its first hairline on the y=76 line.
check(
  'diagrams top bar is the 38px pane header',
  diagCss.includes('.dsd-tools{flex:none;display:flex;align-items:center;gap:6px;box-sizing:border-box;height:38px;padding:0 10px 0 12px;'),
)
const viewerType = diagTypes.find((entry) => entry.kind === 'diagram')
const indexType = diagTypes.find((entry) => entry.kind === 'diagrams')
check('viewer type identity', viewerType.id, 'dsh-diagrams-viewer')
check('index type identity', indexType.id, 'dsh-diagrams-index')
// One tab per DIAGRAM: a resource kind whose glob owns the address the host's
// tool results carry, in the extension band so it beats any shipped viewer.
check(
  'viewer owns the diagram address grammar',
  viewerType.patterns.join(',') + '/' + viewerType.priority,
  'dsh-resource://diagram/session/**,dsh-resource://diagram/library/**/extension',
)
check('viewer claims a host address', viewerType.patterns[0].includes('dsh-resource://diagram/session/'))
// A LIBRARY address names no conversation: that is what makes one tab - and one
// citation - work from every chat.
check('viewer claims the library address too', viewerType.patterns[1] === 'dsh-resource://diagram/library/**')
check('viewer has no guide entry', viewerType.guide === undefined)
// The index is a PAGE type: no patterns, so it never competes for a file
// address, and its one guide entry sits after Files (10), Editor (20) and
// History (30) on the "+" / Start page.
check('index is a page type', indexType.patterns === undefined)
check('index guide entry', indexType.guide.map((entry) => entry.order + ':' + entry.title()).join(','), '40:Diagrams')
check('index chip title', indexType.title(), 'Diagrams')
check(
  'diagrams seats',
  Object.keys(diagSeats).sort().join(','),
  [
    'sidebar.right.pane.tab#dsh-diagrams-index',
    'sidebar.right.pane.tab#dsh-diagrams-viewer',
    'sidebar.right.pane.tab.title#dsh-diagrams-index',
    'sidebar.right.pane.tab.title#dsh-diagrams-viewer',
    'tool.call.toolview#diagram_delete',
    'tool.call.toolview#diagram_patch',
    'tool.call.toolview#diagram_publish',
    'tool.call.toolview#diagram_read',
    'tool.call.toolview#diagram_verify',
    'tool.call.toolview#diagram_write',
  ].join(','),
)
// The chip of a diagram tab is the diagram's own name; with nothing loaded yet
// it falls back to the id the address carries rather than an empty chip.
const viewerAddress = 'dsh-resource://diagram/session/sess-1/auth-flow'
check('viewer chip falls back to the address id', viewerType.title(viewerAddress), 'auth-flow')

const ViewerBody = diagSeats['sidebar.right.pane.tab#dsh-diagrams-viewer'].component
const viewerTab = { id: 'tabD', contentId: viewerAddress, title: 'auth-flow', navigation: { revision: 0 } }
const viewerMarkup = renderToStaticMarkup(h(ViewerBody, { useTabInfo: () => ({ tab: viewerTab }), sessionId: 'sess-1' }))
check('viewer body waits for the store', viewerMarkup.includes('Loading the diagram...'))
const badTab = { id: 'tabE', contentId: 'sidebar://diagrams', title: 'Diagrams', navigation: { revision: 0 } }
check(
  'viewer body rejects a non-diagram address',
  renderToStaticMarkup(h(ViewerBody, { useTabInfo: () => ({ tab: badTab }), sessionId: 'sess-1' })).includes('carries no diagram address'),
)

const IndexBody = diagSeats['sidebar.right.pane.tab#dsh-diagrams-index'].component
const indexMarkup = renderToStaticMarkup(h(IndexBody, { sessionId: 'sess-1' }))
check('index body renders its empty state', indexMarkup.includes('Nothing yet: this conversation has no diagrams and the library is empty.'))
check(
  'index body offers both engines',
  indexMarkup.includes('>New Mermaid<') && indexMarkup.includes('>New TikZ<') && indexMarkup.includes('dsh-diagrams 0.1.0-alpha.7'),
)
// The index is where the LIBRARY becomes visible: the file bar always counts
// both halves, and the two labelled lists are asserted from the source below
// (with an empty store the page draws its empty state instead).
check('index counts the shared library', indexMarkup.includes('in the library') && indexMarkup.includes(' here'))
check('index title seat', renderToStaticMarkup(h(diagSeats['sidebar.right.pane.tab.title#dsh-diagrams-index'].component, {})), 'Diagrams')

// The conversation card draws from the tool call itself, so it is right on
// replay. The block shapes are the SHELL's: a call still running is a call
// block with no `kind` (`ui-tool` reads `done = "kind" in block`), and a
// settled call is a `tool-result` block carrying `call.argsRaw` plus the
// presentation `meta` the host declared - which is where a `diagram_write`
// gets its id, because the write itself never names one.
const WriteCard = diagSeats['tool.call.toolview#diagram_write'].component
const writeArgs = JSON.stringify({ kind: 'tikz', title: 'Layers', source: '\\node {A};' })
const runningMarkup = renderToStaticMarkup(
  h(WriteCard, {
    toolName: 'diagram_write',
    sessionId: 'sess-1',
    block: { callId: 'c1', name: 'diagram_write', argsRaw: writeArgs, subCalls: [] },
  }),
)
check('write card shows the pending state', runningMarkup.includes('Writing a diagram...'))
check('write card offers no link while it runs', runningMarkup.includes('Open tab') === false)
const settledMarkup = renderToStaticMarkup(
  h(WriteCard, {
    toolName: 'diagram_write',
    sessionId: 'sess-1',
    block: {
      kind: 'tool-result',
      callId: 'c1',
      call: { name: 'diagram_write', argsRaw: writeArgs },
      content: [{ type: 'text', text: 'Wrote diagram "layers" (tikz) - status: ok.' }],
      isError: false,
      meta: {
        id: 'layers',
        kind: 'tikz',
        title: 'Layers',
        status: 'ok',
        address: 'dsh-resource://diagram/session/sess-1/layers',
      },
      subCalls: [],
    },
  }),
)
check('a settled write is not still writing', settledMarkup.includes('Writing a diagram...') === false)
check(
  'write card names the diagram the host created',
  settledMarkup.includes('TikZ') && settledMarkup.includes('Layers') && settledMarkup.includes('layers'),
)
check('write card links its tab', settledMarkup.includes('>Open tab<'))
check('write card keeps the picture behind the toggle', settledMarkup.includes('>Show<') && settledMarkup.includes('dsd-cardBody') === false)
// A call that never settled (an interrupted turn) still has to render honestly
// instead of claiming a diagram it never wrote.
const callOnlyMarkup = renderToStaticMarkup(
  h(WriteCard, {
    toolName: 'diagram_write',
    sessionId: 'sess-1',
    block: { callId: 'c2', name: 'diagram_write', argsRaw: JSON.stringify({ kind: 'mermaid', source: 'flowchart TD\n A-->B' }), subCalls: [] },
  }),
)
check('write card survives a call with no title yet', callOnlyMarkup.includes('dsd-card'))
// A replayed log can settle a call whose call block is gone (`call: null`): the
// view in `meta` still names the diagram, and nothing may dereference the args.
const calllessMarkup = renderToStaticMarkup(
  h(WriteCard, {
    toolName: 'diagram_write',
    sessionId: 'sess-1',
    block: {
      kind: 'tool-result',
      callId: 'c6',
      call: null,
      content: [{ type: 'text', text: 'Wrote diagram "layers" (tikz) - status: ok.' }],
      isError: false,
      meta: { id: 'layers', kind: 'tikz', title: 'Layers', status: 'ok' },
      subCalls: [],
    },
  }),
)
check('write card survives a missing call block', calllessMarkup.includes('Layers') && calllessMarkup.includes('>Open tab<'))

const ReadCard = diagSeats['tool.call.toolview#diagram_read'].component
check(
  'read card names the index',
  renderToStaticMarkup(h(ReadCard, { toolName: 'diagram_read', sessionId: 'sess-1', block: { callId: 'c3', name: 'diagram_read', argsRaw: '{}', subCalls: [] } })).includes(
    'Diagram index',
  ),
)
const readNamedMarkup = renderToStaticMarkup(
  h(ReadCard, {
    toolName: 'diagram_read',
    sessionId: 'sess-1',
    block: {
      kind: 'tool-result',
      callId: 'c4',
      call: { name: 'diagram_read', argsRaw: JSON.stringify({ id: 'auth-flow' }) },
      content: [{ type: 'text', text: 'auth-flow' }],
      isError: false,
      meta: { id: 'auth-flow', kind: 'mermaid', title: 'Auth flow', status: 'ok', address: 'dsh-resource://diagram/session/sess-1/auth-flow' },
      subCalls: [],
    },
  }),
)
check('read card links the diagram it read', readNamedMarkup.includes('auth-flow') && readNamedMarkup.includes('>Open tab<'))
const DeleteCard = diagSeats['tool.call.toolview#diagram_delete'].component
check(
  'delete card is a one-liner',
  renderToStaticMarkup(
    h(DeleteCard, { toolName: 'diagram_delete', sessionId: 'sess-1', block: { callId: 'c5', name: 'diagram_delete', argsRaw: JSON.stringify({ id: 'old-one' }), subCalls: [] } }),
  ).includes('Deleted diagram') &&
    renderToStaticMarkup(
      h(DeleteCard, { toolName: 'diagram_delete', sessionId: 'sess-1', block: { callId: 'c5', name: 'diagram_delete', argsRaw: JSON.stringify({ id: 'old-one' }), subCalls: [] } }),
    ).includes('old-one'),
)
// A mounted index tab re-reads the host when it becomes visible again: that is
// what keeps an open "Diagrams" page in step with writes made in the chat.
check(
  'the index re-reads on visibility',
  readFileSync(path.join(repo, 'packages/dsh-diagrams/lib/client.js'), 'utf8').includes('tabInfoNow(props)'),
)
// The client never invents the host's routes: the vendored engine, the state
// and the artifact routes are the ones lib/index.js registers.
const diagSource = readFileSync(path.join(repo, 'packages/dsh-diagrams/lib/client.js'), 'utf8')
check(
  'client routes match the host half',
  [
    '/api/dsh-diagrams/state',
    '/api/dsh-diagrams/diagram',
    '/api/dsh-diagrams/artifact',
    '/api/dsh-diagrams/export',
    '/api/dsh-diagrams/render-report',
    '/api/dsh-diagrams/vendor/mermaid.js',
  ].every((route) => diagSource.includes(route)),
)
check('client loads the engine as a classic script', diagSource.includes('new Blob([source]') && diagSource.includes('window.mermaid'))

// THE RENDER TRAP. `mermaid.render(id, source)` with no container builds a
// `#d<id>` div on document.body and only removes it on the success path; when
// the engine drew its own error diagram into it first, what stays in the page
// is a full-size "Syntax error in text / mermaid version <v>" picture - one per
// failed render. Three things keep that out of the interface, and all three are
// load-bearing, so each is asserted here rather than left to review.
check('the engine is told never to draw its own errors', diagSource.includes('suppressErrorRendering: true'))
check('a source is parsed before it is rendered', diagSource.indexOf('await mermaid.parse(text)') < diagSource.indexOf('await mermaid.render('))
check(
  'every render goes into a container the plugin owns',
  /mermaid\.render\(id,\s*text,\s*mermaidHost\(\)\)/.test(diagSource),
)
check('the render host is offscreen and out of the flow', /renderHost\.style\.cssText[^\n]*left:-100000px/.test(diagSource))
check('engine fixtures are swept even when the render throws', /finally \{[\s\S]{0,120}sweepMermaidFixtures\(\)/.test(diagSource))
// The one entry point the pictures use hands back a verdict instead of
// throwing, so no surface has to remember the parse/render order.
check('the pictures go through the safe renderer', diagSource.includes('renderMermaidSafe(source, dark)'))
check('exports refuse a diagram that does not render', /async function mermaidSvgNow[\s\S]{0,400}if \(!result\.ok\)/.test(diagSource))
// A Mermaid source the host already refused is never handed to the engine: it
// has no picture to make, and asking anyway is exactly what used to produce an
// engine error diagram.
check(
  'a refused Mermaid source is never rendered',
  /entry\.kind === 'mermaid' && entry\.status === 'error'/.test(diagSource) && diagSource.includes('does not parse, so there is nothing to draw'),
)

// ZOOM. A diagram is read whole first and zoomed in on second, so the picture is
// laid out at 80% of the pane and the ladder moves the BOX rather than applying a
// CSS transform: a transform scales into a clipped box with no scrollable area,
// and the reader could never reach the edge of a zoomed diagram.
check('the reader gets a zoom ladder', /const ZOOM_STEPS = \[0\.25, 0\.5, 0\.75, 1, 1\.25, 1\.5, 2, 3, 4\]/.test(diagSource))
check('100% is 80% of the pane', diagSource.includes('const ZOOM_FIT_WIDTH = 80'))
check('the picture is laid out as a share of the pane', diagSource.includes("style: { width: ZOOM_FIT_WIDTH * zoom + '%' }"))
check('zooming in lets the picture outgrow its natural width', diagSource.includes("'data-zoomed': zoom > ZOOM_DEFAULT"))
check('zoom is remembered per diagram', diagSource.includes('zoomMemory.set(zoomKey, next)'))
check('the canvas can scroll a zoomed diagram to its left edge', diagCss.includes('justify-content:flex-start'))
check('the zoom box never shrinks to fit', /\.dsd-zoomBox\{flex:none;/.test(diagCss))
check(
  'a zoomed mermaid svg overrides the max-width the engine writes',
  diagCss.includes('.dsd-zoomBox[data-zoomed="true"] .dsd-svg svg{width:100%;max-width:none!important;height:auto}'),
)
// The two ways this zoom could silently zoom nothing, both of them real defects
// found by using it: a column flex container sizes its children to their CONTENT
// on the cross axis, so the `.dsd-svg` wrapper stayed at the svg's natural width
// however wide the box became; and without an explicit `width:100%` on that
// wrapper the svg's own `width:100%` resolved against the wrapper, not the box.
check(
  'every child of a zoomed box is stretched to it',
  diagCss.includes('.dsd-zoomBox[data-zoomed="true"] > *{align-self:stretch}'),
)
check(
  'the picture wrapper fills the box',
  diagCss.includes('.dsd-svg{width:100%;max-width:100%;display:flex;justify-content:center}'),
)
check(
  'readable blocks do not stretch with the zoom',
  diagCss.includes('max-width:720px') && diagCss.includes('.dsd-diags{margin:0 auto;'),
)
// PAN. The picture is laid out at real size in a scrollable box, so a drag moves
// the SCROLL POSITION: no transform, nothing repositioned, and the wheel keeps
// working. A picture that fits must not offer a grab cursor, and a wide diagram
// at 100% must, because it overflows with no zoom at all.
check(
  'a drag pans the scroll position, not a transform',
  /canvas\.scrollLeft = start\.left - \(event\.clientX - start\.x\)/.test(diagSource) &&
    diagSource.includes('canvas.scrollTop = start.top - (event.clientY - start.y)'),
)
check('the drag captures the pointer', diagSource.includes('canvas.setPointerCapture(event.pointerId)'))
check(
  'the canvas is the pan surface',
  diagCss.includes('.dsd-canvas[data-pannable="true"]{cursor:grab}') && diagCss.includes('.dsd-canvas[data-panning="true"]{cursor:grabbing'),
)
check(
  'a picture that fits never offers a grab cursor',
  diagSource.includes("'data-pannable': pannable ? 'true' : undefined") &&
    diagSource.includes('canvas.scrollWidth > canvas.clientWidth + 1'),
)
check(
  'the native drag of a picture cannot steal the pan',
  diagSource.includes('draggable: false') && diagCss.includes('-webkit-user-drag:none'),
)
check(
  'a zoom keeps the point the reader was looking at',
  diagSource.includes('element.scrollLeft = anchor.x * element.scrollWidth - element.clientWidth / 2') &&
    diagSource.includes('window.requestAnimationFrame(restore)'),
)

// EXPORT. Every format is saved to the Desktop of the machine running the
// harness by the host route - the same deal the screenshot control makes, with
// the client naming a format and never a path. The browser download survives
// only as the fallback for a profile without that route.
check('the export menu saves to the Desktop', diagSource.includes('Save to the Desktop') && diagSource.includes("'Save .' + format"))
check(
  'the export reports the absolute path the host wrote',
  diagSource.includes("setStatus('saved to ' + (answer && answer.path ? answer.path : 'the Desktop'))"),
)
check('the browser download survives as a fallback', diagSource.includes("'Download .' + format + ' in the browser'"))

// VERDICT LABELS. Four objective states, and an absent report is never read as a
// picture: the pill draws what the host computed and falls back to the same four
// answers rather than inventing an optimistic one.
check('the pill draws the host verdict', diagSource.includes('entry.verification ? entry.verification : renderVerdictOf(entry)'))
check('the client keeps a fallback verdict for an older host', /function renderVerdictOf\(entry\)/.test(diagSource))
const fallbackVerdict = diagSource.slice(diagSource.indexOf('function renderVerdictOf'), diagSource.indexOf('function verdictTitle'))
check('a missing report is never read as a picture', fallbackVerdict.includes("if (!report) return { state: 'pending'"))
check(
  'the fallback carries the same four answers',
  fallbackVerdict.includes("state: 'stale'") && fallbackVerdict.includes("state: report.ok ? 'drawn' : 'failed'"),
)
check(
  'a failed render is red, an absent verdict is neutral',
  diagCss.includes('.dsd-pill[data-status="error"],.dsd-pill[data-status="failed"]') &&
    diagCss.includes('.dsd-pill[data-status="unchecked"],.dsd-pill[data-status="pending"],.dsd-pill[data-status="stale"]'),
)

// LIBRARY. A diagram published to the shared store is the same diagram in every
// conversation, and its address names no conversation - which is what makes one
// citation work from anywhere. The client has to know all of that: a second list
// in the store, a second address shape, and a scope on every request that names
// a diagram.
check(
  'the library address opens without a session',
  diagSource.includes('function addressFor(sessionId, diagramId, scope)') &&
    diagSource.includes('if (scope === LIBRARY_SCOPE) return LIBRARY_PREFIX + encodeURIComponent(diagramId)'),
)
check(
  'the address parser knows both shapes',
  /if \(text\.startsWith\(LIBRARY_PREFIX\)\)/.test(diagSource) && diagSource.includes("scope: 'conversation', sessionId: decodeURIComponent"),
)
check(
  'the store keeps the two halves apart',
  diagSource.includes('libraryById') && diagSource.includes('store.library = Array.isArray(payload && payload.library)'),
)
check(
  'an id with no scope resolves library-first, like the host',
  /function entryNow\(sessionId, diagramId, scope\)[\s\S]{0,400}return store\.libraryById\.get\(diagramId\) \?\? store\.byId\.get\(diagramId\)/.test(diagSource),
)
check(
  'the index shows both halves, library first',
  diagSource.includes("'Library - every conversation sees these") &&
    diagSource.includes("'This conversation'") &&
    diagCss.includes('.dsd-listHead{'),
)
check(
  'the scope travels with every request that names a diagram',
  diagSource.includes('revision, scope, ...report') &&
    diagSource.includes("'&scope=' +") &&
    diagSource.includes('{ session: sessionId, id: diagramId, format, data, scope }') &&
    diagSource.includes('scope,\n              recompile:') &&
    diagSource.includes('scope: entry.scope'),
)

// ------------------------------------------------------------------ dsh-pdf
const pdf = loadBundle('packages/dsh-pdf/lib/client.js', {})
const pdfCssTag = pdf.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-pdf/pdf.css').pop()
const pdfCss = pdfCssTag ? pdfCssTag.textContent : ''
const pdfSource = readFileSync(path.join(repo, 'packages/dsh-pdf/lib/client.js'), 'utf8')
check('pdf bundle id', pdf.id, 'dsh-pdf')
check('pdf inject', JSON.stringify(pdf.exports.inject), '["slots","sidebarRightTabs"]')
check('pdf stylesheet injected', pdfCss.includes('.dpf-root{') && pdfCss.includes('.dpf-tools{'))
// The toolbar is this tab's top bar: the same 38px border-box pane header the
// Files tab, the document preview, the editor and History use, so every
// column's first hairline lands on the same y=76 line.
check(
  'pdf top bar is the 38px pane header',
  pdfCss.includes('.dpf-tools{flex:none;display:flex;align-items:center;gap:6px;box-sizing:border-box;height:38px;'),
)
// The reader is a real reader, and these are the parts that make it one: a text
// layer pdf.js can position, the scale variable pdf.js reads (v6 uses
// --total-scale-factor, not v3's --scale-factor), and hit highlighting.
check(
  'the text layer keeps pdf.js contracts',
  pdfCss.includes('.dpf-textLayer span,.dpf-textLayer br{position:absolute;white-space:pre;') &&
    pdfCss.includes('--total-scale-factor:1;--scale-round-x:1px;--scale-round-y:1px') &&
    pdfCss.includes('.dpf-textLayer mark{'),
)
// The engine is never inlined: the harness reads every client bundle at boot,
// so pdf.js (1.8 MB) is fetched from this plugin's own routes on first use.
check('the engine is not inlined', pdfSource.length < 220000 && pdfSource.includes('pdfjsVersion') === false)
check('the engine comes from a route', pdfSource.includes("API_ROOT + '/vendor/pdf.min.mjs'") && pdfSource.includes("API_ROOT + '/vendor/pdf.worker.min.mjs'"))
check('the worker is handed over as a blob URL', pdfSource.includes('pdfjs.GlobalWorkerOptions.workerSrc = workerUrl'))
check('the engine is imported as a module blob', pdfSource.includes('await import(/* webpackIgnore: true */ engineUrl)'))
// The route registry matches EXACT paths only, so the cMap and standard-font
// trees cannot be fetched file by file: one map per kind is decoded on demand.
check(
  'assets arrive as one map per kind',
  pdfSource.includes("API_ROOT + '/vendor/cmaps.json'") &&
    pdfSource.includes("API_ROOT + '/vendor/standard-fonts.json'") &&
    pdfSource.includes('BinaryDataFactory: MapBinaryDataFactory'),
)
// pdf.js validates all three factory parameters with its own getFactoryUrlProp()
// even when a custom BinaryDataFactory is supplied, so a bare route killed every
// document with `Invalid factory url: ".../cmaps.json" must include trailing
// slash.` before a page was read. What is handed over is therefore the route
// PLUS a slash - and the route itself stays bare, because the route registry
// matches exact paths and `.../cmaps.json/` is not one of them.
check(
  'the factory urls pdf.js validates are slash-terminated',
  pdfSource.includes("const factoryUrl = (route) => route + '/'") &&
    pdfSource.includes('cMapUrl: factoryUrl(VENDOR_CMAPS),') &&
    pdfSource.includes('standardFontDataUrl: factoryUrl(VENDOR_FONTS),') &&
    pdfSource.includes('wasmUrl: factoryUrl(VENDOR_WASM),') &&
    pdfSource.includes("VENDOR_CMAPS = API_ROOT + '/vendor/cmaps.json'") &&
    pdfSource.includes("VENDOR_FONTS = API_ROOT + '/vendor/standard-fonts.json'") &&
    pdfSource.includes("VENDOR_WASM = API_ROOT + '/vendor/wasm.json'"),
)
// alpha.5: the bytes of an open belong to pdf.js, and the WORKER is the
// reader's to release. `getDocument` hands `data` to the worker as a transfer,
// which detaches the array, so a cached Uint8Array poisons its address for every
// LATER open of the same document:
//
//   Failed to execute 'postMessage' on 'Worker': An ArrayBuffer is detached and
//   could not be cloned.
//
// - the reader's "This PDF could not be opened" on the SECOND visit (a Retry, a
// password reopen, a reopened tab, two panes on one file) while the first visit
// worked. So there is no byte cache in this bundle, every open reads the route
// again (`loadDocumentBytes`), and the loading task - which owns the worker and
// the parsed document - is destroyed when the tab unmounts or the open is
// replaced. `check-pdf-node.mjs` proves the engine's side of the rule with the
// real pdf.js.
check(
  'the reader caches no PDF bytes (pdf.js detaches what it is given)',
  pdfSource.includes('documentCache') === false &&
    pdfSource.includes('async function loadDocumentBytes(parsed)') &&
    pdfSource.includes('const bytes = await loadDocumentBytes(parsed)') &&
    pdfSource.includes('data: bytes,'),
)
check(
  'the reader tears its loading task down',
  pdfSource.includes('let task = null') &&
    pdfSource.includes('task = engine.getDocument({') &&
    pdfSource.includes('task.destroy()') &&
    pdfSource.includes('// A tab that went away while the bytes were in flight must not'),
)
// alpha.6: the page column must fit the PANE, at any width, and a fit the reader
// can re-apply. Two faults met here, and both were measured in Chrome against
// this file's own dress:
//
//   1. an undrawn page reserved `minWidth: 45vw` / `minHeight: 60vh` - a
//      VIEWPORT unit inside a reader that lives in one pane of a dock. The
//      column is `min-width:min-content`, so a placeholder wider than the pane
//      stretched the column past it, and every page was then centred in a box
//      wider than the pane: at a 700px pane in a 1600px window the column came
//      out 738px wide and the page sat 44px from the left edge with its right
//      edge clipped (and 246px / -197px in a 2500px window) while the SCALE was
//      exactly right - which is why neither fit button could repair it. The box
//      now comes from the document's OWN page 1 at the current scale (`unit`),
//      the same measurement the fit divides by, and the two small fallbacks are
//      only for the frame before page 1's box is known.
//   2. `applyFit` awaited `doc.getPage(1)` INSIDE the ResizeObserver callback,
//      and a drag fires dozens of them: the scale that stayed was whichever
//      promise resolved LAST, not the one measured last. It is synchronous now,
//      and a fit mode that is clicked while it is ALREADY active re-applies
//      instead of being a `setState` with the same value (React bails out, so
//      the button did nothing exactly when it was the way out).
check(
  'an undrawn page reserves the pane-sized page box, never a viewport unit',
  pdfSource.includes('const width = size ? Math.floor(size.width) : unit ? Math.floor(unit.width * scale) : null') &&
    pdfSource.includes('const height = size ? Math.floor(size.height) : unit ? Math.floor(unit.height * scale) : null') &&
    pdfSource.includes("minWidth: width ? undefined : '140px'") &&
    // the literals, not the bare tokens: the fix's own comment names the unit it
    // replaced, and that explanation is worth keeping.
    pdfSource.includes("'45vw'") === false &&
    pdfSource.includes("'60vh'") === false,
)
check(
  'the reader measures its unit once and hands it to every page',
  pdfSource.includes('const [unit, setUnit] = useState(null)') &&
    pdfSource.includes('const base = first.getViewport({ scale: 1, rotation })') &&
    pdfSource.includes('setUnit({ width: base.width, height: base.height })') &&
    pdfSource.includes('const { doc, pageNumber, scale, rotation, registerBox, unit } = props'),
)
check(
  'a fit is measured synchronously against the pane, and re-appliable',
  pdfSource.includes('async (mode) => {') === false &&
    pdfSource.includes('availableWidth / unit.width') &&
    pdfSource.includes('const observer = new ResizeObserver(() => applyFit(fit))') &&
    pdfSource.includes('if (fit === mode) applyFit(mode)') &&
    pdfSource.includes("onClick: () => chooseFit('width')") &&
    pdfSource.includes("onClick: () => chooseFit('page')"),
)
check('the reader uses pdf.js own TextLayer', pdfSource.includes('new engine.TextLayer({'))
check('the reader is page-navigable by keyboard', pdfSource.includes("event.key === 'PageDown'") && pdfSource.includes('dpf-pageInput') && pdfSource.includes('goToPage'))
check('a PDF is claimed as an extension type', pdfSource.includes("patterns: ['*.pdf']") && pdfSource.includes("priority: 'extension'"))
// alpha.3: the side panel (thumbnails + the document's own outline), the wasm
// decoders, and the workspace index page.
check(
  'the reader has a thumbnail rail, drawn lazily',
  pdfSource.includes('data-pdf-thumb') &&
    pdfSource.includes('THUMB_MAX = 300') &&
    pdfSource.includes('root: element.closest(\'.dpf-side\') ?? null') &&
    pdfSource.includes('Thumbnails stop at '),
)
check(
  'the reader reads the document outline itself',
  pdfSource.includes('await doc.getOutline()') &&
    pdfSource.includes('await doc.getDestination(') &&
    pdfSource.includes('await doc.getPageIndex(') &&
    pdfSource.includes('This document has no bookmarks'),
)
check(
  'the wasm decoders are wired',
  pdfSource.includes("API_ROOT + '/vendor/wasm.json'") &&
    pdfSource.includes("kind === 'wasmUrl' ? VENDOR_WASM") &&
    pdfSource.includes('wasmUrl: factoryUrl(VENDOR_WASM)'),
)
check(
  'the index page reads the workspace route',
  pdfSource.includes("API_ROOT + '/list'") &&
    pdfSource.includes("data-pdf-index-row") &&
    pdfSource.includes('Every PDF in this workspace'),
)
check('the index is a page type with its own guide entry', pdfSource.includes("priority: 'builtin',") && pdfSource.includes('order: 50'))
// Derived, not pinned: the marker is what the reader's toolbar draws, and the
// generic pass at the end of this file already compares every bundle's constant
// with its package.json - a literal here would only go stale on the next bump.
const pdfVersion = JSON.parse(readFileSync(path.join(repo, 'packages/dsh-pdf/package.json'), 'utf8')).version
check('the client version constant is the package version', pdfSource.includes("PLUGIN_VERSION = '" + pdfVersion + "'"))

const pdfTypes = []
const pdfSeats = {}
const pdfTabTypes = { register: (definition) => (pdfTypes.push(definition), () => {}), entries: () => [] }
pdf.exports.apply({
  slots: {
    inject: (name, fn) => fn(),
    register(spec, component) {
      pdfSeats[spec.name + (spec.key ? '#' + spec.key : '')] = { spec, component }
      return () => {}
    },
  },
  sidebarRightTabs: pdfTabTypes,
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
check('pdf type registered', pdfTypes.length === 2 && pdfTypes[0].id + '/' + pdfTypes[0].kind, 'dsh-pdf/pdf')
check('the index registers as a page type', pdfTypes[1].id + '/' + pdfTypes[1].kind + '/' + pdfTypes[1].priority, 'dsh-pdf-index/pdfs/builtin')
check('the index claims no file address', pdfTypes[1].patterns === undefined, true)
check('the index guide entry follows Diagrams', pdfTypes[1].guide.map((entry) => entry.order + ':' + entry.title()).join(','), '50:PDFs')
check('pdf claims only *.pdf', JSON.stringify(pdfTypes[0].patterns), '["*.pdf"]')
check('pdf outranks the shipped preview band', pdfTypes[0].priority, 'extension')
check(
  'pdf canOpen accepts both address shapes',
  pdfTypes[0].canOpen('dsh-resource://file/session/s1/docs/report.pdf') === true &&
    pdfTypes[0].canOpen('dsh-resource://pdf/absolute/' + encodeURIComponent('C:\\tmp\\scan.PDF')) === true &&
    pdfTypes[0].canOpen('dsh-resource://file/session/s1/notes.txt') === false,
)
check('pdf chip title is the file name', pdfTypes[0].title('dsh-resource://file/session/s1/docs/report.pdf'), 'report.pdf')
check(
  'pdf seats',
  Object.keys(pdfSeats).sort().join(','),
  'sidebar.right.pane.tab#dsh-pdf,sidebar.right.pane.tab#dsh-pdf-index,sidebar.right.pane.tab.title#dsh-pdf,sidebar.right.pane.tab.title#dsh-pdf-index,tool.call.toolview#pdf_find,tool.call.toolview#pdf_info,tool.call.toolview#pdf_read,tool.call.toolview#pdf_render,tool.call.toolview#pdf_scan',
)
// alpha.2, the scanner: a page with no text layer must SAY so and offer the one
// action that can change it, through the same route the pdf_scan tool drives.
check(
  'a scanned page says so and offers a scan',
  pdfSource.includes('data-pdf-scanned') &&
    pdfSource.includes('.dpf-scanRow{') &&
    pdfSource.includes('This page is a scanned image') &&
    pdfSource.includes("'Scan this page'"),
)
check(
  'the reader scans through the plugin route',
  pdfSource.includes("API_ROOT + '/scan'") &&
    pdfSource.includes("method: 'POST'") &&
    pdfSource.includes('body: JSON.stringify({ ...payload, page: pageNumber, dpi: SCAN_DPI })'),
)
check(
  'recognized text is labelled as recognized',
  pdfSource.includes('data-pdf-ocr') &&
    pdfSource.includes('OCR misreads digits, names, accents and punctuation') &&
    pdfSource.includes('Recognized, not extracted'),
)
const PdfBody = pdfSeats['sidebar.right.pane.tab#dsh-pdf'].component
const pdfTab = { id: 'tab7', contentId: 'dsh-resource://file/session/s1/report.pdf', title: 'report.pdf' }
const pdfMarkup = renderToStaticMarkup(h(PdfBody, { useTabInfo: () => ({ tab: pdfTab }), sessionId: 's1' }))
check('pdf body renders its opening state', pdfMarkup.includes('data-pdf-state="loading"') && pdfMarkup.includes('Opening the PDF'))
check(
  'pdf title seat draws the chip',
  renderToStaticMarkup(h(pdfSeats['sidebar.right.pane.tab.title#dsh-pdf'].component, { useTabInfo: () => ({ tab: pdfTab }) })),
  '<span class="dpf-title">report.pdf</span>',
)
// The index page: a page tab whose body reads the workspace. The effect cannot
// run under static rendering, so what is checked here is that it renders its
// own opening state and carries the address its guide entry opens.
const PdfIndexBody = pdfSeats['sidebar.right.pane.tab#dsh-pdf-index'].component
const pdfIndexMarkup = renderToStaticMarkup(h(PdfIndexBody, { sessionId: 's1' }))
check('the index body renders its opening state', pdfIndexMarkup.includes('data-pdf-index="sidebar://pdfs"') && pdfIndexMarkup.includes('data-pdf-index-state="loading"'))
check('the index offers a refresh and a page count', pdfIndexMarkup.includes('data-pdf-action="index-reload"') && pdfIndexMarkup.includes('data-pdf-action="index-count"'))
check(
  'the index title seat draws the chip',
  renderToStaticMarkup(h(pdfSeats['sidebar.right.pane.tab.title#dsh-pdf-index'].component, {})),
  '<span class="dpf-title">PDFs</span>',
)
const ToolCard = pdfSeats['tool.call.toolview#pdf_read'].component
const settledBlock = {
  kind: 'tool-result',
  call: { name: 'pdf_read', argsRaw: '{"path":"report.pdf","pages":"1-5","mode":"layout"}' },
  meta: {
    file: 'C:/work/report.pdf',
    name: 'report.pdf',
    address: 'dsh-resource://file/session/s1/report.pdf',
    pages: 12,
    mode: 'layout',
    scanned: [7, 8],
    cached: true,
  },
  content: [{ type: 'text', text: 'report.pdf — pages 1-5 of 12 (layout mode)' }],
}
const cardMarkup = renderToStaticMarkup(h(ToolCard, { toolName: 'pdf_read', block: settledBlock, sessionId: 's1' }))
check('the card names the document', cardMarkup.includes('data-pdf-card="pdf_read"') && cardMarkup.includes('report.pdf'))
check('the card shows what the host reported', cardMarkup.includes('12 pages') && cardMarkup.includes('layout text') && cardMarkup.includes('from cache'))
check('the card flags pages with no text layer', cardMarkup.includes('2 page(s) without text') && cardMarkup.includes('data-warn="true"'))
check('the card previews the answer', cardMarkup.includes('pages 1-5 of 12 (layout mode)'))
check('the card offers the tab', cardMarkup.includes('data-pdf-open="dsh-resource://file/session/s1/report.pdf"') && cardMarkup.includes('Open tab'))
const pdfRunningMarkup = renderToStaticMarkup(h(ToolCard, { toolName: 'pdf_read', block: { argsRaw: '{"path":"report.pdf"}' }, sessionId: 's1' }))
check('a running call says so', pdfRunningMarkup.includes('working…'))
// The pdf_scan card: what was recognized, with the engine and the resolution,
// and the warning that this is a transcription rather than extracted text.
const ScanCard = pdfSeats['tool.call.toolview#pdf_scan'].component
const scanCardMarkup = renderToStaticMarkup(
  h(ScanCard, {
    toolName: 'pdf_scan',
    block: {
      kind: 'tool-result',
      call: { name: 'pdf_scan', argsRaw: '{"path":"scan.pdf"}' },
      meta: {
        file: 'C:/work/scan.pdf',
        name: 'scan.pdf',
        address: 'dsh-resource://file/session/s1/scan.pdf',
        pages: 4,
        mode: 'ocr',
        dpi: 200,
        ocr: { engine: 'tesseract', lang: 'eng', dpi: 200, pages: [1, 2] },
      },
      content: [{ type: 'text', text: 'Recognized 2 pages of scan.pdf with tesseract (eng, 200 dpi, psm 3)' }],
    },
    sessionId: 's1',
  }),
)
check('the scan card names the engine and pages', scanCardMarkup.includes('recognized 1, 2 with tesseract (eng, 200 dpi)'))
check('the scan card warns it is a transcription', scanCardMarkup.includes('transcription, not extracted text'))
check('the scan card opens the tab', scanCardMarkup.includes('data-pdf-open="dsh-resource://file/session/s1/scan.pdf"'))

// ---------------------------------------------------------------- dsh-image
const image = loadBundle('packages/dsh-image/lib/client.js', {})
const imageCssTag = image.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-image/image.css').pop()
const imageCss = imageCssTag ? imageCssTag.textContent : ''
const imageSource = readFileSync(path.join(repo, 'packages/dsh-image/lib/client.js'), 'utf8')
check('image bundle id', image.id, 'dsh-image')
check('image inject', JSON.stringify(image.exports.inject), '["slots","sidebarRightTabs","remote.workspaceFiles"]')
check('image stylesheet injected', imageCss.includes('.dsi-root{') && imageCss.includes('.dsi-tools{'))
// The toolbar is this tab's top bar: the same 38px border-box pane header the
// Files tab, the document preview, the editor, History, Diagrams and the PDF
// reader use, so every column's first hairline lands on the same y=76 line.
check(
  'image top bar is the 38px pane header',
  imageCss.includes('.dsi-tools{flex:none;display:flex;align-items:center;gap:6px;box-sizing:border-box;height:38px;'),
)
// The zoom is a LAYOUT size on a box inside a scrollable pane, never a CSS
// transform: a transform would scale into a clipped box with no scrollable
// area, which is the bug the pack's diagram viewer shipped first.
check(
  'the zoom moves the layout, never a transform',
  imageSource.includes("style: natural ? { width: width + 'px', height: height + 'px' } : undefined") &&
    imageCss.includes('.dsi-box{flex:none;margin:auto;') &&
    imageCss.includes("transform:") === false,
)
check('the picture box is the pane-centred one', imageCss.includes('margin:auto;position:relative;box-sizing:border-box'))
// Transparency is shown as transparency, and past 300% the picture is drawn
// with nearest-neighbour sampling so pixel-peeping is honest.
check(
  'a checkerboard sits behind the picture',
  imageCss.includes('.dsi-box{') && imageCss.includes('background-image:linear-gradient(45deg,rgba(127,127,127,.22) 25%'),
)
check(
  'past 300% the picture is pixelated',
  imageSource.includes('const PIXELATED_AT = 3') &&
    imageSource.includes("'data-pixelated': pixelated ? 'true' : undefined") &&
    imageCss.includes('image-rendering:pixelated'),
)
// Panning is the pane's own scroll, offered only when it was MEASURED, and the
// grab cursor follows that measurement rather than an assumption.
check(
  'panning is real overflow measured, then scroll',
  imageSource.includes('canvas.scrollWidth > canvas.clientWidth + 1') &&
    imageCss.includes('.dsi-canvas[data-pannable="true"]{cursor:grab}') &&
    imageCss.includes('.dsi-canvas[data-panning="true"]{cursor:grabbing') &&
    imageSource.includes('canvas.scrollLeft = origin.left - (event.clientX - origin.x)'),
)
// Ctrl/Cmd + wheel zooms ANCHORED AT THE POINTER. The listener must be native
// and non-passive: React's own wheel listener is passive, so a preventDefault
// inside it does nothing and the browser's Ctrl+wheel page zoom fires too.
check(
  'wheel zoom is a non-passive listener at the pointer',
  imageSource.includes("canvas.addEventListener('wheel', listener, { passive: false })") &&
    imageSource.includes('if (!event.ctrlKey && !event.metaKey) return') &&
    imageSource.includes('moveTo(scaleRef.current * factor, { x: event.clientX, y: event.clientY })'),
)
// A trackpad pinch is a STREAM of wheel events that all land before the next
// render, so the handler must read a ref written synchronously by every move;
// reading the `scale` state would compute each step from the same base and the
// gesture would under-zoom badly.
check(
  'a pinch compounds on a synchronous zoom ref',
  imageSource.includes('const scaleRef = useRef(1)') &&
    imageSource.includes('scaleRef.current = clamped') &&
    imageSource.includes("const current = scaleRef.current"),
)
check(
  'a zoom keeps the point the reader was looking at',
  imageSource.includes('fx: (canvas.scrollLeft + px) / Math.max(1, canvas.scrollWidth)') &&
    imageSource.includes('element.scrollLeft = mark.fx * element.scrollWidth - mark.px') &&
    imageSource.includes('window.requestAnimationFrame(restore)'),
)
check(
  'the zoom ladder runs 5% to 800% with fit and 1:1',
  imageSource.includes('const ZOOM_STEPS = [0.05, 0.1, 0.17, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8]') &&
    imageSource.includes('const FIT_PADDING = 24') &&
    imageSource.includes("'data-image-action': 'fit'") &&
    imageSource.includes("'data-image-action': 'actual'"),
)
// The pointer readout samples a ONE-PIXEL canvas, so inspecting a large
// photograph never copies the picture into a second buffer.
check(
  'the pixel readout samples through a 1x1 canvas',
  imageSource.includes('const PIXEL_SAMPLE_PX = 1') &&
    imageSource.includes('context.drawImage(image, x, y, 1, 1, 0, 0, 1, 1)') &&
    imageSource.includes("'data-image-pixel': pixel.x + ',' + pixel.y"),
)
// Bytes come from the harness's own workspaceFiles remote - the call already
// enforces the path policy and the byte cap on the HOST side - so this package
// has no route, no fetch, and no policy of its own to get wrong.
//
// THE CALL IS `readBytes(sessionId, path, {}, signal)`: EMPTY options are the
// namespace's whole-file read, and that is exactly what the shipped document
// preview passes for its own bytes-complete mode. The namespace has NO
// `readAll` (the pinned line's generated Remote declares `changes`, `list`,
// `read`, `readBytes` and `stat`), and this tab called one for as long as it
// existed - which is why every image answered "This harness exposes no
// workspaceFiles remote" while the remote was there all along.
check(
  'bytes come from the shipped remote, not a route of its own',
  imageSource.includes("const REMOTE_NAMESPACE = 'remote.workspaceFiles'") &&
    imageSource.includes('workspaceFiles\n          .readBytes(sessionId, parsed.path, {}, controller.signal)') &&
    imageSource.includes('.readAll(') === false &&
    imageSource.includes('fetch(') === false &&
    imageSource.includes("'/api/") === false,
)
check(
  'the read is aborted and its blob URL revoked',
  imageSource.includes('const controller = new AbortController()') &&
    imageSource.includes('controller.abort()') &&
    imageSource.includes('URL.revokeObjectURL(objectUrl)'),
)
// The payload shift is DRIVEN, not grepped - a grep for a call shape is what let
// the absent `readAll` ship. The generated result codec declares `data` as a
// Uint8Array, and every other shape a carrier could hand over must answer the
// same bytes, because bytes fed to `atob` by mistake are a broken picture.
const probeBytes = new Uint8Array([0, 1, 127, 128, 255])
const probeBase64 = btoa(String.fromCharCode(0, 1, 127, 128, 255))
check(
  'the image byte payload is accepted in every shape a carrier could use',
  image.exports.__internals.bytesOf(probeBytes).join(',') === '0,1,127,128,255' &&
    image.exports.__internals.bytesOf(probeBytes.buffer).join(',') === '0,1,127,128,255' &&
    image.exports.__internals.bytesOf([0, 1, 127, 128, 255]).join(',') === '0,1,127,128,255' &&
    image.exports.__internals.bytesOf(probeBase64).join(',') === '0,1,127,128,255' &&
    image.exports.__internals.bytesOf(null) === null &&
    image.exports.__internals.bytesOf('') === null,
)
check('the base64 decode is one indexed loop', imageSource.includes('bytes[index] = binary.charCodeAt(index)'))
// A read that stops at the host's ceiling answers `eof: false`, and half a
// photograph drawn as if it were the picture is worse than one sentence.
check(
  'a truncated read is refused rather than drawn',
  imageSource.includes('value.eof === false') && imageSource.includes('only part of it arrived'),
)

const imageTypes = []
const imageSeats = {}
image.exports.apply({
  slots: {
    inject: (name, fn) => fn(),
    register(spec, component) {
      imageSeats[spec.name + (spec.key ? '#' + spec.key : '')] = { spec, component }
      return () => {}
    },
  },
  sidebarRightTabs: { register: (definition) => (imageTypes.push(definition), () => {}), entries: () => [] },
  remote: { workspaceFiles: { readBytes: () => Promise.resolve({ ok: false, error: { code: 'workspace-file/not-file' } }) } },
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
check('image type registered', imageTypes.length === 1 && imageTypes[0].id + '/' + imageTypes[0].kind, 'dsh-image/image')
check('image outranks the shipped preview band', imageTypes[0].priority, 'extension')
check(
  'image claims exactly the image suffixes',
  JSON.stringify(imageTypes[0].patterns),
  '["*.png","*.apng","*.jpg","*.jpeg","*.jpe","*.jfif","*.gif","*.webp","*.avif","*.bmp","*.ico","*.svg","*.tif","*.tiff"]',
)
check(
  'image canOpen takes images and refuses everything else',
  imageTypes[0].canOpen('dsh-resource://file/session/s1/docs/shot.PNG') === true &&
    imageTypes[0].canOpen('dsh-resource://file/session/s1/docs/photo.jpeg') === true &&
    imageTypes[0].canOpen('dsh-resource://file/session/s1/drawings/plan.svg') === true &&
    imageTypes[0].canOpen('dsh-resource://file/session/s1/notes.txt') === false &&
    imageTypes[0].canOpen('dsh-resource://file/absolute/C:/tmp/shot.png') === false &&
    imageTypes[0].canOpen('dsh-resource://pdf/absolute/x.png') === false,
)
check('the image chip title is the file name', imageTypes[0].title('dsh-resource://file/session/s1/docs/shot.png'), 'shot.png')
// A blank image is not a document anyone opens from the "+" control, so this
// type adds no guide capsule - it only ever claims a real file address.
check('the image type adds no guide entry', imageTypes[0].guide === undefined)
check(
  'image seats',
  Object.keys(imageSeats).sort().join(','),
  'sidebar.right.pane.tab#dsh-image,sidebar.right.pane.tab.title#dsh-image',
)
const ImageBody = imageSeats['sidebar.right.pane.tab#dsh-image'].component
const imageTab = { id: 'tab9', contentId: 'dsh-resource://file/session/s1/shots/hero%20image.png', title: 'hero image.png' }
const imageMarkup = renderToStaticMarkup(h(ImageBody, { useTabInfo: () => ({ tab: imageTab }), sessionId: 's1' }))
check('image body renders its opening state', imageMarkup.includes('data-image-state="loading"') && imageMarkup.includes('Opening the image'))
check('the opening state names the file it is opening', imageMarkup.includes('s1/shots/hero image.png'))
check(
  'image title seat draws the chip',
  renderToStaticMarkup(h(imageSeats['sidebar.right.pane.tab.title#dsh-image'].component, { useTabInfo: () => ({ tab: imageTab }) })),
  '<span class="dsi-title">hero image.png</span>',
)
const imageNoTabMarkup = renderToStaticMarkup(h(ImageBody, { useTabInfo: () => ({ tab: { id: 'tab10', contentId: '' } }), sessionId: 's1' }))
check('an address-less image tab still renders', imageNoTabMarkup.includes('data-image-state="loading"'))

// ---------------------------------------------------------------- dsh-video
//
// The video tab is the pack's one surface whose data comes from ANOTHER
// package's host routes (dsh-media owns the bytes, the probe and the ffmpeg), so
// this section pins three separate promises: the tab type ranks and refuses the
// way the image and audio types do; the player is handed a URL rather than
// bytes, because the host route supports HTTP Range and reading a 2 GB film into
// memory is the one thing that must never happen here; and a profile without
// dsh-media is told which package is missing instead of showing a dead player.
const video = loadBundle('packages/dsh-video/lib/client.js', {})
const videoCssTag = video.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-video/video.css').pop()
const videoCss = videoCssTag ? videoCssTag.textContent : ''
const videoSource = readFileSync(path.join(repo, 'packages/dsh-video/lib/client.js'), 'utf8')
check('video bundle id', video.id, 'dsh-video')
check('video inject', JSON.stringify(video.exports.inject), '["slots","sidebarRightTabs"]')
check('video stylesheet injected', videoCss.includes('.dsv-root{') && videoCss.includes('.dsv-tools{'))
check(
  'video top bar is the 38px pane header',
  videoCss.includes('.dsv-tools{flex:none;display:flex;align-items:center;gap:6px;box-sizing:border-box;height:38px;'),
)
// The player FITS the pane: a real layout size, never a scale transform, so a
// 4K film is visible whole and a phone clip is not stretched across the pane.
check(
  'the player fits the pane by layout, never a transform',
  videoCss.includes('.dsv-video{display:block;max-width:100%;max-height:100%;width:auto;height:auto') && videoCss.includes('transform:') === false,
)
// The stage is the black box the video is centred in, which is what makes the
// fitted picture read as a player rather than as a hole in the tab.
check('the stage is the letterboxed one', videoCss.includes('.dsv-stage{flex:1;min-width:0;min-height:0;position:relative;display:flex;align-items:center;justify-content:center;background:#0a0a0a'))
// THE RULE THIS TAB EXISTS FOR: the <video> element is handed a URL to a
// Range-capable route. No byte is ever read into the tab, no blob is built.
check(
  'the bytes stay on the host: <video> gets a URL, never a buffer',
  videoSource.includes('src: source.url') &&
    videoSource.includes("FILE_ROUTE + '?' + addressParams(parsed, sessionId).toString()") &&
    videoSource.includes('arrayBuffer(') === false &&
    videoSource.includes('createObjectURL') === false &&
    videoSource.includes('readAll') === false,
)
check('the route it streams through is dsh-media range-capable file route', video.exports.__internals.FILE_ROUTE, '/api/dsh-media/file')
check('the probe is one request to dsh-media, with the credentials a route needs', videoSource.includes('fetchJson(url, { signal: controller.signal })') && videoSource.includes("credentials: 'same-origin'"))
check(
  'a tab that changes address aborts the request it started',
  videoSource.includes('const controller = new AbortController()') && videoSource.includes('controller.abort()') && videoSource.includes('live = false'),
)
check(
  'a conversion is a POST of the address, then a poll of the job',
  videoSource.includes('fetchJson(REMUX_ROUTE, {') && videoSource.includes("JOB_ROUTE + '?id=' + encodeURIComponent(jobId)"),
)
// The poll must key on the job's ID and whether it runs, never on the job
// object: every poll replaces that object, and an effect depending on it would
// restart its own timer on every tick (the bug this comment exists to prevent).
check('the job poll keys on the id, not the object', videoSource.includes('}, [running, jobId])'))
check(
  'a profile without dsh-media says which package is missing',
  videoSource.includes("phase === 'missing'") && /dsh-media is not installed/.test(videoSource) && videoSource.includes('/api/dsh-media/*'),
)
check(
  'the overlay keeps "play it anyway" reachable when the probe fails',
  videoSource.includes("'data-dsh-video': 'play-anyway'") && videoSource.includes('const overlay = dismissed ? null : overlayFor('),
)
check('chapters are jump targets in both the bar and the panel', videoSource.includes("'data-dsh-video': 'chapter'") && videoSource.includes('onChapter(chapter.startSec)'))
check(
  'the conversion is offered with its real cost named',
  videoSource.includes("'Remux it (instant, no quality loss)'") && videoSource.includes("'Convert it to H.264'"),
)
check('the version marker is in the toolbar', videoSource.includes("h('span', { className: 'dsv-meta dsv-ver' }, 'v' + props.version)"))

const videoTypes = []
const videoSeats = {}
video.exports.apply({
  slots: {
    inject: (name, fn) => fn(),
    register(spec, component) {
      videoSeats[spec.name + (spec.key ? '#' + spec.key : '')] = { spec, component }
      return () => {}
    },
  },
  sidebarRightTabs: { register: (definition) => (videoTypes.push(definition), () => {}), entries: () => [] },
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
check('video type registered', videoTypes.length === 1 && videoTypes[0].id + '/' + videoTypes[0].kind, 'dsh-video/video')
check('video outranks the shipped preview band', videoTypes[0].priority, 'extension')
// Pinned against the SAME literal dsh-media's VIDEO_EXTENSIONS is pinned to in
// check-media-node.mjs: a tab that claims a format the host route refuses to
// stream would open a player that can never load.
check(
  'video claims exactly the video containers',
  JSON.stringify(videoTypes[0].patterns),
  JSON.stringify(['*.mp4', '*.m4v', '*.mov', '*.webm', '*.mkv', '*.avi', '*.wmv', '*.flv', '*.ogv', '*.ts', '*.m2ts', '*.mpg', '*.mpeg', '*.3gp', '*.mts']),
)
check(
  'video canOpen takes videos and refuses everything else',
  videoTypes[0].canOpen('dsh-resource://file/session/s1/clips/HOLIDAY.MP4') === true &&
    videoTypes[0].canOpen('dsh-resource://file/session/s1/clips/render.mkv') === true &&
    videoTypes[0].canOpen('dsh-resource://file/absolute/home/me/clip.webm') === true &&
    videoTypes[0].canOpen('dsh-resource://file/session/s1/song.mp3') === false &&
    videoTypes[0].canOpen('dsh-resource://file/session/s1/wave.wav') === false &&
    videoTypes[0].canOpen('dsh-resource://file/session/s1/shot.png') === false &&
    videoTypes[0].canOpen('dsh-resource://pdf/absolute/x.mp4') === false,
)
check('the video chip title is the file name', videoTypes[0].title('dsh-resource://file/session/s1/clips/holiday%20clip.mp4'), 'holiday clip.mp4')
// A blank video is not a document anyone opens from the "+" control.
check('the video type adds no guide entry', videoTypes[0].guide === undefined)
check(
  'video seats',
  Object.keys(videoSeats).sort().join(','),
  'sidebar.right.pane.tab#dsh-video,sidebar.right.pane.tab.title#dsh-video',
)
// The pure half: both address shapes, and the one that is easy to get wrong.
const videoInternals = video.exports.__internals
check(
  'a POSIX absolute address gets its leading slash back',
  JSON.stringify(videoInternals.parseVideoAddress('dsh-resource://file/absolute/home/me/clip.mp4')),
  JSON.stringify({ absolute: '/home/me/clip.mp4' }),
)
check(
  'a Windows absolute address is left alone',
  JSON.stringify(videoInternals.parseVideoAddress('dsh-resource://file/absolute/C:/Users/me/clip.mp4')),
  JSON.stringify({ absolute: 'C:/Users/me/clip.mp4' }),
)
check(
  'a UNC absolute address keeps its empty first segment',
  JSON.stringify(videoInternals.parseVideoAddress('dsh-resource://file/absolute//server/share/clip.mp4')),
  JSON.stringify({ absolute: '//server/share/clip.mp4' }),
)
check(
  'a session address decodes its path segments',
  JSON.stringify(videoInternals.parseVideoAddress('dsh-resource://file/session/s1/clips/holiday%20clip.mp4')),
  JSON.stringify({ sessionId: 's1', path: 'clips/holiday clip.mp4' }),
)
check('an unknown address shape is refused', videoInternals.parseVideoAddress('dsh-resource://diagram/session/s1/x') === null && videoInternals.parseVideoAddress('') === null)
check('a browser error code is explained in words', /will not play this container or codec at all/.test(videoInternals.mediaErrorText({ error: { code: 4 } })))
check('...and an unknown one is not blamed on the file', /without saying why/.test(videoInternals.mediaErrorText(null)))

const VideoBody = videoSeats['sidebar.right.pane.tab#dsh-video'].component
const videoTab = { id: 'tab11', contentId: 'dsh-resource://file/session/s1/clips/holiday%20clip.mp4', title: 'holiday clip.mp4' }
const videoMarkup = renderToStaticMarkup(h(VideoBody, { useTabInfo: () => ({ tab: videoTab }), sessionId: 's1' }))
check('video body renders its opening state', videoMarkup.includes('data-dsv-state="loading"') && videoMarkup.includes('Reading the file'))
check('the opening state names the file it is opening', videoMarkup.includes('clips/holiday clip.mp4'))
check(
  'video title seat draws the chip',
  renderToStaticMarkup(h(videoSeats['sidebar.right.pane.tab.title#dsh-video'].component, { useTabInfo: () => ({ tab: videoTab }) })),
  '<span class="dsv-name" data-dsh-video="title">holiday clip.mp4</span>',
)
const videoNoTabMarkup = renderToStaticMarkup(h(VideoBody, { useTabInfo: () => ({ tab: { id: 'tab12', contentId: '' } }), sessionId: 's1' }))
check('an address-less video tab still renders', videoNoTabMarkup.includes('data-dsv-state="bad-address"'))
// The facts panel and the conversion affordances are props -> markup, and the
// tab body's own render can never reach them (a server render runs no effect, so
// it always stops at the loading state). They are driven directly instead - this
// is the markup a person reads while deciding what to do with a file, and the
// checked-jump and one-click-repair promises live here.
const videoFacts = {
  path: 'clips/holiday clip.mkv',
  name: 'holiday clip.mkv',
  size: 1_234_567,
  sizeText: '1.2 MB',
  container: { name: 'matroska,webm', longName: 'Matroska / WebM', tags: { encoder: 'Lavf60.6.100' } },
  durationSec: 62.5,
  durationText: '1:02.500',
  bitRate: 1_900_000,
  bitRateText: '1.9 Mb/s',
  streams: [
    {
      index: 0,
      type: 'video',
      codec: 'h264',
      profile: 'High',
      width: 1920,
      height: 1080,
      dar: '16:9',
      rate: { rational: '24000/1001', decimal: 23.98, text: '23.98 fps' },
      pixelFormat: 'yuv420p',
      bitDepth: 8,
      bitRate: 1_500_000,
      frames: 1500,
      language: '',
      title: '',
      dispositions: ['default'],
      rotation: null,
      fieldOrder: 'progressive',
    },
    { index: 1, type: 'audio', codec: 'aac', profile: 'LC', sampleRate: 48_000, channels: 2, channelLayout: 'stereo', bitRate: 128_000, language: 'eng', title: '', dispositions: ['default'] },
  ],
  video: [],
  audio: [],
  subtitles: [],
  others: [],
  chapters: [
    { index: 0, startSec: 0, endSec: 30, title: 'Intro' },
    { index: 1, startSec: 30, endSec: 62.5, title: 'Main feature' },
  ],
  notes: [],
  error: '',
  playable: { verdict: 'remux', container: 'matroska', reason: 'the streams are browser-decodable, but the matroska container is not one a browser opens', command: 'ffmpeg -i "holiday clip.mkv" -c copy "holiday clip-playable.mp4"' },
}
videoFacts.video = [videoFacts.streams[0]]
videoFacts.audio = [videoFacts.streams[1]]
const videoInternals2 = video.exports.__internals
const factsMarkup = renderToStaticMarkup(
  h(videoInternals2.FactsPanel, { facts: videoFacts, kind: 'matroska', onChapter: () => {} }),
)
check('the facts panel names the container and the duration', factsMarkup.includes('Matroska / WebM') && factsMarkup.includes('1:02.500'))
check('...draws one block per stream', (factsMarkup.match(/dsv-streamHead/g) ?? []).length, 2)
check('...with the real pixel size and the exact frame-rate rational', factsMarkup.includes('1920 x 1080') && factsMarkup.includes('24000/1001'))
check('...and the audio layout', factsMarkup.includes('48000 Hz') && factsMarkup.includes('stereo'))
check('...lists the tags', factsMarkup.includes('encoder') && factsMarkup.includes('Lavf60.6.100'))
check('every chapter is a jump target', (factsMarkup.match(/data-dsh-video="chapter"/g) ?? []).length, 2)
check('...and the chapter titles are shown', factsMarkup.includes('Intro') && factsMarkup.includes('Main feature'))
check('the panel states the browser verdict', factsMarkup.includes('data-verdict="remux"') && /not one a browser opens/.test(factsMarkup))
check('...and prints the command that would fix it', factsMarkup.includes('ffmpeg -i &quot;holiday clip.mkv&quot; -c copy') && factsMarkup.includes('Copy command'))
const toolbarMarkup = renderToStaticMarkup(
  h(videoInternals2.Toolbar, {
    name: 'holiday clip.mkv',
    version: '0.1.0-alpha.1',
    facts: videoFacts,
    needsWork: true,
    verdict: 'remux',
    showFacts: false,
    onToggleFacts: () => {},
    chapters: videoFacts.chapters,
    onChapter: () => {},
    onNudge: () => {},
    onConvert: () => {},
  }),
)
check('the bar offers the REMUX, not a blind transcode', toolbarMarkup.includes('Remux to MP4') && toolbarMarkup.includes('data-dsh-video="convert"'))
check('...carries the file facts and the honest verdict chip', toolbarMarkup.includes('1:02.500') && toolbarMarkup.includes('1920x1080') && toolbarMarkup.includes('data-dsh-video="verdict-chip"'))
check('...offers the chapter picker and the seek steps', toolbarMarkup.includes('data-dsh-video="chapters"') && toolbarMarkup.includes('−5s') && toolbarMarkup.includes('+5s'))
check('...and the Facts toggle', toolbarMarkup.includes('data-dsh-video="facts-toggle"'))
check('the transcode wording is used when the codec is the problem', renderToStaticMarkup(h(videoInternals2.Toolbar, { name: 'x.avi', version: 'v', facts: { ...videoFacts, playable: { ...videoFacts.playable, verdict: 'transcode' } }, needsWork: true, verdict: 'transcode', onConvert: () => {} })).includes('Convert for the browser'))
const noFfmpegOverlay = renderToStaticMarkup(h(videoInternals2.overlayFor, { phase: 'unavailable', message: 'No ffmpeg on this machine yet' }, { provisioning: false, onProvision: () => {}, onRetry: () => {}, onDismiss: () => {} }))
check('the no-ffmpeg overlay offers the pinned download AND a way to play', noFfmpegOverlay.includes('data-dsh-video="get-ffmpeg"') && noFfmpegOverlay.includes('data-dsh-video="play-anyway"'))
const unreadableOverlay = renderToStaticMarkup(h(videoInternals2.overlayFor, { phase: 'unreadable', message: 'ffprobe found no container' }, { provisioning: false, onProvision: () => {}, onRetry: () => {}, onDismiss: () => {} }))
check('an unreadable probe keeps the file reachable', unreadableOverlay.includes('data-dsh-video="play-anyway"') && unreadableOverlay.includes('Read it again'))
check('a ready phase draws no overlay at all', videoInternals2.overlayFor({ phase: 'ready' }, {}) === null)

// ---------------------------------------------------------------- dsh-audio
//
// The audio bundle is the pack's one surface whose real work is ARITHMETIC: a
// WAV/AIFF decoder and a peak pyramid. Neither can be exercised through a
// static render (the decode runs in an effect the server renderer never runs),
// so the bundle exposes its pure half as `__internals` and this section builds
// the FILES - a RIFF/WAVE, an IFF FORM, a FLAC - by hand and asserts the
// numbers that come back out of them. Nothing here needs ffmpeg, sox, a
// browser or a fixture on disk.

/** One RIFF/WAVE file, built by hand. `sample` writes its own sample bytes. */
function buildWav(options) {
  const channels = options.channels === undefined ? 1 : options.channels
  const bits = options.bits === undefined ? 16 : options.bits
  const rate = options.rate === undefined ? 44100 : options.rate
  const frames = options.frames === undefined ? 1000 : options.frames
  const kind = options.kind === undefined ? 'pcm' : options.kind
  const extensible = options.extensible === true
  const bytesPerSample = Math.ceil(bits / 8)
  const blockAlign = channels * bytesPerSample
  const dataBytes = frames * blockAlign
  const tag = kind === 'float' ? 3 : kind === 'alaw' ? 6 : kind === 'ulaw' ? 7 : kind === 'adpcm' ? 0x11 : 1
  const fmtSize = extensible ? 40 : 16
  const bytes = new Uint8Array(28 + fmtSize + dataBytes)
  const view = new DataView(bytes.buffer)
  const text = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index)
  }
  text(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, fmtSize, true)
  view.setUint16(20, extensible ? 0xfffe : tag, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bits, true)
  if (extensible) {
    view.setUint16(36, 22, true)
    view.setUint16(38, bits, true)
    view.setUint32(40, 3, true)
    view.setUint16(44, tag, true)
  }
  const dataHeader = 20 + fmtSize
  text(dataHeader, 'data')
  view.setUint32(dataHeader + 4, options.declaredDataBytes === undefined ? dataBytes : options.declaredDataBytes, true)
  const dataStart = dataHeader + 8
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const at = dataStart + frame * blockAlign + channel * bytesPerSample
      if (options.sample !== undefined) {
        options.sample(bytes, view, at, frame, channel)
        continue
      }
      const sine = Math.round(Math.sin((2 * Math.PI * 1000 * frame) / rate) * 16384)
      if (bits === 8) view.setUint8(at, 128 + (sine >> 8))
      else if (bits === 16) view.setInt16(at, sine, true)
      else if (bits === 24) {
        view.setUint8(at, sine & 0xff)
        view.setUint8(at + 1, (sine >> 8) & 0xff)
        view.setUint8(at + 2, (sine >> 16) & 0xff)
      } else if (bits === 32) view.setInt32(at, sine * 65536, true)
    }
  }
  return bytes
}

/** The 80-bit IEEE extended float AIFF states a sample rate with. */
function writeExtended80(view, offset, value) {
  const TWO63 = 9223372036854775808
  let exponent = 16383 + 63
  let mantissa = value < 0 ? -value : value
  while (mantissa < TWO63 && exponent > 0) {
    mantissa *= 2
    exponent -= 1
  }
  const high = Math.floor(mantissa / 4294967296)
  view.setUint16(offset, (value < 0 ? 0x8000 : 0) | exponent, false)
  view.setUint32(offset + 2, high, false)
  view.setUint32(offset + 6, mantissa - high * 4294967296, false)
}

/** One IFF FORM (AIFF, or AIFC with a compression type), built by hand. */
function buildAiff(options) {
  const channels = options.channels === undefined ? 1 : options.channels
  const bits = options.bits === undefined ? 16 : options.bits
  const rate = options.rate === undefined ? 44100 : options.rate
  const frames = options.frames === undefined ? 100 : options.frames
  const compression = options.compression === undefined ? '' : options.compression
  const bytesPerSample = Math.ceil(bits / 8)
  const blockAlign = channels * bytesPerSample
  const dataBytes = frames * blockAlign
  const commSize = compression === '' ? 18 : 23 // AIFC adds the type + a name
  const commPadded = commSize + (commSize & 1)
  const ssndSize = 8 + dataBytes
  const bytes = new Uint8Array(12 + 8 + commPadded + 8 + ssndSize)
  const view = new DataView(bytes.buffer)
  const text = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index)
  }
  text(0, 'FORM')
  view.setUint32(4, bytes.length - 8, false)
  text(8, compression === '' ? 'AIFF' : 'AIFC')
  text(12, 'COMM')
  view.setUint32(16, commSize, false)
  const comm = 20
  view.setInt16(comm, channels, false)
  view.setUint32(comm + 2, frames, false)
  view.setInt16(comm + 6, bits, false)
  writeExtended80(view, comm + 8, rate)
  if (compression !== '') {
    text(comm + 18, compression)
    bytes[comm + 22] = 0 // an empty compression name
  }
  const ssnd = 20 + commPadded
  text(ssnd, 'SSND')
  view.setUint32(ssnd + 4, ssndSize, false)
  const dataStart = ssnd + 16
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const at = dataStart + frame * blockAlign + channel * bytesPerSample
      const value = Math.round(Math.sin((2 * Math.PI * 1000 * frame) / rate) * 12000)
      if (options.sample !== undefined) options.sample(bytes, view, at, frame, channel)
      else if (bits === 8) view.setInt8(at, value >> 8)
      else if (bits === 16) view.setInt16(at, value, compression === 'sowt')
      else if (bits === 24) {
        view.setUint8(at, (value >> 16) & 0xff)
        view.setUint8(at + 1, (value >> 8) & 0xff)
        view.setUint8(at + 2, value & 0xff)
      }
    }
  }
  return bytes
}

/** One FLAC stream: a STREAMINFO block and a Vorbis comment, built by hand. */
function buildFlac(options) {
  const vendor = 'vncode-check'
  const entry = 'TITLE=' + (options.title === undefined ? 'Test' : options.title)
  const comments = new Uint8Array(12 + vendor.length + entry.length)
  const commentView = new DataView(comments.buffer)
  commentView.setUint32(0, vendor.length, true)
  for (let index = 0; index < vendor.length; index += 1) comments[4 + index] = vendor.charCodeAt(index)
  commentView.setUint32(4 + vendor.length, 1, true)
  commentView.setUint32(8 + vendor.length, entry.length, true)
  for (let index = 0; index < entry.length; index += 1) comments[12 + vendor.length + index] = entry.charCodeAt(index)
  const bytes = new Uint8Array(4 + 4 + 34 + 4 + comments.length)
  const view = new DataView(bytes.buffer)
  const text = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index)
  }
  text(0, 'fLaC')
  bytes[4] = 0 // STREAMINFO, not the last block
  bytes[7] = 34
  view.setUint16(8, 4096, false)
  view.setUint16(10, 4096, false)
  const high =
    (((options.rate & 0xfffff) << 12) | (((options.channels - 1) & 7) << 9) | (((options.bits - 1) & 31) << 4) | Math.floor(options.total / 4294967296)) >>> 0
  view.setUint32(18, high, false)
  view.setUint32(22, options.total % 4294967296, false)
  bytes[42] = 0x80 | 4 // VORBIS_COMMENT, the last block
  const size = comments.length
  bytes[43] = (size >> 16) & 0xff
  bytes[44] = (size >> 8) & 0xff
  bytes[45] = size & 0xff
  bytes.set(comments, 46)
  return bytes
}

const audio = loadBundle('packages/dsh-audio/lib/client.js', {})
const audioCssTag = audio.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-audio/audio.css').pop()
const audioCss = audioCssTag ? audioCssTag.textContent : ''
const audioSource = readFileSync(path.join(repo, 'packages/dsh-audio/lib/client.js'), 'utf8')
// The version the console PRINTS is the package's own, read here rather than
// written twice: the bundle's new PLUGIN_VERSION and a literal in this check
// drifted apart once already (alpha.3 -> alpha.4 bumped the bundle and left this
// failing), and a version assertion that has to be edited by hand on every bump
// is one that gets edited wrong.
const audioVersion = JSON.parse(readFileSync(path.join(repo, 'packages/dsh-audio/package.json'), 'utf8')).version
check('the audio client version constant is the package version', audioSource.includes("PLUGIN_VERSION = '" + audioVersion + "'"))
const A = audio.exports.__internals
check('audio bundle id', audio.id, 'dsh-audio')
check('audio inject', JSON.stringify(audio.exports.inject), '["slots","sidebarRightTabs","remote.workspaceFiles"]')
check('audio stylesheet injected', audioCss.includes('.dsa-root{') && audioCss.includes('.dsa-tools{'))
check(
  'audio top bar is the 38px pane header',
  audioCss.includes('.dsa-tools{flex:none;display:flex;align-items:center;gap:6px;box-sizing:border-box;height:38px;'),
)
// The zoom is a LAYOUT width - the scrollable spacer is the file's duration
// times the pixels per second - never a CSS transform, and the canvas that
// paints the waveform is VIEWPORT-ANCHORED over it, because a canvas cannot be
// hundreds of thousands of pixels wide.
check(
  'the zoom moves the layout, never a transform',
  audioSource.includes("style: { width: contentWidth + 'px', height: contentHeight + 'px' }") &&
    audioCss.includes('.dsa-spacerBox{position:relative}') &&
    audioSource.includes('const totalPx = Math.max(1, Math.round(duration * pxPerSecond))') &&
    audioCss.includes('transform:') === false,
)
check('the canvas is viewport-anchored over the file-wide spacer', audioCss.includes('.dsa-canvas{position:sticky;left:0;'))
check(
  'a zoom keeps the time under the anchor',
  audioSource.includes('const timeAtAnchor = (scroller.scrollLeft + anchorX - GUTTER) / current') &&
    audioSource.includes('element.scrollLeft = Math.max(0, GUTTER + timeAtAnchor * clamped - anchorX)') &&
    audioSource.includes('window.requestAnimationFrame(restore)'),
)
// Ctrl/Cmd + wheel zooms at the POINTER, and the listener must be native and
// non-passive: React's own wheel listener is passive, so a preventDefault
// inside it does nothing and the browser's Ctrl+wheel page zoom fires too.
check(
  'wheel zoom is a non-passive listener at the pointer',
  audioSource.includes("scroller.addEventListener('wheel', listener, { passive: false })") &&
    audioSource.includes('zoomTo(ppsRef.current * factor, { x: event.clientX, y: event.clientY })') &&
    audioSource.includes('if (event.shiftKey) {'),
)
// A trackpad pinch is a STREAM of wheel events that all land before the next
// render, so the handler must read a ref written synchronously by every move;
// reading the `pxPerSecond` state would compute every step from the same base
// and the gesture would under-zoom badly (the bug dsh-image shipped once).
check(
  'a pinch compounds on a synchronous zoom ref',
  audioSource.includes('const ppsRef = useRef(MIN_PPS)') &&
    audioSource.includes('ppsRef.current = clamped') &&
    audioSource.includes('const current = ppsRef.current'),
)
// The cursor says what a press would do where it is: a track's bottom edge
// resizes, the ruler pans, a track selects. A static grab cursor over a
// waveform that selects is a promise the surface does not keep.
check(
  'the cursor follows what a press would do there',
  audioSource.includes("canvas.style.cursor = 'grabbing'") &&
    audioSource.includes("canvas.style.cursor = 'ew-resize'") &&
    audioSource.includes("canvas.style.cursor = 'ns-resize'") &&
    audioSource.includes("point && point.handle >= 0 ? 'ns-resize'"),
)
// THE TRACKS ARE ROWS, and the height is ONE number the reader drags: any
// track's bottom edge resizes every track at once, because a waveform is read
// across tracks and separately sized tracks would no longer line up.
check(
  'a track edge drags a height that every track shares',
  audioSource.includes('const MIN_TRACK_H = 24') &&
    audioSource.includes('const MAX_TRACK_H = 420') &&
    audioSource.includes('const HANDLE_GRAB = 5') &&
    audioSource.includes("dragRef.current = { kind: 'resize', y: event.clientY, height: trackHeight }") &&
    audioSource.includes('setTrackHeight(Math.round(next))') &&
    audioSource.includes('const [trackHeight, setTrackHeight] = useState(TRACK_H)'),
)
// Each track is ONE row all the way across, and the gutter cell beside it is
// exactly as tall: the left part of the picture is the same track as the
// waveform next to it, and the name and the reading stay together in it.
check(
  'a track is one row, gutter cell and all',
  audioSource.includes('context.fillRect(GUTTER, RULER_H + track * trackStride, cssWidth - GUTTER, trackHeight)') &&
    audioSource.includes('context.fillRect(0, top, GUTTER, trackHeight)') &&
    audioSource.includes('const twoLines = trackHeight >= 42'),
)
check('there is no amplitude-gain button any more', audioSource.includes("'data-audio-action': 'gain'") === false)
check(
  'the toolbar counts tracks, and one track is a row',
  audioSource.includes("'data-audio-action': 'tracks'") &&
    audioSource.includes("trackRows > 1 ? trackRows + ' tracks' : '1 track'") &&
    audioSource.includes("'lanes'") === false,
)
// A re-read is a new viewer: a stale playback buffer is the bug this key stops.
check('a re-read resets the viewer', audioSource.includes("key: 'dsh-audio-load-' + reload"))
// The playhead is the AUDIO CLOCK's own position, not a CSS animation, so the
// line cannot drift away from the sound.
check(
  'the playhead follows the AudioContext clock',
  audioSource.includes('const elapsed = current.context.currentTime - current.startedAt') &&
    audioSource.includes('source.start(0, start)'),
)
check('the two amplitude scales are both real', audioSource.includes('const DB_RANGE = 72') && audioSource.includes("dbMode ? 'dBFS' : 'linear'"))
check(
  'individual samples are drawn as stems once they are big enough on screen',
  audioSource.includes('const STEM_PX_PER_SAMPLE = 3') && audioSource.includes('if (stems) {'),
)
// Bytes come from the harness's own workspaceFiles remote, read in WINDOWS so a
// file far past the single-read cap still draws - and the package ships no
// route of its own to re-implement the path policy with. The WHOLE-FILE read is
// `readBytes` with empty options too: the namespace has no `readAll`, and the
// whole-file path asked for one, which is why no FLAC could ever be decoded.
check(
  'audio streams the file through the shipped remote, not a route of its own',
  audioSource.includes("const REMOTE_NAMESPACE = 'remote.workspaceFiles'") &&
    audioSource.includes('workspaceFiles.readBytes(sessionId, path, { offset: offset, length: size }, signal)') &&
    audioSource.includes('workspaceFiles.readBytes(sessionId, path, {}, signal)') &&
    audioSource.includes('.readAll(') === false &&
    audioSource.includes('fetch(') === false &&
    audioSource.includes("'/api/") === false,
)
check(
  'a refused window teaches the host cap instead of truncating the read',
  audioSource.includes("code !== 'workspace-file/too-large' && code !== 'gateway/bad-request'") &&
    audioSource.includes("typeof error.details.limit === 'number'") &&
    audioSource.includes('size = Math.max(WINDOW_FLOOR, smaller)'),
)
check(
  'the read is aborted when the tab goes away',
  audioSource.includes('const controller = new AbortController()') &&
    audioSource.includes('controller.abort()') &&
    audioSource.includes('const binary = atob(String(base64))') &&
    audioSource.includes('bytes[index] = binary.charCodeAt(index)'),
)
// Every window of every file goes through this decode, so it is DRIVEN rather
// than grepped: a `Uint8Array` (what the generated result codec declares), an
// ArrayBuffer, a plain array and base64 text must all answer the same bytes -
// a window handed to `atob` by mistake is a waveform that cannot be drawn.
const probeWindow = new Uint8Array([82, 73, 70, 70, 0, 255])
check(
  'the audio byte payload is accepted in every shape a carrier could use',
  audio.exports.__internals.bytesOf(probeWindow).join(',') === '82,73,70,70,0,255' &&
    audio.exports.__internals.bytesOf(probeWindow.buffer).join(',') === '82,73,70,70,0,255' &&
    audio.exports.__internals.bytesOf([82, 73, 70, 70, 0, 255]).join(',') === '82,73,70,70,0,255' &&
    audio.exports.__internals.bytesOf(btoa(String.fromCharCode(82, 73, 70, 70, 0, 255))).join(',') === '82,73,70,70,0,255' &&
    audio.exports.__internals.bytesOf(null) === null &&
    audio.exports.__internals.bytesOf('') === null,
)
// A whole-file read that stopped at the single-read ceiling arrives truncated
// with `eof: false`, and a browser decoder handed a truncated FLAC reports a
// decode fault instead of the size that caused it.
check(
  'a whole-file read refuses a truncated payload',
  audioSource.includes('result.value.eof === false') && audioSource.includes('so it cannot be decoded'),
)
check(
  'a FLAC past the single-read cap keeps its facts and says so',
  audioSource.includes('drawing its waveform means handing the whole file to the browser in one read') &&
    audioSource.includes('parseFlacInfo(bytes)'),
)
check('the peak pyramid starts at 256 samples and quadruples', A.BASE_BUCKET === 256 && A.LEVEL_FACTOR === 4)
// The header probe has to read PAST one window: a WAV with a large LIST/ID3
// chunk (embedded cover art) before its `data` is a chunk walk the first window
// cuts in half, and a walk that never finishes must say so rather than report a
// format it never reached.
check(
  'the header probe reads past one window, up to a ceiling',
  audioSource.includes('const PROBE_CEILING = 8 * 1024 * 1024') &&
    audioSource.includes('length = Math.min(ceiling, length * PROBE_GROWTH)') &&
    audioSource.includes('async function readPrefix(') &&
    audioSource.includes('so its format was never reached'),
)

// --- the WAV container, and the decoder behind it
const wavBytes = buildWav({ rate: 44100, channels: 1, bits: 16, frames: 2000 })
const wav = A.parseWav(wavBytes, wavBytes.length)
check(
  'a RIFF/WAVE header parses into facts',
  wav.ok === true && wav.sampleRate === 44100 && wav.channels === 1 && wav.bits === 16 && wav.format.kind === 's16' && wav.dataOffset === 44,
)
check('the frame count is the data chunk over the block align', wav.frames === 2000 && Math.abs(wav.duration - 2000 / 44100) < 1e-12)
const wavDecoded = A.decodePcm(wav.format, wavBytes.subarray(wav.dataOffset))
check('the decoder returns one Float32Array per channel', wavDecoded.channels.length === 1 && wavDecoded.frames === 2000 && wavDecoded.channels[0] instanceof Float32Array)
let wavPeak = 0
for (let index = 0; index < wavDecoded.channels[0].length; index += 1) {
  const magnitude = Math.abs(wavDecoded.channels[0][index])
  if (magnitude > wavPeak) wavPeak = magnitude
}
// 16384 of a signed 16-bit full scale is a half-scale sine, and 44.1 samples
// per cycle at 1 kHz means the nearest sample sits just under the crest.
check('a half-scale 16-bit sine decodes to a half-scale envelope', wavPeak > 0.495 && wavPeak <= 0.5)

// A known silence is silence: the second half of this file is exactly zero.
const gapsBytes = buildWav({
  rate: 8000,
  channels: 1,
  bits: 16,
  frames: 1600,
  sample(bytes, view, at, frame) {
    view.setInt16(at, frame < 800 ? 8000 : 0, true)
  },
})
const gapsFacts = A.parseWav(gapsBytes, gapsBytes.length)
const gaps = A.decodePcm(gapsFacts.format, gapsBytes.subarray(gapsFacts.dataOffset)).channels[0]
let silentTail = true
for (let index = 800; index < 1600; index += 1) if (gaps[index] !== 0) silentTail = false
let headSquares = 0
for (let index = 0; index < 800; index += 1) headSquares += gaps[index] * gaps[index]
check('a DC half then real silence decodes exactly', silentTail && gaps[0] === 8000 / 32768 && Math.abs(Math.sqrt(headSquares / 800) - 8000 / 32768) < 1e-9)

// 24-bit stereo: the two's-complement edges are the values a viewer can get
// wrong by one LSB.
const rampBytes = buildWav({
  channels: 2,
  bits: 24,
  frames: 3,
  sample(bytes, view, at, frame, channel) {
    const value = frame === 0 ? (channel === 0 ? 0x7fffff : -0x800000) : frame === 1 ? 0 : 0x400000
    bytes[at] = value & 0xff
    bytes[at + 1] = (value >> 8) & 0xff
    bytes[at + 2] = (value >> 16) & 0xff
  },
})
const rampFacts = A.parseWav(rampBytes, rampBytes.length)
const ramp = A.decodePcm(rampFacts.format, rampBytes.subarray(rampFacts.dataOffset))
check('24-bit stereo is read as 24-bit with a 6-byte frame', rampFacts.format.kind === 's24' && rampFacts.channels === 2 && rampFacts.blockAlign === 6)
check(
  '24-bit two\u2019s-complement edges decode to their exact ratios',
  ramp.channels[0][0] === 8388607 / 8388608 && ramp.channels[1][0] === -1 && ramp.channels[0][1] === 0 && ramp.channels[0][2] === 0.5,
)

// IEEE float is NOT clamped by the decoder: the value in the file is the value
// reported, and it is the DRAWING that clamps.
const floatBytes = buildWav({
  bits: 32,
  kind: 'float',
  frames: 2,
  sample(bytes, view, at, frame) {
    view.setFloat32(at, frame === 0 ? 0.25 : -1.5, true)
  },
})
const floatFacts = A.parseWav(floatBytes, floatBytes.length)
const floats = A.decodePcm(floatFacts.format, floatBytes.subarray(floatFacts.dataOffset))
check('IEEE float WAVE decodes unclamped', floatFacts.format.kind === 'f32' && floats.channels[0][0] === 0.25 && floats.channels[0][1] === -1.5)

// WAVE_FORMAT_EXTENSIBLE states its real format in the sub-format GUID.
const extensibleBytes = buildWav({ bits: 24, extensible: true, frames: 4 })
const extensibleFacts = A.parseWav(extensibleBytes, extensibleBytes.length)
check(
  'a WAVE_FORMAT_EXTENSIBLE header is read through its sub-format',
  extensibleFacts.ok === true && extensibleFacts.format.kind === 's24' && extensibleFacts.format.extensible === true && extensibleFacts.format.validBits === 24,
)

// The companded laws, against their canonical identities.
check(
  'the G.711 laws decode their own zero and full-scale codes',
  A.ulawToLinear(0xff) === 0 && A.ulawToLinear(0) === -32124 && A.alawToLinear(0x55) === -8 && A.alawToLinear(0xd5) === 8 && A.alawToLinear(0x2a) === -32256,
)
const alawBytes = buildWav({
  bits: 8,
  kind: 'alaw',
  frames: 2,
  sample(bytes, view, at, frame) {
    bytes[at] = frame === 0 ? 0x55 : 0x2a
  },
})
const alawFacts = A.parseWav(alawBytes, alawBytes.length)
const alaw = A.decodePcm(alawFacts.format, alawBytes.subarray(alawFacts.dataOffset))
check('A-law WAVE audio is decoded through the table', alawFacts.format.kind === 'alaw' && alaw.channels[0][0] === -8 / 32768 && alaw.channels[0][1] === -32256 / 32768)

// A truncated file draws what exists and says the rest is UNKNOWN, not silent.
const cutBytes = buildWav({ frames: 2000 }).slice(0, 44 + 1000)
const cut = A.parseWav(cutBytes, cutBytes.length)
check('a truncated WAVE reports the tail as unknown', cut.ok === true && cut.truncated === true && cut.frames === 500 && cut.declaredDataBytes === 4000)

// A codec this package does not decode is NAMED rather than drawn as noise.
const adpcmBytes = buildWav({ kind: 'adpcm', bits: 4, frames: 8 })
const adpcm = A.parseWav(adpcmBytes, adpcmBytes.length)
check('an unsupported WAVE codec is refused by name', adpcm.ok === false && adpcm.reason.includes('IMA ADPCM'))
const other = A.parseContainer(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 12)
check('something that is not audio at all is refused in a sentence', other.ok === false && other.reason.includes('not a RIFF/WAVE'))

// A `fmt ` chunk whose block align is narrower than one frame cannot be a stride
// at all: walking it reads a channel out of the NEXT frame's bytes (silently
// wrong samples), an 8-bit stereo file reads `undefined` into the samples and a
// float file throws a raw DataView RangeError at the last frame. Refused by name.
const narrowStride = buildWav({ channels: 2, bits: 16, frames: 16 })
new DataView(narrowStride.buffer).setUint16(32, 1, true)
const narrow = A.parseWav(narrowStride, narrowStride.length)
check(
  'a block align narrower than a frame is refused by name',
  narrow.ok === false && narrow.reason.includes('a frame of 4 bytes') && narrow.reason.includes('block align of 1'),
)

// A chunk with no body at all (a zero-size `junk`, an empty `LIST`) is 8 bytes of
// header and nothing else, so the walk has to step OVER it. It used to stop
// there, which made any file carrying one unreadable: the walk ended before
// `data`, the parse answered "no data chunk ... so far", the probe re-read the
// whole file looking for one and the viewer blamed a header it never reached.
const withEmptyChunk = buildWav({ channels: 1, bits: 16, frames: 8 })
const emptyChunk = new Uint8Array(withEmptyChunk.length + 8)
emptyChunk.set(withEmptyChunk.subarray(0, 36), 0)
emptyChunk.set([0x6a, 0x75, 0x6e, 0x6b, 0, 0, 0, 0], 36)
emptyChunk.set(withEmptyChunk.subarray(36), 44)
new DataView(emptyChunk.buffer).setUint32(4, emptyChunk.length - 8, true)
const stepped = A.parseWav(emptyChunk, emptyChunk.length, true)
check('a zero-size chunk is stepped over, not the end of the walk', stepped.ok === true && stepped.frames === 8)

// A prefix that IS the whole file has no more bytes to offer, so "read more" is
// the wrong answer: it is what made a 20-byte `RIFF...WAVE` report that its
// header was larger than the 8 MiB ceiling. The probe knows (the host says `eof`,
// and a known size it has covered is the same fact) and passes it down.
const stub = new Uint8Array(20)
const stubView = new DataView(stub.buffer)
for (const at of [0, 8]) {
  const word = at === 0 ? 'RIFF' : 'WAVE'
  for (let index = 0; index < 4; index += 1) stub[at + index] = word.charCodeAt(index)
}
stubView.setUint32(4, 12, true)
const wholeStub = A.parseWav(stub, stub.length, true)
check(
  'a whole-file prefix gets a verdict, not a "read more"',
  wholeStub.ok === false && wholeStub.needsMore !== true && wholeStub.reason === 'it has no fmt chunk',
)
const prefixStub = A.parseWav(stub, 4096)
check('a genuine prefix still asks for more bytes', prefixStub.ok === false && prefixStub.needsMore === true)
const flacStub = new Uint8Array(8)
flacStub.set([0x66, 0x4c, 0x61, 0x43], 0)
flacStub[4] = 0x80
flacStub[7] = 34
check(
  'an AIFF/FLAC chunk cut off by the END of the file is a verdict too',
  A.parseFlacInfo(flacStub, true).needsMore !== true && A.parseFlacInfo(flacStub, false).needsMore === true,
)

// ONE accent, four surfaces: the alpha is what separates the envelope from the
// RMS core inside it, and the token path used to hand the SAME opaque colour to
// envelope, rms, selection and selectionEdge - so the RMS core was painted in its
// envelope's own colour (invisible), the stems were solid and the selection
// covered the waveform. The token it read was not one the pinned line defines.
check('a hex accent takes the alpha it is given', A.withAlpha('#4f8cff', 0.55) === 'rgba(79,140,255,0.55)')
check('a short hex is expanded', A.withAlpha('#abc', 0.5) === 'rgba(170,187,204,0.5)')
check(
  'the envelope and the RMS core are different colours',
  A.withAlpha('#4f8cff', 0.55) !== A.withAlpha('#4f8cff', 1) &&
    audioSource.includes('envelope: withAlpha(accent, ENVELOPE_ALPHA)') &&
    audioSource.includes('rms: withAlpha(accent, RMS_ALPHA)'),
)
check(
  'every translucent surface gets its alpha',
  audioSource.includes('selection: withAlpha(accent, SELECTION_ALPHA)') && audioSource.includes('selectionEdge: withAlpha(accent, SELECTION_EDGE_ALPHA)'),
)
check(
  'the accent token is one the pinned line defines',
  audioSource.includes("value('--dsw-alias-brand-primary', ACCENT_FALLBACK)") && audioSource.includes('--dsw-alias-state-accent') === false,
)

// --- the AIFF container (the format a browser will not decode for us)
const aiffBytes = buildAiff({ rate: 44100, channels: 1, bits: 16, frames: 500 })
const aiff = A.parseAiff(aiffBytes, aiffBytes.length)
check(
  'an AIFF header parses, sample rate and all',
  aiff.ok === true && aiff.sampleRate === 44100 && aiff.channels === 1 && aiff.bits === 16 && aiff.format.kind === 's16' && aiff.format.endian === 'be' && aiff.frames === 500,
)
const aiffDecoded = A.decodePcm(aiff.format, aiffBytes.subarray(aiff.dataOffset))
let aiffPeak = 0
for (let index = 0; index < aiffDecoded.channels[0].length; index += 1) {
  const magnitude = Math.abs(aiffDecoded.channels[0][index])
  if (magnitude > aiffPeak) aiffPeak = magnitude
}
// Big-endian: reading these bytes little-endian would give a large, wrong
// number rather than a plausible one, which is exactly what this pins.
check('big-endian AIFF samples decode to their signed value', aiffPeak > 0.36 && aiffPeak <= 12000 / 32768)
const sowtBytes = buildAiff({ compression: 'sowt', bits: 16, frames: 200 })
const sowt = A.parseAiff(sowtBytes, sowtBytes.length)
check(
  'an AIFC sowt keeps its little-endian samples straight',
  sowt.ok === true && sowt.container === 'AIFC (IFF FORM)' && sowt.format.kind === 's16' && sowt.format.endian === 'le' && sowt.sampleRate === 44100,
)
const aiff8 = A.parseAiff(buildAiff({ bits: 8, frames: 100 }), 12 + 8 + 18 + 8 + 8 + 100)
check('8-bit AIFF is SIGNED, unlike 8-bit WAVE', aiff8.ok === true && aiff8.format.kind === 's8')
const imaBytes = buildAiff({ compression: 'ima4', bits: 16, frames: 100 })
const ima = A.parseAiff(imaBytes, imaBytes.length)
check('an AIFC codec this viewer cannot decode is refused by name', ima.ok === false && ima.reason.includes('IMA 4:1 ADPCM'))

// --- the FLAC container's own facts
const flacBytes = buildFlac({ rate: 48000, channels: 2, bits: 16, total: 96000, title: 'Tone' })
const flac = A.parseFlacInfo(flacBytes)
check(
  'a FLAC STREAMINFO block parses into facts',
  flac.ok === true && flac.sampleRate === 48000 && flac.channels === 2 && flac.bits === 16 && flac.frames === 96000 && flac.duration === 2,
)
check('a FLAC says which decoder will draw it', flac.format.compressed === true && flac.codec.includes('browser-decoded'))
check('a FLAC\u2019s Vorbis comment is read for its tags', flac.metadata.title === 'Tone')
check('the container is recognized from its magic, not its name', A.parseContainer(flacBytes, flacBytes.length).container === 'FLAC')

// --- the peak pyramid
const wave = new Float32Array(1024)
for (let index = 0; index < 256; index += 1) wave[index] = 0.5
for (let index = 256; index < 512; index += 1) wave[index] = -0.25
const whole = new A.PeakSet(1, 1024)
whole.push([wave])
whole.finish()
const split = new A.PeakSet(1, 1024)
split.push([wave.subarray(0, 300)])
split.push([wave.subarray(300, 700)])
split.push([wave.subarray(700)])
split.finish()
check('level 0 is one bucket per 256 samples', whole.levels[0].bucket === 256 && whole.levels[0].count === 4)
check(
  'a bucket is the (min, max, rms) of the samples in it',
  whole.levels[0].maxs[0][0] === 0.5 && whole.levels[0].mins[0][0] === 0.5 && whole.levels[0].rmss[0][0] === 0.5 && whole.levels[0].mins[0][1] === -0.25 && whole.levels[0].rmss[0][1] === 0.25 && whole.levels[0].rmss[0][2] === 0,
)
// The pyramid's buckets are Float32Arrays, so a decimated RMS is compared
// against its exact value with the storage's own tolerance (float32 rounding is
// ~4e-9 here), not a double's.
check(
  'a decimated level groups four buckets, RMS and all',
  whole.levels[1].bucket === 1024 &&
    whole.levels[1].count === 1 &&
    whole.levels[1].maxs[0][0] === 0.5 &&
    whole.levels[1].mins[0][0] === -0.25 &&
    Math.abs(whole.levels[1].rmss[0][0] - Math.sqrt((0.25 + 0.0625) / 4)) < 1e-6,
)
// This is the claim the windowed decode rests on: feeding the samples in
// windows builds the SAME pyramid as feeding them in one block. A window
// boundary that split a bucket would break it.
check(
  'a windowed decode builds the same pyramid as a whole one',
  split.levels[0].count === whole.levels[0].count &&
    split.levels[0].rmss[0][1] === whole.levels[0].rmss[0][1] &&
    split.levels[0].maxs[0][0] === whole.levels[0].maxs[0][0] &&
    split.levels[1].rmss[0][0] === whole.levels[1].rmss[0][0],
)
check('the level read is the largest one that fits a pixel', A.pickLevel(whole, 100).bucket === 256 && A.pickLevel(whole, 1024).bucket === 1024 && A.pickLevel(whole, 9e6).bucket === 1024)
const column = A.columnEnvelope(whole.levels[0], 0, 0, 256)
check('a pixel column aggregates the buckets under it', column !== null && column.max === 0.5 && column.rms === 0.5)

// --- the ruler, the readouts and the addresses
check('the ruler picks a 1-2-5 step that fits its labels', A.tickStepFor(100, 64) === 1 && A.tickStepFor(10, 64) === 10 && A.tickStepFor(1000, 64) === 0.1 && A.tickStepFor(500000, 64) === 0.0002)
check('times read as m:ss.mmm, with the hours only when there are any', A.formatTime(0) === '0:00.000' && A.formatTime(221.512) === '3:41.512' && A.formatTime(3725.5) === '1:02:05.500')
check(
  'dBFS is 20 log10, and real silence says so',
  A.formatDb(1) === '0.0 dBFS' && A.formatDb(0.5) === '-6.0 dBFS' && A.formatDb(0) === 'silent' && Math.abs(A.amplitudeToDb(0.25) + 12.0412) < 0.001,
)
check(
  'tracks are named L/R for a stereo pair, numbered past that, and a mono file has no letter to decode',
  A.channelLabel(0, 2) === 'L' && A.channelLabel(1, 2) === 'R' && A.channelLabel(0, 1) === '' && A.channelLabel(2, 4) === '3',
)
check(
  'audio canOpen takes the three families and refuses everything else',
  A.isAudioAddress('dsh-resource://file/session/s1/takes/take%2001.WAV') === true &&
    A.isAudioAddress('dsh-resource://file/session/s1/takes/take.flac') === true &&
    A.isAudioAddress('dsh-resource://file/session/s1/takes/take.aifc') === true &&
    A.isAudioAddress('dsh-resource://file/session/s1/song.mp3') === false &&
    A.isAudioAddress('dsh-resource://file/session/s1/notes.txt') === false &&
    A.isAudioAddress('dsh-resource://file/absolute/C:/tmp/take.wav') === false &&
    A.isAudioAddress('dsh-resource://pdf/absolute/x.wav') === false,
)
check('the address parser keeps a Windows drive segment whole', A.parseAudioAddress('dsh-resource://file/session/s1/C:/audio/take.wav').path, 'C:/audio/take.wav')

// --- activation, the tab type and the seats
const audioTypes = []
const audioSeats = {}
audio.exports.apply({
  slots: {
    inject: (name, fn) => fn(),
    register(spec, component) {
      audioSeats[spec.name + (spec.key ? '#' + spec.key : '')] = { spec, component }
      return () => {}
    },
  },
  sidebarRightTabs: { register: (definition) => (audioTypes.push(definition), () => {}), entries: () => [] },
  get: () => ({ readBytes: () => Promise.resolve({ ok: false, error: { code: 'workspace-file/not-found' } }) }),
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
check('audio type registered', audioTypes.length === 1 && audioTypes[0].id + '/' + audioTypes[0].kind, 'dsh-audio/audio')
check('audio outranks the shipped preview band', audioTypes[0].priority, 'extension')
check('audio claims exactly the three families', JSON.stringify(audioTypes[0].patterns), '["*.wav","*.wave","*.aif","*.aiff","*.aifc","*.flac"]')
// A blank audio file is not a document anyone opens from the "+" control, so
// this type adds no guide capsule - it only ever claims a real file address.
check('the audio type adds no guide entry', audioTypes[0].guide === undefined)
check('the audio chip title is the file name', audioTypes[0].title('dsh-resource://file/session/s1/takes/take%2001.wav'), 'take 01.wav')
// The tab seats, AND (alpha.3) the two registrations the left column's Audio
// button needs: the panel ROW the shell draws, and the `main` SEAT its click
// selects. Both are asserted by shape below, because the row is useless without
// the seat (layout.selectPanel throws for an id with no panel behind it) and the
// seat is unreachable without the row.
check(
  'audio seats',
  Object.keys(audioSeats).sort().join(','),
  'main#audio,sidebar.panellist,sidebar.right.pane.tab#dsh-audio,sidebar.right.pane.tab.title#dsh-audio',
)
check(
  'the Audio row is a panel row of this package, above Plugins',
  audioSeats['sidebar.panellist'] !== undefined &&
    audioSeats['sidebar.panellist'].spec.name === 'sidebar.panellist' &&
    audioSeats['sidebar.panellist'].spec.id === A.PANEL_ID &&
    audioSeats['sidebar.panellist'].spec.order === A.PANEL_ORDER &&
    audioSeats['sidebar.panellist'].spec.label === 'Audio',
)
check('...and the seat its click selects is keyed by the same id', audioSeats['main#audio'] !== undefined && audioSeats['main#audio'].spec.key === A.PANEL_ID)
// Plugins is the row this one must sit ON TOP OF, and `order` is the whole
// mechanism: the list sorts ascending. Pinned against the SHIPPED bundle rather
// than against a comment, and skipped loudly on a host with no harness install.
{
  const pluginManagerFile = findCoreFile(path.join('@deepseek-ai', 'dsh-client-ui-plugin-manager', 'lib', 'client.js'))
  if (pluginManagerFile === null) {
    console.log('skip the shipped Plugins row order                      (no core bundle on this host)')
  } else {
    const pluginManager = readFileSync(pluginManagerFile, 'utf8')
    const at = pluginManager.indexOf('"sidebar.panellist"')
    const registration = at === -1 ? '' : pluginManager.slice(at, at + 420)
    check('the shipped Plugins row still registers at order 0', registration.includes('order: 0'), true)
    check('...so an order below zero is above it', A.PANEL_ORDER < 0, true)
    // The label is what the shell prints in the row AND in its tooltip, so it
    // has to be the plain product name and nothing else.
    check('the row is labelled exactly "Audio"', audioSeats['sidebar.panellist'].spec.label === 'Audio', true)
  }
}
// The glyph is drawn here (the shipped primitives have no speaker icon) and it
// is the ONLY thing the row's registrant owns: the shell draws the button, its
// hover, its active state and the label.
check(
  'the row draws a speaker glyph and nothing else',
  renderToStaticMarkup(h(A.AudioPanelRow, { size: 16, active: false })).indexOf('<svg') !== -1 &&
    renderToStaticMarkup(h(A.AudioPanelRow, { size: 16, active: false })).indexOf('Audio') === -1,
)
const AudioBody = audioSeats['sidebar.right.pane.tab#dsh-audio'].component
const audioTab = { id: 'tab11', contentId: 'dsh-resource://file/session/s1/takes/take%2001.wav', title: 'take 01.wav' }
const audioMarkup = renderToStaticMarkup(h(AudioBody, { useTabInfo: () => ({ tab: audioTab }), sessionId: 's1' }))
check('the audio body renders its opening state', audioMarkup.includes('data-audio-state="loading"') && audioMarkup.includes('Opening take 01.wav'))
check('the opening state names the file it is opening', audioMarkup.includes('s1/takes/take 01.wav'))
check(
  'audio title seat draws the chip',
  renderToStaticMarkup(h(audioSeats['sidebar.right.pane.tab.title#dsh-audio'].component, { useTabInfo: () => ({ tab: audioTab }) })),
  '<span class="dsa-title">take 01.wav</span>',
)
const audioNoTabMarkup = renderToStaticMarkup(h(AudioBody, { useTabInfo: () => ({ tab: { id: 'tab12', contentId: '' } }) }))
check('an address-less audio tab still renders', audioNoTabMarkup.includes('data-audio-state="loading"'))

// --- the surface itself, rendered
//
// The loading state above is all a server render of the BODY reaches (the
// decode runs in an effect). The viewer and the details panel are rendered
// directly instead, on facts and a pyramid built here, so the toolbar, the
// spacer, the canvas and the status line are all exercised as markup - which is
// what catches a reference or a prop that only the loaded surface touches.
const audioViewerFacts = {
  container: 'WAVE (RIFF)',
  codec: 'PCM signed 16-bit little-endian',
  sampleRate: 8000,
  channels: 2,
  bits: 16,
  frames: 1024,
  duration: 0.128,
  truncated: false,
  metadata: { title: 'Take 1', artist: 'Test' },
  format: { kind: 's16', endian: 'le', channels: 2, sampleRate: 8000, bits: 16, blockAlign: 4 },
}
const audioViewerPeaks = new A.PeakSet(2, 1024)
audioViewerPeaks.push([new Float32Array(1024).fill(0.25), new Float32Array(1024).fill(-0.25)])
audioViewerPeaks.finish()
const audioViewerMarkup = renderToStaticMarkup(
  h(A.AudioViewer, {
    facts: audioViewerFacts,
    peaks: audioViewerPeaks,
    samples: [new Float32Array(1024).fill(0.25), new Float32Array(1024).fill(-0.25)],
    buffer: null,
    size: 4124,
    source: 'this package (WAV/AIFF decoded in the page, window by window)',
    name: 'take 01.wav',
    path: 'takes/take 01.wav',
    onReload: () => {},
  }),
)
check(
  'the viewer renders its transport, canvas, spacer and status line',
  audioViewerMarkup.includes('data-audio-viewer="take 01.wav"') &&
    audioViewerMarkup.includes('data-audio-action="play"') &&
    audioViewerMarkup.includes('data-audio-canvas="true"') &&
    audioViewerMarkup.includes('data-audio-spacer="true"') &&
    audioViewerMarkup.includes('data-audio-status="true"'),
)
check(
  'the viewer states the facts it was given',
  audioViewerMarkup.includes('data-audio-rate="8000"') &&
    audioViewerMarkup.includes('8000 Hz') &&
    audioViewerMarkup.includes('2 ch') &&
    audioViewerMarkup.includes('16-bit') &&
    audioViewerMarkup.includes('0:00.128') &&
    audioViewerMarkup.includes('WAV'),
)
check(
  'the spacer carries the file\'s own width at this zoom, and the canvas does not',
  audioViewerMarkup.includes('data-audio-spacer="true"') && audioViewerMarkup.includes('width:') && audioViewerMarkup.includes('data-audio-canvas="true"'),
)
check('the scale toggle shows which scale is on', audioViewerMarkup.includes('>linear<') && audioViewerMarkup.includes('data-audio-action="scale"'))
const audioViewerInfoMarkup = renderToStaticMarkup(
  h(A.InfoPanel, { facts: audioViewerFacts, size: 4124, source: 'this package', levels: '256 samples/bucket \u2192 1024 samples/bucket' }),
)
check(
  'the details panel carries the facts, the pyramid and the file\'s metadata',
  audioViewerInfoMarkup.includes('PCM signed 16-bit little-endian') &&
    audioViewerInfoMarkup.includes('8000 Hz') &&
    audioViewerInfoMarkup.includes('Take 1') &&
    audioViewerInfoMarkup.includes('Test') &&
    audioViewerInfoMarkup.includes('256 samples/bucket'),
)

// --- the audio console (alpha.3): this machine's devices, the output the page
// plays through, and the tone that proves it
//
// The console is the pack's first surface about the MACHINE rather than about a
// file: which outputs and inputs this computer has, which one this page plays
// through, and a tone that verifies the pick by ear. None of that is reachable
// from a server render - enumeration, routing and playback are all effects - so
// this section splits it the way the rest of this file does: the NUMBERS are
// pure and driven here, and the MARKUP is rendered from hand-built devices.

// The three shapes a browser can have, as environment objects: the branch that
// decides whether a pick can be honoured AT ALL, and the sentence each branch
// owes the reader. Only Chromium 110+ routes a page's Web Audio graph, and
// Firefox/Safari route nothing - so the "no" branch has to name the way out.
check('a browser with AudioContext.setSinkId routes the app\u2019s own engine', A.pickOutputStrategy({ contextSetSinkId: true, elementSetSinkId: true }).kind, 'context')
check('a browser with only HTMLMediaElement.setSinkId routes the tone', A.pickOutputStrategy({ elementSetSinkId: true }).kind, 'element')
const noRouting = A.pickOutputStrategy({})
check('a browser with neither says so instead of pretending', noRouting.kind === 'none' && noRouting.sentence.includes('system mixer'))

// The device list: the default alias is folded onto the EMPTY id, the two kinds
// are separated, the browser's own order is replaced by default-then-label, a
// device with no name is KEPT (it is a real device) and the list reports that a
// name is missing, and a camera is not audio.
const rawDeviceList = [
  { kind: 'audioinput', deviceId: 'mic1', label: 'USB Microphone', groupId: 'g1' },
  { kind: 'audiooutput', deviceId: 'default', label: 'Default', groupId: 'g2' },
  { kind: 'audiooutput', deviceId: 'spk1', label: 'Speakers (Realtek)', groupId: 'g2' },
  { kind: 'audiooutput', deviceId: 'hdmi1', label: '', groupId: 'g3' },
  { kind: 'videoinput', deviceId: 'cam1', label: 'Webcam', groupId: 'g4' },
]
const devices = A.normalizeDevices(rawDeviceList)
check(
  'the device list splits the two kinds, default first',
  devices.outputs.length === 3 && devices.inputs.length === 1 && devices.outputs[0].id === '' && devices.outputs[0].isDefault === true,
)
check('...sorts the rest by label', devices.outputs[1].id === 'hdmi1' && devices.outputs[2].id === 'spk1', true)
check('...keeps an unnamed device and says a name is missing', devices.unnamed === true && devices.outputs[1].label === '')
check('...and drops a camera', devices.outputs.every((device) => device.kind === 'output') && devices.inputs[0].id === 'mic1')
check(
  'a nameless device is named by its position instead',
  A.deviceTitle({ label: '', kind: 'output' }, 1) === 'Output 2' && A.deviceTitle({ label: '', kind: 'input' }, 0) === 'Input 1' && A.deviceTitle({ label: 'Speakers' }, 0) === 'Speakers',
)
check('an id is a hash, so a card shows six characters of it', A.shortId('0123456789abcdef') === '012345\u2026' && A.shortId('') === 'system default' && A.shortId('ab') === 'ab')
// Where the system default GOES. Chromium gives the alias and the device it
// resolves to the SAME groupId, which is the only way to show it rather than
// leave a person to find out by ear.
check('the default card can name the device it points at', A.defaultTargetOf(devices.outputs), 'Speakers (Realtek)')
check('...and says nothing when the browser does not group them', A.defaultTargetOf([{ kind: 'output', id: '', label: 'Default', groupId: '', isDefault: true }]), '')
check(
  'a picked device is named, and a device that has gone says so',
  A.nameOfId(devices.outputs, 'spk1') === 'Speakers (Realtek)' &&
    A.nameOfId(devices.outputs, '') === 'system default' &&
    A.nameOfId(devices.outputs, 'gone') === 'a device that is no longer connected',
)

// The tone's numbers. The level is a SQUARE law so the slider's middle is -12 dB
// (a linear slider spends nine tenths of its travel in the top 20 dB) and the
// frequency is clamped to what a listener can hear.
check('the level slider is a square law, so half of it is -12 dB', A.gainForLevel(50) === 0.25 && A.gainForLevel(100) === 1 && A.gainForLevel(0) === 0, true)
check('...and the label beside it says the same thing', A.dbForLevel(50).toFixed(1), '-12.0')
check('a typed frequency is clamped to the audible band', A.clampFrequency(0) === 440 && A.clampFrequency(999999) === 20000 && A.clampFrequency(3) === 20 && A.clampFrequency(440.4) === 440)
check('the channel picker has three positions', A.panForChannel('left') === -1 && A.panForChannel('right') === 1 && A.panForChannel('both') === 0)
check('a steady tone stops itself', A.TONE_MAX_SECONDS === 30)

// The tone as samples, which is what the `element` path plays and what the WAV
// encoder writes: silent at BOTH ends (a click is not a speaker test), and a
// channel choice has to be SILENT on the side it is not testing - an equal-power
// pan law would leave a "left" tone audible on the right.
const toneLeft = A.toneChannels({ frequency: 250, level: 100, channel: 'both', sampleRate: 1000, seconds: 1 })
check('a generated tone is two channels of a sine', toneLeft.length === 2 && toneLeft[0].length === 1000 && toneLeft[1].length === 1000)
check('...silent at both ends', toneLeft[0][0] === 0 && toneLeft[0][999] === 0 && toneLeft[1][0] === 0)
let tonePeak = 0
for (let index = 100; index < 900; index += 1) tonePeak = Math.max(tonePeak, Math.abs(toneLeft[0][index]))
check('...at the level the slider asked for', tonePeak > 0.999 && tonePeak <= 1)
check('...and equal in both channels for "both"', toneLeft[0][400] === toneLeft[1][400] && toneLeft[0][400] !== 0)
// A mono choice is the same signal on ONE side only, which is what makes the
// channel picker a speaker check at all.
const monoChoice = A.toneChannels({ frequency: 250, level: 100, channel: 'left', sampleRate: 1000, seconds: 0.01 })
check('...and a left-only tone is exactly that', monoChoice[0][5] !== 0 && monoChoice[1][5] === 0)

// THE WAV ENCODER, against the decoder that sits next to it in the same file:
// the tone is encoded, parsed back as a container and decoded as PCM, and the
// numbers that come out have to be the numbers that went in. That is the only
// way the `element` path's sound is verified without a browser to play it.
const encodedTone = A.encodeWav(toneLeft, 1000)
const encodedFacts = A.parseWav(encodedTone, encodedTone.length)
check(
  'the generated tone is a real RIFF/WAVE the package\u2019s own parser accepts',
  encodedFacts.ok === true && encodedFacts.format.kind === 's16' && encodedFacts.sampleRate === 1000 && encodedFacts.channels === 2 && encodedFacts.frames === 1000,
)
const decodedTone = A.decodePcm(encodedFacts.format, encodedTone.subarray(encodedFacts.dataOffset))
let roundTripWorst = 0
for (let index = 0; index < 1000; index += 1) {
  roundTripWorst = Math.max(roundTripWorst, Math.abs(decodedTone.channels[0][index] - toneLeft[0][index]), Math.abs(decodedTone.channels[1][index] - toneLeft[1][index]))
}
check('...and 16-bit round-trips to within one LSB', roundTripWorst <= 1 / 32767 + 1e-9)

// The meter. `getByteTimeDomainData` hands back unsigned bytes about 128, so the
// reading is an amplitude and the bar is a dB scale - a linear bar would sit at
// zero for every room a microphone is actually used in.
check('the meter reads silence as silence', A.rmsOfWaveform(new Uint8Array(64).fill(128)) === 0)
const halfScaleWave = new Uint8Array(64)
for (let index = 0; index < 64; index += 1) halfScaleWave[index] = index % 2 === 0 ? 192 : 64
check('...and a half-scale square wave as a half-scale amplitude', Math.abs(A.rmsOfWaveform(halfScaleWave) - 0.5) < 1e-12)
check('the bar is a 60 dB scale', A.levelBar(1) === 1 && A.levelBar(0) === 0 && Math.abs(A.levelBar(0.5) - (60 - 20 * Math.log10(2)) / 60) < 1e-12)
check('a camel-case setting reads as words', A.camelWords('echoCancellation') === 'echo cancellation' && A.camelWords('autoGainControl') === 'auto gain control')
const described = A.describeStream({
  getSettings: () => ({ sampleRate: 48000, channelCount: 1, latency: 0.01, echoCancellation: false, noiseSuppression: true }),
  getCapabilities: () => ({ sampleRate: { min: 8000, max: 48000 } }),
})
check(
  'the input test reports what the browser actually opened',
  JSON.stringify(described),
  JSON.stringify([
    ['sample rate', '48000 Hz'],
    ['channels', '1'],
    ['latency', '10.0 ms'],
    ['echo cancellation', 'off'],
    ['noise suppression', 'on'],
    ['device rates', '8000\u201348000 Hz'],
  ]),
)
// A track with no `getSettings` at all is not a crash: the meter still runs.
check('a track that reports nothing describes nothing', A.describeStream({}).length === 0 && A.describeStream(null).length === 0)
check('a chosen input is opened EXACTLY, and the default is left to the system', JSON.stringify(A.captureConstraints('mic1')), JSON.stringify({ audio: { deviceId: { exact: 'mic1' } } }))
check('...and the default asks for nothing in particular', JSON.stringify(A.captureConstraints('')), JSON.stringify({ audio: true }))

// The remembered choice, driven with a storage double - including the two shapes
// a real browser hands back: a BLOCKED store (which THROWS on access rather than
// answering null) and a value that is not the JSON this package wrote.
const storageDouble = { map: {}, getItem(key) { return Object.prototype.hasOwnProperty.call(this.map, key) ? this.map[key] : null }, setItem(key, value) { this.map[key] = String(value) } }
check('an unset choice is the system default', JSON.stringify(A.readChoice(storageDouble)), JSON.stringify({ outputId: '', inputId: '' }))
A.writeChoice(storageDouble, { outputId: 'spk1', inputId: 'mic1' })
check('a choice round-trips through storage', JSON.stringify(A.readChoice(storageDouble)), JSON.stringify({ outputId: 'spk1', inputId: 'mic1' }))
storageDouble.map[A.STORAGE_KEY] = '{ not json'
check('...and corrupt storage is the default rather than a crash', A.readChoice(storageDouble).outputId === '')
const throwingStorage = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
check('...and a BLOCKED store is survivable in both directions', A.readChoice(throwingStorage).outputId === '' && A.writeChoice(throwingStorage, { outputId: 'x', inputId: '' }) === undefined)
check('no storage at all is survivable too', A.readChoice(null).outputId === '' && A.writeChoice(null, { outputId: 'x', inputId: '' }) === undefined)

// THE CONSOLE, RENDERED. One ready state with both kinds of device, a default
// that points somewhere, a chosen output, and a routing verdict - which is as
// much as a static render can see, and enough to catch a card that lost its
// selection test or a control that lost its label.
const consoleReady = {
  phase: 'ready',
  error: '',
  unnamed: true,
  outputs: [
    { kind: 'output', id: '', label: 'Default', groupId: 'g2', isDefault: true },
    { kind: 'output', id: 'hdmi1', label: '', groupId: 'g3', isDefault: false },
    { kind: 'output', id: 'spk1', label: 'Speakers (Realtek)', groupId: 'g2', isDefault: false },
  ],
  inputs: [{ kind: 'input', id: 'mic1', label: 'USB Microphone', groupId: 'g1', isDefault: false }],
}
const consoleMarkup = renderToStaticMarkup(
  h(A.AudioConsoleView, {
    state: consoleReady,
    choice: { outputId: 'spk1', inputId: 'mic1' },
    routing: A.pickOutputStrategy({ contextSetSinkId: true }),
    tone: { playing: false, frequency: 440, level: 50, channel: 'both' },
    meter: { phase: 'idle', error: '', level: 0, peak: 0, rows: [] },
    status: { tone: 'ok', message: 'The device names are visible now.' },
    naming: false,
    engineState: 'running',
    engineRate: '48000 Hz',
    onSelectOutput: () => {},
    onSelectInput: () => {},
    onFrequency: () => {},
    onLevel: () => {},
    onChannel: () => {},
    onToggle: () => {},
    onInputStart: () => {},
    onInputStop: () => {},
    onNames: () => {},
    onReload: () => {},
    onClose: () => {},
  }),
)
check('the console draws its bar, its version and both columns', consoleMarkup.includes('data-audio-console="true"') && consoleMarkup.includes('v' + audioVersion) && consoleMarkup.includes('data-audio-section="output"') && consoleMarkup.includes('data-audio-section="input"'))
check('every device is a card, named as the browser named it', consoleMarkup.includes('Speakers (Realtek)') && consoleMarkup.includes('USB Microphone') && consoleMarkup.includes('data-audio-device="spk1"'))
check('...a nameless device is a card too', consoleMarkup.includes('Output 2') && consoleMarkup.includes('data-audio-device="hdmi1"'))
check('...and the default card says where it points', consoleMarkup.includes('system default \u2192 Speakers (Realtek)'))
check('the picked output and input are the marked ones', (consoleMarkup.match(/data-audio-device="(spk1|mic1)"[^>]*data-active="true"/g) || []).length === 2 && !/data-audio-device="hdmi1"[^>]*data-active/.test(consoleMarkup))
check('the tone offers a frequency, a level, a channel and Play', consoleMarkup.includes('aria-label="Tone frequency in hertz"') && consoleMarkup.includes('aria-label="Tone level"') && consoleMarkup.includes('data-audio-channel="left"') && consoleMarkup.includes('-12.0 dB') && consoleMarkup.includes('data-audio-action="tone"'))
check('the input side offers the meter and the names', consoleMarkup.includes('data-audio-meter="true"') && consoleMarkup.includes('data-audio-action="names"') && consoleMarkup.includes('Listen to this input'))
check('the engine section reports the engine\u2019s own state', consoleMarkup.includes('data-audio-section="engine"') && consoleMarkup.includes('48000 Hz'))
check('a status message is drawn with its own tone', consoleMarkup.includes('data-audio-status="ok"'))

// A browser that cannot route draws the SAME cards, disabled and with the
// reason on them: the machine has those devices, and knowing the list is what
// makes the "choose it in the system mixer" sentence actionable.
const noRouteMarkup = renderToStaticMarkup(
  h(A.AudioConsoleView, {
    state: consoleReady,
    choice: { outputId: '', inputId: '' },
    routing: A.pickOutputStrategy({}),
    tone: { playing: false, frequency: 440, level: 50, channel: 'both' },
    meter: { phase: 'idle', error: '', level: 0, peak: 0, rows: [] },
    status: null,
    naming: false,
    engineState: 'not started',
    engineRate: '',
    onSelectOutput: () => {},
    onSelectInput: () => {},
    onFrequency: () => {},
    onLevel: () => {},
    onChannel: () => {},
    onToggle: () => {},
    onInputStart: () => {},
    onInputStop: () => {},
    onNames: () => {},
    onReload: () => {},
    onClose: () => {},
  }),
)
check('an unrouteable browser still lists the devices', noRouteMarkup.includes('Speakers (Realtek)') && noRouteMarkup.includes('data-audio-device="spk1"'))
check('...with the output cards disabled and the reason on them', noRouteMarkup.includes('cannot route a page\u2019s audio to a chosen output') && (noRouteMarkup.match(/data-device-kind="output"[^>]*disabled/g) || []).length >= 3)

// The playing state: the button becomes Stop and the settings FREEZE - which is
// the honest shape, because the generated-WAV path bakes them in and a control
// that works on one browser and not another is worse than one that is disabled.
const playingMarkup = renderToStaticMarkup(
  h(A.ToneSection, {
    tone: { playing: true, frequency: 1000, level: 50, channel: 'right' },
    live: false,
    target: 'Speakers (Realtek)',
    onFrequency: () => {},
    onLevel: () => {},
    onChannel: () => {},
    onToggle: () => {},
  }),
)
check('a playing tone offers Stop and freezes its settings', playingMarkup.includes('Stop') && playingMarkup.includes('data-audio-note="frozen"') && (playingMarkup.match(/aria-label="Tone frequency in hertz"[^>]*disabled/g) || []).length === 1)
check('...and the level slider freezes with it', (playingMarkup.match(/aria-label="Tone level"[^>]*disabled/g) || []).length === 1)

// The meter, live and failed: the bar carries the level, the peak is printed,
// and a refusal is a sentence rather than a silent zero.
const meterMarkup = renderToStaticMarkup(
  h(A.InputTestSection, {
    meter: { phase: 'live', error: '', level: 0.5, peak: 0.9, rows: [['sample rate', '48000 Hz']] },
    sentence: 'A live meter off the chosen input.',
    onStart: () => {},
    onStop: () => {},
  }),
)
check('a live meter draws a bar, a reading and the capture\u2019s facts', meterMarkup.includes('data-audio-meter="true"') && meterMarkup.includes('-6.0 dBFS') && meterMarkup.includes('peak -0.9 dBFS') && meterMarkup.includes('48000 Hz'))
check('...and offers the stop', meterMarkup.includes('Stop listening'))
const meterFailed = renderToStaticMarkup(
  h(A.InputTestSection, {
    meter: { phase: 'error', error: 'The microphone could not be opened: NotAllowedError', level: 0, peak: 0, rows: [] },
    sentence: 'A live meter off the chosen input.',
    onStart: () => {},
    onStop: () => {},
  }),
)
check('a refused microphone is a sentence', meterFailed.includes('NotAllowedError') && meterFailed.includes('Listen to this input'))

// The seat, with NO dialog service in the profile (the stub context answers
// every service name with an object that has no `open`): the console is drawn
// INLINE, which is the whole point of the degradation - a working surface
// instead of an unhandled exception, and no dead end either way.
const seatInline = renderToStaticMarkup(h(A.AudioSeat, {}))
check('without the dialog service the console is a page, not a crash', seatInline.includes('data-audio-console="true"') && seatInline.includes('data-audio-seat="inline"'))
// ...and WITH one, the seat defers to it and draws the reopen control instead of
// a second copy of the console - activated against a context that HAS `modals`,
// because that is the only difference between the two profiles.
audio.exports.apply({
  slots: { inject: (name, fn) => fn(), register: () => () => {} },
  sidebarRightTabs: { register: () => () => {}, entries: () => [] },
  get: (name) => (name === 'modals' ? { open: () => Promise.resolve(null) } : undefined),
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
const seatDialog = renderToStaticMarkup(h(A.AudioSeat, {}))
check('with the dialog service the seat opens it and offers it again', seatDialog.includes('data-audio-seat="dialog"') && seatDialog.includes('data-audio-action="open-console"') && seatDialog.includes('data-audio-console="true"') === false)
check('...and can still be forced inline', renderToStaticMarkup(h(A.AudioSeat, { inline: true })).includes('data-audio-seat="inline"'))

// The wiring that a render cannot see, pinned as source because each of these is
// a decision that would quietly stop working if it were dropped.
check('the dialog surface is resolved lazily, never injected', audioSource.includes("const MODAL_SERVICE = 'modals'") && audioSource.includes('serviceNow(MODAL_SERVICE)'))
check('the pick is remembered per browser', audioSource.includes("const STORAGE_KEY = 'dsh-audio.devices'"))
check(
  'the output is routed through the shared engine AND the page\u2019s media elements',
  audioSource.includes('await audioContext.setSinkId(id)') && audioSource.includes("querySelectorAll('audio,video')") && audioSource.includes('await element.setSinkId(id)'),
)
// A context created AFTER the choice was made is pointed at it at the one moment
// it exists: otherwise a reload would silently play through the system default.
check('a context created later honours the remembered output', audioSource.includes('applyChosenSink(audioContext)'))
// ...and a player mounted later is caught by the CAPTURE listener, because
// `play` does not bubble: one listener catches every element the page will ever
// start, instead of a sweep that only ever sees what is already mounted.
check('a media element mounted later joins the chosen output', audioSource.includes("document.addEventListener('play', onPlay, true)"))
check('the sink APIs are feature-detected, never assumed', audioSource.includes("typeof proto.setSinkId === 'function'") && audioSource.includes("'setSinkId' in elementProto"))
// The meter is a SINK: nothing may connect an analyser to the destination, or
// the microphone would feed the room back into it.
check('the input meter is never played back', audioSource.includes('source.connect(analyser)') && audioSource.includes('analyser.connect(') === false)
check('the tone stops itself and is ramped, never cut', audioSource.includes('oscillator.stop(endsAt)') && audioSource.includes('linearRampToValueAtTime(0.0001'))
// THE CONSOLE STAYS SMALL, and it is pinned by ABSENCE so it cannot grow back one
// button at a time: no frequency ladder, no left-right sweep, and no sentence
// about the tone - the routing caveat lives once, in the output section, and the
// status line is reserved for what went wrong.
check(
  'the console keeps ONE frequency control and no sweep',
  audioSource.includes('TONE_PRESETS') === false &&
    audioSource.includes('SWEEP_PLAN') === false &&
    audioSource.includes('sweepSeconds') === false &&
    audioSource.includes("'data-audio-action': 'sweep'") === false &&
    audioSource.includes('Left \u2192 right') === false &&
    audioSource.includes('stops itself after') === false &&
    audioSource.includes('which is the graph the output pick moves') === false,
)
check('the panel list is asked for the row above Plugins', audioSource.includes("ctx.slots.register({ name: PANEL_SLOT, id: PANEL_ID, order: PANEL_ORDER, label: 'Audio'"))
// The dialog is opened ON MOUNT, and `version` is the only thing that re-opens
// it: the service lives in a ref precisely so a provider answering a fresh
// wrapper cannot turn one press into a queue of dialogs.
check('the seat opens the dialog on mount and can reopen it', audioSource.includes("'data-audio-action': 'open-console'") && audioSource.includes('[hasModal, version])') && audioSource.includes('modalsRef.current = modals'))
check('the column is handed back only when it is still this package\u2019s', audioSource.includes('if (active !== PANEL_ID) return'))
check('...and never to a panel that has gone', audioSource.includes('layout.selectPanel(panelBeforeAudio)') && audioSource.includes('layout.selectPanel(null)'))
check('the console keeps the package client-only', audioSource.includes('fetch(') === false && audioSource.includes("'/api/") === false)
check(
  'the stylesheet carries the console\u2019s own dress',
  audioCss.includes('.dsa-console{') && audioCss.includes('.dsa-card[') && audioCss.includes('.dsa-meterFill{') && audioCss.includes('.dsa-panelGlyph{'),
)

// ----------------------------------------------------------- dsh-ui-state
// The pack's durable UI state (alpha.1). Its Node half DECLARES the row's own
// `.volatile()` Config - which is what the Host projects into the settings form
// these fields live in - and the pre-paint zoom row (both driven in
// check-node-routes.mjs); THIS half binds that form once, publishes the `uiState`
// service, and puts the two COLUMN WIDTHS back - the one piece of interface state
// no other bundle owns, because ui-layout keeps them in a transient store
// ("transient layout preferences", in its own words) and `ctx.layout` exposes no
// width setter. The store is reached through the `root` slot registration's own
// store handle, which is the same shared instance the frame renders from, so
// every scenario below drives a double of exactly that shape.
//
// The binder is `ctx.configForms.get(<entry id>)`, the 0.2.0 replacement for the
// removed `settingsScope` service: the form handle answers the same
// `getSnapshot()`/`subscribe()`/`set()`/`unset()`/`mutate()` shape a bound scope
// did, so only the ACQUISITION changed - and the id it is acquired with is a
// three-file contract worth pinning on its own, because a mismatch is silent
// (the form answers `unavailable` and the pack simply remembers nothing).
const uiStateBundle = loadBundle('packages/dsh-ui-state/lib/client.js', {})
check('ui-state bundle id', uiStateBundle.id, 'dsh-ui-state')
check('ui-state inject', JSON.stringify(uiStateBundle.exports.inject), '["slots","remote","configForms"]')
check('ui-state binds its own profile entry', uiStateBundle.exports.__internals.ENTRY_ID, 'ui-state')
check(
  'ui-state contract defaults',
  JSON.stringify(uiStateBundle.exports.__internals.DEFAULTS),
  JSON.stringify({ theme: '', pageZoom: 100, dockHeight: 280, sidebarWidth: -1, rightbarWidth: -1 }),
)

/** A layout store double: the state, and every action a restore asked of it. */
function fakeLayoutStore(info) {
  const calls = []
  const state = {
    panelInfo: { activePanelId: null },
    layoutInfo: Object.assign(
      {
        sidebar: 280,
        viewportWidth: 1440,
        narrowExpanded: false,
        rightbar: null,
        rightbarShown: false,
        rightbarTrack: false,
        rightbarFullscreen: false,
        rightbarInstant: false,
      },
      info || {},
    ),
  }
  return {
    calls,
    state,
    instance: {
      actions: {
        setSidebar: (px) => {
          calls.push(['setSidebar', px])
          state.layoutInfo.sidebar = Math.min(Math.max(Math.round(px), 264), 420)
        },
        toggleSidebar: () => {
          calls.push(['toggleSidebar'])
          state.layoutInfo.sidebar = state.layoutInfo.sidebar === 0 ? 280 : 0
        },
        setRightbar: (px) => {
          calls.push(['setRightbar', px])
          state.layoutInfo.rightbar = px
        },
      },
      getSnapshot: () => state,
      subscribe: () => () => {},
    },
  }
}

/**
 * A config-form double: one section, the write log, and a manual notify. It
 * models the public face of the Host's `ConfigFormController` - what
 * `ctx.configForms.get(entryId)` answers in 0.2.0 - so the bundle under test sees
 * the same `getSnapshot()` (with `status`/`value`/`revision`), `subscribe()`,
 * `set()`, `unset()` and `mutate()` a live form carries.
 */
function fakeUiScope(value) {
  const writes = []
  const listeners = new Set()
  let snapshot = {
    status: value === undefined ? 'loading' : 'ready',
    value,
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    mode: 'host',
  }
  return {
    writes,
    accept(next) {
      snapshot = Object.assign({}, snapshot, { status: 'ready', value: next })
      for (const listener of [...listeners]) listener()
    },
    scope: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      set: (field, next) => {
        writes.push([field, next])
        return Promise.resolve()
      },
      unset: (field) => {
        writes.push([field, 'UNSET'])
        return Promise.resolve()
      },
      mutate: () => Promise.resolve(),
    },
  }
}

/**
 * Activate a FRESH copy of the bundle against a root slot carrying `layout`.
 * A fresh load per scenario is not tidiness: the bundle keeps the bound scope and
 * the found layout in module state (a page loads the module once), so reusing one
 * instance would carry the first scenario's store into the next.
 */
function activateUiState(value, layout, options) {
  const settings = fakeUiScope(value)
  const provided = new Map()
  const slotListeners = new Set()
  let entry = options && options.entry !== undefined ? options.entry : layout === null ? [] : [{ store: { create: () => layout.instance } }]
  const ctx = {
    slots: {
      entries: () => (options && options.foreign ? [{ store: { create: () => ({}) } }] : entry),
      subscribe: (key, listener) => {
        slotListeners.add(listener)
        return () => slotListeners.delete(listener)
      },
    },
    configForms: { get: () => settings.scope },
    reflect: { provide: (name, api) => (provided.set(name, api), () => provided.delete(name)) },
    effect: () => {},
    logger: { debug() {}, warn() {} },
  }
  const bundle = options && options.bundle !== undefined ? options.bundle : loadBundle('packages/dsh-ui-state/lib/client.js', {})
  bundle.exports.apply(ctx)
  return {
    settings,
    provided,
    calls: layout === null ? [] : layout.calls,
    layout,
    api: provided.get('uiState'),
    slotListeners,
    setEntry: (next) => {
      entry = next
      for (const listener of [...slotListeners]) listener()
    },
  }
}

const sharedWidths = { theme: 'nord', pageZoom: 125, dockHeight: 340, sidebarWidth: 300, rightbarWidth: 480 }
const widthScenario = activateUiState(sharedWidths, fakeLayoutStore())
check('ui-state provides the service', typeof widthScenario.api.get, 'function')
check(
  'ui-state restores the remembered column widths',
  JSON.stringify(widthScenario.calls),
  JSON.stringify([['setSidebar', 300], ['setRightbar', 480]]),
)
check('ui-state reads a remembered field', widthScenario.api.get('pageZoom'), 125)
check('ui-state reads the extension theme', widthScenario.api.get('theme'), 'nord')
check('ui-state reads the remembered sidebar width', widthScenario.api.get('sidebarWidth'), 300)
check('ui-state answers for an unknown field', widthScenario.api.get('nope') === undefined, true)
check('ui-state reports its status', widthScenario.api.status(), 'ready')

// A remembered 0 is the sidebar COLLAPSED, and it cannot go through the width
// setter: ui-layout clamps that to its 264..420 drag range, so 0 is not in it.
// Collapse is the toggle's own transition, which is why the restore uses it.
const collapsedScenario = activateUiState({ sidebarWidth: 0, rightbarWidth: -1 }, fakeLayoutStore())
check('ui-state collapses through the toggle', JSON.stringify(collapsedScenario.calls), JSON.stringify([['toggleSidebar']]))
check('ui-state leaves the sidebar collapsed', collapsedScenario.layout.state.layoutInfo.sidebar, 0)

// -1 means "this host has never recorded a width", which is NOT 0: nothing is
// touched and the layout keeps its own contract default.
const freshScenario = activateUiState({ sidebarWidth: -1, rightbarWidth: -1 }, fakeLayoutStore())
check('ui-state leaves a never-recorded layout alone', freshScenario.calls.length, 0)

// Below ui-layout's own auto-collapse width the rail is the layout's decision.
const narrowScenario = activateUiState({ sidebarWidth: 300, rightbarWidth: -1 }, fakeLayoutStore({ viewportWidth: 800 }))
check('ui-state keeps the rail on a narrow frame', narrowScenario.calls.length, 0)

// Both orders have to work: the section is a wire read, and the layout store is
// another row's registration.
const lateSection = activateUiState(undefined, fakeLayoutStore())
check('ui-state restores nothing while loading', lateSection.calls.length, 0)
lateSection.settings.accept({ sidebarWidth: 280, rightbarWidth: 500 })
check(
  'ui-state restores when the section lands',
  JSON.stringify(lateSection.calls),
  JSON.stringify([['setSidebar', 280], ['setRightbar', 500]]),
)
const lateLayout = activateUiState({ sidebarWidth: 360, rightbarWidth: -1 }, null, { entry: [] })
const lateLayoutStore = fakeLayoutStore()
lateLayout.setEntry([{ store: { create: () => lateLayoutStore.instance } }])
check('ui-state restores when the root slot appears', JSON.stringify(lateLayoutStore.calls), JSON.stringify([['setSidebar', 360]]))

// This is core surface, so a handle that is not a layout store means "remember
// nothing" rather than "run blind".
check('ui-state refuses a foreign store shape', activateUiState({ sidebarWidth: 300 }, null, { foreign: true }).calls.length, 0)
// And with no transport the service still exists, so a consumer can ask and get
// the contract defaults instead of a crash.
const bare = loadBundle('packages/dsh-ui-state/lib/client.js', {})
const bareProvided = new Map()
bare.exports.apply({
  get: () => undefined,
  slots: { entries: () => [], subscribe: () => () => {} },
  reflect: { provide: (name, api) => (bareProvided.set(name, api), () => {}) },
  effect: () => {},
  logger: { debug() {}, warn() {} },
})
const bareApi = bareProvided.get('uiState')
check('ui-state survives without a transport', bareApi.status(), 'absent')
check('ui-state falls back to defaults without a transport', bareApi.get('dockHeight'), 280)
// `unset` is what clears a field rather than overwriting it with the default: a
// built-in theme replacing a remembered extension one must leave the user's own
// document free of the stale id.
const unsetScope = fakeUiScope({ theme: 'nord' })
const unsetBundle = loadBundle('packages/dsh-ui-state/lib/client.js', {})
const unsetProvided = new Map()
unsetBundle.exports.apply({
  slots: { entries: () => [], subscribe: () => () => {} },
  configForms: { get: () => unsetScope.scope },
  reflect: { provide: (name, api) => (unsetProvided.set(name, api), () => {}) },
  effect: () => {},
  logger: { debug() {}, warn() {} },
})
unsetProvided.get('uiState').unset('theme')
check('ui-state clears a field', JSON.stringify(unsetScope.writes), JSON.stringify([['theme', 'UNSET']]))

// --------------------------------------- the shared state, from dsh-themes
// alpha.17: the page zoom and an EXTENSION theme now ride the same section, and
// the two things that make that safe are pinned here - localStorage stays the
// fallback (so this bundle still remembers its level without dsh-ui-state), and
// the service is resolved LAZILY, never declared in `inject` (or a profile with
// this bundle and without that one would lose the control entirely).
const themedSource = themesSource
check(
  'themes resolves the shared state lazily',
  themedSource.includes("ctx.get('uiState')") && themedSource.includes("const inject = ['slots', 'locale']"),
)
check(
  'themes keeps localStorage under the shared state',
  themedSource.includes('sharedReady()') && themedSource.includes('store.getItem(ZOOM_KEY)'),
)
check(
  'themes writes both stores on a step',
  themedSource.includes("sharedState.set('pageZoom', percent)") && themedSource.includes('store.setItem(ZOOM_KEY, String(percent))'),
)
// alpha.18: an extension theme is a DESIRED STATE the control keeps applied,
// because ui-theme re-adopts its durable built-in on every settings-document
// change. The three parts of that are pinned at the source level here (the
// behaviour itself is proven against the real ui-theme runtime above).
check(
  'themes tracks the extension theme it wants in force',
  themedSource.includes('let desiredTheme') && themedSource.includes('function reconcileTheme(state)') && themedSource.includes('applyDesiredTheme(state, desiredTheme)'),
)
check(
  'themes tells a re-adopt from a deliberate built-in by the durable revision',
  themedSource.includes("const THEME_SERVICE_NAMESPACE = 'ui-theme'") && themedSource.includes('durableRevisionSeen') && themedSource.includes('revision !== durableRevisionSeen'),
)
// The tie-break is only as good as the scope it reads: 0.2.0 replaced the
// `settingsScope` namespace binder with the row's own config form, so the id the
// form is acquired with has to be ui-theme's ENTRY id - and the removed service
// must not come back, or the tie-break silently stops reading anything and the
// bug alpha.18 fixed (any settings write reverting an extension theme) returns.
check(
  'themes reads the durable form of the ui-theme entry',
  !themedSource.includes("ctx.get('settingsScope')") &&
    themedSource.includes("ctx.get('configForms')") &&
    themedSource.includes('forms.get(THEME_SERVICE_NAMESPACE)'),
)
check(
  'themes clears the field only for a built-in chosen in its own menu',
  themedSource.includes('function chooseBuiltInTheme(state, id)') && themedSource.includes('forgetRememberedTheme()') && themedSource.includes('sharedState.unset'),
)
check(
  'themes re-applies a theme that arrives after its first render',
  themedSource.includes('sharedState.subscribe(adopt)') && themedSource.includes('setPercent(saved)'),
)
// Driven: a fresh copy bound to a section that remembers Nord applies it, and
// one that remembers a built-in preference applies nothing.
function activateThemesWithShared(section) {
  const writes = []
  let snapshot = { preference: 'light', active: { id: 'light', colorScheme: 'light' }, themes: [], revision: 1 }
  const applied = []
  const bundle = loadBundle('packages/dsh-themes/lib/client.js', {})
  const listeners = new Set()
  const scope = {
    getSnapshot: () => ({ status: 'ready', value: section, revision: 1, writable: true, mode: 'host' }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (field, value) => {
      writes.push([field, value])
      return Promise.resolve()
    },
    unset: (field) => {
      writes.push([field, 'UNSET'])
      return Promise.resolve()
    },
  }
  const themeService = {
    getTheme: () => snapshot,
    register: (definition) => {
      snapshot = Object.assign({}, snapshot, { themes: [...snapshot.themes, definition], revision: snapshot.revision + 1 })
      return () => {}
    },
    setTheme: (id) => {
      applied.push(id)
      snapshot = Object.assign({}, snapshot, { preference: id, revision: snapshot.revision + 1 })
    },
  }
  bundle.exports.apply({
    get: (name) => (name === 'theme' ? themeService : name === 'uiState' ? Object.assign({}, scope, { status: () => 'ready', get: (field) => (section ? section[field] : undefined) }) : undefined),
    on: () => () => {},
    slots: { inject: (name, fn) => fn(), register: () => () => {} },
    locale: { register: () => () => {} },
    effect: (fn) => fn(),
    logger: { debug() {}, warn() {} },
  })
  return { writes, applied }
}
check('themes restores a remembered extension theme', JSON.stringify(activateThemesWithShared({ theme: 'nord' }).applied), JSON.stringify(['nord']))
check('themes restores nothing for a built-in preference', JSON.stringify(activateThemesWithShared({ theme: '' }).applied), '[]')

// ------------------------------------- the shared state, from dsh-cmdbar
// alpha.5: the dock's HEIGHT rides the same section, with localStorage kept
// underneath. Its OPEN state deliberately does not: the panel is the window onto
// a process, and after a reload the client holds no slots, so reopening it would
// either show an empty panel or - once the server's five minute PTY retention has
// lapsed - start a shell nobody asked for.
check(
  'cmdbar resolves the shared state lazily',
  cmdbarSource.includes("ctx.get('uiState')") && cmdbarSource.includes("const inject = ['slots']"),
)
check(
  'cmdbar reads the shared height first',
  cmdbarSource.includes('sharedReady()') && cmdbarSource.includes("sharedState.get('dockHeight')"),
)
check(
  'cmdbar writes both stores on a resize',
  cmdbarSource.includes('function queueSharedHeight') &&
    cmdbarSource.includes("sharedState.set('dockHeight', value)") &&
    cmdbarSource.includes('STORAGE_KEY, String(next)') &&
    // ...and NOT once per pointer move: the section is a queued wire write, and a
    // request per move both floods it and feeds the echo loop below.
    cmdbarSource.includes('SHARED_WRITE_DEBOUNCE_MS') &&
    cmdbarSource.includes('sharedPending += 1'),
)
check(
  'cmdbar adopts only what is news',
  cmdbarSource.includes('sharedState.subscribe(adoptShared)') &&
    cmdbarSource.includes('adoptDecision({') &&
    // Every one of the three not-news gates has to be WIRED, not merely defined:
    // the pointer, our own writes still on the wire, and the value in force.
    cmdbarSource.includes('dragging,') &&
    cmdbarSource.includes('pending: sharedPending') &&
    cmdbarSource.includes('known: sharedKnown,') &&
    cmdbarSource.includes('setHeight(next, { persist: false })') &&
    cmdbarSource.includes('sharedPending += 1'),
)
check('cmdbar remembers no open state', cmdbarSource.includes('dockOpen') === false)

// -------------------------- extension themes, against the REAL ui-theme runtime
// The bug this section exists for (found in the field, alpha.17): choosing Nord or
// Monokai appeared to do nothing, while Light and Dark worked. The cause was not
// the persistence - it was ui-theme's own `ThemeRuntime.adopt()`, which assigns its
// preference from its DURABLE section whenever its settings scope notifies, and
// that scope notifies whenever the settings DOCUMENT changes. An extension theme is
// never written to that durable section (ui-theme's schema accepts light/dark/system
// only), so choosing Nord applied it and the next settings write - this pack's own
// zoom, dock and width writes included - snapped the app back to the durable
// built-in. It predated alpha.17: ANY Settings change reverted an extension theme.
//
// The fix (alpha.18) makes an extension theme a DESIRED STATE the pack keeps
// applied, with ui-theme's namespace REVISION as the tie-break: revision unmoved
// means nobody chose anything (a re-adopt, so put the theme back), revision moved
// means a surface that writes durably chose a built-in (the shipped Settings >
// Appearance row, whose decision wins).
//
// A stub theme service cannot see any of this, which is exactly why the tracked
// check asserted a working registration against a fake and shipped a broken
// feature. So this section runs the REAL ui-theme bundle, and skips loudly when
// this host has no copy of it.
const coreThemeBundle = findCoreFile(path.join('@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js'))
if (coreThemeBundle === null) {
  console.log('skip extension themes hold through a real ui-theme runtime (no core bundle on this host)')
} else {
  const themeChangeListeners = []
  const emitThemeChange = (snapshot) => {
    for (const listener of [...themeChangeListeners]) {
      try {
        listener(snapshot)
      } catch (err) {
        console.log('  ..   a theme/change listener threw: ' + (err && err.message))
      }
    }
  }
  const sharedSeats = {}
  const sharedProvided = new Map()
  // ui-theme's durable section: the only thing `adopt()` reads.
  let durableSection = { preference: 'light', fontSize: 14 }
  let durableRevision = 1
  const durableListeners = new Set()
  const realThemeScope = {
    getSnapshot: () => ({
      status: 'ready',
      value: durableSection,
      base: undefined,
      user: { preference: durableSection.preference },
      revision: durableRevision,
      writable: true,
      mode: 'host',
    }),
    subscribe(listener) {
      durableListeners.add(listener)
      return () => durableListeners.delete(listener)
    },
    set(field, value) {
      durableSection = { ...durableSection, [field]: value }
      durableRevision += 1
      return Promise.resolve()
    },
    unset: () => Promise.resolve(),
    mutate: () => Promise.resolve(),
  }
  /** What ANY settings-document change does: the trigger ui-theme re-adopts on. */
  const settingsDocumentMoved = () => {
    for (const listener of [...durableListeners]) listener()
  }
  const packWrites = []
  let packSection = {}
  const packUiState = {
    get: (name) => (Object.prototype.hasOwnProperty.call(packSection, name) ? packSection[name] : undefined),
    set: (name, value) => {
      packWrites.push([name, value])
      packSection = { ...packSection, [name]: value }
      return Promise.resolve()
    },
    unset: (name) => {
      packWrites.push([name, 'UNSET'])
      const next = { ...packSection }
      delete next[name]
      packSection = next
      return Promise.resolve()
    },
    status: () => 'ready',
    subscribe: () => () => {},
  }
  // ONE host for both bundles: a shared theme/change bus, one slot table, one
  // provider map - so the pack's control really drives the real service.
  const realCtx = {
    effect: (fn) => fn(),
    on: (event, listener) => {
      if (event === 'theme/change') themeChangeListeners.push(listener)
      return () => {}
    },
    emit: (event, payload) => {
      if (event === 'theme/change') emitThemeChange(payload)
    },
    provide: (name, value) => (sharedProvided.set(name, value), () => sharedProvided.delete(name)),
    reflect: { provide: (name, value) => (sharedProvided.set(name, value), () => sharedProvided.delete(name)) },
    locale: { register: () => () => {} },
    slots: {
      inject: (name, fn) => fn(),
      register(spec, component) {
        sharedSeats[spec.name + '#' + spec.id] = { spec, component }
        return () => {}
      },
    },
    get: (name) =>
      name === 'theme'
        ? sharedProvided.get('theme')
        : name === 'uiState'
          ? packUiState
          : name === 'configForms'
            ? { get: () => realThemeScope }
            : undefined,
    configForms: { get: () => realThemeScope },
    logger: { debug() {}, warn() {} },
  }

  const realTheme = loadBundle(coreThemeBundle, {})
  realTheme.exports.apply(realCtx)
  const realThemeService = sharedProvided.get('theme')
  check('the real ui-theme provides its service', typeof realThemeService, 'object')

  const themedPack = loadBundle('packages/dsh-themes/lib/client.js', {})
  themedPack.exports.apply(realCtx)
  // The control reads the registry on the microtask after activation.
  await new Promise((resolve) => setTimeout(resolve, 20))

  check(
    'the pack registered all four extension themes into the real registry',
    realThemeService.getTheme().themes.filter(
      (theme) => theme.id === 'nord' || theme.id === 'monokai' || theme.id === 'hacker' || theme.id === 'cyber',
    ).length,
    4,
  )
  const realSeat = sharedSeats['conversation.session.header.utilities#dsh-themes']
  check('the Themes seat took the header', realSeat !== undefined, true)
  const realControlState = realSeat.spec.inject().themeState
  check(
    'the control sees them in the registry',
    realControlState.getSnapshot().themes.filter((theme) => theme.id === 'nord').length,
    1,
  )
  // Rendering is only how the Menu's own `onSelect` is reached; a server render
  // uses `getServerSnapshot`, so the list is asserted from the state above.
  renderToStaticMarkup(React.createElement(realSeat.component, { t: themesT, themeState: realControlState }))
  check('the Themes menu exposes a selection handler', typeof lastMenuProps.onSelect, 'function')

  lastMenuProps.onSelect('nord')
  check('choosing Nord applies it through the real service', realThemeService.getTheme().preference, 'nord')
  check('choosing Nord remembers it', JSON.stringify(packWrites), JSON.stringify([['theme', 'nord']]))
  // THE REGRESSION: any settings-document change used to discard it here.
  settingsDocumentMoved()
  check('Nord SURVIVES a settings-document change', realThemeService.getTheme().preference, 'nord')
  check('and its remembered id is kept', JSON.stringify(packWrites), JSON.stringify([['theme', 'nord']]))
  settingsDocumentMoved()
  check('it survives the next one too', realThemeService.getTheme().preference, 'nord')
  // A surface that WRITES THE DURABLE PREFERENCE (Settings > Appearance) still
  // wins: its decision moved ui-theme's own namespace revision.
  realThemeScope.set('preference', 'light')
  settingsDocumentMoved()
  check('a built-in chosen elsewhere wins', realThemeService.getTheme().preference, 'light')
  check('and the remembered extension is cleared', JSON.stringify(packWrites), JSON.stringify([['theme', 'nord'], ['theme', 'UNSET']]))
  settingsDocumentMoved()
  check('the extension does not come back afterwards', realThemeService.getTheme().preference, 'light')
  // ...and this control's own menu can always go back to a built-in.
  lastMenuProps.onSelect('dark')
  check('the pack menu switches to a built-in', realThemeService.getTheme().preference, 'dark')
  settingsDocumentMoved()
  check('and that sticks', realThemeService.getTheme().preference, 'dark')
}

// --------------------------------------------------------- the version constant
// Every browser bundle that carries a `PLUGIN_VERSION` - the marker its toolbar
// and its console line print, and what a person reads to know which build is
// loaded - must agree with its own package.json. Nothing else checks it, and the
// two DID drift: dsh-audio printed alpha.1 while its package.json said alpha.2,
// so a freshly built bundle looked older than it was and the only way to notice
// was to compare two files by hand. (dsh-editor pins its own constant for the
// extra reason that its engine request is version-qualified; this is the
// pack-wide shape of the same rule. The three GENERATED forks carry no marker,
// which is why they are absent rather than failing.)
{
  const drifted = []
  const carriers = []
  for (const entry of readdirSync(path.join(repo, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = path.join(repo, 'packages', entry.name, 'lib', 'client.js')
    if (!existsSync(file)) continue
    const match = /const PLUGIN_VERSION = '([^']+)'/.exec(readFileSync(file, 'utf8'))
    if (match === null) continue
    carriers.push(entry.name)
    let version = null
    try {
      version = JSON.parse(readFileSync(path.join(repo, 'packages', entry.name, 'package.json'), 'utf8')).version
    } catch (err) {
      version = null
    }
    if (match[1] !== version) drifted.push(entry.name + '=' + match[1] + ' vs package.json ' + String(version))
  }
  check('a bundle version marker matches package.json', drifted.join(', '), '')
  check('most bundles still print their version', carriers.length >= 10, true)
}

// ------------------------------------------ the primitives the pack reads
// A browser bundle that reads `primitives.<Name>` is asking the PINNED harness
// line for an export, and a name that line does not have is `undefined` - which
// `h(undefined, …)` turns into "Element type is invalid" at render, and which the
// slots core turns into ABDICATION: the entry leaves its cell and whatever the
// shell shipped for that id renders instead. That is not a hypothetical: dsh-themes
// alpha.22 read `IconDownloadOutline16` (renamed to `…Regular` on 0.2.0-rc.2), so
// its own download seat crashed and the shipped three-dot "More actions" menu -
// the very control the seat exists to replace - came back in the conversation
// header. The stub above could not catch it because it carried the same stale
// names; this check grades the names against the package itself.
{
  const primitivesFile = findCoreFile('@deepseek-ai/dsh-client-ui-primitives/lib/index.js')
  if (primitivesFile === null) {
    console.log('skip the primitives the pack reads (no pinned primitives package on this host)')
  } else {
    const exported = new Set(
      ((readFileSync(primitivesFile, 'utf8').split('\n').filter((line) => line.startsWith('export {')).pop() || '').match(
        /[A-Za-z_$][\w$]*/g,
      ) || []),
    )
    check('the pinned primitives export a list', exported.size > 50, true)
    const referenced = new Map()
    for (const entry of readdirSync(path.join(repo, 'packages'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = path.join(repo, 'packages', entry.name, 'lib', 'client.js')
      if (!existsSync(file)) continue
      for (const match of readFileSync(file, 'utf8').matchAll(/\bprimitives\.([A-Za-z_$][\w$]*)/g)) {
        if (!referenced.has(match[1])) referenced.set(match[1], entry.name)
      }
    }
    // A floor, not a target: it exists so a broken scan (a regex that stopped
    // matching, a bundle moved) fails HERE instead of vacuously passing the
    // comparison below. The count is small by design - most bundles destructure
    // the primitives once, and dsh-themes resolves its glyphs from a table.
    check('the primitive scan finds the pack\'s reads', referenced.size > 0, true)
    check(
      'every primitive the pack reads exists in the pinned line',
      [...referenced]
        .filter(([name]) => !exported.has(name))
        .map(([name, where]) => name + ' (' + where + ')')
        .join(', '),
      '',
    )

    // The GLYPH LISTS are the other half, and a different question: `glyphOf([…])`
    // survives a missing name with a placeholder, so the check is not "does the
    // name exist" but "does at least ONE spelling exist", i.e. whether the glyph a
    // header seat wears is the shipped artwork or the fallback dot. A list whose
    // every name is gone is a silently degraded control.
    const themesFile = path.join(repo, 'packages', 'dsh-themes', 'lib', 'client.js')
    const unreachable = []
    let glyphLists = 0
    if (existsSync(themesFile)) {
      const source = readFileSync(themesFile, 'utf8')
      for (const match of source.matchAll(/glyphOf\(\[([^\]]*)\]\)/g)) {
        glyphLists += 1
        const names = [...match[1].matchAll(/'([^']+)'/g)].map((name) => name[1])
        if (!names.some((name) => exported.has(name))) unreachable.push(names.join(' | '))
      }
    }
    check('the pack resolves its glyphs through a list', glyphLists >= 5, true)
    check('every glyph list still reaches a shipped glyph', unreachable.join(', '), '')
  }
}

// ---------------------------------------------------------------- dsh-canvas
// The canvas bundle registers the conversation VIEW RING's third entry (to the
// right of Trajectory), one conversation card per canvas tool, and the
// page-level renderer that answers the host's render requests. These checks load
// it with the real React runtime, activate it against a stub ctx, and render the
// seat the shell would render.
const canvas = loadBundle('packages/dsh-canvas/lib/client.js', {})
check('canvas bundle id', canvas.id, 'dsh-canvas')
check('canvas inject', JSON.stringify(canvas.exports.inject), '["slots"]')
const canvasSeats = {}
const canvasEffects = []
const canvasDisposers = []
canvas.exports.apply({
  slots: {
    inject: (name, fn) => fn(),
    register(spec, component) {
      canvasSeats[spec.name + (spec.key ? '#' + spec.key : '')] = { spec, component }
      return () => {}
    },
  },
  effect: (fn) => {
    // The shell runs an effect on activation, so the stub does too - a stub that
    // only recorded the function would hide every registration behind it. The
    // disposer is KEPT and called at the end of this section: the canvas
    // renderer's effect starts a long-poll loop, and a loop left running would
    // keep this process alive (and a fetch to a relative URL retrying forever).
    canvasEffects.push(fn)
    const dispose = fn()
    const stop = typeof dispose === 'function' ? dispose : () => {}
    canvasDisposers.push(stop)
    return stop
  },
  logger: { debug() {}, warn() {} },
})
const canvasView = canvasSeats['conversation.view']
check('canvas registers one conversation view', canvasView !== undefined, true)
check('the view is keyed by its id, not a slot key', canvasView.spec.id, 'canvas')
// The ring is ordered: Chat 0, Trajectory 10 - so 20 is literally to the right.
check('the view sits to the right of Trajectory', canvasView.spec.order, 20)
check('the view labels itself', canvasView.spec.label(), 'Canvas')
check('the view takes no own child seats', canvasView.spec.children === undefined, true)
// A conversation view gets no `sessionId` prop: its own inject face is where the
// session comes from (the shape the shipped Trajectory view uses too).
check('the view learns its session through inject', canvasView.spec.inject('session-abc').canvasSession, 'session-abc')
check(
  'one card per canvas tool',
  Object.keys(canvasSeats)
    .filter((key) => key.startsWith('tool.call.toolview#'))
    .map((key) => key.split('#')[1])
    .sort()
    .join(','),
  canvas.exports.__internals.TOOL_NAMES.slice().sort().join(','),
)
const canvasCssTag = canvas.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-canvas/canvas.css').pop()
const canvasCss = canvasCssTag ? canvasCssTag.textContent : ''
check('canvas stylesheet injected', canvasCss.includes('.cnv-root{') && canvasCss.includes('.cnv-art{'), true)
// The full-height view asks the shell to float the composer over it, which is the
// same contract the shipped Trajectory view uses.
check(
  'the canvas root asks for the composer overlay',
  renderToStaticMarkup(h(canvasView.component, { canvasSession: null })).includes('data-conversation-composer-overlay'),
  true,
)
const emptyMarkup = renderToStaticMarkup(h(canvasView.component, { canvasSession: null }))
check('a session-less view says what to do', emptyMarkup.includes('Open a conversation'), true)
check('the empty view is still a canvas view', emptyMarkup.includes('data-dsh-canvas-view'), true)
// A running tool call and a settled one both render a card, from the block alone.
const runningCard = renderToStaticMarkup(
  h(canvasSeats['tool.call.toolview#canvas_render'].component, {
    toolName: 'canvas_render',
    sessionId: 'session-abc',
    block: { argsRaw: '{"id":"launch-banner"}' },
  }),
)
check('a running render call draws a card', runningCard.includes('Rendering in the browser'), true)
const settledCard = renderToStaticMarkup(
  h(canvasSeats['tool.call.toolview#canvas_export'].component, {
    toolName: 'canvas_export',
    sessionId: 'session-abc',
    block: {
      kind: 'tool-result',
      call: { name: 'canvas_export', argsRaw: '{"id":"launch-banner"}' },
      content: [{ type: 'text', text: 'Wrote /tmp/launch-banner.png (412 KB).' }],
      meta: { id: 'launch-banner', title: 'Launch banner', scope: 'conversation', state: 'drawn', revision: 3, tab: 'dsh-resource://canvas/session/session-abc/launch-banner' },
    },
  }),
)
check('a settled export call draws its card', settledCard.includes('launch-banner'), true)
check('the settled card shows the verdict pill', settledCard.includes('data-state="drawn"'), true)
check('the settled card shows the host text', settledCard.includes('Wrote /tmp/launch-banner.png'), true)
// The page-level renderer is started by an effect (so a page that never opens the
// tab still answers a render request).
check('the renderer is started by the plugin, not the tab', canvasEffects.length >= 11, true)
const canvasSource = readFileSync(path.join(repo, 'packages/dsh-canvas/lib/client.js'), 'utf8')
check('the bundle has no build-time eval', /new Function\(|eval\(/.test(canvasSource.replace(/\/\/.*$/gm, '')) === false, true)
check('the bundle polls the queue for ANY session', canvasSource.includes("QUEUE_ROUTE + '?session=*&wait='"), true)
check('the bundle fetches the engine from the host route', canvasSource.includes('ENGINE_ROUTE'), true)
check('the bundle imports the engine from a blob URL', canvasSource.includes('URL.createObjectURL(new Blob([source]'), true)
check(
  'the bundle never fetches a remote design resource',
  !/https?:\/\/[^'"\s]+/.test(canvasSource.replace(/https?:\/\/www\.w3\.org[^'"\s]*/g, '')),
  true,
)
// The route names the browser hard-codes must be the ones the host registers.
// The host declares them as `API_ROOT + '<suffix>'`, so both sides are compared
// as full paths.
const canvasHostSource = readFileSync(path.join(repo, 'packages/dsh-canvas/lib/index.js'), 'utf8')
const hostRoutes = [...canvasHostSource.matchAll(/const ([A-Z_]+_ROUTE) = API_ROOT \+ '([^']+)'/g)].map((match) => '/api/dsh-canvas' + match[2])
const clientRoutes = Object.values(canvas.exports.__internals.ROUTES)
const unknownRoutes = clientRoutes.filter((route) => !hostRoutes.includes(route))
check('every client route exists on the host', unknownRoutes.join(', '), '')
// `/health` is the one host route the browser does not need: it is the status
// snapshot a person or a check reads, not something a tab fetches.
const missedRoutes = hostRoutes.filter((route) => route !== '/api/dsh-canvas/health' && !clientRoutes.includes(route))
check('the client knows every host route it reads', missedRoutes.join(', '), '')
const canvasInternals = canvas.exports.__internals
check('a stored-asset name is recognised', canvasInternals.ASSET_NAME.test('0123456789abcdef.png'), true)
check('a content hash is not mistaken for a filename', canvasInternals.ASSET_NAME.test('logo.png'), false)
check('a workspace path is recognised', canvasInternals.isWorkspacePath('docs/header.png'), true)
check('an asset name is not called a workspace path', canvasInternals.isWorkspacePath('0123456789abcdef.png'), false)
check('a running block is not settled', canvasInternals.isSettled({ argsRaw: '{}' }), false)
check('a tool-result block is settled', canvasInternals.isSettled({ kind: 'tool-result' }), true)
check('the card reads the host meta', canvasInternals.viewOfBlock({ meta: { id: 'x' } }).id, 'x')
check('the card parses settled arguments', canvasInternals.argsOf({ kind: 'tool-result', call: { argsRaw: '{"id":"x"}' } }).id, 'x')
check('the card flattens tool content', canvasInternals.flattenContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
check('a layer kind is badged in three letters', canvasInternals.layerKindBadge('frame') + '/' + canvasInternals.layerKindBadge('shape') + '/' + canvasInternals.layerKindBadge('text'), 'fra/sha/tex')
check('a long path is shortened for the side panel', canvasInternals.shortPath('/a/b/c/d/e.png'), '…/c/d/e.png')
check('base64 survives a round trip', canvasInternals.toBase64(new TextEncoder().encode('canvas').buffer), 'Y2FudmFz')
check('the feed scale is a quarter', canvasInternals.FEED_SCALE, 0.25)
check('the zoom ladder starts at fit', canvasInternals.ZOOM_STEPS[0], 'fit')
// THE LAYER MODEL: a design's nodes as a flat, nested, selectable list, and the
// path arithmetic the drag and the layer rows both address.
const layerDoc = { layers: [{ kind: 'art', id: 'backdrop' }, { kind: 'frame', id: 'stack', children: [{ kind: 'text', text: 'Ship plugins' }, { kind: 'shape', id: 'rule', x: 4, y: 8, w: 10, h: 2 }] }] }
const canvasLayerTree = canvasInternals.layerTree(layerDoc)
check('the layer tree walks every node in paint order', canvasLayerTree.map((row) => row.path).join(','), 'layers.0,layers.1,layers.1.children.0,layers.1.children.1')
check('the layer tree carries depth for the indent', canvasLayerTree.map((row) => row.depth).join(','), '0,0,1,1')
check('a node resolves by its path', canvasInternals.nodeAtPath(layerDoc, 'layers.1.children.1').id, 'rule')
check('a missing path answers null', canvasInternals.nodeAtPath(layerDoc, 'layers.9.children.0'), null)
check('a node with x/y is absolute', canvasInternals.isAbsolutePath(layerDoc, 'layers.1.children.1'), true)
check('a flow child is not', canvasInternals.isAbsolutePath(layerDoc, 'layers.1.children.0'), false)
check('a layer is named by its id', canvasInternals.layerLabel({ kind: 'shape', id: 'rule' }, 'layers.0'), 'rule')
check('a text layer is named by its words', canvasInternals.layerLabel({ kind: 'text', text: 'Ship plugins' }, 'layers.0'), '"Ship plugins"')
check('a run layer is named by its runs', canvasInternals.layerLabel({ kind: 'text', runs: [{ text: 'a' }, { text: 'b' }] }, 'layers.0'), '"ab"')
check('a bare layer falls back to its own style', canvasInternals.layerLabel({ kind: 'art', style: 'mesh' }, 'layers.0'), 'mesh')
// The composer seam and the layer dress live in the stylesheet, not inline: a tab
// the composer floats over has to draw the hairline at the composer's own edge.
check('the composer seam is drawn at the composer height', canvasCss.includes('bottom:var(--dsh-composer-height,152px)') && canvasCss.includes('.cnv-root:after{'), true)
check('the page reserves the composer clearance', canvasCss.includes('--cnv-composer-clearance:calc(var(--dsh-composer-height,152px) + 16px)'), true)
check('the layer list is styled', canvasCss.includes('.cnv-layers{') && canvasCss.includes('.cnv-layer[data-selected=true]'), true)
check('the layer rows indent by depth', canvasSource.includes('paddingLeft: 6 + Math.min(row.depth, 6) * 8'), true)
check('a selection draws a box and handles', canvasSource.includes("'data-canvas-selection'") && canvasSource.includes('handle-'), true)
// RESIZE, the other half of direct manipulation: the handles a node kind can
// actually honour, a handle that wins over the node under it, and a stretch written
// as width/height pointer ops. The GEOMETRY is asserted as DATA, not as a shape in
// the source: `handlesFor`/`handlePoints` are what the overlay draws and `resizeOps`
// is what the gesture writes, so a change to either is a change to the picture.
check('a box carries eight handles', canvasInternals.handlesFor({ kind: 'frame' }).join(','), 'nw,n,ne,e,se,s,sw,w')
// A text node's height is what its words measure: it is stretched in WIDTH, and the
// only handles that can do that are the two SIDE midpoints. It used to carry all six
// side-and-corner squares, and that was the dead gesture - a corner is a vertical
// resize as much as a horizontal one, so a drag that began on a text layer's top-left
// square wrote a width, dropped the height it could not honour, and left a selection
// that looked like it refused to move.
check('a text layer carries the two side handles only', canvasInternals.handlesFor({ kind: 'text' }).join(','), 'w,e')
const handleBox = { x: 10, y: 20, w: 100, h: 40 }
const pointAt = (keys) => canvasInternals.handlePoints(handleBox, keys)
check('a handle sits on its corner', JSON.stringify(pointAt(['nw'])[0]), JSON.stringify({ key: 'nw', x: 10, y: 20 }))
check('a handle sits on its edge midpoint', JSON.stringify(pointAt(['e'])[0]), JSON.stringify({ key: 'e', x: 110, y: 40 }))
check('every handle of a box resolves', canvasInternals.handlePoints(handleBox, canvasInternals.handlesFor({ kind: 'shape' })).every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)), true)
// THE EDGE TEST HONOURS THE HANDLES. A point near the TOP of a text layer is not a
// vertical resize, because no vertical handle is drawn there; the same point on a
// frame is. This is asserted as arithmetic because it is the one decision that says
// whether a border drag resizes or grabs.
const tol = { x: 4, y: 4 }
const textBox = { x: 10, y: 20, w: 100, h: 40 }
check('the top edge of a text layer is not a resize', canvasInternals.edgesAt(textBox, 60, 20, tol, canvasInternals.handlesFor({ kind: 'text' })), null)
check('the top edge of a frame is', JSON.stringify(canvasInternals.edgesAt(textBox, 60, 20, tol, canvasInternals.handlesFor({ kind: 'frame' }))), JSON.stringify({ left: false, right: false, top: true, bottom: false }))
check('a text layer’s side is a resize', JSON.stringify(canvasInternals.edgesAt(textBox, 110, 40, tol, canvasInternals.handlesFor({ kind: 'text' }))), JSON.stringify({ left: false, right: true, top: false, bottom: false }))
check('a point inside the box grabs', canvasInternals.edgesAt(textBox, 60, 40, tol, canvasInternals.handlesFor({ kind: 'frame' })), null)
check('no handles means every edge is offered', canvasInternals.edgesAt(textBox, 60, 20, tol, []).top, true)
// The ops a stretch writes, for the two cases that differ: a grabbed RIGHT edge
// moves the width alone, a grabbed LEFT edge moves the width AND the x, and a text
// node's vertical edge is dropped rather than written.
const sizedNode = { kind: 'frame', x: 10, y: 20, w: 100, h: 40 }
check('a right edge sets the width alone', JSON.stringify(canvasInternals.resizeOps('layers.0', sizedNode, null, { right: true }, 30, 0)), JSON.stringify([{ op: 'set', at: 'layers.0.w', value: 130 }]))
const leftOps = canvasInternals.resizeOps('layers.0', sizedNode, null, { left: true }, 30, 0)
check('a left edge moves the x with the width', leftOps.map((op) => op.at + '=' + op.value).join(','), 'layers.0.w=70,layers.0.x=40')
const bottomOps = canvasInternals.resizeOps('layers.0', sizedNode, null, { bottom: true }, 0, 10)
check('a bottom edge sets the height alone', bottomOps.map((op) => op.at + '=' + op.value).join(','), 'layers.0.h=50')
check('a text node keeps its own height', canvasInternals.resizeOps('layers.0', { kind: 'text', x: 0, y: 0, w: 80, h: 20 }, null, { top: true }, 0, -10).length, 0)
// A node that was `hug` has no numbers: the box the layout produced is the base.
const hugOps = canvasInternals.resizeOps('layers.1', { kind: 'frame' }, { box: { x: 5, y: 6, w: 50, h: 60 } }, { right: true }, 5, 0)
check('a hug node is measured from its laid-out box', hugOps.map((op) => op.at + '=' + op.value).join(','), 'layers.1.w=55')
check('a handle is grabbed within a screen-pixel tolerance', canvasSource.includes('const HANDLE_HIT = 9') && canvasSource.includes('HANDLE_HIT / Math.max(1, rect.width)'), true)
check('a handle wins over the node under it', canvasSource.includes('handle ? selectedEntry :'), true)
check('a stretch writes width and height ops', canvasSource.includes('resizeOps(path, node, entry, edges, dx, dy)'), true)
check('a drag reports which gesture it is', canvasSource.includes("handle ? 'resize' : 'move'"), true)
// THE GESTURE IS DECIDED ONCE, ON POINTER DOWN: the same `handle` decides the resize
// on release, so a drag that began on a handle can never end as a move. The pointer
// is captured for the drag's length, and the capture is released on the one listener
// that also fires for a cancelled pointer.
check('the gesture is decided once, on pointer down', canvasSource.includes('if (handle && onResize) onResize(chosen.path') && canvasSource.includes('else if (onMove) onMove(chosen.path'), true)
check('the pointer is captured for the drag', canvasSource.includes('element.setPointerCapture(event.pointerId)') && canvasSource.includes('element.releasePointerCapture(event.pointerId)'), true)
check('a cancelled pointer ends the gesture too', canvasSource.includes("window.addEventListener('pointercancel', finish)"), true)
check('a handle drag never reselects', canvasSource.includes('if (!handle && onSelect) onSelect(chosen.path)'), true)
check('the cursor names the edge pair', canvasInternals.cursorFor({ right: true }) === 'ew-resize' && canvasInternals.cursorFor({ bottom: true }) === 'ns-resize' && canvasInternals.cursorFor({ left: true, top: true }) === 'nesw-resize', true)
check('the resize dress is styled', canvasCss.includes('.cnv-art[data-dragging=resize]'), true)
// THE HOUSE GALLERY in the tab: the rows the state route carries, each starting a
// design by example id rather than by preset + archetype + style.
check('the new-design gallery lists the house examples', canvasSource.includes("'data-canvas-examples'") && canvasSource.includes('state.examples.map'), true)
check('an example row starts a design by id', canvasSource.includes('onCreate(null, null, null, entry.id)') && canvasSource.includes('example: exampleId'), true)
check('a drag sends x and y as pointer ops', canvasSource.includes("path + '.x'") && canvasSource.includes("path + '.y'"), true)
check('a reorder is a remove plus an insert', canvasSource.includes('Reordered the layers') && canvasSource.includes("{ op: 'remove', at: path }"), true)
check('dragging is a pointer gesture', canvasSource.includes('pointermove') && canvasSource.includes("element.setAttribute('data-dragging'"), true)
// THE STYLE LIBRARY in the tab: a style is chosen when a design is STARTED, from the
// + New gallery, and both go through the same document route the model uses. There is
// deliberately NO style control in the top bar any more: a select there could only
// either restyle or start a new design, and starting one is what "+ New" already does
// - so the styling decision belongs to the New gallery alone.
check('the new-design gallery offers the style library', canvasSource.includes("'data-canvas-styles'") && canvasSource.includes('cnv-styleChip'), true)
check('a style chip carries its own swatch', canvasSource.includes('entry.swatch.colours'), true)
check('starting a design sends the chosen style', canvasSource.includes('preset: presetId, archetype: archetypeId, style: styleId'), true)
check('no style picker in the top bar', canvasSource.includes("'data-canvas-style-picker'") === false && canvasSource.includes('restyle(') === false, true)
check('the side panel carries the current style card', canvasSource.includes("'data-canvas-style-card'") && canvasSource.includes('currentStyle.gates'), true)
check('the style dress is styled', canvasCss.includes('.cnv-styleChip[data-selected=true]') && canvasCss.includes('.cnv-styleCard{'), true)
// ZOOM IS A MENU TOO, for the same reason the export is: five rungs in the bar is a
// row of buttons for one choice. Every rung survives as a row and the summary names
// the one in force.
check('zoom is a menu with every rung', canvasSource.includes("'data-canvas-zoom': 'true'") && canvasSource.includes("'data-canvas-zoom-step'"), true)
check('the zoom summary names the current rung', canvasSource.includes("'Zoom: ' + (zoom === 'fit'"), true)
// A MENU MUST CLEAR THE APP'S OWN LAYOUT. The canvas view is a box INSIDE the shell,
// so a panel at the pack's old 40 sat under the composer seat and the frame's overlay
// - which is exactly "the export dropdown is behind the bar". 1000 is the app's own
// modal-root layer: above every column of furniture, below the toasts and portals that
// are meant to interrupt anything.
check('an open menu clears the app furniture', canvasCss.includes('.cnv-menuPanel{position:absolute;right:0;top:calc(100% + 6px);z-index:1000'), true)
// THE TOP BAR HOLDS ONE EXPORT CONTROL, not four buttons: format and destination are
// two axes of ONE decision, and four buttons for it was the first thing to wrap out
// of the bar on a narrow pane. The menu is a native <details>, so the open state, the
// click-anywhere-else and Escape are the browser's rather than listeners this bundle
// has to own - and a row that starts an async export can keep it open until the write
// lands. The four decisions survive as ROWS, destination included.
check('the bar carries one export menu', canvasSource.includes("'data-canvas-export': 'true'") && canvasSource.includes('h(\'details\''), true)
check('the export menu lists every decision', ['png-1', 'png-2', 'svg', 'png-workspace'].every((key) => canvasSource.includes("'data-canvas-export-item': '" + key + "'")), true)
check('every export row names its destination', (canvasSource.match(/cnv-menuHint/g) || []).length >= 4 && canvasSource.includes('Write into the conversation folder'), true)
check('the four old export buttons are gone', canvasSource.includes("'Export PNG'") === false && canvasSource.includes("'To workspace'") === false, true)
check('the export menu is dressed', canvasCss.includes('.cnv-menuPanel{') && canvasCss.includes('.cnv-menuItem:disabled'), true)
check('the bar cannot wrap', canvasCss.includes('flex-wrap:nowrap') && canvasCss.includes('.cnv-barGroup{display:flex;align-items:center;gap:4px;flex:none}'), true)
check('the menu closes on the write, not the press', canvasSource.includes('menu.open = false') && canvasSource.includes('event.preventDefault()'), true)
// THE EXPORT SURVIVES AN ENCODER THAT DECLINES. `toBlob` is asynchronous and a
// browser may answer null for it on a big canvas; the synchronous data URL is the
// fallback, so an export cannot die on a refusal the person can do nothing about.
check('a refused toBlob falls back to the data URL', canvasSource.includes('blobFromDataUrl') && canvasSource.includes('blob ? blob : viaDataUrl()'), true)
// THE RIGHT BAR'S TWO PANES. One scroll column for both jobs meant a design with
// many layers pushed the rest of the bar out of sight, so shaping and auditing are
// two panes and only one is mounted. The rule that makes that hold is in the
// stylesheet: every scrolling block is NAMED (`.cnv-paneScroll` for the audit pane,
// `.cnv-layersScroll` for the list inside the shaping pane), and no pane scrolls.
check('the right bar holds two panes', canvasSource.includes("'data-canvas-pane': 'design'") && canvasSource.includes("'data-canvas-pane': 'inspect'"), true)
check('only the chosen pane is mounted', canvasSource.includes("sideTab === 'inspect' ? inspectPane : designPane"), true)
// THE INSPECT PANE IS THE CONTROLS. It used to hold a quarter-scale copy of the
// artboard, which showed a person nothing the artboard was not already showing and
// cost the panel a black rectangle; it now holds the transformation of the SELECTED
// layer - nudge, size, scale, rotate, opacity and colour - and every one of them
// writes through the same document route the drag and the agent's patch use.
check('the inspect pane carries the transform controls', ["'data-canvas-transform'", "'data-canvas-size'", "'data-canvas-frame'", "'data-canvas-colors'"].every((marker) => canvasSource.includes(marker)), true)
check('the panes no longer carry a feed thumbnail', canvasSource.includes('data-canvas-feed') === false && canvasCss.includes('.cnv-feed') === false, true)
check('the nudge pads the four directions', ['up', 'down', 'left', 'right'].every((dir) => canvasSource.includes("'data-canvas-nudge-dir': '" + dir + "'")), true)
// The arithmetic behind the controls, asserted as DATA: a nudge is a position, a size
// is one field, a scale multiplies what the layer HAS, and the language's own two
// refusals hold - a text node has no height to give, and rotate/opacity are bounded.
check('a nudge writes the position', JSON.stringify(canvasInternals.nudgeOps('layers.0', { x: 10, y: 20 }, null, 5, 0)), JSON.stringify([{ op: 'set', at: 'layers.0.x', value: 15 }]))
check('a nudge from a flow child reads its laid-out box', JSON.stringify(canvasInternals.nudgeOps('layers.1', {}, { box: { x: 7, y: 9, w: 4, h: 4 } }, 0, -9)), JSON.stringify([{ op: 'set', at: 'layers.1.y', value: 0 }]))
check('a nudge never goes negative', JSON.stringify(canvasInternals.nudgeOps('layers.0', { x: 2, y: 2 }, null, -10, -10)), JSON.stringify([{ op: 'set', at: 'layers.0.x', value: 0 }, { op: 'set', at: 'layers.0.y', value: 0 }]))
check('a typed size writes that field alone', JSON.stringify(canvasInternals.sizeOps('layers.0', { kind: 'frame', w: 100, h: 50 }, null, 'w', 140)), JSON.stringify([{ op: 'set', at: 'layers.0.w', value: 140 }]))
check('a text layer refuses a height', canvasInternals.sizeOps('layers.0', { kind: 'text', w: 100 }, null, 'h', 40).length, 0)
check('a size has a floor', JSON.stringify(canvasInternals.sizeOps('layers.0', { kind: 'text', w: 100 }, null, 'w', 2)), JSON.stringify([{ op: 'set', at: 'layers.0.w', value: 40 }]))
check('a rotate is bounded to the language', JSON.stringify(canvasInternals.rotateOps('layers.0', {}, 400)), JSON.stringify([{ op: 'set', at: 'layers.0.rotate', value: 360 }]))
check('a rotate back to zero is written even with no rotate', JSON.stringify(canvasInternals.rotateOps('layers.0', { rotate: 30 }, 0)), JSON.stringify([{ op: 'set', at: 'layers.0.rotate', value: 0 }]))
check('an unchanged rotate writes nothing', canvasInternals.rotateOps('layers.0', { rotate: 30 }, 30).length, 0)
check('opacity is clamped to the language\'s 0..1', JSON.stringify(canvasInternals.opacityOps('layers.0', {}, 1.5)), JSON.stringify([{ op: 'set', at: 'layers.0.opacity', value: 1 }]))
check('an opacity below the current one is written', JSON.stringify(canvasInternals.opacityOps('layers.0', {}, 0.5)), JSON.stringify([{ op: 'set', at: 'layers.0.opacity', value: 0.5 }]))
check('an unchanged opacity writes nothing', canvasInternals.opacityOps('layers.0', { opacity: 0.5 }, 0.5).length, 0)
// THE RESET THAT WAS SILENTLY DROPPED: a faint layer dragged back to 100% must write
// 1, because "1 is the default" is a fact about a document that does not carry a 0.5.
check('opacity back to full is written', JSON.stringify(canvasInternals.opacityOps('layers.0', { opacity: 0.5 }, 1)), JSON.stringify([{ op: 'set', at: 'layers.0.opacity', value: 1 }]))
check('opacity is rounded to two places', JSON.stringify(canvasInternals.opacityOps('layers.0', {}, 0.456)), JSON.stringify([{ op: 'set', at: 'layers.0.opacity', value: 0.46 }]))
// WHAT A KIND CAN RECOLOUR: the language gives each kind its own paint field, and a
// kind that paints nothing owns nothing - which is what makes the control say so
// rather than write a property nothing reads.
check('a text node recolours its glyphs', canvasInternals.paintTargets({ kind: 'text', color: '#111111' }).map((row) => row.key).join(','), 'color')
check('a shape recolours its fill and stroke', canvasInternals.paintTargets({ kind: 'shape', fill: '#111111', stroke: '#222222' }).map((row) => row.key).join(','), 'fill,stroke')
check('a frame recolours its background', canvasInternals.paintTargets({ kind: 'frame', background: '#111111' }).map((row) => row.key).join(','), 'background')
check('an art node recolours its palette', canvasInternals.paintTargets({ kind: 'art', colors: ['#111111', '#222222'] }).map((row) => row.key).join(','), 'colors.0,colors.1')
check('an image owns no colour', canvasInternals.paintTargets({ kind: 'image', src: 'x.png' }).length, 0)
check('a colour is read off a solid paint', canvasInternals.paintColorOf({ type: 'solid', color: '#4D6BFE' }), '#4d6bfe')
check('a gradient is not a flat colour', canvasInternals.paintColorOf({ type: 'linear', stops: [] }), null)
check('a token name is not a colour', canvasInternals.paintColorOf('accent'), null)
check('recolouring writes the literal', JSON.stringify(canvasInternals.colorOps('layers.0', { key: 'fill', paint: '#111111' }, '#4D6BFE')), JSON.stringify([{ op: 'set', at: 'layers.0.fill', value: '#4d6bfe' }]))
check('recolouring to the same colour writes nothing', canvasInternals.colorOps('layers.0', { key: 'fill', paint: '#4d6bfe' }, '#4D6BFE').length, 0)
check('a gradient is replaced by the chosen solid', JSON.stringify(canvasInternals.colorOps('layers.0', { key: 'fill', paint: { type: 'linear', stops: [] } }, '#4D6BFE')), JSON.stringify([{ op: 'set', at: 'layers.0.fill', value: '#4d6bfe' }]))
check('the transform dress is styled', canvasCss.includes('.cnv-nudgeRow{') && canvasCss.includes('.cnv-swatch[data-active=true]'), true)
// THE GAP OVER THE COMPOSER. The page's bottom inset used to be the composer clearance
// with 6px subtracted, which still left the artboard touching its top edge because the
// clearance is measured to the START of the composer, not past it. It is now a 10px
// inset of its own, and the clearance variable is not what draws it.
check('the artboard keeps a gap over the composer', canvasCss.includes('padding:10px 10px calc(var(--cnv-composer-clearance,168px) + 10px) 10px'), true)
check('the page reserves the composer clearance', canvasCss.includes('--cnv-composer-clearance:calc(var(--dsh-composer-height,152px) + 16px)'), true)
// THE RULERS AND THE ORIGIN: the page's coordinate system, drawn. The gutters are grid
// tracks - the ONLY horizontal inset on the left - so design x=0 is the artboard's own
// left edge, which is what makes the origin marker the origin.
check('the page is a ruler gutter around the artboard', canvasCss.includes('.cnv-pad{min-width:100%;min-height:100%;display:grid;grid-template-columns:22px 1fr;grid-template-rows:22px 1fr'), true)
check('both rulers exist', canvasCss.includes('.cnv-axisTop{') && canvasCss.includes('.cnv-axisLeft{'), true)
check('the origin is marked on the artboard', canvasSource.includes("'data-canvas-origin': '0,0'") && canvasSource.includes("'data-canvas-origin-marker': 'true'"), true)
check('the rulers are labelled in design pixels', canvasSource.includes('data-canvas-ruler') && canvasSource.includes('cnv-axisLabel'), true)
check('the ruler spacing is chosen so labels do not collide', canvasSource.includes('candidate * Math.abs(scale) >= 64'), true)
// SAVE confirms what the HOST holds rather than inventing a second writer: the design is
// already persisted on every edit, so the button re-reads the state and reports the
// revision - two writers for one document is how a document forks.
check('the bar carries a Save that confirms the host revision', canvasSource.includes("}, 'Save')") && canvasSource.includes('is on the host at revision'), true)
// A CLICK ON NOTHING DE-SELECTS, and the cursor does not outlive the selection it
// promised: the hover that carries the pointer onto a NEW selection is skipped, and a
// drag clears the cursor it painted.
check('a click on empty canvas de-selects', canvasSource.includes('if (!chosen) {') && canvasSource.includes('if (!handle && onDeselect) onDeselect()'), true)
check('a drag does not leave a stale cursor', canvasSource.includes('draggingRef.current = false') && canvasSource.includes('if (draggingRef.current) return'), true)
check('the one hover after a selection is skipped', canvasSource.includes('if (triggerSelect.current) {'), true)
check('the pane switcher is styled', canvasCss.includes('.cnv-sideTab[data-active=true]') && canvasCss.includes('.cnv-sideTabs{'), true)
check('the layer list owns its own scrollport', canvasCss.includes('.cnv-layersScroll{') && canvasCss.includes('.cnv-section[data-grow=true] .cnv-layersScroll{flex:1}'), true)
check('no pane scrolls as a whole', canvasCss.includes('.cnv-pane{flex:1;min-height:0;display:flex;flex-direction:column}') && canvasSource.includes('cnv-paneScroll'), true)
// The widgets that earned no room: the raw measurement table (a diagnostic the
// model's render report already carries), the six-line prose helper, and the
// two-rule-per-heading style card. Their absence is the assertion, because a bar
// that grows a wall of text back is the bug this alpha fixes.
check('the raw measurement table is not furniture', canvasCss.includes('.cnv-metrics') === false && canvasSource.includes('metricsText') === false, true)
check('the prose gesture helper is gone', canvasSource.includes('Drag a layer to move it, or a handle'), false)
check('the style card keeps one rule per heading', canvasSource.includes('(currentStyle.do || []).slice(0, 1)') && canvasSource.includes('(currentStyle.gates || []).slice(0, 1)'), true)
check('the canvas tool list carries canvas_style', canvasInternals.TOOL_NAMES.includes('canvas_style'), true)

// --- ONE SURFACE (alpha.13)
//
// The Canvas tab used to carry a SECOND surface: a vendored Excalidraw mounted over
// the design surface, seeded from the layout one way, with its own library kept in
// this origin's storage. It is gone, and the tab is the design surface and nothing
// else. What is pinned here is that the bundle carries no trace of it - no loader,
// no bridge, no storage key, no overlay stylesheet, no surface mode for the toolbar
// to hide behind - because the tab's whole contract is that the document the host
// validates is the document the person edits, and a second editor with its own
// element model is exactly what that contract cannot survive.
check('the bundle carries no Excalidraw reference at all', /excalidraw/i.test(canvasSource), false)
check('...and no overlay stylesheet for one', /cnv-excalidraw/.test(canvasCss), false)
check('...and no second surface for the toolbar to hide behind', canvasSource.includes("'data-canvas-surface'"), false)
check('...and no storage of its own', canvasSource.includes('localStorage'), false)
check('...and the scene bridge went with it', canvasInternals.sceneSkeletonsFor === undefined, true)
check('...and so did the library persistence', canvasInternals.readStoredLibrary === undefined && canvasInternals.LIBRARY_STORAGE_KEY === undefined, true)
check('...and the vendored routes went with them', Object.values(canvasInternals.ROUTES).join(',').includes('excalidraw'), false)

// --- THE OBJECT VERBS (alpha.13)
//
// Adding, duplicating, deleting and re-ordering a layer are the verbs that make the tab
// a DESIGNER rather than a nudger, and every one of them is a `canvas_patch` the agent
// could have written - so they are pinned here as pure data, before any UI is involved:
// what each verb emits, and that a verb with nothing to act on emits NOTHING rather than
// a patch the host would refuse.
{
  const { objectOps, parentOf, newLayer } = canvasInternals
  check('the pure verb layer is exported', typeof objectOps === 'function' && typeof parentOf === 'function' && typeof newLayer === 'function', true)
  check('a path splits into its parent array and its index', JSON.stringify(parentOf('layers.1.children.0')), JSON.stringify({ parentPath: 'layers.1.children', index: 0 }))
  check('...and a top-level layer keeps the array it lives in', parentOf('layers.3').parentPath, 'layers')
  const node = { kind: 'shape', shape: 'rect', w: 10, h: 10 }
  check('add appends to the array it is given', JSON.stringify(objectOps('add', { parentPath: 'layers', node })), JSON.stringify([{ op: 'insert', at: 'layers.-', value: node }]))
  check('...and into a frame\u2019s children when that is the parent', JSON.stringify(objectOps('add', { parentPath: 'layers.2.children', node })), JSON.stringify([{ op: 'insert', at: 'layers.2.children.-', value: node }]))
  check('duplicate lands directly after its original', JSON.stringify(objectOps('duplicate', { path: 'layers.1', node })), JSON.stringify([{ op: 'insert', at: 'layers.2', value: node }]))
  check('delete removes the path', JSON.stringify(objectOps('delete', { path: 'layers.1' })), JSON.stringify([{ op: 'remove', at: 'layers.1' }]))
  // A Z-ORDER MOVE IS TWO OPS AND THE ORDER MATTERS: the insert index is read against the
  // array AFTER the removal, which is why both ends are what they are.
  check('to front removes and then appends', JSON.stringify(objectOps('front', { path: 'layers.0', node })), JSON.stringify([{ op: 'remove', at: 'layers.0' }, { op: 'insert', at: 'layers.-', value: node }]))
  check('to back removes and then inserts at the head', JSON.stringify(objectOps('back', { path: 'layers.4', node })), JSON.stringify([{ op: 'remove', at: 'layers.4' }, { op: 'insert', at: 'layers.0', value: node }]))
  check('a verb with no node writes nothing', objectOps('duplicate', { path: 'layers.1' }).length, 0)
  check('an unknown verb writes nothing', objectOps('explode', { path: 'layers.1', node }).length, 0)
  check('add without a parent writes nothing', objectOps('add', { node }).length, 0)
  // A NEW LAYER, and the two properties that make it belong to the design rather than to
  // the toolbar: it is INSIDE the canvas, and its colour is the document's own token when
  // the document defines one.
  const fixture = { canvas: { width: 1280, height: 640 }, tokens: { color: { ink: '#111111', accent: '#4D6BFE' }, font: { display: 'Space Grotesk' }, radius: { card: 20 } } }
  const added = { text: newLayer('text', fixture), rect: newLayer('rect', fixture), ellipse: newLayer('ellipse', fixture) }
  check('a new text layer is a text node with words to replace', added.text.kind === 'text' && added.text.text.length > 0, true)
  check('...sized from an explicit size, not a style role', typeof added.text.size === 'number' && added.text.style === undefined, true)
  check('...and naming a family only because the document has that role', added.text.family, 'display')
  check('a new rectangle is a shape with the document\u2019s own accent', added.rect.shape === 'rect' && added.rect.fill === 'accent', true)
  check('...and the document\u2019s own corner radius', added.rect.radius, 20)
  check('a new ellipse is square', added.ellipse.shape === 'ellipse' && added.ellipse.w === added.ellipse.h, true)
  check('every new layer starts inside the canvas', Object.values(added).every((entry) => entry.x >= 0 && entry.y >= 0 && entry.x < 1280 && entry.y < 640), true)
  const bare = newLayer('text', { canvas: { width: 400, height: 300 }, tokens: {} })
  check('a document with no tokens gets a literal colour and no family role', bare.color === '#111111' && bare.family === undefined, true)

  // --- SNAPPING, as pure data
  //
  // A drag aligns to the canvas's own edges and centre and to every OTHER box's edges and
  // centre, and the LINES THAT ARE DRAWN come from the same call that decides the movement -
  // so a guide can never describe a snap the document did not get. Pinned here without a
  // browser, because it is arithmetic.
  const { snapFor } = canvasInternals
  check('the snap helper is exported', typeof snapFor === 'function', true)
  const canvas = { width: 1000, height: 500 }
  const dragged = { x: 494, y: 100, w: 100, h: 50 }
  const ownCentre = snapFor(dragged, [], canvas, 8)
  check('a box near the canvas centre snaps its centre onto it', ownCentre.dx, 6)
  check('...and draws the guide it snapped to', JSON.stringify(ownCentre.guides), JSON.stringify([{ axis: 'x', at: 500, from: 0, to: 500 }]))
  check('a box near a canvas edge snaps its own edge', snapFor({ x: 3, y: 100, w: 100, h: 50 }, [], canvas, 8).dx, -3)
  check('...and the guide runs the full height', JSON.stringify(snapFor({ x: 3, y: 100, w: 100, h: 50 }, [], canvas, 8).guides[0]), JSON.stringify({ axis: 'x', at: 0, from: 0, to: 500 }))
  // A box whose six lines are ALL far from every candidate: nothing moves and nothing is
  // drawn. (The earlier fixture taught the difference: a box whose top edge lands exactly on
  // the canvas's middle line has dy 0 and STILL gets a guide - an edge already on a line is
  // exactly the fact a guide exists to show.)
  check('nothing within tolerance moves nothing and draws nothing', JSON.stringify(snapFor({ x: 250, y: 180, w: 100, h: 50 }, [], canvas, 8)), JSON.stringify({ dx: 0, dy: 0, guides: [] }))
  check('...while an edge already ON a line draws a guide without moving it', JSON.stringify(snapFor({ x: 250, y: 250, w: 100, h: 50 }, [], canvas, 8).guides), JSON.stringify([{ axis: 'y', at: 250, from: 0, to: 1000 }]))
  const other = { path: 'layers.0', box: { x: 200, y: 40, w: 100, h: 400 } }
  const toOther = snapFor({ x: 203, y: 250, w: 100, h: 50 }, [other], canvas, 8)
  check('a box snaps to ANOTHER box\u2019s edge', toOther.dx, -3)
  check('...and the guide spans both boxes', JSON.stringify(toOther.guides[0]), JSON.stringify({ axis: 'x', at: 200, from: 40, to: 440 }))
  // THREE candidates are within reach and the smallest distance wins: the dragged box's left
  // edge is 4px from the other box's right edge (300), 46 from its centre line (250) and 96
  // from its left edge (200) - so the answer is +4 and not -46.
  check('the NEAREST of several candidate lines wins', snapFor({ x: 296, y: 250, w: 100, h: 50 }, [{ path: 'a', box: { x: 200, y: 0, w: 100, h: 10 } }], { width: 1000, height: 500 }, 60).dx, 4)
  const both = snapFor({ x: 494, y: 246, w: 100, h: 50 }, [], canvas, 8)
  check('the two axes are decided independently', both.dx + '/' + both.dy, '6/4')
  check('...with one guide each', both.guides.length, 2)
  check('a zero-sized box offers no lines to snap to', snapFor({ x: 100, y: 100, w: 10, h: 10 }, [{ path: 'z', box: { x: 100, y: 100, w: 0, h: 0 } }], { width: 1000, height: 500 }, 8).guides.length, 0)
  check('a box already ON a line is not moved', snapFor({ x: 500, y: 100, w: 100, h: 50 }, [], canvas, 8).dx, 0)

  // --- THE MARQUEE, as pure data
  //
  // The band that catches a group of layers and the patch that MOVES that group are both
  // arithmetic, and they are pinned here without a browser for the same reason the snap is:
  // what a check can prove exactly, it should.
  const { marqueeHits, multiMoveOps, boxesTouch } = canvasInternals
  check('the marquee helpers are exported', typeof marqueeHits === 'function' && typeof multiMoveOps === 'function' && typeof boxesTouch === 'function', true)
  const layout = [
    { path: 'layers.0', box: { x: 0, y: 0, w: 100, h: 100 } },
    { path: 'layers.1', box: { x: 90, y: 90, w: 100, h: 100 } },
    { path: 'layers.2', box: { x: 400, y: 400, w: 100, h: 100 } },
    { path: 'layers.3', box: { x: 10, y: 10, w: 0, h: 0 } },
  ]
  check('two boxes that merely touch still overlap', boxesTouch({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), true)
  check('...and two that do not, do not', boxesTouch({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 }), false)
  check('a band catches every layer it touches', marqueeHits(layout, { x: 50, y: 50, w: 100, h: 100 }).join(','), 'layers.0,layers.1')
  check('...in the layout\u2019s own order', marqueeHits(layout, { x: 0, y: 0, w: 600, h: 600 }).join(','), 'layers.0,layers.1,layers.2')
  check('...and leaves out what it did not reach', marqueeHits(layout, { x: 0, y: 0, w: 600, h: 600 }).includes('layers.3'), false)
  check('a layer with no drawable box is never caught', marqueeHits(layout, { x: 0, y: 0, w: 20, h: 20 }).includes('layers.3'), false)
  check('a band over nothing catches nothing', marqueeHits(layout, { x: 900, y: 900, w: 10, h: 10 }).length, 0)
  // ONE GESTURE OVER SEVERAL LAYERS IS ONE PATCH, up to the cap - and the layers that did not
  // fit are COUNTED, because moving some of a selection silently is worse than saying so.
  const movables = Array.from({ length: 40 }, (unused, index) => ({ path: 'layers.' + index, box: { x: index * 10, y: 0, w: 8, h: 8 } }))
  const moveDoc = { layers: movables.map((row, index) => ({ kind: 'shape', shape: 'rect', x: index * 10, y: 0, w: 8, h: 8 })) }
  const two = multiMoveOps(['layers.0', 'layers.1'], moveDoc, movables, 5, 7)
  check('a move of two layers is four operations', two.ops.length, 4)
  check('...two per layer, position only', two.ops.map((op) => op.at.split('.').pop()).join(','), 'x,y,x,y')
  check('...and nothing was left behind', two.dropped, 0)
  // A MOVE ALONG ONE AXIS IS ONE OPERATION PER LAYER, a diagonal one is two: the cap bites
  // at 64 operations, which is 32 layers diagonally - and the layers that did not fit are
  // counted so the tab can say how many were left behind.
  const flat = multiMoveOps(movables.map((row) => row.path), moveDoc, movables, 5, 0)
  check('a move of forty layers along one axis fits in one patch', flat.ops.length, 40)
  check('...and leaves nobody behind', flat.dropped, 0)
  const diagonal = multiMoveOps(movables.map((row) => row.path), moveDoc, movables, 5, 7)
  check('a DIAGONAL move of forty layers is capped at the patch\u2019s 64 operations', diagonal.ops.length, 64)
  check('...so thirty-two layers move', diagonal.ops.length / 2, 32)
  check('...and the eight that did not are counted', diagonal.dropped, 8)
  check('a move of nothing writes nothing', multiMoveOps([], moveDoc, movables, 5, 5).ops.length, 0)
  check('a path that is not in the document is skipped, not counted as dropped', multiMoveOps(['layers.999'], moveDoc, movables, 5, 5).dropped, 0)

  // --- THE IN-PLACE TEXT EDITOR'S PURE HALF
  //
  // A text layer has TWO spellings in this language - `text` for a plain string and `runs`
  // for rich text, which is what the archetypes carry - and the editor has to open on the
  // words a person can SEE either way: a model-authored rich-text block used to be
  // uneditable in place, because the editor only looked at `text`.
  const { nodeTextOf } = canvasInternals
  check('the editor\u2019s word reader is exported', typeof nodeTextOf === 'function', true)
  check('a plain text layer reads its own string', nodeTextOf({ kind: 'text', text: 'Hello' }), 'Hello')
  check('a rich-text layer reads its runs joined', nodeTextOf({ kind: 'text', runs: [{ text: 'Ship ' }, { text: 'plugins', color: '#f00' }, { text: ', not patches.' }] }), 'Ship plugins, not patches.')
  check('plain text wins when a layer carries both', nodeTextOf({ text: 'plain', runs: [{ text: 'rich' }] }), 'plain')
  check('a run with no words contributes nothing', nodeTextOf({ runs: [{ text: 'a' }, {}, { text: 'b' }] }), 'ab')
  check('a layer with no words at all reads as null', nodeTextOf({ kind: 'text' }), null)
  check('...and so does a shape', nodeTextOf({ kind: 'shape', shape: 'rect' }), null)
  check('...and nothing at all', nodeTextOf(null), null)
  // AND THE COMMIT. A rich-text layer is edited by WRITING `text` AND REMOVING `runs` in
  // one patch - a node that kept both would still paint the runs, so the words a person
  // typed would be invisible. This is the same shape the tab sends.
  const richEdit = [{ op: 'set', at: 'layers.2.text', value: 'Edited' }, { op: 'remove', at: 'layers.2.runs' }]
  check('an edit of a plain layer writes one field', JSON.stringify([{ op: 'set', at: 'layers.2.text', value: 'Edited' }].map((op) => op.at)), JSON.stringify(['layers.2.text']))
  check('...and an edit of a rich-text layer clears the runs in the SAME patch', richEdit.length, 2)
  // THAT THIS PATCH IS ONE THE ENGINE APPLIES is proved where the engine is:
  // `check-canvas-node.mjs` runs it through `applyPatches` and reads the result back.
  // Unload the row: the renderer's own effect returned a stopper, which is what the
  // shell calls when the plugin goes away (and what lets this process exit).
  for (const dispose of canvasDisposers) dispose()
  check('the renderer stopped with its row', canvasEffects.length >= 11, true)
}

// ---------------------------------------------------------------------------
// NO TWO BUNDLES MAY DRESS THE SAME CLASS
//
// Every bundle injects its stylesheet when it loads, and the LAST one wins each
// equal-specificity tie. So two packages that both define `.x-bar` do not merely
// collide in a linter's sense: the later bundle silently redresses the earlier
// one's UI. That is exactly what dsh-canvas's `dsc-bar` did to dsh-cmdbar's dock
// header - the APP drew a 51px header row, because canvas's
// `.dsc-bar{min-height:38px;padding:6px 10px}` landed on a content-box bar after the
// dock's own `.dsc-bar{padding:2px 8px 2px 10px}`, and its close button at 26px
// instead of 20px (canvas's `.dsc-btn{height:26px}`) - while every render of either
// bundle ON ITS OWN agreed with the design, which is why the harness pictures and
// the app disagreed. Canvas claimed the dock's `dsc-` prefix two days after the
// dock took it (its toolbar wears 88 classes; five were shared: dsc-bar, dsc-btn,
// dsc-pill, dsc-body, dsc-spacer). A prefix is the namespace a package owns; this
// reads every `lib/client.js` in the pack and fails on any class two of them define.
// -------------------------------------------------------------- dsh-writing
// The Writing tab: the view-ring registration, the shell a person actually
// types into, and the run/mark algebra that the whole formatting path rests on.
// That algebra is PURE on purpose - `applyMarkToRuns` takes runs and a character
// range and returns runs - so it is driven here with no browser, which is where
// the "Ctrl+B on a half-bold selection" rule can actually be pinned.
{
  const writing = loadBundle('packages/dsh-writing/lib/client.js', {})
  check('writing bundle id', writing.id, 'dsh-writing')
  check('writing bundle name', writing.exports.name, 'dsh-writing')
  const writingVersion = JSON.parse(readFileSync(path.join(repo, 'packages/dsh-writing/package.json'), 'utf8')).version
  check('writing version marker matches package.json', writing.exports.__internals.PLUGIN_VERSION, writingVersion)
  const io = writing.exports.__internals

  // The registrations, against stub slots AND a stub tab-type registry.
  const registrations = []
  const paneTypes = []
  const writingCtx = {
    effect: (fn) => fn(),
    logger: { debug() {}, warn() {} },
    get: (name) => {
      if (name === 'sidebarRightTabs') {
        return {
          register: (definition) => {
            paneTypes.push(definition)
            return () => {}
          },
          entries: () => paneTypes,
        }
      }
      return undefined
    },
    slots: {
      inject: (name, fn) => fn(),
      register: (definition, component) => {
        registrations.push({ definition, component })
        return () => {}
      },
    },
  }
  writing.exports.apply(writingCtx)
  const views = registrations.filter((entry) => entry.definition.name === 'conversation.view')
  const panes = registrations.filter((entry) => entry.definition.name === 'sidebar.right.pane.tab')
  check('writing registers one conversation view', views.length, 1)
  const view = views[0]
  check('writing view id', view.definition.id, 'writing')
  check('writing sits to the RIGHT of Canvas (order 20)', view.definition.order > 20, true)
  check('writing view label', view.definition.label(), 'Writing')
  check('writing view is a conversation view', view.definition.name, 'conversation.view')
  check('writing learns its session through inject', view.definition.inject('session-writing').writingSession, 'session-writing')
  // THE RIGHT BAR: three pane types and three bodies, in the keyed seats their
  // definitions name - a page, a workbook grid, and the headings navigator.
  check('writing registers three right-bar pane types', paneTypes.length, 3)
  const typeById = new Map(paneTypes.map((definition) => [definition.id, definition]))
  check('the document pane type is registered', Boolean(typeById.get(io.DOC_TYPE_ID)), true)
  check('the outline pane type is registered', Boolean(typeById.get(io.OUTLINE_TYPE_ID)), true)
  check('the sheet pane type is registered', Boolean(typeById.get(io.SHEET_TYPE_ID)), true)
  check('the document pane claims a .docx', typeById.get(io.DOC_TYPE_ID).canOpen('dsh-resource://file/session/s/report.docx'), true)
  check('the document pane refuses a .png', typeById.get(io.DOC_TYPE_ID).canOpen('dsh-resource://file/session/s/picture.png'), false)
  check('the document pane refuses an address outside a session', typeById.get(io.DOC_TYPE_ID).canOpen('dsh-resource://file/absolute/report.docx'), false)
  check('the sheet pane claims a .xlsx', typeById.get(io.SHEET_TYPE_ID).canOpen('dsh-resource://file/session/s/books.xlsx'), true)
  check('the sheet pane refuses a .docx', typeById.get(io.SHEET_TYPE_ID).canOpen('dsh-resource://file/session/s/report.docx'), false)
  check('every pane type carries its guide entry', paneTypes.every((definition) => Array.isArray(definition.guide) && definition.guide.length === 1), true)
  check(
    'every pane body is registered in its own seat',
    panes.map((entry) => entry.definition.key).sort().join(','),
    [io.DOC_TYPE_ID, io.OUTLINE_TYPE_ID, io.SHEET_TYPE_ID].sort().join(','),
  )
  check('a file address parses into a session and a path', io.filePathOf('dsh-resource://file/session/abc/dir/a.docx'), 'dir/a.docx')
  check('an address with no session is not a file', String(io.filePathOf('dsh-resource://canvas/session/abc/one')), 'null')
  check('writing view renders with a session', renderToStaticMarkup(h(view.component, { writingSession: 'session-writing', ctx: writingCtx })).includes('data-dsh-writing-view'), true)
  check('writing view renders WITHOUT a session too', renderToStaticMarkup(h(view.component, { ctx: writingCtx })).includes('data-dsh-writing-view'), true)
  const markup = renderToStaticMarkup(h(view.component, { writingSession: 'session-writing', ctx: writingCtx }))
  // The surface a person needs, by the attribute the tab itself sets. The bar is the
  // tab's own (New, the rail toggle, the title, the document's typography, the
  // editor's own block menu, the page setup) and the EDITOR is Editor.js's, so what
  // is asserted here is the shell around it - and the markers the editor's surface
  // hangs on (`data-writing-editor`, `data-writing-editorjs`), which is the swap
  // this refactor made.
  for (const marker of [
    'data-writing-bar',
    'data-writing-rail',
    'data-action="save"',
    'data-action="proof"',
    'data-writing-margin="top"',
    'data-writing-orientation',
    'data-writing-zoom',
    'data-writing-import',
    'data-export="docx"',
    'data-export="md"',
    'data-export="txt"',
    'data-writing-insert="heading-1"',
    'data-writing-insert="heading-2"',
    'data-writing-insert="quote"',
    'data-writing-insert="code"',
    'data-writing-delete',
  ]) {
    check('writing shell carries ' + marker, markup.includes(marker), true)
  }
  // The editor's own seat belongs to the OPEN document: with nothing open there is
  // no editor to draw, and the tab says what it is doing instead. Both states are
  // asserted here, and the one below is the same assertion read the other way.
  check('writing draws no editor before a document is open', markup.includes('data-writing-editorjs'), false)
  check('writing draws no editor phase before a document is open', markup.includes('data-writing-editor='), false)
  // The editor's three marks only the pack's own tools carry: the toolbar no longer
  // has a button per mark (Editor.js's inline toolbar has bold and italic), so what
  // is asserted is that the tab does NOT pretend to have one.
  check('writing has no mark buttons of its own', markup.includes('data-writing-marks'), false)
  check('writing has no page-break control of its own', markup.includes('data-action="page-break"'), false)
  check('writing status starts at zero words', markup.includes('0 words'), true)
  // NEW is the LEFTMOST control on the bar, before the title and every other
  // control - which is where a document tab keeps it, and where the owner of this
  // tab asked for it after finding it in the middle.
  {
    const newAt = markup.indexOf('data-writing-new')
    const titleAt = markup.indexOf('data-writing-title')
    const fontAt = markup.indexOf('data-writing-font')
    check('writing puts New on the bar', newAt >= 0, true)
    check('writing puts New before the title', newAt >= 0 && titleAt > newAt, true)
    check('writing puts New before the document typography', newAt >= 0 && fontAt > newAt, true)
  }
  // With no document open yet (the state a first paint is in), there is nothing to
  // edit and the tab says what it is doing rather than drawing an empty surface.
  check('writing draws no editor before a document is open', markup.includes('data-writing-editorjs'), false)
  check('writing says it is opening', markup.includes('Opening'), true)
  check('writing phase starts at loading', markup.includes('data-writing-phase="loading"'), true)

  // THE PAGE SURFACE AS ELEMENTS, kept and still driven: the tab no longer renders
  // paper (Editor.js owns the surface now), but `pagesElement`, `blockElement`,
  // `flowStyle` and the block element builder are exported pure functions and the
  // block splitter is a public part of this package - so they are proved here
  // rather than left to rot. What the TAB draws is asserted above.
  const pageDoc = {
    id: 'check-doc',
    title: 'Check',
    page: { size: 'a4', orientation: 'portrait', margins: { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 } },
    blocks: [
      { type: 'heading', level: 1, runs: [{ text: 'Title', marks: [] }] },
      { type: 'paragraph', align: 'center', runs: [{ text: 'body ', marks: [] }, { text: 'bold', marks: ['b'] }] },
      { type: 'pageBreak', runs: [{ text: '', marks: [] }] },
      { type: 'listItem', ordered: true, level: 1, runs: [{ text: 'item', marks: [] }] },
      { type: 'paragraph', runs: [{ text: 'tall', marks: [] }] },
    ],
  }
  const pageGeometry = { widthMm: 210, heightMm: 297, margins: pageDoc.page.margins, contentWidthMm: 159.2, footerMm: 10 }
  const noop = () => () => {}
  const pageHandlers = { refFor: noop, onInput: noop, onKeyDown: noop, onFocus: noop, onEmptyPage: () => {} }
  const pageMarkup = renderToStaticMarkup(
    h(
      React.Fragment,
      null,
      io.pagesElement({
        doc: pageDoc,
        pages: [
          { index: 0, blocks: [{ index: 0, topMm: 25.4, heightMm: 10, overflow: false }, { index: 1, topMm: 40, heightMm: 8, overflow: false }] },
          { index: 1, blocks: [{ index: 3, topMm: 25.4, heightMm: 6, overflow: false }, { index: 4, topMm: 31, heightMm: 400, overflow: true }] },
          { index: 2, blocks: [] },
        ],
        geometry: pageGeometry,
        renderedHtml: pageDoc.blocks.map((block) => io.blockHtmlString(block)),
        handlers: pageHandlers,
      }),
    ),
  )
  check('writing draws one element per page', (pageMarkup.match(/data-writing-page="/g) || []).length, 3)
  check('writing numbers the pages', pageMarkup.includes('>1</div>') && pageMarkup.includes('>3</div>'), true)
  // A4 at 96 dpi is 793.7 x 1122.52 CSS pixels and a 25.4mm margin is exactly
  // 96px: the numbers come from the model's millimetres, asserted as the pixels
  // the page actually wears.
  check('writing sizes the page in pixels from millimetres', pageMarkup.includes('width:793.7px') && pageMarkup.includes('height:1122.52px'), true)
  check('writing turns the margins into the page padding', pageMarkup.includes('padding:96px 96px 96px 96px'), true)
  check('writing sizes the text column to the content width', pageMarkup.includes('width:601.7px'), true)
  check('writing makes every block editable', (pageMarkup.match(/contenteditable="true"/g) || []).length, 4)
  check('writing marks a heading with its level', pageMarkup.includes('data-type="heading"') && pageMarkup.includes('data-level="1"'), true)
  check('writing marks a list with its kind and level', pageMarkup.includes('data-ordered="true"'), true)
  check('writing carries alignment onto the block', pageMarkup.includes('data-align="center"'), true)
  check('writing renders the marks inside the block', pageMarkup.includes('<strong>bold</strong>'), true)
  check('writing flags a block taller than its page', pageMarkup.includes('data-overflow="true"'), true)
  check('writing gives an empty page something to click', pageMarkup.includes('data-writing-empty-page="2"'), true)
  check('writing draws one editable block per block it was given', (pageMarkup.match(/data-type=/g) || []).length, 4)
  check('writing draws the page menu apart from the pages', markup.includes('data-writing-pagemenu'), true)
  // A page break is a marker element when one is placed. The paginator never
  // places one (a break only starts the next page), so the branch is driven
  // directly rather than through a page list that cannot contain it.
  check(
    'writing draws a page break as its own marker',
    renderToStaticMarkup(
      io.blockElement({ block: io.PAGE_BREAK_BLOCK, placed: { index: 2, from: 0, to: null, split: false }, handlers: pageHandlers, pageIndex: 0 }),
    ).includes('data-page-break="true"'),
    true,
  )
  // A FRAGMENT of a block: the page renders the character range it shows, which
  // is what lets a paragraph continue on the next page.
  const fragmentMarkup = renderToStaticMarkup(
    io.blockElement({
      block: { type: 'paragraph', runs: [{ text: 'one two three', marks: [] }] },
      placed: { index: 5, from: 4, to: 7, split: true },
      html: io.runsHtml(io.sliceRuns([{ text: 'one two three', marks: [] }], 4, 7)),
      handlers: pageHandlers,
      pageIndex: 1,
    }),
  )
  check('a fragment carries the block it belongs to', fragmentMarkup.includes('data-block="5"'), true)
  check('a fragment carries the range it shows', fragmentMarkup.includes('data-from="4"') && fragmentMarkup.includes('data-to="7"'), true)
  check('a fragment is flagged as split', fragmentMarkup.includes('data-split="true"'), true)
  check('a fragment renders only its own text', fragmentMarkup.includes('two'), true)
  check('a fragment leaves the rest of the block out', fragmentMarkup.includes('one'), false)
  // The slicing algebra the fragments rest on, driven directly.
  const sliceSource = [{ text: 'abcdef', marks: [] }, { text: 'GHI', marks: ['b'] }]
  check('writing slices runs by character range', JSON.stringify(io.sliceRuns(sliceSource, 2, 7)), JSON.stringify([{ text: 'cdef', marks: [] }, { text: 'G', marks: ['b'] }]))
  check('writing slices to the end when asked for no end', JSON.stringify(io.sliceRuns(sliceSource, 4, null)), JSON.stringify([{ text: 'ef', marks: [] }, { text: 'GHI', marks: ['b'] }]))
  check('writing slices an empty range to one empty run', JSON.stringify(io.sliceRuns(sliceSource, 3, 3)), JSON.stringify([{ text: '', marks: [] }]))
  check('writing keeps a run\'s font through a slice', JSON.stringify(io.sliceRuns([{ text: 'abcd', marks: [], font: 'Georgia', size: 14 }], 1, 3)), JSON.stringify([{ text: 'bc', marks: [], font: 'Georgia', size: 14 }]))
  // An edit inside a fragment goes back into the block at its own offset.
  check(
    'writing splices an edit back where the fragment was',
    JSON.stringify(io.replaceRange([{ text: 'one two three', marks: [] }], 4, 7, [{ text: 'TWO', marks: ['b'] }])),
    JSON.stringify([{ text: 'one ', marks: [] }, { text: 'TWO', marks: ['b'] }, { text: ' three', marks: [] }]),
  )
  check(
    'writing splices a deletion back too',
    JSON.stringify(io.replaceRange([{ text: 'one two three', marks: [] }], 3, 8, [{ text: '', marks: [] }])),
    JSON.stringify([{ text: 'onethree', marks: [] }]),
  )
  check('writing renders plain text as one run', JSON.stringify(io.runsFromPlainText('hello')), JSON.stringify([{ text: 'hello', marks: [] }]))

  // ---------------------------------------------------------------------------
  // The Editor.js bridge: the model in, Editor.js's block JSON out, and back.
  //
  // This is the piece that made the surface swap possible, and it is PURE - no DOM,
  // no editor, no fetch - so it is driven here exactly as the host half's own copy
  // is driven in `check-writing-node.mjs`. Both halves must agree, which is what
  // these two lists of cases are for.
  // ---------------------------------------------------------------------------
  check('the vendored scripts are named in load order', io.EDITOR_SCRIPTS.map((entry) => entry.file).join(','), 'editorjs.umd.js,paragraph.umd.js,header.umd.js,editorjs-list.umd.js,quote.umd.js,code.umd.js')
  check('the core is the first script', io.EDITOR_SCRIPTS[0].global, 'EditorJS')
  check('the list tool is the global it leaves behind', io.EDITOR_SCRIPTS[3].global, 'EditorjsList')
  check('the editor route is the package route', io.EDITOR_ROUTE, '/api/dsh-writing/vendor/editorjs/')
  check('the editor offers the two inline tools it has', io.EDITOR_INLINE_TOOLS.join(','), 'bold,italic')
  check('the marks the pack adds ride on an attribute', io.MARK_ATTRIBUTE, 'data-mark')

  const bridgeDoc = {
    page: { size: 'a4', orientation: 'portrait', margins: { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 } },
    font: '',
    fontSize: 12,
    blocks: [
      { type: 'heading', level: 2, runs: [{ text: 'A heading', marks: [] }] },
      { type: 'paragraph', runs: [{ text: 'plain ', marks: [] }, { text: 'b', marks: ['b'] }, { text: 'u', marks: ['u'] }, { text: 's', marks: ['s'] }, { text: 'c', marks: ['code'] }] },
      { type: 'listItem', ordered: false, level: 0, runs: [{ text: 'one', marks: [] }] },
      { type: 'listItem', ordered: false, level: 1, runs: [{ text: 'nested', marks: [] }] },
      { type: 'listItem', ordered: false, level: 0, runs: [{ text: 'two', marks: [] }] },
      { type: 'quote', runs: [{ text: 'quoted', marks: [] }] },
      { type: 'code', runs: [{ text: 'const x = 1', marks: [] }] },
      { type: 'pageBreak', runs: [{ text: '', marks: [] }] },
    ],
  }
  const bridgeTime = 1700000000000
  const editorData = io.toEditorData(bridgeDoc, bridgeTime)
  check('the bridge stamps the data with the time it is given', editorData.time, bridgeTime)
  check(
    'the bridge maps every block type',
    editorData.blocks.map((block) => block.type).join(','),
    'header,paragraph,list,quote,code,delimiter',
  )
  check('the heading carries its level', editorData.blocks[0].data.level, 2)
  check('the list carries its style', editorData.blocks[2].data.style, 'unordered')
  check('the list NESTS the deeper level', editorData.blocks[2].data.items[0].items.length, 1)
  check('the list keeps the sibling at the root', editorData.blocks[2].data.items.length, 2)
  check('the quote carries its text', editorData.blocks[3].data.text, 'quoted')
  check('the code carries its characters', editorData.blocks[4].data.code, 'const x = 1')
  check(
    'the marks ride on data-mark spans inside the paragraph',
    /data-mark="b"|data-mark="[^"]*b/.test(editorData.blocks[1].data.text) && editorData.blocks[1].data.text.includes('<br>') === false,
    true,
  )
  // The round trip: what the editor would save is what the model gets back, block
  // for block, with the text intact. Marks are the client DOM reader's business and
  // are driven through `runsFromHtmlString` below.
  const roundTrip = io.fromEditorData(editorData)
  check(
    'the round trip keeps every block type',
    roundTrip.blocks.map((block) => block.type).join(','),
    'heading,paragraph,listItem,listItem,listItem,quote,code,pageBreak',
  )
  // The list flattens back to the levels it came from, not to three siblings: the
  // nesting the tool draws IS the model's level.
  check('the round trip keeps the list levels', roundTrip.blocks.slice(2, 5).map((block) => block.level ?? null).join(','), '0,1,0')
  check('the round trip keeps the heading level', roundTrip.blocks[0].level, 2)
  check('the round trip keeps the code verbatim', roundTrip.blocks[6].runs.map((run) => run.text).join(''), 'const x = 1')
  check('the round trip keeps the words', roundTrip.blocks[1].runs.map((run) => run.text).join(''), 'plain busc')
  check('a page break is reported, not silently drawn', roundTrip.losses.some((entry) => entry.kind === 'page break'), true)
  check('a model with no page break reports no loss', io.fromEditorData(io.toEditorData({ blocks: [{ type: 'paragraph', runs: [{ text: 'x', marks: [] }] }] })).losses.length, 0)
  // A block type no vendored tool has: kept as a paragraph WITH its text and reported.
  const unknownRound = io.fromEditorData({ blocks: [{ id: 'a', type: 'table', data: { text: 'cells' } }] })
  check('an unknown block becomes a paragraph', unknownRound.blocks[0].type, 'paragraph')
  check('an unknown block keeps its text', unknownRound.blocks[0].runs.map((run) => run.text).join(''), 'cells')
  check('an unknown block is reported', unknownRound.losses.some((entry) => entry.kind === 'block type the editor does not have'), true)
  check('an empty editor data is still one empty paragraph', io.fromEditorData({ blocks: [] }).blocks.length, 0)

  // The HTML reader/writer the pack's own tools use: the marks survive a round
  // trip through the attribute, the browser's own `<b>`/`<em>` are read too, an
  // unknown element is transparent, and a stray `<` stays text.
  const markRuns = [{ text: 'a', marks: ['b'] }, { text: 'b', marks: ['u'] }, { text: 'c', marks: ['s'] }, { text: 'd', marks: ['code'] }, { text: 'e', marks: ['i'] }]
  check(
    'a mark round trips through markHtml',
    JSON.stringify(io.runsFromHtmlString(io.markHtml(markRuns))),
    JSON.stringify(markRuns),
  )
  check('markHtml stamps the mark attribute', io.markHtml([{ text: 'x', marks: ['u'] }]), '<span data-mark="u">x</span>')
  check('markHtml keeps a font on a style', io.markHtml([{ text: 'x', marks: [], font: 'Georgia', size: 14 }]), "<span style=\"font-family:'Georgia';font-size:14pt\">x</span>")
  check('markHtml turns a soft break into a br', io.markHtml([{ text: 'a\nb', marks: [] }]), 'a<br>b')
  check('markHtml gives an empty block a break', io.markHtml([]), '<br>')
  check('markHtml escapes the text', io.markHtml([{ text: '<b> & </b>', marks: [] }]), '&lt;b&gt; &amp; &lt;/b&gt;')
  check('the reader reads the browser\u2019s own bold', JSON.stringify(io.runsFromHtmlString('<strong>x</strong>')), JSON.stringify([{ text: 'x', marks: ['b'] }]))
  check('the reader reads an em as italic', JSON.stringify(io.runsFromHtmlString('<em>x</em>')), JSON.stringify([{ text: 'x', marks: ['i'] }]))
  check('the reader is transparent for an unknown element', JSON.stringify(io.runsFromHtmlString('<div><span>x</span></div>')), JSON.stringify([{ text: 'x', marks: [] }]))
  check('the reader turns a br into a soft break', JSON.stringify(io.runsFromHtmlString('a<br>b')), JSON.stringify([{ text: 'a\nb', marks: [] }]))
  check('the reader keeps a stray < as text', JSON.stringify(io.runsFromHtmlString('a < b')), JSON.stringify([{ text: 'a < b', marks: [] }]))
  check('the reader never returns zero runs', JSON.stringify(io.runsFromHtmlString('')), JSON.stringify([{ text: '', marks: [] }]))
  check('the reader reads the family and size off a style', JSON.stringify(io.runsFromHtmlString('<span style="font-family:Georgia;font-size:14pt">x</span>')), JSON.stringify([{ text: 'x', marks: [], font: 'Georgia', size: 14 }]))
  // One element per run: a marked run before a plain one must NOT colour the plain
  // one, because the reader reads the attribute, not a wrapping scope.
  check(
    'the reader keeps a marked run from colouring its neighbour',
    JSON.stringify(io.runsFromHtmlString(io.markHtml([{ text: 'a', marks: ['b'] }, { text: 'b', marks: [] }]))),
    JSON.stringify([{ text: 'a', marks: ['b'] }, { text: 'b', marks: [] }]),
  )
  check('every model block has an Editor.js type', ['paragraph', 'header', 'list', 'quote', 'code', 'delimiter'].every((type) => io.EDITOR_KNOWN_TYPES.has(type)), true)
  // A menu CLOSES when its item is chosen: a `details` that stays open over the
  // page reads as a menu that did not work, and the New flow depends on it.
  {
    const menu = { open: true }
    io.closeMenus({ closest: () => menu })
    check('writing closes the menu a chosen item lives in', menu.open, false)
    io.closeMenus(null)
    io.closeMenus({})
    check('writing survives closing a menu that is not there', true, true)
    check('writing shows no dialog until one is asked for', markup.includes('data-writing-dialog'), false)
  }
  // THE FONT AND FILE CONTROLS, the headings toggle, the × that removes the
  // document being written on, and the ONE New button (a document is what this tab
  // makes, so there is no menu of file kinds left to choose from).
  for (const marker of [
    'data-writing-font',
    'dsw-fontFamilies',
    'data-writing-fontsize',
    'data-writing-docfont',
    'data-writing-docsize',
    'data-writing-new',
    'data-action="new"',
    'data-writing-delete',
    'data-action="headings"',
  ]) {
    check('writing shell carries ' + marker, markup.includes(marker), true)
  }
  check('the bar no longer offers a file-kind menu', markup.includes('data-new="xlsx"'), false)
  check('the bar no longer offers a workbook from New', markup.includes('data-new="docx"'), false)
  // EVERY heading level is reachable, not just one: a document whose only heading
  // was a Heading 2 could not be given a title.
  check(
    'the Document menu inserts every heading level',
    [1, 2, 3, 4, 5, 6].every((level) => markup.includes('data-writing-insert="heading-' + level + '"')),
    true,
  )
  check('the Document menu still inserts a quote and a code block', markup.includes('data-writing-insert="quote"') && markup.includes('data-writing-insert="code"'), true)
  // Export: one destination, the Desktop, for every format - there is no longer a
  // "into the conversation folder" row to pick by mistake.
  check('the Export menu writes to the Desktop', markup.includes('to the Desktop'), true)
  check('no export row offers the conversation folder', markup.includes('into the conversation folder'), false)
  // The document's own typography is what the page column wears, and the px/mm
  // arithmetic is the same one the page box uses.
  const flow = io.flowStyle({ font: 'Georgia', fontSize: 14 }, 601.7)
  check('writing sets the document font on the text column', flow.fontFamily, "'Georgia'")
  check('writing sets the document size on the text column', flow.fontSize, '14pt')
  check('writing falls back to 12pt when a document names no size', io.flowStyle({ font: '', fontSize: null }, 100).fontSize, '12pt')
  // THE HEADINGS NAVIGATOR, as a pane: it renders its own chrome and its own
  // empty state with no document open, which is the state a fresh page is in.
  const outlinePane = renderToStaticMarkup(h(io.OutlinePane, { sessionId: 'session-writing', ctx: writingCtx }))
  check('the headings pane renders', outlinePane.includes('data-writing-outline-pane'), true)
  check('the headings pane says what it shows', outlinePane.includes('data-writing-pane-title'), true)
  check('the headings pane with no document yet says so', outlinePane.includes('This document has no headings yet.'), true)
  const outlinePaneBare = renderToStaticMarkup(h(io.OutlinePane, { ctx: writingCtx }))
  check('the headings pane with no CONVERSATION asks for one', outlinePaneBare.includes('Open a document in the Writing tab'), true)
  // THE SHEET PANE, likewise: its bar, its tabs and its cell address exist before
  // any file is read, and no grid is drawn until there is a workbook.
  const sheetPane = renderToStaticMarkup(h(io.SheetView, { file: { sessionId: 'session-writing', path: 'books.xlsx' }, ctx: writingCtx }))
  check('the sheet pane renders', sheetPane.includes('data-dsh-sheet-view'), true)
  check('the sheet pane has its toolbar', sheetPane.includes('data-action="sheet-save"') && sheetPane.includes('data-action="sheet-proof"'), true)
  check('the sheet pane has sheet tabs', sheetPane.includes('data-sheet-tabs'), true)
  check('the sheet pane names the active cell', sheetPane.includes('>A1<'), true)
  check('the sheet pane draws no grid before a workbook is open', sheetPane.includes('data-sheet-grid'), false)
  check('the sheet pane says it is opening', sheetPane.includes('Opening'), true)
  // BOTH entry modes: the view ring (a conversation, no file) and a right-bar
  // pane (a file, and the session it names). One component serves both, so the
  // check drives both props.
  check(
    'the editor mounts for a FILE pane as well as a conversation view',
    renderToStaticMarkup(h(view.component, { file: { sessionId: 'session-writing', path: 'report.docx' }, ctx: writingCtx })).includes('data-dsh-writing-view'),
    true,
  )
  check(
    'the sheet pane with no file says so rather than loading forever',
    renderToStaticMarkup(h(io.SheetView, { sessionId: 'session-writing', ctx: writingCtx })).includes('No file to open.'),
    true,
  )
  // The grid's own arithmetic: A..Z, AA.., and the address a cell prints as.
  check('writing names columns past Z', io.columnName(0) + io.columnName(25) + io.columnName(26) + io.columnName(51) + io.columnName(52), 'AZAAAZBA')
  check('writing names the far column', io.columnName(io.SHEET_MAX_COLUMNS - 1), 'BZ')
  check('writing prints a cell address', io.cellAddress(0, 0) + ' ' + io.cellAddress(9, 27), 'A1 AB10')
  // What a person typed, as the model holds it: a number IS a number, an empty
  // cell is null and never '', and a formula keeps its text without the '='.
  check(
    'writing reads what was typed into a cell',
    JSON.stringify([io.parseCellInput(''), io.parseCellInput('42'), io.parseCellInput('=SUM(A1:A2)'), io.parseCellInput('TRUE'), io.parseCellInput('hello')]),
    JSON.stringify([null, 42, { value: '', formula: 'SUM(A1:A2)' }, true, 'hello']),
  )
  check('writing keeps leading zeros as text, not as a number', io.parseCellInput('007'), '007')
  check('writing shows a formula with its =', io.cellDisplay({ value: '', formula: 'A1*2' }), '=A1*2')
  check('writing shows a boolean the way a spreadsheet does', io.cellDisplay(true) + '/' + io.cellDisplay(false), 'TRUE/FALSE')
  check('writing pads a ragged grid', JSON.stringify(io.sheetGrid({ rows: [[1], [2, 3, 4]] })), JSON.stringify([[1, null, null], [2, 3, 4]]))
  check('writing never returns an empty grid', JSON.stringify(io.sheetGrid({ rows: [] })), JSON.stringify([[]]))

  // The run algebra.
  check(
    'writing reads a DOM-shaped tree into runs',
    JSON.stringify(io.runsFromNodes(['a', { tag: 'STRONG', children: ['b'] }, { tag: 'BR' }, { tag: 'EM', children: [{ tag: 'CODE', children: ['c'] }] }])),
    JSON.stringify([{ text: 'a', marks: [] }, { text: 'b', marks: ['b'] }, { text: '\n', marks: [] }, { text: 'c', marks: ['i', 'code'] }]),
  )
  check('writing merges neighbouring runs with the same marks', JSON.stringify(io.runsFromNodes(['a', { tag: 'SPAN', children: ['b'] }])), JSON.stringify([{ text: 'ab', marks: [] }]))
  check('writing never returns zero runs', JSON.stringify(io.runsFromNodes([])), JSON.stringify([{ text: '', marks: [] }]))
  // A family and a size ride on the run, and an inner one REPLACES an outer one
  // (what an inline style means) while marks ACCUMULATE.
  check(
    'writing reads a family and a size off the inline style',
    JSON.stringify(io.runsFromNodes([{ tag: 'SPAN', font: 'Georgia', size: 14, children: ['hi'] }])),
    JSON.stringify([{ text: 'hi', marks: [], font: 'Georgia', size: 14 }]),
  )
  check(
    'writing lets an inner family replace an outer one',
    JSON.stringify(io.runsFromNodes([{ tag: 'SPAN', font: 'Georgia', children: [{ tag: 'SPAN', font: 'Arial', children: ['x'] }] }])),
    JSON.stringify([{ text: 'x', marks: [], font: 'Arial' }]),
  )
  check('writing merges only runs whose font and size agree', JSON.stringify(io.runsFromNodes([{ tag: 'SPAN', font: 'Arial', children: ['a'] }, { tag: 'SPAN', font: 'Georgia', children: ['b'] }])), JSON.stringify([{ text: 'a', marks: [], font: 'Arial' }, { text: 'b', marks: [], font: 'Georgia' }]))
  check('writing reads a pt size as it was set', io.parseFontSize('14pt'), 14)
  check('writing converts a px size to points', io.parseFontSize('16px'), 12)
  check('writing refuses a size it cannot resolve', String(io.parseFontSize('1.2em')), 'null')
  check('writing strips the quotes off a family name', io.unquoteFamily('"Times New Roman", serif'), 'Times New Roman')
  check('writing wraps a family and a size in one span', io.runHtml({ text: 'x', marks: [], font: 'Georgia', size: 14 }), "<span style=\"font-family:'Georgia';font-size:14pt\">x</span>")
  // Offset 3 is inside the SECOND run ('cd'), which carries bold and no font of
  // its own - so the toolbar would show the document's family, not the first
  // run's Arial.
  check('writing reads the properties at a caret', JSON.stringify(io.propertiesAt([{ text: 'ab', marks: [], font: 'Arial', size: 9 }, { text: 'cd', marks: ['b'] }], 3)), JSON.stringify({ marks: ['b'], font: '', size: null }))
  check('writing reads a run\'s own family at the caret', JSON.stringify(io.propertiesAt([{ text: 'ab', marks: [], font: 'Arial', size: 9 }], 1)), JSON.stringify({ marks: [], font: 'Arial', size: 9 }))
  // Setting a family over a range splits the runs and CLEARING it puts the run
  // back on the document's default - which is what an empty value means.
  check(
    'writing sets a family over part of a block',
    JSON.stringify(io.applyAttributeToRuns([{ text: 'abcdef', marks: [] }], 2, 4, 'font', 'Georgia')),
    JSON.stringify([{ text: 'ab', marks: [] }, { text: 'cd', marks: [], font: 'Georgia' }, { text: 'ef', marks: [] }]),
  )
  check(
    'writing clears a family back to the document default',
    JSON.stringify(io.applyAttributeToRuns([{ text: 'ab', marks: [] }, { text: 'cd', marks: [], font: 'Georgia' }, { text: 'ef', marks: [] }], 0, 6, 'font', '')),
    JSON.stringify([{ text: 'abcdef', marks: [] }]),
  )
  check(
    'writing sets a size over a range',
    JSON.stringify(io.applyAttributeToRuns([{ text: 'one two', marks: [] }], 4, 7, 'size', 18.5)),
    JSON.stringify([{ text: 'one ', marks: [] }, { text: 'two', marks: [], size: 18.5 }]),
  )
  const mixed = [{ text: 'plain ', marks: [] }, { text: 'bold', marks: ['b'] }, { text: ' tail', marks: [] }]
  check('writing measures a block in characters', io.runsLength(mixed), 15)
  check('writing reads the marks at a caret', io.marksAt(mixed, 7).join(','), 'b')
  check('writing reads no marks at the start', io.marksAt(mixed, 0).join(','), '')
  check('writing reads no marks at the end', io.marksAt(mixed, 15).join(','), '')
  // Ctrl+B over the whole of a half-marked selection BOLDS all of it rather than
  // flipping each half: the toggle is decided over the range, not per character.
  const boldedAll = io.applyMarkToRuns(mixed, 0, 15, 'b')
  check('writing bolds a whole half-bold selection', JSON.stringify(boldedAll), JSON.stringify([{ text: 'plain bold tail', marks: ['b'] }]))
  check('writing unbolds it again', JSON.stringify(io.applyMarkToRuns(boldedAll, 0, 15, 'b')), JSON.stringify([{ text: 'plain bold tail', marks: [] }]))
  check(
    'writing adds a mark to a range that does not all carry it',
    JSON.stringify(io.applyMarkToRuns(mixed, 6, 10, 'i')),
    JSON.stringify([{ text: 'plain ', marks: [] }, { text: 'bold', marks: ['b', 'i'] }, { text: ' tail', marks: [] }]),
  )
  // Toggling a mark OFF over the one run that carries it removes it, and the
  // three runs then merge - which is the observable difference between "the mark
  // is gone" and "the mark is gone but the runs still remember it".
  check(
    'writing removes a mark when the whole range carries it',
    JSON.stringify(io.applyMarkToRuns(mixed, 6, 10, 'b')),
    JSON.stringify([{ text: 'plain bold tail', marks: [] }]),
  )
  check(
    'writing splits a run to mark half of it',
    JSON.stringify(io.applyMarkToRuns([{ text: 'abcdef', marks: [] }], 2, 4, 'i')),
    JSON.stringify([{ text: 'ab', marks: [] }, { text: 'cd', marks: ['i'] }, { text: 'ef', marks: [] }]),
  )
  const [left, right] = io.splitRunsAt(mixed, 8)
  check('writing splits a paragraph at the caret', JSON.stringify([left, right]), JSON.stringify([[{ text: 'plain ', marks: [] }, { text: 'bo', marks: ['b'] }], [{ text: 'ld', marks: ['b'] }, { text: ' tail', marks: [] }]]))
  const [markLeft, markRight] = io.splitRunsAt(mixed, 7)
  check('writing keeps the marks on both sides of a split', JSON.stringify([markLeft, markRight]), JSON.stringify([[{ text: 'plain ', marks: [] }, { text: 'b', marks: ['b'] }], [{ text: 'old', marks: ['b'] }, { text: ' tail', marks: [] }]]))
  check('writing joins two blocks back together', JSON.stringify(io.mergeRuns([{ text: 'one', marks: ['b'] }], [{ text: 'two', marks: ['b'] }])), JSON.stringify([{ text: 'onetwo', marks: ['b'] }]))
  check('writing escapes text into HTML', io.blockHtmlString({ type: 'paragraph', runs: [{ text: '<b> & </b>', marks: [] }] }), '&lt;b&gt; &amp; &lt;/b&gt;')
  check('writing turns a soft break into a br', io.blockHtmlString({ type: 'paragraph', runs: [{ text: 'a\nb', marks: [] }] }), 'a<br>b')
  // Marks nest in the order runHtml applies them: the LAST one wrapped is the
  // outermost element, which is why code (the innermost) closes first.
  check('writing wraps marks in elements', io.blockHtmlString({ type: 'paragraph', runs: [{ text: 'x', marks: ['b', 'i', 'u', 's', 'code'] }] }), '<s><u><em><strong><code>x</code></strong></em></u></s>')
  check('writing gives an empty block a break to click into', io.blockHtmlString({ type: 'paragraph', runs: [{ text: '', marks: [] }] }), '<br>')
  check('writing labels a block', io.describeBlock({ type: 'heading', level: 2 }), 'Heading 2')
  check('writing retypes a paragraph into a list', JSON.stringify(io.retypeBlock({ type: 'paragraph', runs: [{ text: 'x', marks: [] }] }, 'listItem', 0, true)), JSON.stringify({ type: 'listItem', runs: [{ text: 'x', marks: [] }], ordered: true, level: 0 }))
  check('writing drops list fields when it retypes back', JSON.stringify(io.retypeBlock({ type: 'listItem', ordered: true, level: 2, runs: [{ text: 'x', marks: [] }] }, 'paragraph', null, null)), JSON.stringify({ type: 'paragraph', runs: [{ text: 'x', marks: [] }] }))
  check('writing keeps alignment across a retype', io.retypeBlock({ type: 'paragraph', align: 'center', runs: [] }, 'heading', 1, null).align, 'center')
  check('writing never retypes a block into a page break', io.retypeBlock({ type: 'paragraph', runs: [] }, 'pageBreak', null, null).type, 'paragraph')
  check('writing carries a heading level onto the element', io.blockAttributes({ type: 'heading', level: 3 }, {})['data-level'], '3')
  check('writing carries the list kind onto the element', JSON.stringify([io.blockAttributes({ type: 'listItem', ordered: true, level: 1 }, {})['data-ordered'], io.blockAttributes({ type: 'listItem', ordered: true, level: 1 }, {})['data-level']]), JSON.stringify(['true', '1']))
  check('writing carries alignment onto the element', io.blockAttributes({ type: 'paragraph', align: 'justify' }, {})['data-align'], 'justify')
  check('writing counts the words of a document', io.wordCountOf({ blocks: [{ type: 'paragraph', runs: [{ text: 'one two', marks: [] }] }, { type: 'pageBreak', runs: [{ text: '', marks: [] }] }, { type: 'heading', level: 1, runs: [{ text: 'three', marks: [] }] }] }), 3)
  // The fallback paginator is what runs when lib/page.js cannot be imported: it
  // is a degradation, and it must still put every block somewhere.
  const degraded = io.fallbackPaginate({ blocks: [{ type: 'paragraph', runs: [] }, { type: 'pageBreak', runs: [] }, { type: 'paragraph', runs: [] }] })
  check('writing degrades to one page when the breaker is missing', degraded.pages.length, 1)
  check('writing degrades without losing a block', degraded.pages[0].blocks.length, 2)
  check('writing says so when it degraded', degraded.degraded, true)

  // The client and the host must agree on every route: two hard-coded lists that
  // a rename would otherwise silently desynchronise (this is the same agreement
  // check dsh-canvas and dsh-editor carry). Both halves spell a route as
  // `API_ROOT + '<suffix>'`, so the suffixes are what is compared.
  const writingClientSource = readFileSync(path.join(repo, 'packages/dsh-writing/lib/client.js'), 'utf8')
  const writingHostSource = readFileSync(path.join(repo, 'packages/dsh-writing/lib/index.js'), 'utf8')
  const routeSuffixes = (source) => [...source.matchAll(/const [A-Z_]+_ROUTE = API_ROOT \+ '([^']+)'/g)].map((match) => match[1])
  const hostRoutes = routeSuffixes(writingHostSource)
  const clientRoutes = routeSuffixes(writingClientSource)
  check('writing: the host registers routes at all', hostRoutes.length > 5, true)
  check('writing: the client names no route the host does not register', clientRoutes.filter((route) => !hostRoutes.includes(route)).join(','), '')
  // The client names every host route EXCEPT one, and that one is named: the page
  // breaker. The host keeps serving it (the splitter is a public part of this
  // package and check-writing-node drives it), but the tab edits in Editor.js now,
  // so a route a client no longer reads is exactly the kind of thing that goes
  // stale unnoticed.
  check(
    'writing: the client names every host route but the page breaker',
    hostRoutes.filter((route) => !clientRoutes.includes(route) && route !== '/page.js').join(','),
    '',
  )
  check('writing: the host still serves the page breaker', hostRoutes.includes('/page.js'), true)
  check('writing: the client does not ask for the page breaker', clientRoutes.includes('/page.js'), false)
}

// The pack's class namespace rule, last so it sees every bundle above.
{
  const bundlesDir = path.join(repo, 'packages')
  const owners = new Map()
  for (const name of readdirSync(bundlesDir)) {
    const file = path.join(bundlesDir, name, 'lib', 'client.js')
    if (!existsSync(file)) continue
    const source = readFileSync(file, 'utf8')
    for (const [, cls] of source.matchAll(/\.([a-z][a-z0-9]*-[A-Za-z0-9_-]+)\s*[,{:[>\s]/g)) {
      if (!owners.has(cls)) owners.set(cls, new Set())
      owners.get(cls).add(name)
    }
  }
  const shared = [...owners.entries()]
    .filter(([, names]) => names.size > 1)
    .map(([cls, names]) => cls + ' (' + [...names].join(', ') + ')')
  check('no two bundles define the same class', shared.length === 0 ? 'ok' : shared.join(' | '), 'ok')
}

console.log('')
console.log(failures === 0 ? 'all client-bundle checks passed' : failures + ' check(s) FAILED')
process.exitCode = failures === 0 ? 0 : 1
