# dsh-canvas (alpha.15)

**The Canvas tab: a design page the agent drives, in the chat panel's own view ring
to the right of Trajectory.**

The model authors a small JSON design language, the host validates and stores it,
and the **browser** paints it: the model reads the returned PNG with `read_image`
and fixes what it sees, which is the loop. There is no image-generation model here
(pictures come from the workspace, a paste or the seeded `art` generators), a
design is JSON rather than HTML/CSS, and a render needs the **app page** open - no
page answering within 20 s says so.

## What it adds

- **Twelve tools**: `canvas_new`, `canvas_write`, `canvas_patch` (pointer ops, at
  most 64 a call), `canvas_read`, `canvas_style`, `canvas_set` (one design derived to
  several destinations), `canvas_publish`, `canvas_delete`, `canvas_render`,
  `canvas_export`, `canvas_assets`, and `canvas_audit`.
- **THE PERFECT GATE** (`lib/gate.js`, alpha.15): one function over a laid-out design
  that scores it against five checks - the engine's own lints, the 2:1 type ratio, the
  copy budget its own typography allows, and a single focal point. `canvas_audit` is that
  function as a tool, so the model can score any design (or its own patch) with **no page
  open**. All twelve house examples pass it, and `check-canvas-node.mjs` runs the whole
  gallery through it: a starter that stops being perfect fails a check rather than a
  person's eye. What the gate means is generated into
  `skills/canvas-house-edit/reference/gate.md` and a check re-runs the generator, so the
  document the model reads cannot drift from the contract the tool enforces.
- **The document language**: `preset` (or an explicit `canvas`), `tokens` and
  `layers`; six node kinds (`frame`, `text`, `image`, `shape`, `art`, `svg`); a
  CANONICAL form (tokens resolved, defaults filled) and every refusal a code.
- **Ten presets as data** with a `verifiedOn` date and sources - `github-social`
  (1280x640), `github-readme`, `og`, `linkedin-personal-banner` (1584x396),
  `linkedin-company-banner`, `linkedin-post`, `linkedin-square`,
  `linkedin-carousel-page`, `x-post`, `poster-a3` (3508x4961) - each with its
  formats, byte ceiling, safe/keep-out areas, margin and click path.
- **Eight archetypes, twelve styles, twelve house examples**: `canvas_new` and the
  tab's **+ New** start from the same files, and `canvas_style` applies a look
  (`lib/styles/<id>.json`) through one pure transform that re-colours and re-types
  a design and **never moves anything** - as a delta against the style it carries.
- **One layout, two painters**: `lib/engine.js` is one file with zero static
  imports (the browser imports it from a blob URL); the layout is pure with the
  text measurer **injected**, and one draw-op list feeds the canvas painter (which
  serves the artboard **and** the PNG export) and the SVG serializer.
- **The stage is a drafting grid** (alpha.15), and the rulers are gone. The page used to
  carry a 22px ruler gutter on the top and the left, which cost the artboard 44px of every
  pane at every zoom for numbers the transform controls already print. It now draws a 16px
  grid behind the artboard - a 1px rule every 64px and a dot at every intersection - and
  centres the design in the pane, so a fitted design shows the workspace around it instead
  of running edge to edge. That centring is the change that makes the grid visible at all:
  the ruler gutters were also what sized the artboard to the pane.
- **The interaction layer** (alpha.13): a vendored Konva 10.7.0 (188 KB, one UMD
  script, no dependencies) draws nothing anybody sees - one invisible hit rect per
  laid-out box, nested exactly like the document, so the deepest node under the
  pointer wins - and it is what makes a drag follow the pointer: the tab applies the
  operations locally (`engine.applyPatches` -> `engine.layout` -> one paint) and
  commits **one** patch when the gesture ends, through the same route and validator
  as every other edit. Resizing stays the pack's own vocabulary (`handlesFor`,
  `edgesAt`, `resizeOps`) on both pointer surfaces. Konva's Transformer was built,
  measured and removed: its anchors paint nothing in this embedding (see
  `check-canvas-panel.mjs`) - and the engine remains the only painter.
- **The Konva painter** (`lib/konva-paint.js`, alpha.13): the module that replays the engine's
  draw-op list into **real Konva nodes** - `Konva.Rect`, `Konva.Ellipse`, `Konva.Line`,
  `Konva.Path`, `Konva.Image`, and a `Konva.Shape` whose `sceneFunc` draws a line of text by the
  engine's own rules (baseline, font shorthand, per-character tracking). It has zero static
  imports, is served by this package and imported from a blob URL, and `stageFor()` is the one
  entry point the artboard and an export would share. **Its parity against the engine's painter
  is measured, not assumed**: `check-canvas-browser.mjs` renders the same ops through both and
  compares the pixels per op kind - solid rects and every line of text are pixel-identical
  (worst channel delta 0-1), and an **ellipse's gradient fill is an open gap that the check
  records and refuses to hide**. Until that gap closes, engine.js remains the painter of the
  artboard, the render report and the PNG export.
- **Snapping** (alpha.13): a dragged layer aligns to the canvas's own edges and centre and
  to every other layer's edges and centres, within 6 screen pixels - and the guide line it
  draws comes from the SAME pure call that decides the movement (`snapFor`), so a line can
  never describe a snap the document did not get. The guide goes with the gesture.
