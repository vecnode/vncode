// check-sc-examples.mjs — every SuperCollider example in the shipped skills.
//
// Why this exists: a skill is prompt-visible text, and text cannot fail to
// build. A `.schelp` example with a moved argument name, a UGen that does not
// exist, or a `var` that drifted out of the top of its block is a skill that
// teaches the model a mistake — and the model will then write it into the user's
// session, where it fails. So every fenced `supercollider` block is compiled
// against the machine's own class library.
//
// The contract, which the file names say out loud:
//
//   ```supercollider             MUST compile (and is compiled here)
//   ```supercollider fragment    MAY be a piece of a block — not compiled
//   ```supercollider invalid     MUST NOT compile — asserted
//   ```supercollider output      it is the program's OUTPUT, not code — not compiled
//   ```text / ```                     anything else — not compiled
//
// A block that a skill is not sure about is marked `fragment`, and that is an
// honest answer rather than a weaker check: the ones that claim to be complete
// code are held to it.
//
// Run:  node scripts/checks/check-sc-examples.mjs

const { readdirSync, readFileSync, statSync } = await import('node:fs')
const path = (await import('node:path')).default
const { fileURLToPath, pathToFileURL } = await import('node:url')

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const skillsDir = path.join(repo, 'skills')

let failures = 0
let compiled = 0
let skipped = 0

function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(58) + (ok ? '' : ' got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected)))
  return ok
}

/** Every SKILL.md under the skills root. */
function findSkills() {
  const found = []
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = path.join(skillsDir, entry.name, 'SKILL.md')
    try {
      if (statSync(file).isFile()) found.push({ name: entry.name, file })
    } catch (err) {
      /* not a skill folder */
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Every fenced block in one document.
 *
 * @param text - the markdown.
 * @returns an array of `{ info, body, line }`.
 */
function blocksOf(text) {
  const normalized = text.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const blocks = []
  let open = null
  for (const [index, line] of lines.entries()) {
    const fence = /^```(.*)$/.exec(line)
    if (fence === null) {
      if (open !== null) open.body.push(line)
      continue
    }
    if (open === null) {
      open = { info: fence[1].trim(), body: [], line: index + 1 }
      continue
    }
    blocks.push({ info: open.info, body: open.body.join('\n'), line: open.line })
    open = null
  }
  return blocks
}

const skills = findSkills()
check('the package ships five skills', skills.length, 5)

// Every skill must carry the frontmatter the registry's validator reads.
for (const skill of skills) {
  const text = readFileSync(skill.file, 'utf8')
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n?/g, '\n'))
  check(skill.name + ': has frontmatter', front !== null, true)
  if (front === null) continue
  check(skill.name + ': declares name', /^name:\s*\S/m.test(front[1]), true)
  check(skill.name + ': declares description', /^description:\s*\S/m.test(front[1]), true)
  check(skill.name + ': declares whenToUse', /^whenToUse:\s*\S/m.test(front[1]), true)
  check(skill.name + ': body is not empty', text.length > 2000, true)
}

// The block contract.
const complete = []
const invalid = []
for (const skill of skills) {
  const text = readFileSync(skill.file, 'utf8')
  for (const block of blocksOf(text)) {
    const info = block.info.toLowerCase()
    if (info === 'supercollider') complete.push({ ...block, skill: skill.name })
    else if (info.startsWith('supercollider invalid')) invalid.push({ ...block, skill: skill.name })
    else if (info.startsWith('supercollider')) skipped += 1
  }
}
check('the skills ship complete examples', complete.length > 20, true)
check('the skills mark at least one invalid example', invalid.length >= 1, true)

// A complete example is offered to `sc_check` exactly as a user's snippet would
// be: the whole block, which the tool wraps in its own parenthesised block.
const install = await import(pathToFileURL(path.join(repo, 'lib', 'engine', 'install.js')).href)
const sclang = await import(pathToFileURL(path.join(repo, 'lib', 'engine', 'sclang.js')).href)
const live = install.resolveInstall({ env: process.env })

if (!live.hasLanguage) {
  console.log('skip ' + 'compiling the examples'.padEnd(58) + ' no SuperCollider install on this host (' + complete.length + ' block(s) await it)')
} else {
  console.log('     compiling ' + complete.length + ' example(s) against SuperCollider ' + live.version + ' …')
  for (const block of complete) {
    const result = await sclang.checkSyntax({ code: block.body, sclangFile: live.sclang.file })
    if (result.ok) {
      compiled += 1
      console.log('ok   ' + (block.skill + ':' + block.line).padEnd(58))
    } else {
      failures += 1
      const detail = String(result.output ?? '')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .slice(-6)
        .join('\n        ')
      console.log('FAIL ' + (block.skill + ':' + block.line).padEnd(58) + ' does not compile')
      console.log('        ' + detail)
    }
  }
  // An example marked invalid must be refused, or the marking is a lie.
  for (const block of invalid) {
    const result = await sclang.checkSyntax({ code: block.body, sclangFile: live.sclang.file })
    check(block.skill + ':' + block.line + ' is refused as marked', result.ok, false)
  }
}

console.log('')
console.log(
  'dsh-supercollider examples: ' +
    (failures === 0 ? 'ok' : failures + ' FAILURE(S)') +
    (compiled > 0 ? ', ' + compiled + ' compiled' : '') +
    (skipped > 0 ? ', ' + skipped + ' not checked by contract' : ''),
)
process.exitCode = failures === 0 ? 0 : 1
