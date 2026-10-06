// check-sc-wiring.mjs — drive the package's OWN contract, without the harness.
//
// Why this exists: the vncode pack has four tracked checks that judge a bundle —
// `check-node-routes.mjs` (route registrations), `check-client-bundles.mjs` (the
// browser bundle), `check-dist-layout.mjs` (it ships) and `check-node-routes.mjs`
// again for the manifest. None of them runs in THIS repository, and none of them
// can tell you *here* whether the row mounts, the ten tools declare the output
// contract the registry enforces, or the client bundle is a classic script a
// loader can actually instantiate.
//
// So this drives the same things against stub contexts, from this package alone:
//
//   1. `package.json` — `dsh.bundle.patch`, `dsh.client` with `platform: "web"`,
//      an `exports["./client"]`, and a patch file that inserts this row;
//   2. the browser bundle — run as a CLASSIC SCRIPT under `new Function`, its
//      entry registered with `window.__ModuleLoader__.load`, its factory CALLED
//      (the stylesheet and the plugin face live inside the factory, not in the
//      entry), its `require`s limited to what a client bundle may ask for, and
//      its two seats registered;
//   3. `lib/index.js` — `apply(ctx)` against a stub cordis context with the
//      injected services, asserting ten tools, three routes and five skills, and
//      that every tool declares what the tool registry requires.
//
// Run:  node scripts/checks/check-sc-wiring.mjs

const { readFileSync } = await import('node:fs')
const path = (await import('node:path')).default
const { fileURLToPath, pathToFileURL } = await import('node:url')

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const plugin = repo

let failures = 0
function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(58) + (ok ? '' : ' got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected)))
  return ok
}

/** What a client bundle is allowed to require of the platform. */
const ALLOWED_REQUIRES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom/client',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/cordis',
])

// ---------------------------------------------------------------- 1. the manifest
const pkg = JSON.parse(readFileSync(path.join(plugin, 'package.json'), 'utf8'))
check('package name is the row name', pkg.name, 'dsh-supercollider')
check('declares dsh.bundle.patch', pkg.dsh?.bundle?.patch, './cordis.patch.yml')
check('declares dsh.client for the web platform', pkg.dsh?.client?.platform, 'web')
check('exports a "./client" bundle', pkg.exports?.['./client'], './lib/client.js')
check('exports the engine on its own', pkg.exports?.['./engine'] !== undefined, true)
check('client inject names the right bar', (pkg.dsh?.client?.inject ?? []).includes('dsh-rightbar'), true)
const patchSource = readFileSync(path.join(plugin, 'cordis.patch.yml'), 'utf8')
check('the patch file inserts the row', patchSource.includes('id: supercollider'), true)
// It may mention the word in prose (the file explains why there is none), so the
// KEY is what is checked, not the word.
check('the patch disables no core row', /^\s*disabled:\s*true/m.test(patchSource), false)
check('the patch has exactly one insert', (patchSource.match(/^\s*- insert:/gm) ?? []).length, 1)
check('the package ships no dependencies', pkg.dependencies === undefined, true)

// ---------------------------------------------------------------- 2. the browser bundle
const clientSource = readFileSync(path.join(plugin, 'lib', 'client.js'), 'utf8')
let entry = null
let styleTag = null
const documentStub = {
  querySelector: () => null,
  createElement: () => ({
    dataset: {},
    set textContent(value) {
      this._css = value
    },
    get textContent() {
      return this._css
    },
  }),
  head: {
    appendChild: (tag) => {
      styleTag = tag
    },
  },
  visibilityState: 'visible',
}
const windowStub = { __ModuleLoader__: { load: (value) => { entry = value } }, localStorage: { getItem: () => null, setItem: () => {} } }

// A classic script: no ESM syntax, and `window`/`document` are the only globals
// it may rely on being there. A throw here is a bundle the loader cannot run.
try {
  new Function('window', 'document', 'console', clientSource)(windowStub, documentStub, console)
  check('the bundle runs as a classic script', true, true)
} catch (err) {
  check('the bundle runs as a classic script', false, true)
  console.log('     ' + (err && err.message))
}
check('it registers with the module loader', entry !== null, true)
check('its id is the package name', entry?.id, pkg.name)
check('it registers a factory', typeof entry?.factory, 'function')

