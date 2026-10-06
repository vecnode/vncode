// check-sc-library.mjs — the bundled example instruments must be real.
//
// Why this exists: an example that does not compile, or that compiles into
// something silent, is worse than no example at all — the agent starts from it,
// trusts it, and ships a sound that does not exist. So every file under
// `examples/` is COMPILED here, and its shape is asserted: a named SynthDef, a
// path to `Out.ar`, and an envelope that frees its own node.
//
// The compile section SKIPS LOUDLY and exits 0 on a machine with no
// SuperCollider, which is this package's rule everywhere; the shape assertions
// need no install and always run.
//
// Run:  node checks/check-sc-library.mjs

const { readdirSync, readFileSync, existsSync } = await import('node:fs')
const path = (await import('node:path')).default
const { fileURLToPath, pathToFileURL } = await import('node:url')

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const examples = path.join(repo, 'examples')

let failures = 0
let skipped = 0

function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(58) + (ok ? '' : ' got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected)))
  return ok
}

function skip(label, why) {
  skipped += 1
  console.log('skip ' + label.padEnd(58) + ' ' + why)
}

// ---------------------------------------------------------------- the folder
if (!existsSync(examples)) {
  console.log('FAIL the examples folder is missing: ' + examples)
  process.exit(1)
}

const files = readdirSync(examples)
  .filter((name) => name.endsWith('.scd'))
  .sort()
check('there is a library to check', files.length >= 10, true)

// ---------------------------------------------------------------- the catalogue
const library = await import(pathToFileURL(path.join(repo, 'lib', 'engine', 'examples.js')).href)
const { examples: catalogue } = library.listExamples()
check('the catalogue sees every file', catalogue.length, files.length)
check('every catalogue entry has a summary', catalogue.every((entry) => entry.summary.length > 10), true)
check('every catalogue entry names its SynthDef', catalogue.every((entry) => entry.synthDef !== null), true)
check('every catalogue entry defines a helper', catalogue.every((entry) => entry.helper !== null), true)
// The lookup an agent actually uses: a number, a file name, or part of a name.
check('an example is found by number', library.findExample('3') !== null, true)
check('an example is found by padded number', library.findExample('03') !== null, true)
check('an example is found by file name', library.findExample(files[2]) !== null, true)
check('an example is found by part of a name', library.findExample('gong') !== null, true)
check('a name that is not there is null', library.findExample('no such example'), null)

// ---------------------------------------------------------------- the shape of each file
const tools = await import(pathToFileURL(path.join(repo, 'lib', 'tools.js')).href)
for (const name of files) {
  const text = readFileSync(path.join(examples, name), 'utf8')
  const def = /SynthDef\(\s*\\(\w+)/.exec(text)
  check(name + ': declares a named SynthDef', def !== null, true)
  check(name + ': reaches Out.ar', /\bOut\.ar\s*\(/.test(text), true)
  // An example that never frees its node leaks a synth on every trigger, and one
  // with no envelope at all is a drone the file did not admit to being.
  check(name + ': frees its node with doneAction', /doneAction\s*:\s*2/.test(text), true)
  // The house rule that keeps the whole library audible and unclipped.
  check(name + ': has a single amp argument', /\bamp\s*=/.test(text), true)
  check(name + ': documents the technique', /\/\/\s*The technique:/.test(text), true)
  check(name + ': shows how to play it', /\/\/\s*~/.test(text), true)
  // `var` must be the first statement of its block, so a `var` that follows a
  // semicolon or a brace on the same line is the classic mistake.
  const badVar = /[;{]\s*var\s+/.test(text)
  check(name + ': declares no var after a statement', badVar, false)
  check(name + ': uses no .wait', /\.wait\b/.test(text), false)
  check(name + ': uses no Routine or Task', /\b(Routine|Task|SystemClock)\b/.test(text), false)

  // The SynthDef must ALSO be measurable, because that is what the workflow does
  // with it: `sc_capture` rewrites the def's own `Out.ar` to record it. A def this
  // cannot be done to is an example the agent can play but never verify — and the
  // transform refuses an unbalanced expression, which is how a missing `)` in an
  // otherwise plausible example gets caught here rather than in a user's session.
  const expr = text.slice(text.indexOf('SynthDef(')).trim()
  const tapped = def === null ? null : tools.tapSynthDefSource(expr, 'probecheck')
  check(name + ': can be measured (its Out.ar can be tapped)', tapped !== null, true)
  if (tapped !== null) {
    const opens = (tapped.match(/\(/g) ?? []).length
    const shuts = (tapped.match(/\)/g) ?? []).length
    check(name + ': the tapped form balances', opens === shuts, true)
  }
}

// ---------------------------------------------------------------- the compile
{
  const install = await import(pathToFileURL(path.join(repo, 'lib', 'engine', 'install.js')).href)
  const live = install.resolveInstall({ env: process.env })
  if (!live.hasLanguage) {
    skip('live compilation of every example', 'no SuperCollider install on this host')
  } else {
    const sclang = await import(pathToFileURL(path.join(repo, 'lib', 'engine', 'sclang.js')).href)
    const bad = []
    for (const name of files) {
      const code = readFileSync(path.join(examples, name), 'utf8')
      const result = await sclang.checkSyntax({ code, sclangFile: live.sclang.file, timeoutMs: 60_000 })
      if (!result.ok) {
        bad.push(name)
        failures += 1
        console.log('FAIL ' + name.padEnd(58) + ' does not compile')
        const output = String(result.output ?? result.error ?? '')
        for (const line of output.split('\n').filter((entry) => /ERROR|error|line \d/.test(entry)).slice(0, 4)) {
          console.log('       ' + line.trim())
        }
      }
    }
    if (bad.length === 0) check('every example compiles (' + files.length + ')', true)
  }
}

if (failures === 0) {
  console.log('\ndsh-supercollider library: ok' + (skipped > 0 ? ' (' + skipped + ' section(s) skipped)' : ''))
  process.exit(0)
}
console.log('\ndsh-supercollider library: ' + failures + ' FAILURE(S)')
process.exit(1)