- **The object verbs and the in-place text editor** (alpha.13): `+ Add` (text, a
  rectangle, an ellipse - sized and coloured from the design's OWN tokens), and
  Duplicate / Delete / To front / To back on the selected layer. Every one is a
  `canvas_patch` the agent could have written (`lib/client.js`'s `objectOps`), so a
  button press cannot produce a document the model's own tool would refuse. A text
  layer's words are edited **on the canvas**: the field is laid over the block's own
  box in the block's own type, Enter commits one `set .text`, Escape writes nothing -
  and a rich-text layer (the model's `runs`) is seeded with its runs joined and
  committed as `text` with `runs` removed in the same patch.
- **The render queue**: `canvas_render` enqueues the document and its revision, the
  page paints and posts back the PNG, a 25%-scale feed thumbnail, the measurements
  and the lints; the verdict is `drawn` / `failed` / `stale` / `pending`.
- **Advisory lints**, each with a fix: `SAFE_AREA`, `MARGIN`, `LOW_CONTRAST`, `TYPE_TOO_SMALL`,
  `TEXT_TRUNCATED`, `TEXT_OVERFLOW`, `TEXT_UNWRAPPED`, `MANY_SIZES`, `MANY_FAMILIES`, `NO_TEXT`,
  `MISSING_ASSET`, `IMAGE_UNMEASURED`, `SVG_FRAGMENT_UNPAINTED`.
- **Exports**: PNG/JPG/SVG at 1x or 2x, to the Desktop (default) or the
  conversation folder, create-exclusive (`-2`, `-3`, ...); the preset decides the
  format and the ceiling, and one over the ceiling still writes and says so.
- **Assets**: a stored image content-addressed by SHA-256, or a workspace-relative
  path resolved on the host with `realpath` containment - a remote URL is not a
  thing a design can name.

There is **one surface**, and it is this one. The vendored Excalidraw editor that
alpha.10-12 mounted over the design page is gone (alpha.13): a second editor with its
own element model cannot be kept in step with a document the host validates, and the
tab's contract is that what the model wrote is what the person edits. The engine is
the only painter, on screen and in the exported file.

## How it plugs in

| Piece | Value |
|---|---|
| row | `canvas` (one inserted row; no core row disabled, no fork) |
| tab | `conversation.view` id `canvas` at `order: 20` - right of Trajectory (10), after Chat (0); unlike Trajectory it is not gated on developer tools |
| session | a view receives no `sessionId` prop; it learns its session through its own `inject(sessionId)` face |
| seats | one `tool.call.toolview` per tool name, plus the page-level renderer |
| addresses | `dsh-resource://canvas/session/<session>/<id>`, `dsh-resource://canvas/library/<id>` |
| skills | four: `canvas-design` (the language and the craft), `social-banners` (per-destination delivery), `canvas-banner` (a banner built from nothing), `canvas-house-edit` (edit a house design, and the gate as the bar). Registered at runtime **and** copied into `$DSH_HOME/skills` by both installers under a `.vncode-dsh-canvas` marker |

Routes are exact paths, `GET`/`HEAD`/`POST` only:

| Method | Paths |
|---|---|
| `GET` | `/api/dsh-canvas/state`, `/health`, `/render-queue?session=*`, `/workspace-asset`, `/vendor/engine.js`, `/vendor/konva.js` |
| `POST` | `/api/dsh-canvas/document`, `/delete`, `/publish`, `/render-report` |
| both | `/api/dsh-canvas/asset`; one immutable route per vendored font file under `/vendor/fonts/<file>` |

## Limits

- canvas 8192 px a side, 512 top-level layers, 4096 nodes, 12 levels of nesting,
  256 KB a document, 4 MB of designs per conversation, 64 designs.
- 12 MB an asset, 256 assets / 256 MB in total; a report render is capped at
  2048 px on the long edge and an export at 48 MB.
- Fonts: Inter 400/600/700 and Space Grotesk 500/700 as Latin WOFF2 subsets (96 KB), served
  from this plugin's own routes and loaded **before** the first layout; `system` is the mono role.
- No host renderer for a tool call, no image generation, no HTML/CSS, one artboard
  per design, no npm dependencies.

## Verify

```
node scripts/checks/check-canvas-node.mjs
node scripts/checks/check-client-bundles.mjs
node scripts/checks/check-canvas-panel.mjs        # needs a Chromium-family browser
node scripts/checks/check-canvas-browser.mjs      # needs a Chromium-family browser
node scripts/checks/check-skill-examples.mjs
```

`packages/dsh-canvas/vendor/konva/build.mjs --check` re-hashes the vendored
interaction layer offline, and `check-canvas-panel.mjs` drives BOTH of the tab's
pointer surfaces in one run - its own handlers (the fallback when the interaction
layer cannot load) and the vendored layer (the shipped path) - plus the Add menu and
the layer verbs through the real UI. The in-place text editor's UI needs a mount of a
SETTLED document (its control is in the layer list, which those verbs churn), so what
is pinned today is its pure half: which words a layer holds and the exact operations a
commit writes (`check-client-bundles.mjs`), and that the engine applies them
(`check-canvas-node.mjs`).