const required = [...clientSource.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
check('it requires only what a client bundle may', required.every((name) => ALLOWED_REQUIRES.has(name)), true)
console.log('     requires: ' + (required.length > 0 ? required.join(', ') : '(nothing)'))

// The loader INSTALLS the entry and then calls the factory; the module-scope
// body — the stylesheet and the plugin face — lives inside the factory call.
const react = { useState: (value) => [typeof value === 'function' ? value() : value, () => {}], useEffect: () => {}, useRef: () => ({ current: null }) }
const clientModule = entry.factory((name) => {
  if (name === 'react') return react
  if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: {} }
  throw new Error('a client bundle required something it may not: ' + name)
})
check('the factory returns a module', typeof clientModule === 'object' && clientModule !== null, true)
check('the client plugin is named', clientModule.name, pkg.name)
check('the client plugin injects the tab registry', JSON.stringify(clientModule.inject), JSON.stringify(['slots', 'sidebarRightTabs']))
check('the client plugin exposes apply', typeof clientModule.apply, 'function')
check('a PLUGIN_VERSION matches package.json', clientModule.PLUGIN_VERSION, pkg.version)
check('it injects exactly one stylesheet', styleTag !== null, true)
check('the stylesheet is tagged for the harness check', styleTag?.dataset?.pluginCss, 'dsh-supercollider/console.css')

// The class prefix has to be this package's OWN. The pack's
// `check-client-bundles.mjs` fails any class two bundles define, because the
// LAST stylesheet wins every equal-specificity tie, so a collision silently
// redresses another package's UI. It caught exactly this: `.dsc-` is
// dsh-cmdbar's prefix and the console was written with it. This check finds the
// same thing in milliseconds, and in THIS repository rather than the pack's.
const stylesheet = styleTag?._css ?? ''
const prefixes = [...new Set([...stylesheet.matchAll(/\.([a-z]{2,6}-)[a-zA-Z]/g)].map((match) => match[1]))]
check('the stylesheet defines exactly one prefix', prefixes.length, 1)
check('the prefix is this package\'s own ("dsu-")', prefixes[0], 'dsu-')
console.log('     classes: ' + [...new Set([...stylesheet.matchAll(/\.([a-z]{2,6}-[a-zA-Z]+)/g)].map((m) => m[1]))].sort().join(', '))

// Its own apply, against a stub bar: one tab type and two seats.
const clientRegistrations = []
clientModule.apply({
  effect: (fn) => {
    fn()
    return () => {}
  },
  sidebarRightTabs: {
    register: (value) => {
      clientRegistrations.push({ kind: 'type', value })
      return () => {}
    },
  },
  slots: {
    inject: (_slot, fn) => {
      fn()
      return () => {}
    },
    register: (seat, component) => {
      clientRegistrations.push({ kind: 'seat', slot: seat.name, key: seat.key, component })
      return () => {}
    },
  },
})
check('it registers one tab type and two seats', clientRegistrations.length, 3)
check(
  'the seats are the tab body and the tab title',
  JSON.stringify(clientRegistrations.filter((r) => r.kind === 'seat').map((r) => r.slot)),
  JSON.stringify(['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']),
)

const definition = clientModule.__internals.definition()
check('the tab type id is the package name', definition.id, pkg.name)
check('the tab claims .scd', definition.patterns.includes('.scd'), true)
check('the tab claims .sc', definition.patterns.includes('.sc'), true)
check('the tab ranks in the extension band', definition.priority, 'extension')
check('the tab opens a .scd', definition.canOpen('pieces/drone.scd'), true)
check('the tab leaves a .txt alone', definition.canOpen('notes.txt'), false)

// ---------------------------------------------------------------- 3. the row, under a stub context
const index = await import(pathToFileURL(path.join(plugin, 'lib', 'index.js')).href)
check('the row is named', index.name, pkg.name)
check('the row injects connection and tools', JSON.stringify(index.inject), JSON.stringify(['connection', 'tools']))
check('the row PLUGIN_VERSION matches package.json', index.PLUGIN_VERSION, pkg.version)

