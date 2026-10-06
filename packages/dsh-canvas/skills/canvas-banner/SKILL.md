---
name: canvas-banner
description: "Design a banner, social preview or poster from nothing: pick the destination preset, then the composition, then write the words, then apply ONE look - and prove it with canvas_audit before you render. Use when the person asks for a banner, an OG card, a social image, a README header, a poster or a launch card and no design exists yet."
whenToUse: "The first call of any banner the person asked for and no design exists yet. Pairs with canvas-house-edit (when a house design already fits) and with the gate that canvas_audit runs. Read this before canvas_new, canvas_write, canvas_style or canvas_set."
---

# Designing a banner

A banner is not a picture with words on it. It is **a message at a size somebody will
actually see it** - 320px wide in a feed, a thumbnail on a repository page, a card in a
chat client - and every decision below exists to survive that size.

You are the designer. There is no image model anywhere in this loop: every pixel comes
from the document you write, so the craft is words, hierarchy, spacing and palette.

## The order is not negotiable

Do these five things in this order. Every failure this skill prevents comes from
swapping two of them - styling before the words, or composing before the destination.

1. **The destination decides the canvas.** `canvas_new { preset }` - never a guess at
   pixels, never a freeform canvas. The preset carries the exact size, the margin, the
   safe areas and the byte ceiling.
2. **The composition decides where things sit.** `archetype` when the brief is a KIND
   of design, `example` when a house design already fits. Both are proven answers and
   cost you nothing.
3. **The words decide whether it works.** Write them before you choose a colour, at the
   budgets in `reference/copy.md` (see the table at the end of this file).
4. **One look, applied once.** `canvas_style { id, style }` re-colours and re-types and
   never moves anything. Two looks is not a style, it is an accident.
5. **The gate, then the picture.** `canvas_audit` scores the design with no page open;
   `canvas_render` paints it and hands back a PNG, the measurements and a 25%-scale feed
   thumbnail. Look at both with `read_image`.

## The destinations, and what each one is for

These are the preset's own numbers; `canvas_read` prints the live table.

| Preset | Pixels | Margin | Reach for it when |
|---|---|---|---|
| `github-social` | 1280×640 | 48 | a repository's social preview card - the big landscape card |
| `github-readme` | 1280×320 | 48 | a README header: a wide, short band at the top of a page |
| `og` | 1200×630 | 64 | any link preview: chat, Slack, a docs site, a blog |
| `linkedin-personal-banner` | 1584×396 | 96 | a profile banner - the face sits bottom-left, so the left third is keep-out |
| `linkedin-company-banner` | 1128×191 | 40 | a company page cover - short, and the logo sits over the left |
| `linkedin-post` | 1200×627 | 56 | an image in the feed: the worst case for small type |
| `linkedin-square` | 1200×1200 | 96 | a square card - the most room, so the most temptation |
| `linkedin-carousel-page` | 1080×1350 | 72 | a page of a carousel: portrait, and it is READ rather than scrolled past |
| `x-post` | 1600×900 | 80 | an X/Twitter image: the centre is cropped in the timeline |
| `poster-a3` | 3508×4961 | 210 | print, at 300dpi - the one destination where body copy is the point |

**Two facts decide a banner's fate.** First, the preset's `safeAreas` are not
decorative: a LinkedIn profile banner loses its left third to the photo and an X post
loses its centre to the timeline's crop, and the `SAFE_AREA` lint names the rectangle you
reached into. Second, the feed thumbnail is 25% of the canvas - 320px for
`github-social` - so 14px is the floor for any type and a 40px subhead is a 10px smudge.

## The words, before the colour

Write them in this order and stop when the budget is spent.

- **Eyebrow** (1-3 words, `transform: "upper"`, `letterSpacing` 1.5-3, `caption` size)
  says WHAT KIND of thing this is. It is furniture, not content.
- **Headline** (at most about 7 words and 42 characters at display size) is the one
  sentence the banner exists to say. If the honest headline is longer it is two pieces of
  copy - a headline and a subhead - not one long line.
- **Subhead** earns the headline: how, or for whom. It never repeats the headline in
  smaller words.
