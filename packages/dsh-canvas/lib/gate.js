/**
 * dsh-canvas — THE PERFECT GATE.
 *
 * A design that VALIDATES is a document the host will store. A design that is PERFECT
 * is one that also survives every objective judgement the engine can make about it,
 * and the difference matters because the house gallery is the thing the model is told
 * to EDIT rather than rewrite: a starter with one weak measurement in it teaches the
 * wrong habit twelve times.
 *
 * So the gate is one function over a laid-out design, and it has three callers:
 *
 *   - `canvas_audit` (the tool), so the model can score any design - including its own
 *     edit - before it shows anyone;
 *   - `check-canvas-node.mjs`, which runs the whole house gallery through it, so a
 *     starter that stops being perfect fails a check rather than a person's eye;
 *   - the skills, which name it: the gate is a contract, not prose.
 *
 * WHAT IS IN IT, and why each one is here rather than in a style pack:
 *
 *   - `LINT` - everything `engine.lintLayout` found, which is the measurable half of
 *     composition: margins, safe areas, contrast, type size, overflow, alignment,
 *     text over a picture, a missing asset. An ERROR is a refusal; a WARN is a fault.
 *   - `TYPE_RATIO` - the headline must be at least twice the next size down. This is
 *     the one hierarchy rule that is arithmetic rather than taste: 72 next to 40 reads
 *     as a tie, and 72 next to 26 reads as a headline and a subhead.
 *   - `COPY_BUDGET` - the words in the design against what its own destination can
 *     hold. The budget is DERIVED from the preset's scale (the same arithmetic
 *     `vendor/copy-doc.mjs` publishes) rather than a table of hand-typed numbers, so a
 *     preset that changes its scale changes its budget with it.
 *   - `FOCAL` - exactly one thing carries the most weight. Measured as: one text node
 *     is the largest on the canvas, and it is not tied with another.
 *
 * A check that CANNOT be judged says so (`skip`) and is not a failure - a design with
 * no text at all, or one whose type is measured from an image, is a question this gate
 * cannot answer, and inventing an answer is how a gate becomes noise.
 */
import { lintLayout } from './engine.js'

/** The gate's version. A change to what "perfect" means is a change to this number. */
export const GATE_VERSION = '1'

/** Every check the gate runs, in report order, with the one line that says what it is. */
export const GATE_CHECKS = [
  { id: 'SYNTAX', label: 'the document validates', what: 'preset, tokens, layers and every node kind accept this design' },
  { id: 'LINT', label: 'the engine finds nothing wrong', what: 'margins, safe areas, contrast, type size, overflow, alignment, assets' },
  { id: 'TYPE_RATIO', label: 'the headline is twice the next size', what: 'the largest type is at least 2x the next distinct size' },
  { id: 'COPY_BUDGET', label: 'the words fit the destination', what: 'the total word count against the budget the preset\u2019s own scale implies' },
  { id: 'FOCAL', label: 'exactly one element leads', what: 'one text node is the largest on the canvas, with no tie' },
]

/**
 * The words a design can hold, from ITS OWN typography and the destination's width.
 *
 * THE BUDGET IS THE DOCUMENT'S OWN ARITHMETIC, and this is the one thing about this
 * check worth arguing. A fixed table of numbers per destination would be a second,
 * competing source of truth beside `reference/copy.md` - and it would be wrong in both
 * directions, because the copy library's numbers describe what fits at the size IT
 * prints, not at the size a design chose. What is true of every design is the
 * arithmetic: a headline may run to TWO lines (the library says so, in as many words)
 * and a banner carries ONE line of support. Measured at the sizes the design actually
 * uses, that is its budget - so a design that shrinks its headline to fit more words
 * gets a bigger budget and a worse design, which is the correct trade, and one that
 * picks a display size it cannot fill is told so.
 *
 * A tie between the two largest sizes is not a hierarchy, so the headline is the
 * largest size; the support line is the largest size that is NOT the headline.
 */
export function copyBudgetFor(document, preset, sizes) {
  const width = preset && Number.isFinite(preset.width) ? preset.width - 2 * (preset.margin ?? 0) : null
  if (!width || !Array.isArray(sizes) || sizes.length === 0) return null
  // 0.5em an average glyph and six characters a word: the advance every check in this
  // package measures with, and the one the copy library publishes.
  const wordsOnOneLine = (size) => Math.floor(Math.floor((width / (size * 0.5)) * 0.9) / 6)
  const headline = wordsOnOneLine(sizes[0])
  const support = sizes.length > 1 ? wordsOnOneLine(sizes[1]) : 0
  return { headline, support, total: headline * 2 + support }
}

/** The words a design actually carries, per text node, in paint order. */
function textRuns(layoutResult) {
  const boxes = (layoutResult && layoutResult.boxes) || []
  const ops = (layoutResult && layoutResult.ops) || []
  const words = new Map()
  for (const op of ops) {
    if (op.kind !== 'text' || typeof op.text !== 'string') continue
    const count = op.text.trim().length === 0 ? 0 : op.text.trim().split(/\s+/).length
    words.set(op.path, (words.get(op.path) ?? 0) + count)
  }
  const rows = []
  for (const entry of boxes) {
    if (entry.kind !== 'text') continue
    const size = entry.font && Number.isFinite(entry.font.size) ? entry.font.size : null
    rows.push({ path: entry.path, size, words: words.get(entry.path) ?? 0 })
  }
  return rows
}

