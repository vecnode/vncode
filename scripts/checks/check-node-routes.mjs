// check-node-routes.mjs - drive the pack's host-side route handlers directly,
// with real Requests and a real temp workspace.
//
// Why this exists: the two Node halves register their handlers through
// `connection.fetch.register`, so importing the module and capturing that
// handler exercises the shipped code path (path resolution, containment,
// optimistic concurrency, create-only semantics, wire validation) without a
// running harness.
//
// Run:  node scripts/checks/check-node-routes.mjs
export {} // (kept import-free: this file is ESM for the dynamic import below)

const { promises: fsp } = await import('node:fs')
const { existsSync, readdirSync, readFileSync } = await import('node:fs')
const os = await import('node:os')
const path = (await import('node:path')).default
const { pathToFileURL, fileURLToPath } = await import('node:url')
const { spawnSync } = await import('node:child_process')

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
let failures = 0
function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(34) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}

/**
 * The subset of JSON Schema the tool registry enforces, applied to a returned
 * value.
 *
 * The diagrams below drive `execute()` directly - the same seam the agent loop
 * uses - so NOTHING else here would notice a value that contradicts the schema
 * the model was handed. That gap shipped two bugs: `verification.reported: null`
 * against `type: "integer"` made every fresh write fail at the registry with
 * "must be an integer", and `error: undefined` failed the registry's
 * lossless-JSON rule. A key that is only sometimes meaningful must be ABSENT,
 * and this is what says so.
 *
 * @param schema - the tool's declared `output.schema`.
 * @param value - the value `execute()` returned.
 * @param label - the path shown in a failure.
 * @returns an array of problems (empty when the value conforms).
 */
function schemaErrors(schema, value, label = 'value') {
  const problems = []
  if (!schema || typeof schema !== 'object') return problems
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  if (schema.type) {
    const wanted = Array.isArray(schema.type) ? schema.type : [schema.type]
    const matches = wanted.some((one) => {
      if (one === 'integer') return Number.isInteger(value)
      if (one === 'number') return typeof value === 'number'
      if (one === 'string') return typeof value === 'string'
      if (one === 'boolean') return typeof value === 'boolean'
      if (one === 'array') return Array.isArray(value)
      if (one === 'object') return actual === 'object'
      if (one === 'null') return value === null
      return true
    })
    if (!matches) problems.push(label + ' must be ' + wanted.join('|') + ' (got ' + actual + ')')
  }
  if (schema.enum && !schema.enum.includes(value)) problems.push(label + ' is not one of ' + schema.enum.join(','))
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => problems.push(...schemaErrors(schema.items, item, label + '[' + index + ']')))
  }
  if (value !== null && actual === 'object' && schema.properties) {
    for (const key of Object.keys(schema.properties)) {
      if (value[key] === undefined) continue
      problems.push(...schemaErrors(schema.properties[key], value[key], label + '.' + key))
    }
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) problems.push(label + '.' + key + ' is required')
    }
  }
  return problems
}

/** The value must also survive a JSON round trip with every key intact. */
function losslessErrors(value, label = 'value') {
  if (value === null || typeof value !== 'object') return []
  const keys = Object.keys(value)
  const round = JSON.parse(JSON.stringify(value))
  const problems = []
  for (const key of keys) {
    if (!Object.hasOwn(round, key)) problems.push(label + '.' + key + ' is dropped by JSON.stringify (undefined)')
    else problems.push(...losslessErrors(value[key], label + '.' + key))
  }
  return problems
}

/** Register one row against a stub context and hand back its route handler. */
async function capture(modulePath, routePath, ctx) {
  const module = await import(pathToFileURL(modulePath).href)
  let handler = null
  const context = {
    ...ctx,
    effect: (fn) => fn(),
    logger: { debug() {}, warn() {} },
    get(name) {
      if (name === 'connection') {
        return {
          fetch: {
            register(route) {
              if (route.path === routePath) handler = route.fetch
              return () => {}
            },
          },
        }
      }
      return ctx.get ? ctx.get(name) : undefined
    },
  }
  module.apply(context)
  if (typeof handler !== 'function') throw new Error('route not registered: ' + routePath)
  return handler
}

