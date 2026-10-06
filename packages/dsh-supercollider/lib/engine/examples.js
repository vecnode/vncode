/**
 * dsh-supercollider — the bundled, playable examples.
 *
 * ## Why these exist
 *
 * An agent that has never heard a SuperCollider patch has nothing to ground a
 * sound in. It guesses at a bell and gets a click, or at a gong and gets noise,
 * because the ratios, the ring times and the level ceiling are all things you
 * learn by hearing them. So this package ships a small shelf of instruments that
 * are known to sound like what they say they are, each one a few dozen lines,
 * each one explaining the single DSP idea it is built on.
 *
 * They are **original** files written for this package — implementations of
 * well-known synthesis techniques, not copies of anyone's examples. The
 * `examples/demonstrations` folder in the SuperCollider repository (GPL-3.0+)
 * is credited as the influence in `examples/README.md`; nothing was copied from
 * it, which is what keeps this MIT package MIT.
 *
 * The files are ordinary `.scd`, so they are also readable by a person and
 * loadable by every other tool here.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where the examples live, relative to this module (`lib/engine/`). */
const EXAMPLES_DIR = fileURLToPath(new URL('../../examples/', import.meta.url))

/** One example's identity, as its file name and header describe it. */
function describe(dir, name) {
  let text = ''
  try {
    text = readFileSync(path.join(dir, name), 'utf8')
  } catch (err) {
    return null
  }
  // The house style is:
  //   // 03-fm-bell.scd -- an inharmonic FM bell
  // so the title is what is left of `--` after dropping the file stem, and the
  // summary is what follows it.
  const firstLine = text.split('\n')[0] ?? ''
  const dash = firstLine.indexOf('--')
  const head = dash < 0 ? firstLine.replace(/^\/\/\s*/, '') : firstLine.slice(0, dash).replace(/^\/\/\s*/, '')
  const slugFromHead = head.replace(/\.scd$/, '').replace(/^\d+[-_\s]*/, '').trim()
  const def = /SynthDef\(\s*\\(\w+)/.exec(text)
  const helper = /~\w+\s*=\s*\{\s*\|/.exec(text)
  return {
    file: name,
    slug: name.replace(/\.scd$/, ''),
    title: slugFromHead === '' ? name.replace(/\.scd$/, '') : slugFromHead,
    summary: dash < 0 ? '' : firstLine.slice(dash + 2).trim(),
    synthDef: def === null ? null : def[1],
    helper: helper === null ? null : helper[0].replace(/\s*=.*$/, '').trim(),
    lines: text.split('\n').length,
    text,
  }
}

/**
 * The examples folder, and every example in it.
 *
 * @param options - `{ dir }` for a test that wants another folder.
 * @returns `{ dir, examples }` sorted by file name, so the numbering holds.
 */
export function listExamples(options = {}) {
  const dir = options.dir ?? EXAMPLES_DIR
  if (!existsSync(dir)) return { dir, examples: [] }
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.scd'))
    .sort()
  const examples = []
  for (const name of names) {
    const entry = describe(dir, name)
    if (entry !== null) examples.push(entry)
  }
  return { dir, examples }
}

/**
 * One example by file name, slug or number.
 *
 * The number is the leading digits of the file name, so `"3"`, `"03"` and
 * `"03-fm-bell"` all find the same file — which is what a person means when they
 * say "the third one".
 *
 * @param wanted - the name, slug or index.
 * @param options - `{ dir }`.
 * @returns the example, or null.
 */
export function findExample(wanted, options = {}) {
  const query = String(wanted ?? '').trim().toLowerCase()
  if (query === '') return null
  const { examples } = listExamples(options)
  const exact = examples.find((entry) => entry.file.toLowerCase() === query || entry.slug.toLowerCase() === query)
  if (exact !== undefined) return exact
  const digits = /^(\d+)$/.exec(query)
  if (digits !== null) {
    const index = Number(digits[1])
    return examples.find((entry) => Number((/^(\d+)/.exec(entry.file) ?? [])[1]) === index) ?? null
  }
  return examples.find((entry) => entry.slug.toLowerCase().includes(query)) ?? null
}

/** The examples directory, for a caller that wants to point a tool at it. */
export function examplesDir() {
  return EXAMPLES_DIR
}