const registered = { tools: [], routes: [], skills: [], effects: 0 }
const connection = {
  fetch: {
    register: (route) => {
      registered.routes.push({ path: route.path, methods: route.methods })
      return () => {}
    },
  },
}
// `inject: ['connection', 'tools']` makes cordis expose those as `ctx.connection`
// / `ctx.tools`; the skill registry is resolved lazily through `ctx.get`. Both
// access paths are provided because the row uses both.
const ctx = {
  connection,
  tools: {
    register: (tool) => {
      registered.tools.push(tool)
      return () => {}
    },
  },
  effect: (fn) => {
    registered.effects += 1
    const off = fn()
    return typeof off === 'function' ? off : () => {}
  },
  logger: { info() {}, warn() {}, debug() {} },
  get(name) {
    if (name === 'connection') return connection
    if (name === 'skills') {
      return {
        register: (skill) => {
          registered.skills.push(skill)
          return () => {}
        },
      }
    }
    return undefined
  },
}

index.apply(ctx)

check('eleven tools registered', registered.tools.length, 11)
check(
  'the tool names are the documented eleven',
  JSON.stringify(registered.tools.map((tool) => tool.name)),
  JSON.stringify(['sc_status', 'sc_help', 'sc_check', 'sc_exec', 'sc_play', 'sc_capture', 'sc_project', 'sc_load', 'sc_synthdef', 'sc_nodes', 'sc_server']),
)
check('three routes registered', registered.routes.length, 3)
check(
  'the routes are the three the console reads',
  JSON.stringify(registered.routes.map((route) => route.path)),
  JSON.stringify(['/api/dsh-supercollider/state', '/api/dsh-supercollider/console', '/api/dsh-supercollider/eval']),
)
check('every route is GET/HEAD/POST only', registered.routes.every((route) => route.methods.every((m) => ['GET', 'HEAD', 'POST'].includes(m))), true)
check('five skills registered', registered.skills.length, 5)
check('every skill carries a source string', registered.skills.every((skill) => typeof skill.source === 'string'), true)
check('every skill carries a file path', registered.skills.every((skill) => typeof skill.path === 'string'), true)
check('every skill carries content', registered.skills.every((skill) => typeof skill.content === 'string' && skill.content.length > 2000), true)
check('every skill carries a description', registered.skills.every((skill) => typeof skill.description === 'string' && skill.description.length > 40), true)

// The tool registry validates a returned value against `output.schema` and
// rejects a lossless-JSON violation. A declaration that cannot be satisfied is
// a tool that fails at the first call, so the shapes are checked here.
const problems = []
for (const tool of registered.tools) {
  if (typeof tool.execute !== 'function') problems.push(tool.name + ': no execute')
  if (typeof tool.description !== 'string' || tool.description.length < 80) problems.push(tool.name + ': thin description')
  const output = tool.output
  if (output === undefined || typeof output.render !== 'function') problems.push(tool.name + ': no output.render')
  if (output === undefined || output.schema === undefined) problems.push(tool.name + ': no output.schema')
  if (output !== undefined && typeof output.presentationMeta !== 'function') problems.push(tool.name + ': no presentationMeta')
  const parameters = tool.parameters
  if (parameters === undefined || parameters.type !== 'object') problems.push(tool.name + ': parameters is not an object schema')
  if (parameters?.additionalProperties !== false) problems.push(tool.name + ': parameters must refuse extra properties')
  if (typeof tool.presentCall !== 'function') problems.push(tool.name + ': no presentCall')
  if (typeof tool.presentResult !== 'function') problems.push(tool.name + ': no presentResult')
}
check('every tool satisfies the tool contract', JSON.stringify(problems), JSON.stringify([]))
if (problems.length > 0) for (const problem of problems) console.log('     ' + problem)

// The example library is reached THROUGH a tool, so the action has to be
// declared or the catalogue is unreachable however good the files are.
{
  const project = registered.tools.find((tool) => tool.name === 'sc_project')
  const actions = project?.parameters?.properties?.action?.enum ?? []
  check('sc_project offers the examples action', actions.includes('examples'), true)
  check('sc_project still offers its file actions', ['list', 'read', 'write', 'send'].every((entry) => actions.includes(entry)), true)
  check('the examples action is documented', /examples/.test(String(project?.description ?? '')), true)
}

// ---------------------------------------------------------------- done
console.log('')
console.log('dsh-supercollider wiring: ' + (failures === 0 ? 'ok' : failures + ' FAILURE(S)'))
process.exitCode = failures === 0 ? 0 : 1