/** One check's result: `pass`, `fail` or `skip`, always with the measurement behind it. */
function result(id, state, detail) {
  const row = GATE_CHECKS.find((entry) => entry.id === id)
  return { id, label: row ? row.label : id, state, detail }
}

/**
 * Score a laid-out design against the gate.
 *
 * @param options.layoutResult - the result of `engine.layout`.
 * @param options.document - the canonical document that produced it.
 * @param options.preset - the destination preset (its margin and scale drive two checks).
 * @param options.problems - validator problems, when the caller already has them.
 * @param options.assets - the asset table, for the lint pass.
 * @returns `{ perfect, failed, skipped, checks, words, budget, scale }`.
 */
export function auditDesign(options = {}) {
  const { layoutResult, document, preset } = options
  const problems = Array.isArray(options.problems) ? options.problems : []
  const checks = []

  // 1. SYNTAX. A document that was refused has no layout to judge, so this is also the
  //    check that makes every other one a skip.
  checks.push(
    problems.length === 0
      ? result('SYNTAX', 'pass', 'the validator accepted the document')
      : result('SYNTAX', 'fail', problems.map((problem) => problem.code + (problem.path ? ' ' + problem.path : '')).slice(0, 6).join(', ')),
  )

  const lints = layoutResult ? lintLayout(layoutResult, document, preset, { assets: options.assets ?? {} }) : null

  // 2. LINT. Errors are refusals; warnings are faults. Both fail the gate, because a
  //    design whose contrast is under 4.5:1 is not a design that is finished.
  if (!lints) checks.push(result('LINT', 'skip', 'the design could not be laid out'))
  else if (lints.length === 0) checks.push(result('LINT', 'pass', 'no lint of any kind'))
  else {
    const errors = lints.filter((entry) => entry.level === 'error')
    checks.push(
      result(
        'LINT',
        'fail',
        lints
          .slice(0, 6)
          .map((entry) => entry.code + (entry.path ? ' ' + entry.path : ''))
          .join(', ') + (errors.length > 0 ? ' (' + errors.length + ' of them errors)' : ''),
      ),
    )
  }

  const runs = layoutResult ? textRuns(layoutResult) : []
  const sizes = [...new Set(runs.map((run) => run.size).filter((size) => Number.isFinite(size)))].sort((left, right) => right - left)

  // 3. TYPE_RATIO. The largest size against the next DISTINCT size, not against the
  //    smallest: the promise is that the headline leads the thing a reader reads next.
  if (sizes.length < 2) checks.push(result('TYPE_RATIO', 'skip', sizes.length === 0 ? 'no text to judge' : 'one size is in play, which is its own hierarchy'))
  else {
    const ratio = Math.round((sizes[0] / sizes[1]) * 100) / 100
    checks.push(
      ratio >= 2
        ? result('TYPE_RATIO', 'pass', sizes[0] + 'px leads ' + sizes[1] + 'px at ' + ratio + ':1')
        : result('TYPE_RATIO', 'fail', sizes[0] + 'px leads ' + sizes[1] + 'px at only ' + ratio + ':1 - a headline needs 2:1 over the next size'),
    )
  }

  // 4. COPY_BUDGET. The words in the document against the arithmetic its own type
  //    implies for this destination's width.
  const budget = preset ? copyBudgetFor(document, preset, sizes) : null
  const words = runs.reduce((total, run) => total + run.words, 0)
  if (!budget || words === 0) checks.push(result('COPY_BUDGET', 'skip', words === 0 ? 'no words to count' : 'this destination publishes no budget'))
  else {
    checks.push(
      words <= budget.total
        ? result('COPY_BUDGET', 'pass', words + ' words of a ' + budget.total + '-word budget')
        : result('COPY_BUDGET', 'fail', words + ' words against a ' + budget.total + '-word budget for this destination: cut ' + (words - budget.total) + ' or move them to another page'),
    )
  }

  // 5. FOCAL. One text node leads, and it is not a tie: two headlines at the same size
  //    are two focal points, which is the same as none.
  if (runs.length === 0) checks.push(result('FOCAL', 'skip', 'no text to judge'))
  else {
    const largest = sizes[0]
    const leads = runs.filter((run) => run.size === largest)
    checks.push(
      leads.length === 1
        ? result('FOCAL', 'pass', leads[0].path + ' is the one ' + largest + 'px element')
        : result('FOCAL', 'fail', leads.length + ' elements share the largest size (' + largest + 'px): ' + leads.map((run) => run.path).slice(0, 4).join(', ')),
    )
  }

  const failed = checks.filter((check) => check.state === 'fail')
  return {
    perfect: failed.length === 0,
    failed: failed.map((check) => check.id),
    skipped: checks.filter((check) => check.state === 'skip').map((check) => check.id),
    checks,
    words,
    budget,
    sizes,
  }
}

/** The gate as text, for a tool answer or a check's report line. */
export function auditLines(audit) {
  return audit.checks
    .map((check) => '  ' + (check.state === 'pass' ? 'ok  ' : check.state === 'fail' ? 'FAIL' : 'skip') + '  ' + check.id.padEnd(12) + ' ' + check.label + ' - ' + check.detail)
    .join('\n')
}
