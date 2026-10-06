# The perfect gate, v1

GENERATED from `lib/gate.js` by `vendor/gate-doc.mjs` - a check fails when this file
is not what the gate would produce, so it cannot drift from the contract the tool
enforces. Run it yourself any time with `canvas_audit`.

A design is **perfect** when every check below is `pass` or `skip`. A check that
CANNOT be judged says `skip` and is not a failure: a design with no text has no
type ratio to measure, and inventing one is how a gate becomes noise.

## The checks

| Check | What it measures | When it fails |
|---|---|---|
| `SYNTAX` | preset, tokens, layers and every node kind accept this design | The validator names the path and the code. Fix that field and audit again - nothing else can be judged until the document is legal. |
| `LINT` | margins, safe areas, contrast, type size, overflow, alignment, assets | The engine names the code and the node. `MARGIN` and `SAFE_AREA` are placement; `LOW_CONTRAST` is the ink against the paint behind it; `TYPE_TOO_SMALL` is the 14px floor; `TEXT_OVERFLOW`, `TEXT_TRUNCATED` and `TEXT_UNWRAPPED` are the words against their box; `OFFGRID` and `SIBLING_EDGE` are alignment; `TEXT_ON_IMAGE` asks for a scrim; `MISSING_ASSET` is an image the design cannot paint. |
| `TYPE_RATIO` | the largest type is at least 2x the next distinct size | Raise `tokens.scale.display`, or lower the size below it. A headline 2x the next size is the floor, not a target. |
| `COPY_BUDGET` | the total word count against the budget the preset’s own scale implies | Cut words, or move them into the subhead. Never shrink the type to fit words - the budget is derived from the type, so that is the one fix that cannot work. |
| `FOCAL` | one text node is the largest on the canvas, with no tie | Make one of the tied elements smaller, or demote it to the caption scale. A tie between two largest elements is the same as no focal point. |

## What the copy budget is

`COPY_BUDGET` is not a table of hand-typed numbers per destination. It is the
design’s OWN arithmetic against the destination’s width: a headline may run to
two lines and a banner carries one line of support, measured at the sizes the
document actually uses (0.5em an average glyph, six characters a word). So a design
that shrinks its headline to fit more words gets a bigger budget and a worse
design, which is the correct trade - and one that picks a display size it cannot
fill is told so.

For reference, the budget the twelve house designs are held to:

| House example | Destination | Words | Budget |
|---|---|---|---|
| `announcement` | `og` | | 14 |
| `campaign-wash` | `linkedin-post` | | 17 |
| `command-proof` | `github-social` | | 18 |
| `developer-card` | `og` | | 22 |
| `docs-cover` | `og` | | 14 |
| `night-launch` | `github-social` | | 18 |
| `printed-announcement` | `linkedin-post` | | 13 |
| `product-launch` | `github-social` | | 15 |
| `quiet-statement` | `og` | | 14 |
| `release-numbers` | `linkedin-post` | | 18 |
| `the-plan` | `linkedin-post` | | 17 |
| `wordmark-page` | `og` | | 12 |

## The other four checks in the package

Two more things are measured, and they are not part of the gate because they
answer different questions:

- **The render report** (from `canvas_render`) carries the same lint codes plus the
  measurements of the painted result - it is the picture, and the picture is the
  only authority on whether a design READS.
- **The destination rules** (`preset.formats`, the byte ceiling and the safe areas)
  are the delivery contract, not the design: `canvas_export` and `canvas_set` report
  a file that cannot be uploaded where it is going.
