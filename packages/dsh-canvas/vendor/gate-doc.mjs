// packages/dsh-canvas/vendor/gate-doc.mjs — generate the gate reference the skills ship,
// FROM the gate itself.
//
// Why generate it: the gate is code, and a hand-kept description of what "perfect" means
// drifts the moment a check is added, renamed or re-thresholded. This writes
// `skills/canvas-house-edit/reference/gate.md` out of `lib/gate.js`, and `--check` (a
// tracked check) fails when the committed file is not what the gate would produce - so
// the document the model reads is the contract the tool actually enforces.
//
// Usage:
//   node packages/dsh-canvas/vendor/gate-doc.mjs           # write the reference
//   node packages/dsh-canvas/vendor/gate-doc.mjs --check   # verify it is current
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { GATE_CHECKS, GATE_VERSION, copyBudgetFor } from '../lib/gate.js'
import { PRESETS } from '../lib/presets.js'
import { EXAMPLE_LIST } from '../lib/examples/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const target = path.join(here, '..', 'skills', 'canvas-house-edit', 'reference', 'gate.md')

/** What each check means when it fails, and what to do about it. */
const FIXES = {
  SYNTAX: 'The validator names the path and the code. Fix that field and audit again - nothing else can be judged until the document is legal.',
  LINT: 'The engine names the code and the node. `MARGIN` and `SAFE_AREA` are placement; `LOW_CONTRAST` is the ink against the paint behind it; `TYPE_TOO_SMALL` is the 14px floor; `TEXT_OVERFLOW`, `TEXT_TRUNCATED` and `TEXT_UNWRAPPED` are the words against their box; `OFFGRID` and `SIBLING_EDGE` are alignment; `TEXT_ON_IMAGE` asks for a scrim; `MISSING_ASSET` is an image the design cannot paint.',
  TYPE_RATIO: 'Raise `tokens.scale.display`, or lower the size below it. A headline 2x the next size is the floor, not a target.',
  COPY_BUDGET: 'Cut words, or move them into the subhead. Never shrink the type to fit words - the budget is derived from the type, so that is the one fix that cannot work.',
  FOCAL: 'Make one of the tied elements smaller, or demote it to the caption scale. A tie between two largest elements is the same as no focal point.',
}

const lines = []
lines.push('# The perfect gate, v' + GATE_VERSION)
lines.push('')
lines.push('GENERATED from `lib/gate.js` by `vendor/gate-doc.mjs` - a check fails when this file')
lines.push('is not what the gate would produce, so it cannot drift from the contract the tool')
lines.push('enforces. Run it yourself any time with `canvas_audit`.')
lines.push('')
lines.push('A design is **perfect** when every check below is `pass` or `skip`. A check that')
lines.push('CANNOT be judged says `skip` and is not a failure: a design with no text has no')
lines.push('type ratio to measure, and inventing one is how a gate becomes noise.')
lines.push('')
lines.push('## The checks')
lines.push('')
lines.push('| Check | What it measures | When it fails |')
lines.push('|---|---|---|')
for (const check of GATE_CHECKS) {
  lines.push('| `' + check.id + '` | ' + check.what + ' | ' + (FIXES[check.id] ?? '') + ' |')
}
lines.push('')
lines.push('## What the copy budget is')
lines.push('')
lines.push('`COPY_BUDGET` is not a table of hand-typed numbers per destination. It is the')
lines.push('design\u2019s OWN arithmetic against the destination\u2019s width: a headline may run to')
lines.push('two lines and a banner carries one line of support, measured at the sizes the')
lines.push('document actually uses (0.5em an average glyph, six characters a word). So a design')
lines.push('that shrinks its headline to fit more words gets a bigger budget and a worse')
lines.push('design, which is the correct trade - and one that picks a display size it cannot')
lines.push('fill is told so.')
lines.push('')
lines.push('For reference, the budget the twelve house designs are held to:')
lines.push('')
lines.push('| House example | Destination | Words | Budget |')
lines.push('|---|---|---|---|')
for (const example of EXAMPLE_LIST) {
  const preset = PRESETS[example.preset]
  // The sizes the example actually lays out at are the document's own; the budget here
  // is therefore the same arithmetic the gate runs, which is why this table is safe.
  const sizes = example.document.tokens && example.document.tokens.scale
    ? [example.document.tokens.scale.display, example.document.tokens.scale.title, example.document.tokens.scale.body, example.document.tokens.scale.caption].filter((size) => Number.isFinite(size))
    : []
  const budget = copyBudgetFor(example.document, preset, sizes)
  lines.push('| `' + example.id + '` | `' + example.preset + '` | | ' + (budget ? budget.total : '?') + ' |')
}
lines.push('')
lines.push('## The other four checks in the package')
lines.push('')
lines.push('Two more things are measured, and they are not part of the gate because they')
lines.push('answer different questions:')
lines.push('')
lines.push('- **The render report** (from `canvas_render`) carries the same lint codes plus the')
lines.push('  measurements of the painted result - it is the picture, and the picture is the')
lines.push('  only authority on whether a design READS.')
lines.push('- **The destination rules** (`preset.formats`, the byte ceiling and the safe areas)')
lines.push('  are the delivery contract, not the design: `canvas_export` and `canvas_set` report')
lines.push('  a file that cannot be uploaded where it is going.')
lines.push('')

const text = lines.join('\n')

if (process.argv.includes('--check')) {
  let current = null
  try {
    current = readFileSync(target, 'utf8')
  } catch (err) {
    console.error('FAIL the gate reference is missing: ' + path.relative(process.cwd(), target))
    process.exitCode = 1
  }
  if (current !== null) {
    if (current === text) {
      console.log('ok   the gate reference matches the gate (v' + GATE_VERSION + ', ' + GATE_CHECKS.length + ' check(s))')
    } else {
      console.error('FAIL the gate reference is stale: ' + path.relative(process.cwd(), target))
      process.exitCode = 1
    }
  }
} else {
  writeFileSync(target, text)
  console.log('wrote ' + path.relative(process.cwd(), target) + ' (' + GATE_CHECKS.length + ' check(s))')
}