// ------------------------------------------------------------- dsh-editor
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-editor-check-'))
const sessionId = 'session-check'
const fileHandler = await capture(path.join(repo, 'packages/dsh-editor/lib/index.js'), '/api/dsh-editor/file', {
  get: (name) => (name === 'sessions' ? { get: (id) => (id === sessionId ? { header: { cwd: root } } : undefined) } : undefined),
})
const put = (body) =>
  fileHandler(
    new Request('http://x/api/dsh-editor/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
const get = (query) => fileHandler(new Request('http://x/api/dsh-editor/file?' + query, { method: 'GET' }))
const code = async (response) => {
  const payload = await response.json().catch(() => null)
  return payload && payload.error ? payload.error.code : payload && payload.ok ? 'ok' : 'http ' + response.status
}

check('create needs an existing folder', await code(await put({ session: sessionId, path: 'notes/a.md', text: '# a\n', create: true })), 'NO_FOLDER')
await fsp.mkdir(path.join(root, 'notes'))
check('create', await code(await put({ session: sessionId, path: 'notes/a.md', text: '# a\n', create: true })), 'ok')
check('created on disk', await fsp.readFile(path.join(root, 'notes', 'a.md'), 'utf8'), '# a\n')
check('create never overwrites', await code(await put({ session: sessionId, path: 'notes/a.md', text: 'x', create: true })), 'EXISTS')
for (const bad of ['../out.txt', 'a/../../b.txt', '/abs.txt', 'C:/abs.txt', 'notes/', '.', 'notes/..']) {
  check('rejects ' + JSON.stringify(bad), await code(await put({ session: sessionId, path: bad, text: 'x', create: true })), 'BAD_REQUEST')
}
check(
  'nothing escaped the workspace',
  await fsp
    .stat(path.join(root, '..', 'out.txt'))
    .then(() => 'exists')
    .catch(() => 'absent'),
  'absent',
)
check('read back', await fsp.readFile(path.join(root, 'notes', 'a.md'), 'utf8'), '# a\n')
const reader = await get('session=' + sessionId + '&path=notes/a.md')
check('GET route answers', reader.status, 200)
check('save of an unknown file', await code(await put({ session: sessionId, path: 'notes/b.md', text: 'x' })), 'NOT_FOUND')
const before = await fsp.stat(path.join(root, 'notes', 'a.md'))
check(
  'save in place',
  await code(await put({ session: sessionId, path: 'notes/a.md', text: '# a2\n', expected: { mtimeMs: before.mtimeMs, size: before.size } })),
  'ok',
)
check(
  'stale save is refused',
  await code(await put({ session: sessionId, path: 'notes/a.md', text: 'z', expected: { mtimeMs: before.mtimeMs, size: before.size } })),
  'CHANGED_ON_DISK',
)
check('unknown session', await code(await put({ session: 'nope', path: 'x.txt', text: 'x', create: true })), 'NO_WORKSPACE')
await fsp.rm(root, { recursive: true, force: true })

// The vendored engine route. Its artifact is GENERATED and regenerated in place
// at a stable URL, so it must never be served from a freshness window: alpha.11
// served it with `public, max-age=3600`, and a browser handed the engine it had
// cached an hour earlier to a client bundle that had just gained a `rust` mode -
// `StreamLanguage.define(undefined)` then killed the whole tab. Revalidation (a
// 304 against the content-hash ETag) is what keeps engine and bundle in step.
const vendorHandler = await capture(path.join(repo, 'packages/dsh-editor/lib/index.js'), '/api/dsh-editor/vendor', {})
const vendorResponse = await vendorHandler(new Request('http://x/api/dsh-editor/vendor', { method: 'GET' }))
const vendorEtag = vendorResponse.headers.get('etag')
const vendorBody = await vendorResponse.text()
check('vendor route answers', vendorResponse.status, 200)
check('vendor body is the committed engine', vendorBody.length, (await fsp.stat(path.join(repo, 'packages/dsh-editor/lib/vendor/cm6.min.js'))).size)
check('vendor must be revalidated, never trusted for a freshness window', vendorResponse.headers.get('cache-control'), 'no-cache')
check('vendor etag is a content hash', /^"[0-9a-f]{40}"$/.test(vendorEtag || ''), true)
check(
  'vendor revalidates to 304',
  (await vendorHandler(new Request('http://x/api/dsh-editor/vendor', { method: 'GET', headers: { 'if-none-match': vendorEtag } }))).status,
  304,
)
check('vendor answers HEAD without a body', (await vendorHandler(new Request('http://x/api/dsh-editor/vendor', { method: 'HEAD' }))).status, 200)
// The engine the route serves must be the one the client bundle asks for: the
// five stream modes languageExtensionFor names, wrapped exactly as it wraps them.
const vendorEngine = new Function(
  'window',
  'document',
  'console',
  vendorBody + '\nreturn DSHEditorCM',
)(undefined, undefined, console)
check(
  'vendor engine carries every stream mode the client names',
  ['shell', 'powerShell', 'batch', 'rust', 'toml'].every((name) => vendorEngine[name] && Boolean(vendorEngine.StreamLanguage.define(vendorEngine[name]))),
  true,
)

// -------------------------------------------------------- dsh-open-in-app
const openHandler = await capture(path.join(repo, 'packages/dsh-open-in-app/lib/index.js'), '/api/dsh-open-in-app/open', {})
const open = (body) =>
  openHandler(
    new Request('http://x/api/dsh-open-in-app/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
const openCode = async (response) => {
  const payload = await response.json().catch(() => null)
  return payload && payload.error ? payload.error.code : payload && payload.ok ? 'ok' : 'http ' + response.status
}
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-open-check-'))
check('only file managers are accepted', await code(await open({ app: 'vscode', path: dir })), 'BAD_REQUEST')
check('the path must be absolute', await code(await open({ app: 'explorer', path: 'relative/dir' })), 'BAD_REQUEST')
check('the directory must exist', await code(await open({ app: 'explorer', path: path.join(dir, 'nope') })), 'NOT_FOUND')
check('the body must be JSON', await code(await open('not json')), 'BAD_REQUEST')
// The happy path SPAWNS the real file browser (an Explorer/Finder window), so it
// is opt-in: DSH_CHECK_LAUNCH=1 node scripts/checks/check-node-routes.mjs
if (process.env.DSH_CHECK_LAUNCH === '1') {
  const launched = await open({ app: 'explorer', path: dir })
  check('a valid request launches', launched.status, 200)
  // Give the file browser a moment to open the folder before it disappears.
  await new Promise((resolve) => setTimeout(resolve, 1500))
} else {
  console.log('skip a valid request launches       (set DSH_CHECK_LAUNCH=1 to open a file browser)')
}
await fsp.rm(dir, { recursive: true, force: true })

// ------------------------------------------------------------- dsh-gittree
// The git routes are driven against a REAL scratch repository (init, commit,
// rename, untracked file, plus a workspace that is a subfolder of it), because
// the wire formats they parse - `status --porcelain=v2 -z` and
// `diff-tree --name-status -z` - are exactly the contract under test.
const hasGit = (() => {
  try {
    return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0
  } catch (err) {
    return false
  }
})()
if (!hasGit) {
  console.log('skip dsh-gittree routes             (git is not on PATH)')
} else {
  const gitRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-gittree-check-'))
  const gitModule = path.join(repo, 'packages/dsh-gittree/lib/index.js')
  const stateRoute = '/api/dsh-gittree/state'
  const historyRoute = '/api/dsh-gittree/history'
  const commitRoute = '/api/dsh-gittree/commit'
  const sessionFor = (cwd) => ({
    get: (name) => (name === 'sessions' ? { get: (id) => (id === 'session-git' ? { header: { cwd } } : undefined) } : undefined),
  })
  const stateHandler = await capture(gitModule, stateRoute, sessionFor(gitRoot))
  const historyHandler = await capture(gitModule, historyRoute, sessionFor(gitRoot))
  const commitHandler = await capture(gitModule, commitRoute, sessionFor(gitRoot))
  const ask = async (handler, route, query) => {
    const response = await handler(new Request('http://x' + route + (query === '' ? '' : '?' + query), { method: 'GET' }))
    return { status: response.status, payload: await response.json().catch(() => null) }
  }
  const outcome = async (handler, route, query) => {
    const answer = await ask(handler, route, query)
    return answer.payload && answer.payload.error ? answer.payload.error.code : answer.payload && answer.payload.ok ? 'ok' : 'http ' + answer.status
  }
  const git = (args) => {
    const result = spawnSync('git', ['-C', gitRoot, ...args], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' } })
    if (result.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + String(result.stderr || '').trim())
    return result.stdout
  }
  const session = 'session-git'
  check('gittree: not a repo yet', await outcome(stateHandler, stateRoute, 'session=' + session), 'NOT_A_REPO')
  check('gittree: unknown session', await outcome(stateHandler, stateRoute, 'session=nope'), 'NO_WORKSPACE')
  check('gittree: a session is required', await outcome(stateHandler, stateRoute, ''), 'BAD_REQUEST')
  git(['init', '-q', '.'])
  git(['config', 'user.email', 'check@example.invalid'])
  git(['config', 'user.name', 'check'])
  await fsp.writeFile(path.join(gitRoot, 'readme.md'), '# one\n')
  await fsp.mkdir(path.join(gitRoot, 'sub'))
  await fsp.writeFile(path.join(gitRoot, 'sub', 'inner.txt'), 'inner\n')
  git(['add', '-A'])
  git(['commit', '-qm', 'first commit'])
  await fsp.writeFile(path.join(gitRoot, 'sub', 'inner.txt'), 'inner changed\n')
  await fsp.writeFile(path.join(gitRoot, 'new file.txt'), 'untracked\n')
  const state = await ask(stateHandler, stateRoute, 'session=' + session)
  const entries = state.payload && Array.isArray(state.payload.entries) ? state.payload.entries : []
  const byPath = Object.fromEntries(entries.map((entry) => [entry.path, entry.status]))
  check('gittree: state answers', state.status, 200)
  check('gittree: names the branch', typeof state.payload.branch === 'string' && state.payload.branch.length > 0)
  check('gittree: names the head', typeof state.payload.head === 'string' && state.payload.head.length > 0)
  check('gittree: a clean tracked file has no status', byPath['readme.md'], '')
  check('gittree: a modified file is marked', (byPath['sub/inner.txt'] || '').indexOf('M') >= 0)
  check('gittree: an untracked file is marked', byPath['new file.txt'], '??')
  check('gittree: counts the changed files', state.payload.changed >= 2)
  // `brief=1` is the tab's own form: the facts the bar shows, and no file list.
  const brief = await ask(stateHandler, stateRoute, 'session=' + session + '&brief=1')
  check('gittree: brief state answers', brief.status, 200)
  check('gittree: brief names the commit', brief.payload.head, state.payload.head)
  check('gittree: brief counts the changes', brief.payload.changed, state.payload.changed)
  check('gittree: brief sends no file list', brief.payload.entries === undefined && brief.payload.total === undefined)
  const history = await ask(historyHandler, historyRoute, 'session=' + session + '&limit=5')
  const commits = history.payload && Array.isArray(history.payload.commits) ? history.payload.commits : []
  check('gittree: history answers', history.status, 200)
  check('gittree: one commit, with its subject', commits.length === 1 && commits[0].subject, 'first commit')
  const detail = await ask(commitHandler, commitRoute, 'session=' + session + '&sha=' + commits[0].sha)
  const files = detail.payload && Array.isArray(detail.payload.files) ? detail.payload.files : []
  check(
    'gittree: the root commit lists its files',
    files.map((file) => file.status + ':' + file.path).sort().join(','),
    'A:readme.md,A:sub/inner.txt',
  )
  // A commit id is never allowed to reach argv as an option.
  check('gittree: a commit needs a valid id', await outcome(commitHandler, commitRoute, 'session=' + session + '&sha=--all'), 'BAD_REQUEST')
  // A workspace that is a SUBFOLDER of the repository: the tree is scoped to it
  // and every path stays workspace-relative.
  const subHandler = await capture(gitModule, stateRoute, {
    get: (name) =>
      name === 'sessions'
        ? { get: (id) => (id === 'session-git' ? { header: { cwd: path.join(gitRoot, 'sub') } } : undefined) }
        : undefined,
  })
  const subState = await ask(subHandler, stateRoute, 'session=' + session)
  const subPaths = (subState.payload && Array.isArray(subState.payload.entries) ? subState.payload.entries : []).map((entry) => entry.path).sort().join(',')
  check('gittree: a subfolder workspace is scoped', subPaths, 'inner.txt')
  // A REAL BRANCH AND MERGE, because the History tab's rail draws its graph from
  // exactly these two log fields: `%P` (the parents - a merge has more than one,
  // and that is what puts a second lane on the rail) and `%D` (the ref
  // decorations - the branch HEAD points at, a tag, and `refs/pull/<n>/...` when
  // a repository fetched its pull requests).
  const trunk = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  git(['checkout', '-q', '-b', 'feature/pr-7'])
  await fsp.writeFile(path.join(gitRoot, 'feature.txt'), 'feature\n')
  git(['add', 'feature.txt'])
  git(['commit', '-qm', 'Add the feature (#7)'])
  git(['checkout', '-q', trunk])
  git(['merge', '--no-ff', '-q', '-m', 'Merge pull request #7 from check/feature/pr-7', 'feature/pr-7'])
  git(['tag', 'v1.0'])
  const merged = await ask(historyHandler, historyRoute, 'session=' + session + '&limit=10')
  const mergedCommits = merged.payload && Array.isArray(merged.payload.commits) ? merged.payload.commits : []
  const mergeCommit = mergedCommits[0]
  // NOT the last row: with every commit made inside the same second, git is free
  // to order the merge's two parents either way, so the root is found by what it
  // is rather than by where it landed.
  const rootCommit = mergedCommits.find((commit) => commit.subject === 'first commit')
  const mergeParents = mergeCommit && Array.isArray(mergeCommit.parents) ? mergeCommit.parents : []
  const mergeRefs = mergeCommit && Array.isArray(mergeCommit.refs) ? mergeCommit.refs : []
  const rootParents = rootCommit && Array.isArray(rootCommit.parents) ? rootCommit.parents : null
  const rootRefs = rootCommit && Array.isArray(rootCommit.refs) ? rootCommit.refs : null
  check('gittree: the log carries three commits', mergedCommits.length, 3)
  check('gittree: a merge names both its parents', mergeParents.length, 2)
  check('gittree: a merge is flagged as one', Boolean(mergeCommit && mergeCommit.merge), true)
  check('gittree: the first parent is the branch it merged into', mergeParents[0], rootCommit ? rootCommit.sha : null)
  check('gittree: a merge names the pull request in its subject', /^Merge pull request #7 /.test((mergeCommit && mergeCommit.subject) || ''), true)
  check('gittree: a merge carries the ref HEAD points at', mergeRefs.some((ref) => ref.indexOf('HEAD -> ') === 0), true)
  check('gittree: a tag is carried as a tag ref', mergeRefs.includes('tag: v1.0'), true)
  check('gittree: a root commit has no parents', rootParents !== null && rootParents.length === 0, true)
  check('gittree: a root commit is not a merge', Boolean(rootCommit && rootCommit.merge), false)
  check('gittree: a root commit carries no refs', rootRefs !== null && rootRefs.length === 0, true)
  await fsp.rm(gitRoot, { recursive: true, force: true })
}

// ------------------------------------------------------------ dsh-cmdbar
// The command bar's Node half is ONE read-only route. alpha.12 deleted the rest -
// the PTY host, the authenticated WebSocket upgrade, the vendored xterm assets
// and the /health probe - so this block drives the route it still owns AND
// asserts that the deleted half is really gone. A `webServer` service is handed
// over on purpose: "no upgrade was registered" is then an observation about this
// row rather than a capability the check withheld.
/** Every node_modules root a harness install can live in: the profile closure, then the npm caches. */
function harnessRoots() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const roots = [path.join(home, 'profiles', 'node_modules')]
  for (const base of [process.env.LOCALAPPDATA, process.env.APPDATA].filter(Boolean)) {
    const cache = path.join(base, 'npm-cache', '_npx')
    if (existsSync(cache)) for (const entry of readdirSync(cache)) roots.push(path.join(cache, entry, 'node_modules'))
  }
  const cache = path.join(os.homedir(), '.npm', '_npx')
  if (existsSync(cache)) for (const entry of readdirSync(cache)) roots.push(path.join(cache, entry, 'node_modules'))
  return roots
}

{
  const cmdbarPath = path.join(repo, 'packages/dsh-cmdbar/lib/index.js')
  const routeHandlers = new Map()
  let upgrades = 0
  const cmdbarModule = await import(pathToFileURL(cmdbarPath).href)
  // One live session double per conversation the activity route is driven with.
  // `snapshotEvents` is what the harness's own Session exposes (the whole
  // contiguous in-memory log), and the events are the durable shapes the client
  // fold reads: `tool/call`, `tool/result` and a HUMAN `user/message`.
  const actEvents = [
    { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 1001, data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'do it' }], source: { kind: 'user' } } },
    { type: 'user/message', seq: 3, time: 1002, data: { id: 'm2', role: 'user', content: [{ type: 'text', text: 'injected context' }], source: { kind: 'plugin', plugin: 'x' } } },
    { type: 'assistant/message', seq: 4, time: 1003, data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [], source: { kind: 'model' } }, stream: [] } },
    { type: 'tool/call', seq: 5, time: 1004, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls","description":"list"}' } },
    {
      type: 'tool/result',
      seq: 6,
      time: 1005,
      data: {
        turn: 1,
        step: 1,
        message: { id: 'r1', role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'a\nb\n[exit code: 0]' }] }] },
      },
    },
  ]
  const bigEvents = []
  for (let index = 0; index < 420; index += 1) {
    bigEvents.push({
      type: 'tool/call',
      seq: index + 1,
      time: 2000 + index,
      data: { turn: 1, step: 1, callId: 'b' + String(index), name: 'bash', arguments: '{"command":"echo ' + String(index) + '","description":"d"}' },
    })
  }
  const hugeEvents = [{ type: 'tool/result', seq: 1, time: 1, data: { turn: 1, step: 1, message: { id: 'r', role: 'user', source: { kind: 'tool', callId: 'huge' }, content: [{ type: 'tool-result', toolCallId: 'huge', content: [{ type: 'text', text: 'x'.repeat(600 * 1024) }] }] } } }]
  const liveSessions = {
    'session-cmd': { header: { cwd: '/tmp/dsh-cmdbar-check' }, snapshotEvents: () => actEvents },
    'session-big': { header: { cwd: '/tmp/dsh-cmdbar-check' }, snapshotEvents: () => bigEvents },
    'session-huge': { header: { cwd: '/tmp/dsh-cmdbar-check' }, snapshotEvents: () => hugeEvents },
    'session-broken': {
      header: { cwd: '/tmp/dsh-cmdbar-check' },
      snapshotEvents: () => {
        throw new Error('unreadable')
      },
    },
  }
  const sessions = { get: (id) => liveSessions[id] }
  cmdbarModule.apply({
    effect: (fn) => fn(),
    logger: { debug() {}, info() {}, warn() {} },
    get(name) {
      if (name === 'connection') {
        return {
          fetch: {
            register(route) {
              routeHandlers.set(route.path, route.fetch)
              return () => {}
            },
          },
          // The two-step gate the REMOVED upgrade used to run through. It is
          // offered, and it must never be reached: there is no socket any more.
          requestRejection: () => 401,
        }
      }
      if (name === 'webServer') {
        return {
          registerUpgrade() {
            upgrades += 1
            return () => {}
          },
        }
      }
      if (name === 'sessions') return sessions
      return undefined
    },
  })
  check(
    'cmdbar: exactly ONE route is registered',
    [...routeHandlers.keys()].sort().join(','),
    '/api/dsh-cmdbar/activity',
  )
  check('cmdbar: no WebSocket upgrade is registered', upgrades, 0)
  check('cmdbar: the health probe is gone', routeHandlers.has('/api/dsh-cmdbar/health'), false)
  check(
    'cmdbar: the vendored xterm routes are gone',
    routeHandlers.has('/api/dsh-cmdbar/vendor/xterm.js') || routeHandlers.has('/api/dsh-cmdbar/vendor/xterm.css'),
    false,
  )

  // The panel's read. It reads the HOST's copy of the conversation log, which is
  // what makes the panel work the moment the app opens instead of waiting for a
  // browser to stage the conversation.
  const activityCall = (query) => routeHandlers.get('/api/dsh-cmdbar/activity')(new Request('http://x/api/dsh-cmdbar/activity' + query))
  const activityRes = await activityCall('?session=session-cmd')
  const activityBody = await activityRes.json()
  check('cmdbar: activity answers', activityRes.status === 200 && activityBody.ok === true, true)
  check('cmdbar: activity sends only what the panel draws', activityBody.entries.map((entry) => entry.event.type).join(','), 'user/message,tool/call,tool/result')
  check('cmdbar: activity drops injected context', activityBody.entries.some((entry) => entry.event.seq === 3), false)
  check('cmdbar: activity drops assistant streams', activityBody.entries.some((entry) => entry.event.type === 'assistant/message'), false)
  check('cmdbar: activity is in log order', activityBody.entries.map((entry) => entry.event.seq).join(','), '2,5,6')
  check('cmdbar: activity says whether older ones remain', activityBody.hasMore, false)
  const missing = await activityCall('')
  check('cmdbar: activity without a session is refused', missing.status, 400)
  const notLive = await activityCall('?session=nope')
  const notLiveBody = await notLive.json()
  check('cmdbar: activity names an unopened conversation', notLive.status === 200 && notLiveBody.ok === false && notLiveBody.reason, 'NOT_LIVE')
  const broken = await activityCall('?session=session-broken')
  const brokenBody = await broken.json()
  check('cmdbar: activity reports an unreadable log', broken.status === 200 && brokenBody.reason, 'UNREADABLE')
  // A conversation past the count budget answers with its TAIL: the newest
  // commands are the ones a reader is looking for.
  const bigRes = await activityCall('?session=session-big')
  const bigBody = await bigRes.json()
  check('cmdbar: activity bounds the answer', bigBody.entries.length, 400)
  check('cmdbar: activity keeps the newest commands', bigBody.entries[bigBody.entries.length - 1].event.seq, 420)
  check('cmdbar: activity flags what it left behind', bigBody.hasMore, true)
  // One enormous command is still sent: a byte budget must not leave the panel
  // with nothing to draw at all.
  const hugeRes = await activityCall('?session=session-huge')
  const hugeBody = await hugeRes.json()
  check('cmdbar: activity keeps an oversized newest command', hugeBody.entries.length, 1)
}