- **One call to action**, one verb, in one place. Two buttons means neither is the action.
- **A URL or a wordmark** when the destination is a page somebody lands on.

Numbers beat adjectives ("4 tools, 1 file" over "powerful tooling"), and concrete nouns
beat abstractions ("`canvas_patch`" over "the engine").

## Composition, in numbers

These are the rules the gate and the render report both measure.

- **One focal point.** Exactly one element carries the most weight: the headline, or one
  picture. Two text nodes at the same largest size is a tie, and `canvas_audit` reports it
  as `FOCAL`.
- **A 2:1 type step.** The headline must be at least twice the next size below it: 72
  next to 40 reads as a tie, 72 next to 26 reads as a headline and a subhead. This is
  `TYPE_RATIO`.
- **Margins come from the preset, and every gap is a multiple of `tokens.space`.** Start
  the content frame at the preset's inset on all four sides and the `MARGIN` lint never
  fires. A 13px gap is what a design looks like when nobody decided.
- **At most two families and three or four sizes.** `Space Grotesk` for display, `Inter`
  for text, `system` for code and terminal motifs.
- **Centre type optically, not mathematically.** A block centred by arithmetic sits low,
  because the line box carries more weight below the glyphs than above; nudge it up 4-8px
  or use a frame with asymmetric padding. Trust the PNG.
- **Negative space is a material.** An empty half of the canvas is what tells the eye
  where to look. If the composition works at 60% coverage, stop.

## The surface under the words

- **Contrast is measured, not judged**: 4.5:1 for body, 3:1 at 28px and above. A text
  node over a frame with an opaque `background` samples that colour exactly, which makes
  the measurement easy AND the design readable. One over a gradient, a photograph or a
  busy art layer samples `unknown` and gets no verdict - which is not a pass.
- **`art` is deterministic** - the same `seed` is the same picture on every machine - so
  it is a background material rather than a randomiser. Two art layers maximum (one base,
  at most a low-opacity `grain`), `opacity` between 0.35 and 0.8 so type can sit on it,
  and never change a `seed` you have settled on.
- **A photograph needs a scrim before type may sit on it.** `scrim: "bottom"` at a
  strength of 0.65 or more, with the copy inside that band. Below 0.35 it is decoration.
- **A raw `svg` fragment is the escape hatch** for a wordmark or a glyph that JSON cannot
  express. It is scanned rather than trusted, and a refused fragment comes back as
  `SVG_TAG`, `SVG_ATTR`, `SVG_FORBIDDEN`, `SVG_EXTERNAL`, `SVG_EVENT` or `SVG_TOO_LARGE`.

## One design, several destinations

A launch needs a repository card, a banner and a link preview. They are the SAME design,
and `canvas_set` keeps them one: every derived design is the source with every number
multiplied by the width ratio, so the family cannot drift. It does **not** re-compose - if
a destination needs a different arrangement that is a different archetype, not a
derivation. Read the lints that come back with each derived design: they are that
destination asking for an adjustment, and the fix belongs in the FAMILY.

## Before you say it is done

```
canvas_audit { id: "launch-banner" }        # the gate: lints, ratio, budget, focal point
canvas_render { id: "launch-banner" }       # the picture, and the feed thumbnail
read_image <the PNG the report names>       # YOU, looking at what you made
read_image <the feed thumbnail path>        # the same design at the size it is seen
```

Then fix what you saw with `canvas_patch` - one or two operations per change, a render
between rounds. Two or three rounds is normal. A banner you have not looked at is a draft,
whatever the gate said.

## Read next

| Read | Where | When |
|---|---|---|
| the copy budgets | `reference/copy.md` | before you write a word: every destination's character and word budget, its size table and where the file is uploaded |
| the document language | `canvas-design` skill, `reference/document.md` | every key of every node kind, the token block, the defaults, and every validator code with its fix |
| the recipes | `canvas-design` skill, `reference/recipes.md` | a copy-paste JSON fragment for a mesh background, a terminal card, a glass panel, a stat row, a giant-type poster |
| the styles | `canvas-design` skill, `reference/styles.md` | the style library generated from the packs: every style's palette, type behaviour, do/don't and gates |
