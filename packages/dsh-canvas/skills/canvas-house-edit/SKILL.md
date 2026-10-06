---
name: canvas-house-edit
description: "Edit a house design instead of rewriting one: the twelve proven designs in canvas_read's gallery are all perfect, so start from one, keep its composition and its look, and change only what the person asked for - proving each round with canvas_audit and a look at the render. Use when the person asks to change, tweak, adjust, restyle or fix a banner that already exists, or asks for a new banner of a kind the gallery already carries."
whenToUse: "Whenever a design already exists or the brief matches a house example - and after every canvas_patch. Read this before patching anything you did not just write, and before you consider a design finished."
---

# Editing a house design

**The gallery is the answer to "start from nothing".** `canvas_read` lists twelve house
examples, each a destination preset, a proven composition and a look that have already
been chosen well - and every one of them passes the gate in `reference/gate.md`: no lint
of any kind, a 2:1 type ratio, a single focal point, and the words inside the budget its
own typography allows. That is what "perfect" means here, and it is measured rather than
asserted.

So the first question is never "what should I draw". It is:

```
canvas_read                                  # the gallery, the archetypes, the styles
canvas_new { example: "night-launch" }       # ONE of them, opened as a design you own
canvas_audit { id: "<the new id>" }          # the gate, with no page open
canvas_render { id: "<the new id>" }         # the picture, and the 25% feed thumbnail
read_image <the PNG the report names>
```

## Edit, do not rewrite

A rewrite throws away the one thing you cannot recover, which is the round trip. So:

- **`canvas_patch` is the edit.** One to sixty-four pointer operations on the stored
  document, validated exactly like a write. Use it for every change: a word, a colour, a
  size, a position, a reorder, a removal.
- **`canvas_write` is for a document you actually intend to replace.** If you find
  yourself re-emitting the whole design to move one element, you have taken the long road
  and lost the composition's own alignment in the process.
- **Patch ONE thing, then look.** Ten small patches with a render between them beat one
  large patch nobody looked at. The gate and the render report are cheap; being wrong
  about eight changes at once is not.
- **The composition is not yours to improve.** The house designs were composed by
  somebody who had the numbers in front of them. Change what was asked for; if you
  believe the layout itself is wrong, say so and render the evidence.
- **A style is not a composition.** `canvas_style` re-colours and re-types and never
  moves anything - so "make it feel calmer" is a style or a palette patch, and "make the
  headline bigger" is a patch on `tokens.scale.display`, not a restyle.

## The gate, and how to use it

`canvas_audit` runs five checks and names the ones that fail. **Nothing is finished until
it passes all five**, and it costs nothing: it lays the design out on the host with the
same engine the browser uses, so no page has to be open.

| Check | What it measures | What to do when it fails |
|---|---|---|
| `SYNTAX` | the document validates | fix the named field; the validator's code names the path |
| `LINT` | everything `lintLayout` found | the code names it: `MARGIN`, `SAFE_AREA`, `LOW_CONTRAST`, `TYPE_TOO_SMALL`, `TEXT_OVERFLOW`, `TEXT_TRUNCATED`, `TEXT_UNWRAPPED`, `OFFGRID`, `SIBLING_EDGE`, `TEXT_ON_IMAGE`, `MISSING_ASSET` |
| `TYPE_RATIO` | the headline against the next size | raise `tokens.scale.display` or lower the next size: 2:1 is the floor |
| `COPY_BUDGET` | the words against the design's own type | cut words, or move them to a subhead - never shrink the type to fit them |
| `FOCAL` | how many elements share the largest size | make one of them smaller, or demote it to the caption scale |

The gate's numbers are the package's own average glyph, so a BORDERLINE `TEXT_OVERFLOW`
is worth confirming with `canvas_render`, which measures with the browser's real faces.
Everything else - margins, contrast, ratio, the focal point - measures the same either way.

## The review protocol

When you have to say whether a design is finished - yours or one you were handed:

1. **The gate first.** It is objective, instant and complete. Do not spend a render on a
   design the gate has already failed.
2. **Then the picture, at both sizes.** `canvas_render` hands back the full PNG and a
   25%-scale feed thumbnail. Read BOTH with `read_image`. A headline that reads
   beautifully at 1280px can be a grey smear at 320px.
3. **Say what you see, in this shape**: the observation (what is actually there), the
   problem (why it matters at the size it will be seen), and the fix (a specific
   operation). "The subhead is 22px" is not a finding; "the subhead is 22px, which is
   9px in the feed thumbnail, so raise it to 26 or cut it to four words" is.
4. **Name the strongest and the weakest thing.** A design has one focal point; if you
   cannot say which element it is, the design does not have one.
5. **A tie is a defect.** Two elements at the same largest size, two buttons, two
   accents: the gate reports the tie and the eye reports it as noise.

## Where the long answers live

| Read | When |
|---|---|
| `reference/gate.md` | every check the gate runs, what it measures and why - generated from the gate itself |
| `reference/copy.md` | the per-destination character and word budgets, and where each file is uploaded |
| `canvas-design` skill, `reference/document.md` | every key of every node kind, the token block, the defaults, and every validator code with its fix |
| `canvas-design` skill, `reference/recipes.md` | a copy-paste JSON fragment for the surfaces a patch reaches for |