// --------------------------------------------------------------- dsh-themes
// The screenshot route: the client's PNG body is written to the host's Desktop.
// HOME / USERPROFILE point at a temp folder for this block, so the check never
// touches the real Desktop - the route resolves the folder per request, which is
// exactly what makes that possible.
const themesHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-themes-home-'))
await fsp.mkdir(path.join(themesHome, 'Desktop'))
const previousHome = process.env.HOME
const previousProfile = process.env.USERPROFILE
process.env.HOME = themesHome
process.env.USERPROFILE = themesHome
try {
  const screenshotHandler = await capture(path.join(repo, 'packages/dsh-themes/lib/index.js'), '/api/dsh-themes/screenshot', {})
  const postShot = (body, type) =>
    screenshotHandler(
      new Request('http://x/api/dsh-themes/screenshot', {
        method: 'POST',
        headers: { 'content-type': type === undefined ? 'image/png' : type },
        body,
      }),
    )
  // A real 1x1 PNG: the signature check is exercised by an actual picture.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  )
  check('screenshot rejects another content type', (await postShot(png, 'application/json')).status, 415)
  check('screenshot rejects an empty body', (await postShot(Buffer.alloc(0))).status, 400)
  check('screenshot rejects a body that is not a PNG', (await postShot(Buffer.from('not a png at all'))).status, 415)
  const saved = await (await postShot(png)).json()
  check('screenshot reports the save', saved.ok, true)
  check('screenshot writes to the Desktop', saved.directory, path.join(themesHome, 'Desktop'))
  const written = await fsp.readFile(saved.path).catch(() => null)
  check('screenshot bytes are on disk', written !== null && written.equals(png))
  check(
    'screenshot name carries the pack name',
    path.basename(saved.path).startsWith('vncode-') && saved.path.endsWith('.png'),
  )
  const again = await (await postShot(png)).json()
  check('a second shot takes the next free name', again.path !== saved.path, true)
  check('the first shot survives the second', existsSync(saved.path))
  check('screenshot refuses a GET', (await screenshotHandler(new Request('http://x/api/dsh-themes/screenshot'))).status, 405)
} finally {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = previousProfile
  await fsp.rm(themesHome, { recursive: true, force: true })
}

// ------------------------------------------------------------- dsh-diagrams
// One row owns the tools, the per-conversation state file, the artifact cache
// and the routes. DSH_HOME points at a temp folder for this block, so the store
// and the cache are never touched for real; the tool bodies are driven directly
// with a fake exec, which is the same seam the agent loop uses.
const diagramsHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-diagrams-home-'))
const diagramsWorkspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-diagrams-ws-'))
// An export lands on the HOST's Desktop, and the route resolves that folder PER
// REQUEST from USERPROFILE / HOME / XDG. Both are redirected into a temp profile
// here: a check must never write to a real person's Desktop, and this is also
// what proves which folder the answer came from.
const diagramsProfile = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-diagrams-profile-'))
const diagramsDesktop = path.join(diagramsProfile, 'Desktop')
await fsp.mkdir(diagramsDesktop, { recursive: true })
const previousDshHome = process.env.DSH_HOME
// `previousProfile` / `previousHome` are the originals captured by the themes
// block above, which restores them in its own finally - so they are still the
// real values here and are reused rather than redeclared.
process.env.DSH_HOME = diagramsHome
process.env.USERPROFILE = diagramsProfile
delete process.env.HOME
try {
  const diagramsModule = await import(pathToFileURL(path.join(repo, 'packages/dsh-diagrams/lib/index.js')).href)
  const diagRoutes = new Map()
  const diagTools = []
  const diagSessions = { get: (id) => (id === 'session-diagrams' ? { header: { cwd: diagramsWorkspace } } : undefined) }
  diagramsModule.apply({
    get(name) {
      if (name === 'connection') {
        return {
          fetch: {
            register(route) {
              diagRoutes.set(route.path, route)
              return () => {}
            },
          },
        }
      }
      if (name === 'sessions') return diagSessions
      // No skill registry on this stub: the row must activate anyway.
      return undefined
    },
    tools: { register: (tool) => (diagTools.push(tool), () => {}) },
    effect: (fn) => fn(),
    logger: { debug() {}, warn() {} },
  })

  check('diagrams: route set', [...diagRoutes.keys()].sort().join(','), [
    '/api/dsh-diagrams/artifact',
    '/api/dsh-diagrams/diagram',
    '/api/dsh-diagrams/export',
    '/api/dsh-diagrams/health',
    '/api/dsh-diagrams/render-report',
    '/api/dsh-diagrams/state',
    '/api/dsh-diagrams/vendor/mermaid.js',
  ].join(','))
  check(
    'diagrams: tools registered',
    diagTools.map((tool) => tool.name).sort().join(','),
    'diagram_delete,diagram_patch,diagram_publish,diagram_read,diagram_verify,diagram_write',
  )
  check(
    'diagrams: every tool declares a JSON-schema surface',
    diagTools.every(
      (tool) =>
        tool.parameters &&
        tool.parameters.type === 'object' &&
        Object.keys(tool.parameters.properties ?? {}).length > 0 &&
        (tool.parameters.required ?? []).every((key) => Object.hasOwn(tool.parameters.properties, key)) &&
        tool.output &&
        tool.output.schema &&
        typeof tool.output.render === 'function' &&
        typeof tool.execute === 'function',
    ),
  )
  // The Connection registry takes GET/HEAD/POST only, and every write must be
  // a POST for that reason (not a stylistic choice).
  check(
    'diagrams: methods stay inside the registry vocabulary',
    [...diagRoutes.values()].every((route) => route.methods.every((method) => ['GET', 'HEAD', 'POST'].includes(method))),
  )

  const call = (routePath, request) => diagRoutes.get(routePath).fetch(request)
  const post = (routePath, body) =>
    call(
      routePath,
      new Request('http://x' + routePath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    )
  const getJson = (routePath, query) => call(routePath, new Request('http://x' + routePath + '?' + query, { method: 'GET' }))
  const tool = (toolName) => diagTools.find((entry) => entry.name === toolName)
  const exec = { agent: { session: { id: 'session-diagrams' } }, signal: new AbortController().signal }

  // --- the vendored engine, and the drift check on the generated tree
  const vendor = await call('/api/dsh-diagrams/vendor/mermaid.js', new Request('http://x/api/dsh-diagrams/vendor/mermaid.js'))
  const vendorBytes = Buffer.from(await vendor.arrayBuffer())
  check('diagrams: serves the vendored engine', vendor.status === 200 && vendorBytes.length > 1000000, true)
  check('diagrams: engine content type', vendor.headers.get('content-type'), 'text/javascript; charset=utf-8')
  const vendorEtag = vendor.headers.get('etag')
  const vendorCached = await call(
    '/api/dsh-diagrams/vendor/mermaid.js',
    new Request('http://x/api/dsh-diagrams/vendor/mermaid.js', { headers: { 'if-none-match': vendorEtag } }),
  )
  check('diagrams: engine is etag-cached', vendorCached.status, 304)
  const { createHash } = await import('node:crypto')
  const recorded = JSON.parse(await fsp.readFile(path.join(repo, 'packages/dsh-diagrams/lib/vendor/VERSION.json'), 'utf8'))
  check(
    'diagrams: vendored engine matches its recorded hash',
    createHash('sha256').update(vendorBytes).digest('hex') === recorded.sha256 && recorded.bytes === vendorBytes.length,
    true,
  )
  check('diagrams: vendored engine is the single-file build', vendorBytes.toString('utf8', -400).includes('globalThis["mermaid"]'), true)

  const health = await getJson('/api/dsh-diagrams/health', '')
  const healthBody = await health.json()
  check('diagrams: health answers', health.status === 200 && healthBody.ok === true)
  check('diagrams: health names the vendored mermaid', healthBody.mermaid.version, recorded.version)
  check('diagrams: health reports the TeX capability', typeof healthBody.tex.available, 'boolean')

  // --- model writes: mermaid (validated through the vendored engine)
  const goodMermaid = await tool('diagram_write').execute(
    { kind: 'mermaid', title: 'Auth flow', source: 'flowchart TD\n  A[Client] --> B{OK?}\n  B -->|yes| C[Home]' },
    exec,
  )
  check('diagrams: mermaid write validates', goodMermaid.view.status, 'ok')
  check('diagrams: write names the parse type', goodMermaid.view.diagramType, 'flowchart-v2')
  check('diagrams: write hands back a tab address', goodMermaid.view.address, 'dsh-resource://diagram/session/session-diagrams/auth-flow')
  const badMermaid = await tool('diagram_write').execute({ kind: 'mermaid', id: 'broken', source: 'flowchart TD\n  A[Start --> B{{{' }, exec)
  check('diagrams: a broken mermaid is reported', badMermaid.view.status, 'error')
  check('diagrams: the parse error travels to the model', badMermaid.diagnostics.length > 0 && /Parse error|Expecting/.test(badMermaid.diagnostics[0].text), true)
  // The DOM stub has to expose `window.CSS`: without it the engine's
  // sequence-diagram box parser takes a `new Option()` fallback that does not
  // exist in a stub, and EVERY `box` diagram came back "unavailable" - stored
  // but never checked, with a real browser as the only judge of the source.
  const boxed = await tool('diagram_write').execute(
    {
      kind: 'mermaid',
      id: 'boxed',
      title: 'Boxed',
      source: 'sequenceDiagram\n  box rgb(240,240,255) Team\n    participant A as Alice\n  end\n  A->>A: solo',
    },
    exec,
  )
  check('diagrams: a boxed sequence diagram validates', boxed.view.status, 'ok')
  check('diagrams: the boxed diagram is a sequence', boxed.view.diagramType, 'sequence')

  const read = await tool('diagram_read').execute({ id: 'auth-flow' }, exec)
  check('diagrams: read returns the source', read.text.includes('flowchart TD') && read.text.includes('Auth flow'), true)
  const list = await tool('diagram_read').execute({}, exec)
  check('diagrams: read lists both diagrams', list.text.includes('auth-flow') && list.text.includes('broken'), true)

  // --- advisory linting: the parser's verdict is unchanged by a warning
  const warned = await tool('diagram_write').execute(
    {
      kind: 'mermaid',
      title: 'Node soup',
      source: 'flowchart LR\n  A[One]\n  B[Two]\n  C[Three]\n  D[Four]\n  E[Five]\n  F[Six]\n  G[Seven]\n  H[Eight]\n  I[Nine]',
    },
    exec,
  )
  check('diagrams: a warning never changes the verdict', warned.view.status, 'ok')
  check('diagrams: an unconnected picture is warned about', (warned.view.warnings ?? []).some((entry) => entry.kind === 'shape'), true)
  check('diagrams: warnings reach the model', /Advisory/.test(warned.text) && /no edges/.test(warned.text), true)
  check('diagrams: warnings travel in the view too', (warned.view.warnings ?? []).length > 0, true)
  const quiet = await tool('diagram_write').execute({ kind: 'mermaid', id: 'warned-one', title: 'Quiet', source: 'flowchart TD\n  A[Client] --> B[API]' }, exec)
  check('diagrams: a clean diagram carries no warnings', (quiet.view.warnings ?? []).length, 0)

  // --- an empty source is refused in words the model can act on, not by the engine
  const blank = await tool('diagram_write').execute({ kind: 'mermaid', id: 'blank-one', title: 'Blank', source: '   \n\n' }, exec)
  check('diagrams: an empty source is an error', blank.view.status, 'error')
  check('diagrams: the empty source is explained', /source is empty/i.test(blank.diagnostics[0].text), true)
  const blankTikz = await tool('diagram_write').execute({ kind: 'tikz', id: 'blank-tikz', title: 'Blank TikZ', source: '\\documentclass{article}\\begin{document}hello\\end{document}' }, exec)
  check('diagrams: a TikZ document with no picture is refused', blankTikz.view.status, 'error')
  check('diagrams: the empty TikZ is explained', /no picture in this source/i.test(blankTikz.diagnostics[0].text), true)

  // --- diagram_verify: re-validates, writes nothing, and does not bump the revision
  const patched = await tool('diagram_patch').execute({ id: 'auth-flow', oldString: 'B{OK?}', newString: 'B{Credentials?}' }, exec)
  check('diagrams: patch reports the occurrence count', patched.occurrences, 1)
  check('diagrams: patch kept the diagram valid', patched.view.status, 'ok')
  const ambiguous = await tool('diagram_patch')
    .execute({ id: 'auth-flow', oldString: 'o', newString: '0' }, exec)
    .then(() => 'no error')
    .catch((err) => err.code)
  check('diagrams: an ambiguous patch is refused', ambiguous, 'AMBIGUOUS')

  const beforeVerify = await tool('diagram_read').execute({ id: 'auth-flow', includeSource: false }, exec)
  check('diagrams: a fresh diagram has no browser report yet', beforeVerify.verification.state, 'pending')
  const revisionBefore = (await (await getJson('/api/dsh-diagrams/state', 'session=session-diagrams')).json()).diagrams.find(
    (entry) => entry.id === 'auth-flow',
  ).revision
  const verified = await tool('diagram_verify').execute({ id: 'auth-flow' }, exec)
  check('diagrams: verify re-checks the diagram', verified.status, 'ok')
  const stateAfterVerify = await (await getJson('/api/dsh-diagrams/state', 'session=session-diagrams')).json()
  check(
    'diagrams: verify left the revision alone',
    stateAfterVerify.diagrams.find((entry) => entry.id === 'auth-flow').revision,
    revisionBefore,
  )
  const missingVerify = await tool('diagram_verify').execute({ id: 'nope' }, exec)
  check('diagrams: verify says so when the diagram is gone', missingVerify.status, 'missing')

  // --- the browser render report: the one question the host cannot answer alone
  const report = await (
    await post('/api/dsh-diagrams/render-report', {
      session: 'session-diagrams',
      id: 'auth-flow',
      revision: revisionBefore,
      kind: 'mermaid',
      ok: true,
      theme: 'default',
      ms: 42,
    })
  ).json()
  check('diagrams: a render report is stored', report.stored, true)
  const afterReport = await tool('diagram_read').execute({ id: 'auth-flow', includeSource: false }, exec)
  check('diagrams: the browser verdict reaches diagram_read', afterReport.verification.state, 'drawn')
  check('diagrams: the model is told the browser drew it', /Browser: DREW/.test(afterReport.text), true)
  const failedReport = await (
    await post('/api/dsh-diagrams/render-report', {
      session: 'session-diagrams',
      id: 'auth-flow',
      revision: revisionBefore,
      kind: 'mermaid',
      ok: false,
      phase: 'render',
      error: 'the engine produced an empty picture',
    })
  ).json()
  check('diagrams: a failed render is stored too', failedReport.stored, true)
  const afterFailure = await tool('diagram_read').execute({ id: 'auth-flow', includeSource: false }, exec)
  check('diagrams: a failed render reads as failed', afterFailure.verification.state, 'failed')
  // A write invalidates the report: the picture was of the PREVIOUS source.
  await tool('diagram_patch').execute({ id: 'auth-flow', oldString: 'C[Home]', newString: 'C[Dashboard]', note: 'rename' }, exec)
  const afterRewrite = await tool('diagram_read').execute({ id: 'auth-flow', includeSource: false }, exec)
  check('diagrams: a rewrite invalidates the browser report', afterRewrite.verification.state, 'pending')
  // ...but a report about the OLD revision is still the truth about that revision.
  await post('/api/dsh-diagrams/render-report', { session: 'session-diagrams', id: 'auth-flow', revision: revisionBefore, ok: true })
  check(
    'diagrams: a report about an older revision reads as stale',
    (await tool('diagram_read').execute({ id: 'auth-flow', includeSource: false }, exec)).verification.state,
    'stale',
  )
  check(
    'diagrams: a report about a deleted diagram is accepted, not an error',
    (await post('/api/dsh-diagrams/render-report', { session: 'session-diagrams', id: 'gone', ok: true })).status,
    200,
  )
  check(
    'diagrams: a report without an id is refused',
    (await post('/api/dsh-diagrams/render-report', { session: 'session-diagrams', ok: true })).status,
    400,
  )

  // --- the browser verdict as a pure function: four honest answers, and a
  // report about an OLDER revision is never read as this revision's picture.
  const { DiagramStore, verificationOf, MAX_SOURCE_BYTES, MAX_STATE_BYTES } = await import(
    pathToFileURL(path.join(repo, 'packages/dsh-diagrams/lib/store.js')).href
  )
  const drawnState = verificationOf({ revision: 3, render: { revision: 3, ok: true, kind: 'mermaid', at: 'T', theme: 'dark', error: null } })
  check('diagrams: a report about this revision reads drawn', drawnState.state + ':' + drawnState.revision + ':' + drawnState.reported, 'drawn:3:3')
  const failedState = verificationOf({ revision: 3, render: { revision: 3, ok: false, kind: 'mermaid', error: 'boom' } })
  check('diagrams: a failed report reads failed, with its error', failedState.state + ':' + failedState.error, 'failed:boom')
  const staleState = verificationOf({ revision: 4, render: { revision: 3, ok: true, kind: 'mermaid' } })
  check('diagrams: a report about an older revision reads stale', staleState.state + ':' + staleState.revision + ':' + staleState.reported, 'stale:4:3')
  const pendingState = verificationOf({ revision: 4, render: null })
  check('diagrams: no report at all reads pending', pendingState.state + ':' + pendingState.revision, 'pending:4')
  // The registry refuses a tool output that does not survive a JSON round trip,
  // and a property whose value is `undefined` is dropped by `JSON.stringify`.
  // Comparing the KEYS (not the serialization) is what catches it: a report that
  // carried `error: null` used to become `undefined` on a DRAWN verdict, and
  // every diagram the browser had rendered came back "value is not lossless
  // JSON" - unreadable to the model.
  const lossless = (value) => {
    const keys = Object.keys(value)
    const round = JSON.parse(JSON.stringify(value))
    return keys.length === Object.keys(round).length && keys.every((key) => round[key] === value[key])
  }
  check(
    'diagrams: every verdict survives a JSON round trip',
    [drawnState, failedState, staleState, pendingState].every(lossless),
  )

  // --- hardening: one diagram's ceiling, and the conversation's source budget,
  // which binds BEFORE the state-file cap. It used to be possible to fill a
  // conversation past that cap, and the store then read the file as empty -
  // every diagram in the conversation vanishing at once.
  const budgetStore = new DiagramStore({ root: path.join(diagramsHome, 'budget-state') })
  const tooBig = (() => {
    try {
      budgetStore.write('session-budget', { kind: 'mermaid', id: 'huge', source: 'x'.repeat(MAX_SOURCE_BYTES + 1), by: 'model' })
      return 'written'
    } catch (err) {
      return err.code
    }
  })()
  check('diagrams: one diagram keeps its own ceiling', tooBig, 'TOO_LARGE')
  const perDiagram = 200 * 1024
  const filler = 'flowchart TD\n' + 'A --> B\n'.repeat(Math.ceil(perDiagram / 8)).slice(0, perDiagram)
  let written = 0
  let refusal = null
  for (let index = 0; index < 40 && refusal === null; index += 1) {
    try {
      budgetStore.write('session-budget', { kind: 'mermaid', id: 'big-' + index, source: filler, by: 'model' })
      written += 1
    } catch (err) {
      refusal = err.code
    }
  }
  check('diagrams: the conversation source budget is enforced', refusal, 'BUDGET')
  check('diagrams: the budget admits a real conversation first', written >= 15, true)
  check('diagrams: the budget binds before the state-file cap', written * perDiagram < MAX_STATE_BYTES, true)
  const replaced = (() => {
    try {
      budgetStore.write('session-budget', { kind: 'mermaid', id: 'big-0', source: filler, by: 'model' })
      return 'ok'
    } catch (err) {
      return err.code
    }
  })()
  check('diagrams: replacing a diagram is charged once, not twice', replaced, 'ok')

  // --- hardening: a cache hit keeps the verdict the compile was cached WITH.
  // A failed compile that still produced a picture is cached deliberately (the
  // partial picture is evidence), and reading that back as "ok" was the plugin
  // telling the model its own diagram was fine.
  const stubStore = new DiagramStore({ root: path.join(diagramsHome, 'stub-state') })
  const stubLibrary = new DiagramStore({ root: path.join(diagramsHome, 'stub-state'), fixedFile: 'library.json' })
  const stubTools = diagramsModule.buildTools({
    store: stubStore,
    library: stubLibrary,
    storeFor: (scopeKey) => (scopeKey === 'library' ? stubLibrary : stubStore),
    cache: {
      keyFor: () => 'a'.repeat(24),
      meta: () => ({
        kind: 'tikz',
        engine: 'stub',
        pages: 1,
        width: 20,
        height: 20,
        formats: ['pdf'],
        at: 'now',
        diagnostics: [{ kind: 'compile', text: 'diagram.tex:3: Package pgf Error: stubbed' }],
      }),
      write: () => ({ formats: ['pdf'], at: 'now' }),
      read: () => null,
      drop: () => {},
    },
    enginesNow: () => ({ available: true, engine: 'stub', svg: 'stub', png: 'stub' }),
  })
  stubStore.write('session-cached', { kind: 'tikz', id: 'cached-failure', source: '\\draw (0,0) -- (1,1);', by: 'model' })
  const cachedVerdict = await stubTools
    .find((entry) => entry.name === 'diagram_verify')
    .execute({ id: 'cached-failure' }, { agent: { session: { id: 'session-cached' } }, signal: new AbortController().signal })
  check('diagrams: a cache hit keeps the verdict it was cached with', cachedVerdict.status, 'error')
  check('diagrams: the cached diagnostics still reach the model', /stubbed/.test(cachedVerdict.text), true)

  // --- THE LIBRARY. One store for the whole harness, which is what makes an id
  // citable from a conversation that never saw it written - and what makes a
  // diagram outlive the chat it was drawn in. `session-elsewhere` stands in for
  // "another chat" everywhere below.
  const otherExec = { agent: { session: { id: 'session-elsewhere' } }, signal: new AbortController().signal }
  const sharedWrite = await tool('diagram_write').execute(
    { kind: 'mermaid', id: 'jepa-model', title: 'JEPA model', scope: 'library', source: 'flowchart TD\n  A[Context x] --> B[Encoder]' },
    exec,
  )
  check('diagrams: a library write lands in the library', sharedWrite.view.scope, 'library')
  check('diagrams: the library address names no conversation', sharedWrite.view.address, 'dsh-resource://diagram/library/jepa-model')
  const fromElsewhere = await tool('diagram_read').execute({ id: 'jepa-model' }, otherExec)
  check('diagrams: another conversation reads a library id alone', /in the shared library/.test(fromElsewhere.text) && /flowchart TD/.test(fromElsewhere.text), true)
  check('diagrams: the reading conversation resolved the library', fromElsewhere.scope, 'library')
  check('diagrams: the library is ONE file at the store root', existsSync(path.join(diagramsHome, 'dsh-diagrams', 'library.json')), true)

  const published = await tool('diagram_publish').execute({ id: 'auth-flow' }, exec)
  check('diagrams: publishing copies into the library', published.view.scope + ':' + published.address, 'library:dsh-resource://diagram/library/auth-flow')
  const readPublished = await tool('diagram_read').execute({ id: 'auth-flow', includeSource: false }, otherExec)
  check('diagrams: the published diagram reaches another chat', readPublished.scope + ':' + readPublished.status, 'library:ok')
  const missingPublish = await tool('diagram_publish').execute({ id: 'nothing-here' }, exec)
  check('diagrams: publishing what is not there says so', /nothing to publish/.test(missingPublish.text), true)

  // The library WINS over a conversation id of the same name: "read X" has to
  // mean the shared diagram, or a citation would resolve differently per chat.
  await tool('diagram_write').execute({ kind: 'mermaid', id: 'shadow', title: 'local shadow', source: 'flowchart TD\n  L[local] --> M[local]' }, exec)
  await tool('diagram_write').execute({ kind: 'mermaid', id: 'shadow', title: 'library shadow', scope: 'library', source: 'flowchart TD\n  S[shared] --> T[shared]' }, exec)
  check('diagrams: a bare id resolves to the library first', (await tool('diagram_read').execute({ id: 'shadow', includeSource: false }, exec)).scope, 'library')
  check(
    'diagrams: an explicit scope reaches the conversation copy',
    (await tool('diagram_read').execute({ id: 'shadow', scope: 'conversation', includeSource: false }, exec)).scope,
    'conversation',
  )
  await tool('diagram_write').execute({ kind: 'mermaid', id: 'local-only', title: 'Local only', source: 'flowchart TD\n  P[private] --> Q[private]' }, exec)
  const elsewhereLocal = await tool('diagram_read').execute({ id: 'local-only', scope: 'conversation' }, otherExec)
  check('diagrams: a conversation diagram is invisible elsewhere', /No diagram "local-only"/.test(elsewhereLocal.text), true)
  check(
    'diagrams: this conversation still sees its own diagram',
    (await tool('diagram_read').execute({ id: 'local-only', scope: 'conversation', includeSource: false }, exec)).scope,
    'conversation',
  )
  check(
    'diagrams: the library is patched by id from another chat',
    (await tool('diagram_patch').execute({ id: 'jepa-model', oldString: 'Context x', newString: 'Context $x$' }, otherExec)).view.scope,
    'library',
  )

  // --- the routes carry the library too: the client shows it in every
  // conversation without a second store.
  const stateHere = await (await getJson('/api/dsh-diagrams/state', 'session=session-diagrams')).json()
  const stateElsewhere = await (await getJson('/api/dsh-diagrams/state', 'session=session-elsewhere')).json()
  check('diagrams: state carries the library', stateHere.library.some((entry) => entry.id === 'jepa-model'), true)
  check('diagrams: library summaries name their scope', stateHere.library.every((entry) => entry.scope === 'library'), true)
  check('diagrams: the library is the same in every conversation', stateElsewhere.library.length, stateHere.library.length)
  check('diagrams: another conversation has no diagrams of its own', stateElsewhere.diagrams.length, 0)
  const oneShared = await (await getJson('/api/dsh-diagrams/diagram', 'session=session-elsewhere&id=jepa-model&scope=library')).json()
  check('diagrams: one library diagram is readable by scope', oneShared.diagram.scope + ':' + oneShared.diagram.address, 'library:dsh-resource://diagram/library/jepa-model')
  const elsewhereReport = await (
    await post('/api/dsh-diagrams/render-report', { session: 'session-elsewhere', id: 'jepa-model', scope: 'library', revision: 1, kind: 'mermaid', ok: true })
  ).json()
  check('diagrams: a render report lands on the library copy', elsewhereReport.stored + ':' + elsewhereReport.scope, 'true:library')
  const droppedShared = await (await post('/api/dsh-diagrams/diagram', { session: 'session-diagrams', id: 'shadow', scope: 'library', delete: true })).json()
  check('diagrams: the library copy can be deleted by scope', droppedShared.deleted, true)

  // --- the state file is the source of truth for the panels
  const state = await (await getJson('/api/dsh-diagrams/state', 'session=session-diagrams')).json()
  check(
    'diagrams: state lists the conversation',
    state.diagrams.slice(0, 2).map((entry) => entry.id).join(','),
    'auth-flow,broken',
  )
  const stored = JSON.parse(await fsp.readFile(path.join(diagramsHome, 'dsh-diagrams', 'sessions', (await fsp.readdir(path.join(diagramsHome, 'dsh-diagrams', 'sessions')))[0]), 'utf8'))
  check('diagrams: state is one file per conversation', stored.sessionId, 'session-diagrams')
  // The browser half has no other copy of the source: the state route has to
  // carry it, or every diagram tab and card renders from `undefined`. It needs
  // the revision too, or it cannot tell a current picture from a stale one.
  check(
    'diagrams: state carries the source the browser renders',
    state.diagrams.find((entry) => entry.id === 'auth-flow').source.includes('flowchart'),
    true,
  )
  check(
    'diagrams: state carries the revision the browser draws',
    Number.isInteger(state.diagrams.find((entry) => entry.id === 'auth-flow').revision),
    true,
  )
  // The tab pill must not have to recompute the verdict: the state route carries
  // the same four-state answer the tool result does.
  check(
    'diagrams: state carries the browser verdict for the pill',
    typeof state.diagrams.find((entry) => entry.id === 'auth-flow').verification?.state,
    'string',
  )

  const one = await (await getJson('/api/dsh-diagrams/diagram', 'session=session-diagrams&id=auth-flow')).json()
  check('diagrams: one diagram carries its source', one.diagram.source.includes('Credentials?'), true)
  const missing = await getJson('/api/dsh-diagrams/diagram', 'session=session-diagrams&id=nope')
  check('diagrams: an unknown diagram is a 404', missing.status, 404)

  // --- the panel's own edit path (POST, never PUT)
  const edited = await (
    await post('/api/dsh-diagrams/diagram', {
      session: 'session-diagrams',
      id: 'auth-flow',
      source: 'flowchart LR\n  A[Client] --> B[API]',
    })
  ).json()
  check('diagrams: the panel edit is validated too', edited.status, 'ok')
  check('diagrams: the panel edit is marked as the user\'s', edited.diagram.by, 'user')
  const created = await (await post('/api/dsh-diagrams/diagram', { session: 'session-diagrams', kind: 'mermaid', title: 'New one', source: 'pie title P\n "a" : 1', create: true })).json()
  check('diagrams: the panel can create a diagram', created.diagram.status, 'ok')
  const deleted = await (await post('/api/dsh-diagrams/diagram', { session: 'session-diagrams', id: 'broken', delete: true })).json()
  check('diagrams: the panel can delete a diagram', deleted.deleted, true)

  // --- artifacts: mermaid has none (the browser draws it), TikZ does
  const noArtifact = await getJson('/api/dsh-diagrams/artifact', 'session=session-diagrams&id=auth-flow&format=svg')
  check('diagrams: mermaid has no host artifact', noArtifact.status, 404)
  const sourceArtifact = await getJson('/api/dsh-diagrams/artifact', 'session=session-diagrams&id=auth-flow&format=mmd')
  check('diagrams: mermaid source is servable', (await sourceArtifact.text()).startsWith('flowchart LR'), true)

  // --- export saves to the HOST's Desktop (never the conversation folder),
  // create-exclusively, and answers with the absolute path it wrote.
  const export1 = await (await post('/api/dsh-diagrams/export', { session: 'session-diagrams', id: 'auth-flow', format: 'mmd' })).json()
  const export2 = await (await post('/api/dsh-diagrams/export', { session: 'session-diagrams', id: 'auth-flow', format: 'mmd' })).json()
  check(
    'diagrams: export lands on the Desktop',
    export1.ok === true && existsSync(export1.path) && path.dirname(export1.path) === diagramsDesktop,
  )
  check(
    'diagrams: the export answers with an absolute path',
    path.isAbsolute(export1.path) && export1.name === path.basename(export1.path) && export1.format === 'mmd',
  )
  check('diagrams: the export names the Desktop', export1.directory, diagramsDesktop)
  check('diagrams: a second export never clobbers the first', export2.path !== export1.path && existsSync(export1.path))
  check('diagrams: export leaves the conversation folder alone', readdirSync(diagramsWorkspace).length, 0)
  check(
    'diagrams: export refuses an unknown format',
    (await post('/api/dsh-diagrams/export', { session: 'session-diagrams', id: 'auth-flow', format: 'exe' })).status,
    400,
  )

  // --- TikZ: compiled when the host has an engine, stored either way
  const tikz = await tool('diagram_write').execute(
    { kind: 'tikz', title: 'Layers', source: '\\node[draw,rounded corners,fill=blue!8] (a) {Client};\n\\node[draw,right=of a] (b) {API};\n\\draw[-{Latex[length=2mm]}] (a) -- (b);' },
    exec,
  )
  if (healthBody.tex.available === true) {
    check('diagrams: tikz compiles', tikz.view.status, 'ok')
    check('diagrams: tikz compiles to an artifact', (await getJson('/api/dsh-diagrams/artifact', 'session=session-diagrams&id=layers&format=svg')).status, 200)
    // A bare pgfplots body used to come back "Environment axis undefined": at the
    // top level of a `standalone` document that environment is not usable, so the
    // host now wraps it in a tikzpicture like any other bare body.
    const chart = await tool('diagram_write').execute(
      {
        kind: 'tikz',
        id: 'chart',
        title: 'Chart',
        source: '\\begin{axis}[width=6cm, height=4cm]\n  \\addplot[domain=0:4, samples=20] {x^2};\n\\end{axis}',
      },
      exec,
    )
    check('diagrams: a bare axis chart compiles', chart.view.status, 'ok')
    const pdf = await getJson('/api/dsh-diagrams/artifact', 'session=session-diagrams&id=layers&format=pdf')
    check('diagrams: the PDF artifact is cached too', pdf.headers.get('content-type'), 'application/pdf')
    const exported = await (await post('/api/dsh-diagrams/export', { session: 'session-diagrams', id: 'layers', format: 'svg' })).json()
    check('diagrams: a compiled diagram exports its SVG', exported.ok === true && path.dirname(exported.path) === diagramsDesktop && existsSync(exported.path))
    // A compile error is reported against the wrapped document.
    const badTikz = await tool('diagram_write').execute({ kind: 'tikz', id: 'bad-tikz', source: '\\draw (a) -- (nowhere);' }, exec)
    check('diagrams: a broken tikz is reported', badTikz.view.status, 'error')
    check('diagrams: the compiler line reaches the model', /diagram\.tex:\d+|Package pgf Error/.test(badTikz.diagnostics.map((entry) => entry.text).join('\n')), true)
  } else {
    console.log('skip diagrams tikz compile          (no TeX engine on this host)')
    check('diagrams: tikz is stored without an engine', tikz.view.status, 'unavailable')
  }

  const removed = await tool('diagram_delete').execute({ id: 'layers' }, exec)
  check('diagrams: delete removes the diagram', removed.deleted, true)
  const afterDelete = await (await getJson('/api/dsh-diagrams/state', 'session=session-diagrams')).json()
  check('diagrams: the state no longer lists it', afterDelete.diagrams.some((entry) => entry.id === 'layers'), false)

  // --- every returned value must satisfy the schema the tool DECLARES and
  // survive a JSON round trip: the registry enforces both, and nothing else in
  // this file would notice a value it refuses. That gap let `reported: null`
  // against `type: "integer"` ship, which made every fresh write fail in front
  // of the model with "must be an integer".
  const shapeProblems = [
    ['diagram_write', goodMermaid],
    ['diagram_patch', patched],
    ['diagram_read', read],
    ['diagram_verify', verified],
    ['diagram_publish', published],
    ['diagram_delete', removed],
  ].flatMap(([name, value]) => [...schemaErrors(tool(name).output.schema, value, name), ...losslessErrors(value, name)])
  check('diagrams: tool results match their declared schema', shapeProblems.length === 0 ? 'ok' : shapeProblems.join(' | '), 'ok')

  // --- the child validator itself: a parse error is a verdict, not a crash
  const { spawnSync } = await import('node:child_process')
  const child = spawnSync(
    process.execPath,
    [path.join(repo, 'packages/dsh-diagrams/lib/mermaid-check.mjs'), '-'],
    { input: 'flowchart TD\n  A[Start --> B{{{', encoding: 'utf8' },
  )
  const verdict = JSON.parse(child.stdout.trim().split('\n').pop())
  check('diagrams: the validator exits cleanly', child.status, 0)
  check('diagrams: the validator calls a broken diagram a parse error', verdict.reason, 'parse')
} finally {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  if (previousProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = previousProfile
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await fsp.rm(diagramsHome, { recursive: true, force: true })
  await fsp.rm(diagramsWorkspace, { recursive: true, force: true })
  await fsp.rm(diagramsProfile, { recursive: true, force: true })
}

// ------------------------------------------------------------ dsh-ui-state
// The pack's durable UI state has no route to capture: its whole host surface is
// ONE `Config` declaration plus the page-zoom bootstrap row, so this block drives
// `apply` against a stub and reads what it declared.
//
// 0.2.0 moved the medium. There is no `settings.register(namespace, schema)` left
// to drive: the Host now projects the ACTIVE PROFILE ENTRY's `.volatile()` Config
// fields into the form the browser half binds (`ctx.configForms.get('ui-state')`),
// and persists an accepted write into the profile's Cordis patch. So the row's
// half of that contract is what is pinned here - EVERY field volatile (a plain
// field is ordinary configuration: not editable through a form, and never written
// back to the patch), the defaults the browser half's DEFAULTS mirror (drift
// between the two is what would make a fresh install read a field nobody set),
// and the fact that only a schema-validated value can reach the inlined boot
// script.
/**
 * The running ENTRY of the pinned harness line, or `null` when this host has no
 * install of it. This is the anchor `packages/dsh-ui-state/lib/index.js` resolves
 * its schemastery through in production - `process.argv[1]` IS the harness's own
 * entry when the harness runs the plugin, so the row finds the exact copy the
 * harness loaded - and it has to be modelled here because several lines can sit
 * on one machine at once: this one keeps a 0.1.5-rc.1 mirror in
 * `$DSH_HOME/profiles/node_modules` (whose schemastery 3.18.2 predates
 * `.volatile()`) beside the pinned line in the npx cache. Importing the row
 * without it would grade the form against a schema builder that cannot declare
 * one.
 * @returns {object|null} the imported module, or null when the pin is not installed.
 */
async function loadPinnedUiState() {
  let pinned = null
  try {
    pinned = JSON.parse(readFileSync(path.join(repo, '.dsh-version.json'), 'utf8')).dsh
  } catch (err) {
    return null
  }
  for (const root of harnessRoots()) {
    const manifest = path.join(root, '@deepseek-ai', 'dsh', 'package.json')
    if (!existsSync(manifest)) continue
    let version = null
    try {
      version = JSON.parse(readFileSync(manifest, 'utf8')).version
    } catch (err) {
      continue
    }
    if (version !== pinned) continue
    const previous = process.argv[1]
    process.argv[1] = path.join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    try {
      return await import(pathToFileURL(path.join(repo, 'packages/dsh-ui-state/lib/index.js')).href)
    } finally {
      process.argv[1] = previous
    }
  }
  return null
}

/** Drive the row's half of the settings-form contract against a stub context. */
function runUiStateChecks(uiStateModule) {
  // The entry id is ONE contract shared by three files - this module, the row id in
  // cordis.patch.yml, and the browser half's binder - and a mismatch is silent: the
  // form answers `unavailable` and the pack remembers nothing.
  check('ui-state: names the entry its form is keyed by', uiStateModule.ENTRY_ID, 'ui-state')
  const uiStateSchema = uiStateModule.Config
  check('ui-state: declares a Config (no schema, no form)', typeof uiStateSchema, 'function')
  /** The resolved section, with each `.volatile()` live accessor unwrapped. */
  const uiStateResolved = (fields) => {
    const resolved = uiStateSchema(fields || {})
    const plain = {}
    for (const [key, value] of Object.entries(resolved)) {
      plain[key] = value && typeof value.get === 'function' ? value.get() : value
    }
    return plain
  }
  check(
    'ui-state: the schema resolves the documented defaults',
    JSON.stringify(uiStateResolved({})),
    JSON.stringify({ theme: '', pageZoom: 100, dockHeight: 280, sidebarWidth: -1, rightbarWidth: -1 }),
  )
  // Volatility read back off the SERIALIZED schema, because that is exactly what
  // the Host's `volatileForm` reads to decide which fields a form carries.
  const uiStateJson = uiStateSchema.toJSON()
  const uiStateRoot = uiStateJson.refs[uiStateJson.uid]
  const uiStateFieldMeta = (name) => uiStateJson.refs[uiStateRoot.dict[name]].meta
  check(
    'ui-state: every remembered field is volatile',
    Object.keys(uiStateRoot.dict)
      .map((name) => name + '=' + (uiStateFieldMeta(name).volatile === true))
      .join(','),
    'theme=true,pageZoom=true,dockHeight=true,sidebarWidth=true,rightbarWidth=true',
  )
  check('ui-state: no field remembers the dock being open', Object.hasOwn(uiStateRoot.dict, 'dockOpen'), false)
  check('ui-state: an extension theme id is kept', uiStateResolved({ theme: 'nord' }).theme, 'nord')
  let zoomRefusal = 'accepted'
  try {
    uiStateSchema({ pageZoom: 900 })
  } catch (err) {
    zoomRefusal = 'refused'
  }
  check('ui-state: a zoom outside the ladder is refused', zoomRefusal, 'refused')
  let heightRefusal = 'accepted'
  try {
    uiStateSchema({ dockHeight: 4 })
  } catch (err) {
    heightRefusal = 'refused'
  }
  check('ui-state: an unusable dock height is refused', heightRefusal, 'refused')
  /**
   * Activate the row once with a live config whose `pageZoom` answers `level`, and
   * collect the index-injection rows it produced.
   * @param level - the remembered zoom (or `undefined` for a host with no Config).
   */
  const uiStateBoot = (level) => {
    const table = []
    const handlers = []
    const injected = []
    const configured = []
    const ctx = {
      logger: { debug() {}, warn() {} },
      fiber: { id: 'ui-state' },
      inject: (deps, callback) => {
        injected.push(deps.join(','))
        callback({
          effect: (fn) => {
            fn()
            return () => {}
          },
          settings: {
            configure: (policy, fiber) => {
              configured.push({ policy, fiber })
              return () => {}
            },
          },
        })
      },
      on: (event, handler) => {
        if (event === 'webserver/index-inject') handlers.push(handler)
      },
    }
    const config = level === undefined ? undefined : { pageZoom: { get: () => level } }
    uiStateModule.apply(ctx, config)
    for (const handler of handlers) handler(table)
    return { table, injected, configured, fiber: ctx.fiber }
  }
  const uiStateApplied = uiStateBoot(125)
  check('ui-state: asks for the optional settings service', uiStateApplied.injected.join(','), 'settings')
  // The opt-out: these fields are the interface's own memory, not preferences a
  // person browses, so no page is generated from them.
  check('ui-state: opts out of a generated settings page', JSON.stringify(uiStateApplied.configured.map((entry) => entry.policy)), '[{"auto":false}]')
  check('ui-state: the page policy belongs to this row', uiStateApplied.configured[0].fiber, uiStateApplied.fiber)
  // The bootstrap row: silent at the resting level (a page nobody has zoomed keeps
  // the markup the harness shipped), the remembered level otherwise.
  check('ui-state: the boot row is silent at the resting level', uiStateBoot(100).table.length, 0)
  const booted = uiStateBoot(125).table
  check('ui-state: the boot row carries the remembered level', booted.length === 1 && booted[0].kind === 'script' && booted[0].placement === 'body', true)
  check('ui-state: the boot row sets the zoom and its seam marker', booted[0].text.includes("style.zoom = String(level) + '%'") && booted[0].text.includes('data-dsh-page-zoomed'), true)
  check('ui-state: the boot row is silent with no Config', uiStateBoot(undefined).table.length, 0)
}

const uiStateModule = await loadPinnedUiState()
if (uiStateModule === null) {
  console.log('skip the ui-state settings form (no install of the pinned harness line on this host)')
} else {
  runUiStateChecks(uiStateModule)
}

// ------------------------------------------------------------- dsh-skills
// The skills browser's host half: three routes over the HOST's skill registry.
// The registry itself is stubbed here, with the exact shapes the shipped
// `@deepseek-ai/dsh-skill` contract declares (`snapshot()` answers
// `{ skills, complete }` of summaries, and `get(name, options)` answers a
// definition carrying `content`, `path` and `invocation`), because what this
// block has to prove is this plugin's OWN behaviour: which file a save writes,
// what it refuses, and what the answer says about a skill that has no file.
// The files, though, are REAL - a temp project workspace and a temp $DSH_HOME -
// so the atomic publish, the frontmatter guard and the conflict refusal are
// driven against a disk, not a mock.
const skillsHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-skills-home-'))
const skillsWorkspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-skills-ws-'))
try {
  const skillsModule = await import(pathToFileURL(path.join(repo, 'packages/dsh-skills/lib/index.js')).href)
  const skillRoutes = new Map()
  const bundleDir = path.join(skillsWorkspace, '.dsh', 'skills', 'demo-skill')
  await fsp.mkdir(bundleDir, { recursive: true })
  const bundleFile = path.join(bundleDir, 'SKILL.md')
  const bundleText = ['---', 'name: demo-skill', 'description: A project skill.', '---', '', '# Demo', '', 'Body text.', ''].join('\n')
  await fsp.writeFile(bundleFile, bundleText, 'utf8')
  const flatFile = path.join(skillsHome, 'skills', 'flat-skill.md')
  await fsp.mkdir(path.dirname(flatFile), { recursive: true })
  const flatText = ['---', 'name: flat-skill', 'description: A flat user skill.', '---', '', '# Flat', ''].join('\n')
  await fsp.writeFile(flatFile, flatText, 'utf8')

  // The two winning definitions: one a directory bundle on disk, one a RUNTIME
  // registration that named no file at all (the case that must stay read-only).
  const definitions = {
    'demo-skill': {
      name: 'demo-skill',
      description: 'A project skill.',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'project-dsh',
      provider: 'filesystem',
      resourceBase: { kind: 'directory', path: bundleDir },
      path: bundleFile,
      content: '# Demo\n\nBody text.',
    },
    'flat-skill': {
      name: 'flat-skill',
      description: 'A flat user skill.',
      invocation: { modelInvocable: false, userInvocable: true },
      source: 'user-dsh',
      provider: 'filesystem',
      resourceBase: { kind: 'directory', path: path.dirname(flatFile) },
      path: flatFile,
      content: '# Flat',
    },
    'runtime-skill': {
      name: 'runtime-skill',
      description: 'Registered at runtime, no file.',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'runtime',
      provider: 'some-plugin',
      content: '# Runtime\n\nHeld in memory.',
    },
  }
  const summaries = [
    { name: 'demo-skill', description: 'A project skill.', invocation: definitions['demo-skill'].invocation, source: 'project-dsh', provider: 'filesystem' },
    { name: 'flat-skill', description: 'A flat user skill.', invocation: definitions['flat-skill'].invocation, source: 'user-dsh', provider: 'filesystem' },
    { name: 'runtime-skill', description: 'Registered at runtime, no file.', invocation: definitions['runtime-skill'].invocation, source: 'runtime', provider: 'some-plugin' },
    { name: 'ghost-skill', description: 'Advertised but unreadable.', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 'filesystem' },
  ]
  const viewCalls = []
  const skillsRegistry = {
    async snapshot(options) {
      viewCalls.push(options)
      return { skills: summaries, complete: true }
    },
    async get(name) {
      if (name === 'ghost-skill') throw new Error('the file vanished')
      return definitions[name]
    },
  }
  const skillsSessions = { get: (id) => (id === 'session-skills' ? { header: { cwd: skillsWorkspace } } : undefined) }
  skillsModule.apply({
    get(name) {
      if (name === 'connection') {
        return {
          fetch: {
            register(route) {
              skillRoutes.set(route.path, route)
              return () => {}
            },
          },
        }
      }
      if (name === 'skills') return skillsRegistry
      if (name === 'sessions') return skillsSessions
      return undefined
    },
    effect: (fn) => fn(),
    logger: { debug() {}, warn() {} },
  })

  check(
    'skills: route set',
    [...skillRoutes.keys()].sort().join(','),
    ['/api/dsh-skills/body', '/api/dsh-skills/list', '/api/dsh-skills/save'].join(','),
  )
  check(
    'skills: methods stay inside the registry vocabulary',
    [...skillRoutes.values()].every((route) => route.methods.every((method) => ['GET', 'HEAD', 'POST'].includes(method))),
  )
  check('skills: the write is a POST', skillRoutes.get('/api/dsh-skills/save').methods.join(','), 'POST')

  const skillsCall = (routePath, request) => skillRoutes.get(routePath).fetch(request)
  const skillsGet = (routePath, query) => skillsCall(routePath, new Request('http://x' + routePath + '?' + query, { method: 'GET' }))
  const skillsPost = (body) =>
    skillsCall(
      '/api/dsh-skills/save',
      new Request('http://x/api/dsh-skills/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    )

  const listResponse = await skillsGet('/api/dsh-skills/list', 'session=session-skills')
  const listBody = await listResponse.json()
  check('skills: the catalog lists every effective skill', listBody.skills.map((entry) => entry.name).join(','), 'demo-skill,flat-skill,runtime-skill,ghost-skill')
  check('skills: the session project folder selects the view', listBody.cwd, skillsWorkspace)
  check('skills: the registry is asked with that folder', viewCalls[0] && viewCalls[0].cwd, skillsWorkspace)
  const demo = listBody.skills.find((entry) => entry.name === 'demo-skill')
  const runtime = listBody.skills.find((entry) => entry.name === 'runtime-skill')
  const ghost = listBody.skills.find((entry) => entry.name === 'ghost-skill')
  check('skills: a directory bundle is named as one, with its file', demo.kind === 'bundle' && demo.path === bundleFile && demo.editable === true)
  check('skills: a runtime entry is listed but not editable', runtime.kind === 'runtime' && runtime.path === null && runtime.editable === false)
  check('skills: an unreadable skill is still a row', ghost.editable === false && ghost.path === null)
  check('skills: the unreadable skill is reported', listBody.unreadable.length, 1)
  check('skills: a user-only skill says so', listBody.skills.find((entry) => entry.name === 'flat-skill').modelInvocable, false)

  // The document, frontmatter INCLUDED: that is what a person edits.
  const bodyResponse = await skillsGet('/api/dsh-skills/body', 'session=session-skills&name=demo-skill')
  const bodyBody = await bodyResponse.json()
  check('skills: the document is the file on disk, frontmatter included', bodyBody.text, bundleText)
  check('skills: an editable document carries its version', typeof bodyBody.mtimeMs === 'number' && typeof bodyBody.size === 'number')
  const runtimeBody = await (await skillsGet('/api/dsh-skills/body', 'session=session-skills&name=runtime-skill')).json()
  check(
    'skills: a runtime skill is shown from its loaded text, read-only',
    runtimeBody.editable === false && runtimeBody.path === null && runtimeBody.text.startsWith('---\nname: runtime-skill\n'),
  )
  check('skills: a runtime skill explains itself', runtimeBody.notice.includes('some-plugin') && runtimeBody.notice.includes('nothing here to edit'))
  const missingBody = await skillsGet('/api/dsh-skills/body', 'session=session-skills&name=nope')
  check('skills: an unknown skill is a 404', missingBody.status, 404)

  // The save: addressed by NAME, written to the registry's own path. The text
  // carries an ellipsis and an arrow ON PURPOSE - a route that decodes or encodes
  // a document with anything narrower than UTF-8 silently rewrites it (`…` became
  // `.` and `→` became `?` through a Latin-1 client in the live probe), and a
  // skill full of prose and arrows is exactly the document that would suffer.
  const editedText = bundleText.replace('Body text.', 'Edited body \u2014 see \u2026 \u2192 here.')
  const saved = await skillsPost({ session: 'session-skills', name: 'demo-skill', text: editedText, expected: { mtimeMs: bodyBody.mtimeMs, size: bodyBody.size } })
  const savedBody = await saved.json()
  check('skills: the save answers the path the registry resolved', saved.status === 200 && savedBody.path === bundleFile)
  check('skills: the save reports the reload verdict', savedBody.reload, 'live')
  check('skills: the file really changed', (await fsp.readFile(bundleFile, 'utf8')).includes('Edited body \u2014 see \u2026 \u2192 here.'))
  check('skills: no temp file is left behind', (await fsp.readdir(bundleDir)).filter((name) => name.includes('.dsh-skills-')).length, 0)

  // A save that would break the document is refused BEFORE the disk is touched.
  const brokenSave = await skillsPost({ session: 'session-skills', name: 'demo-skill', text: '# no frontmatter', expected: { mtimeMs: savedBody.mtimeMs, size: savedBody.size } })
  const brokenBody = await brokenSave.json()
  check('skills: a document without frontmatter is refused', brokenSave.status, 400)
  check('skills: the refusal names what is missing', brokenBody.error.code, 'NO_FRONTMATTER')
  check('skills: the refusal left the file alone', (await fsp.readFile(bundleFile, 'utf8')).includes('Edited body \u2014 see \u2026 \u2192 here.'))

  // Optimistic concurrency: the client's stat is the one it opened with.
  const stale = await skillsPost({ session: 'session-skills', name: 'demo-skill', text: bundleText, expected: { mtimeMs: savedBody.mtimeMs - 5000, size: savedBody.size } })
  check('skills: a save over a changed file is refused', stale.status, 409)
  check('skills: the refusal is the typed conflict', (await stale.json()).error.code, 'CHANGED_ON_DISK')

  const runtimeSave = await skillsPost({ session: 'session-skills', name: 'runtime-skill', text: runtimeBody.text })
  check('skills: a skill with no file cannot be written', runtimeSave.status, 409)
  check('skills: and says so', (await runtimeSave.json()).error.code, 'NOT_FILE_BACKED')

  const noRegistry = new Map()
  skillsModule.apply({
    get(name) {
      if (name === 'connection') return { fetch: { register: (route) => (noRegistry.set(route.path, route), () => {}) } }
      return undefined
    },
    effect: (fn) => fn(),
    logger: { debug() {}, warn() {} },
  })
  const noRegistryList = await noRegistry.get('/api/dsh-skills/list').fetch(new Request('http://x/api/dsh-skills/list', { method: 'GET' }))
  check('skills: no registry is a typed refusal, not a crash', noRegistryList.status, 503)
} finally {
  await fsp.rm(skillsHome, { recursive: true, force: true })
  await fsp.rm(skillsWorkspace, { recursive: true, force: true })
}

// ------------------------------------------- every runtime skill registration
// Four rows register a skill into the harness's own registry at activation
// (dsh-media's two, dsh-diagrams' two, dsh-pdf's one, dsh-writing's one), and each of them
// must name the FILE it read and its SOURCE BUCKET. The source is not cosmetic:
// `ctx.skills.get()` - what the `skill` tool calls to LOAD a skill, as opposed to
// listing it - validates the definition it gets back and requires a STRING
// `source`, so a runtime registration without one is unloadable wherever it is
// the winning entry (`loaded skill "x" source must be a string`, measured against
// the real registry). `path` is what makes the definition file-backed, which is
// what lets a skills browser show and edit the document the model is given.
// dsh-media's own registration is driven behaviourally in check-media-node, and
// dsh-writing's is driven in check-writing-node; the rest are pinned from their
// source here, because nothing else drives them.
{
  const registrations = []
  for (const packageName of ['dsh-media', 'dsh-diagrams', 'dsh-pdf', 'dsh-writing']) {
    registrations.push({
      packageName,
      source: await fsp.readFile(path.join(repo, 'packages', packageName, 'lib', 'index.js'), 'utf8'),
    })
  }
  const named = registrations.filter((entry) => entry.source.includes("source: 'bundled'") && entry.source.includes('path: file') && entry.source.includes("resourceBase: { kind: 'directory', path: path.dirname(file) }"))
  check(
    'every bundled-skill registration names its file and source bucket',
    named.map((entry) => entry.packageName).join(','),
    'dsh-media,dsh-diagrams,dsh-pdf,dsh-writing',
  )
}

// ------------------------------------------------------------------- dsh-ocr
// The OCR row is host-only: no route, one tool, and ONE answer that can only be
// checked by taking the engines away. A host with nothing that can recognize
// text must be told what to install - never a crash, and never silence. The
// engines themselves are driven in packages/dsh-ocr/checks/check-ocr-node.mjs;
// what is pinned here is the registration and the empty-host answer, on every
// platform this check runs on.
{
  const ocrModule = await import(pathToFileURL(path.join(repo, 'packages/dsh-ocr/lib/index.js')).href)
  const ocrTools = []
  ocrModule.apply({
    get: () => undefined,
    tools: { register: (tool) => (ocrTools.push(tool), () => {}) },
    effect: (fn) => fn(),
    logger: { debug() {}, info() {}, warn() {} },
  })
  check('ocr: exactly one tool, named ocr', ocrTools.map((tool) => tool.name).join(','), 'ocr')
  const ocr = ocrTools[0]
  check('ocr: it requires a path and nothing else', (ocr.parameters.required || []).join(','), 'path')
  check('ocr: its arguments are closed to anything else', ocr.parameters.additionalProperties, false)
  check(
    'ocr: it takes the path, the language, the pages, the segmentation mode and the resolution',
    Object.keys(ocr.parameters.properties).sort().join(','),
    'dpi,lang,pages,path,psm',
  )
  check('ocr: it declares a JSON-schema surface', schemaErrors(ocr.parameters, { path: 'x' }).length, 0)
  check('ocr: it renders a text part', ocr.output.render({}, { text: 'x', view: { file: 'f' } })[0].type, 'text')

  // A host with no engine at all: an empty PATH and a platform with no built-in
  // recognizer. The tool must still ANSWER - with the sentence that says what to
  // install - rather than throwing at the model.
  const ocrTemp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-ocr-routes-'))
  const tiny = Buffer.alloc(58)
  tiny.write('BM', 0, 'latin1')
  tiny.writeUInt32LE(58, 2)
  tiny.writeUInt32LE(54, 10)
  tiny.writeUInt32LE(40, 14)
  tiny.writeInt32LE(1, 18)
  tiny.writeInt32LE(1, 22)
  tiny.writeUInt16LE(1, 26)
  tiny.writeUInt16LE(24, 28)
  tiny.writeUInt32LE(4, 34)
  const tinyPath = path.join(ocrTemp, 'tiny.bmp')
  await fsp.writeFile(tinyPath, tiny)
  const bareDeps = ocrModule.createDeps(
    { get: () => undefined, logger: { info() {}, warn() {} } },
    { env: { PATH: '', PATHEXT: '.EXE', SystemRoot: '' }, platform: 'linux' },
  )
  const [bareTool] = ocrModule.__internals.buildTools(bareDeps)
  const bare = await bareTool.execute({ path: tinyPath }, { agent: { session: { id: 'session-ocr' } } })
  check('ocr: a host with no engine is answered, not thrown at', typeof bare.text, 'string')
  check('ocr: that answer names the engine it looked for', bare.text.includes('tesseract'), true)
  check('ocr: that answer says what to install', bare.text.includes('Install one'), true)
  check('ocr: that answer still carries a view for the card', typeof bare.view.file, 'string')
  await fsp.rm(ocrTemp, { recursive: true, force: true })
}

// --------------------------------------------------------- the repo manifest
// `.dsh-version.json` is documentation, but it is documentation a PERSON reads
// to know what is installed and at which version, and nothing else keeps it
// honest: the installers discover bundles from the FILESYSTEM (packages/*/
// package.json with `dsh.bundle`) and read only the `dsh` pin out of this file,
// so a bundle whose package.json moved on leaves a stale version and a stale
// description behind with no error anywhere. It had already drifted (dsh-cmdbar
// sat at alpha.6 through alpha.8, dsh-pdf counted SEVEN routes where the code
// registers TEN). These three checks fail the moment it happens again.
{
  const manifest = JSON.parse(await fsp.readFile(path.join(repo, '.dsh-version.json'), 'utf8'))
  const declared = manifest.packages !== null && typeof manifest.packages === 'object' ? manifest.packages : {}
  const versions = new Map()
  const bundles = []
  for (const entry of readdirSync(path.join(repo, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    let pkg = null
    try {
      pkg = JSON.parse(await fsp.readFile(path.join(repo, 'packages', entry.name, 'package.json'), 'utf8'))
    } catch (err) {
      continue
    }
    versions.set(pkg.name, pkg.version)
    if (pkg.dsh !== undefined && pkg.dsh.bundle !== undefined) bundles.push(pkg.name)
  }
  check(
    'manifest: every bundle is declared',
    bundles.filter((name) => declared[name] === undefined).join(','),
    '',
  )
  check(
    'manifest: every declared version matches package.json',
    Object.entries(declared)
      .filter(([name, entry]) => versions.get(name) !== entry.version)
      .map(([name]) => name)
      .join(','),
    '',
  )
  check(
    'manifest: the dsh pin is present',
    typeof manifest.dsh === 'string' && manifest.dsh !== '' && typeof manifest.vendoredFrom === 'string' && manifest.vendoredFrom !== '',
    true,
  )
}

// --------------------------------------------- the master's pack-wide patches
// The master's `cordis.patch.yml` is the one place a shipped row is disabled
// WITHOUT a pack bundle replacing it (alpha.3's feedback removal), and nothing
// else reads it: the file is data, so a typo, a dropped block or a renamed row id
// would fail silently at boot - the patch warns and is SKIPPED, which is exactly
// the quiet failure this check exists to prevent. Both halves of the claim are
// asserted: every id here is a real shipped row in the pinned line's own layers,
// and every one of them is disabled.
{
  const patch = readFileSync(path.join(repo, 'packages', 'dsh-vn-master', 'cordis.patch.yml'), 'utf8')
  const disabledRows = ['ui-message-feedback', 'message-feedback', 'command-feedback', 'session-telemetry-otel']
  const blockFor = (id) => {
    const header = '- id: ' + id + '\n'
    const at = patch.indexOf(header)
    if (at === -1) return null
    const rest = patch.slice(at + header.length)
    const next = rest.search(/\n- (id|insert):/)
    return next === -1 ? rest : rest.slice(0, next)
  }
  check(
    'master: the feedback surface stays removed',
    disabledRows.filter((id) => {
      const block = blockFor(id)
      return block === null || /^\s*disabled:\s*true\s*$/m.test(block) === false
    }).join(','),
    '',
  )
  // ... and the ids are the pinned line's OWN rows: a patch naming a row that does
  // not exist is skipped with a warning, so a rename in a harness bump would leave
  // this claim intact while the feedback surface quietly came back.
  let shippedLayers = null
  for (const root of harnessRoots()) {
    const webApp = path.join(root, '@deepseek-ai', 'dsh-web-app', 'cordis.patch.yml')
    const base = path.join(root, '@deepseek-ai', 'dsh-base', 'cordis.patch.yml')
    if (existsSync(webApp) && existsSync(base)) {
      shippedLayers = readFileSync(webApp, 'utf8') + readFileSync(base, 'utf8')
      break
    }
  }
  if (shippedLayers === null) note('master: no harness install found, the shipped-row ids are unchecked')
  else {
    check(
      'master: those ids are shipped rows of the pinned line',
      disabledRows.filter((id) => shippedLayers.includes('- id: ' + id) === false).join(','),
      '',
    )
  }
}

console.log('')
console.log(failures === 0 ? 'all node-route checks passed' : failures + ' check(s) FAILED')
process.exitCode = failures === 0 ? 0 : 1
