# dsh-writing (alpha.5)

**A document you write on and a workbook you edit, in the harness's own surfaces.**
The **Writing** tab sits in the chat panel's view ring to the right of Canvas; the
**Sheet**, **Headings** and **.docx** panes live in the right bar. Documents are
kept by this plugin, files are real files in the conversation folder, and
**nothing in this package renders Office** — "Proof" hands a written file to the
shipped preview, which is where the harness's own LibreOffice does the rendering
and the computing.

## The agent writes into the same documents you do (alpha.5)

Three tools, registered by this row and addressed by conversation:

| Tool | What it does |
|---|---|
| `writing_list` | the documents of this conversation (`scope: "library"` for the published ones) |
| `writing_read` | one document as Markdown, or its block model with `format: "blocks"` |
| `writing_write` | creates or replaces one document from Markdown, and answers its id, revision and word count |

**They are not a second model.** `writing_write` reads its Markdown with the same
`blocksFromMarkdown` the tab's Import uses and `writing_read` writes it back with
the same `documentMarkdown` its Export uses, so a document the agent composed is a
document a person edits, proofs and exports — headings, lists, quotes, code and
the six inline marks included. **The tools and the store the tab reads are the
same objects in the same process**, so a write is visible on the next state read
with no file watching and no second source of truth.

**What the model cannot hold, the tool says rather than hides.** There is no
table, image or footnote block in this model: a Markdown table arrives as
pipe-delimited paragraphs and the tool's own description says so. A **workbook**
is refused by name (a page tool that replaced a workbook would throw its sheets
away), and `expectedRevision` comes straight from the store's optimistic
concurrency, so a write that would land on a person's edit can be refused instead.

## The pack's one method skill

`skills/research/SKILL.md` ships with this package and both installers copy it
into `$DSH_HOME/skills`. Every other skill in this pack teaches a tool
(`canvas-design` teaches `canvas_*`, `pdf-analysis` teaches `pdf_*`); this one
teaches a **practice** — how a literature review is scoped, searched, triaged,
verified, synthesized and cited — and it ships here because the artifact a review
produces is the artifact this tab makes, and because its last step is a
`writing_write` call.

Its one rule is the one a review lives by: **no identifier you have not fetched.**
A DOI, a venue, a year or an author list that did not come off a page that was
actually loaded does not go in the document. It carries two reference files —
`reference/search.md` (query ladders, venue families, snowballing, and how to read
a publisher page) and `reference/citations.md` (IEEE reference forms, the receipt
to record per source, retraction and predatory-venue checks) — and
`check-writing-node.mjs` asserts the registration parses, the rule survives, and
every reference file it names is shipped.

## It edits in a vendored Editor.js

The surface is **Editor.js** — pinned, committed, and served from this plugin's own
route (see "How it plugs in"). It is a block list, not a sheet of paper: type, press
Tab or "/" for a block, and its own block menu inserts a header, a list, a quote or
a code block.

- **The pack's own tools carry what Editor.js's stock ones do not.** The vendored
  core loads with this package's `paragraph` and `header` tools: they render the six
  inline marks this model has (**b**, *i*, <u>u</u>, ~~s~~, `code`) and the run's own
  font and size, and they read them back into runs on save. The marks ride on a
  `data-mark` attribute rather than nested elements, because the browser is free to
  reorder nested markup when a person types inside it and it cannot reorder an
  attribute.
- **Every heading level is reachable, three ways.** The Document menu inserts
  Heading 1 through Heading 6 by name; the header tool is in Editor.js's own block
  menu; and a heading's own tune ("convert to") switches an EXISTING block between the
  six levels, the way Editor.js's stock header does. The level is the tool's own data,
  so it survives a save as the `<w:pStyle w:val="HeadingN">` the `.docx` carries.
- **The model follows the editor, not just the save.** What the editor says it holds
  is read back as you type (debounced), so the word count, the Headings navigator and
  the loss banner answer to what has been typed. **Save** reads the editor's own
  `saver.save()` first, so a keystroke that has not reached the model yet is still a
  keystroke somebody made.
- **The document's own typography is the editor's typography.** A family and a size
  belong to the document (the Document menu and the two controls on the bar), and
  they are applied to the editor's column, which is as wide as the page's content
  width — so what is on screen is what the `.docx` will say. Zoom widens that column.
- **New is one button and one keystroke.** It is the leftmost control on the bar and
  it makes the thing this tab makes: a real `.docx` on the Desktop. It opens the tab's
  own dialog (never the browser's prompt), the suggested name is selected so typing
  replaces it, **Enter creates the file and the dialog is gone**, and Escape or a
  click outside closes it without creating anything. A workbook has its own surface in
  the right bar and is not offered here, where only documents are written.
- **× removes the document you are writing on.** It is on the bar beside Save, where
  the document is in front of you; the rail's own Delete is still there for the rest.
- **A vendored file that does not arrive is not a dead tab.** The editor mounts with
  the tools that loaded, the status bar names the missing ones, and the text of their
  blocks is kept (Editor.js renders an unknown type as a paragraph) rather than lost.

## What it adds

- **A grid, not a table of text.** `writing-sheet` is a real spreadsheet pane:
  addressed cells (`A1`, `AB10`), a keyboard that walks the grid (Enter down, Tab
  right, arrows, Ctrl+S), sheet tabs with add/rename/remove, a `+20 rows` growth
  step, and up to 200 x 78 cells per sheet and 12 sheets per workbook.
- **Formulas are kept, never computed here.** A cell typed as `=SUM(B2:B3)` rides
  in the file as `<f>` with **no cached value**, beside
  `<calcPr fullCalcOnLoad="1"/>` — so LibreOffice and Excel compute it, which is
  what `check-writing-node.mjs` proves by handing a workbook it wrote to the
  harness's LibreOffice and getting a PDF back. A second formula engine would be a
  second answer to the same question.
- **A page setup that is written, not drawn.** A4/Letter, portrait or landscape and
  four margins in millimetres live in the Document menu: they are what the `.docx`
  carries (`w:pgSz`/`w:pgMar`) and what sets the editor column's width. There is no
  paper on screen — Editor.js has no page in it.
- **Documents AND files, and the difference is stated.** **New** writes a real
  `.docx` on the Desktop and opens it; **Import** links a file from the conversation
  folder. Documents live in this plugin's own store
  (`$DSH_HOME/dsh-writing/sessions/*.json`, the `dsh-diagrams`
  shape, plus `library.json` for published ones); a file is *linked* through
  `origin`, **Save** writes the store copy and then the file
  atomically, and a file that moved on disk answers **409 CHANGED_ON_DISK** with
  Reload / Keep-mine rather than being clobbered. Export takes a `-2`, `-3` name,
  so a copy never overwrites the original.
- **A document made by New is linked to its Desktop file, and Save writes THAT.**
  `origin` may be a workspace-relative path (an imported file) or the absolute path
  of a file this package created on the Desktop; the host accepts an absolute one
  only when its own folder IS the Desktop, and refuses anything else with
  `403 OUTSIDE_WORKSPACE` rather than writing to a path a caller chose.
- **Proof and Export write to the Desktop of the machine running the harness.** That
  is where a person looks for a file they just asked for. **Proof** also has the host
  write a disposable copy inside the conversation folder, because core's document
  preview can only be handed a workspace address — the preview shows what LibreOffice
  made of the file, and the Desktop copy is the one that stays.
- **The `.docx` codec, both directions, no dependencies.** `lib/zip.js` (ZIP over
  `node:zlib`, CRC-32, typed refusals for ZIP64/encryption/corruption),
  `lib/xml.js` (an OOXML-shaped reader — no DTDs, no entity expansion),
  `lib/ooxml.js` (parts, styles, numbering, `w:sectPr`, fonts and sizes out and
  back). Reading a real Word file reports what the model cannot hold — tables,
  images, footnotes, endnotes, fields, equations, comments, tracked changes,
  content controls, links — as counted losses the tab shows BEFORE a save that
  would drop them.
- **Fonts: every family the machine has.** `lib/fonts.js` walks the platform's font
  directories and reads each file's `name` table in pieces (a 37 MB collection
  costs the same as a 300 KB face). The toolbar offers them in a `<datalist>` that
  filters as you type, a size box in points (half-point granularity, because that
  is what `w:sz` carries), and a **Document font / Document size** pair in the
  Document menu for what every run inherits. A run that says what the document
  already says carries neither, which is what makes "change the document font" one
  write instead of hundreds. On the machine this was built on: **234 families from
  486 files, none unreadable**.
- **Headings, twice.** A **Headings** panel inside the Writing tab (indented by
  level, click to jump, the active one highlighted) and a **Headings** pane in the
  right bar showing the outline of whatever document the tab has open — for a
  workbook, its sheets.
- **The right bar, three pane types.** `dsh-writing` claims `.docx` (editable,
  where the shipped preview keeps every other file), `dsh-writing-sheet` claims
  `.xlsx`, and `dsh-writing-outline` is the navigator. Each carries a guide entry
  for the "+" page. Claiming `.xlsx` means an `.xlsx` opened from Files lands in
  the GRID rather than in the shipped preview's spreadsheet view — deliberately,
  because the point is to edit it, and the pane's own **Proof** renders the workbook
  it writes with that same preview in one click.
- **Proof is core's LibreOffice.** The button writes the `.docx` to the Desktop and
  hands the preview a workspace copy of it (whose kind is read out of the tab
  registry, never hardcoded), and that preview converts and paints it. The tab
  composes the file; core shows what LibreOffice makes of it. The sheet pane's own
  Proof does the same for a workbook.
- **Import** `.docx`, `.xlsx`, `.md`, `.txt`; **export** `.docx`, `.md`, `.txt` (and
  a workbook as `.xlsx`). `.doc`, `.odt`, `.rtf`, `.xls` and `.ods` are refused WITH
  the way out ("open it in LibreOffice or Word and save it as .docx"), because that
  is a real answer and "unsupported" is not.
- **Keyboard** (Editor.js's own, plus one shortcut this tab keeps): Tab inserts a
  block, "/" opens the block menu, Enter splits, Ctrl/Cmd+B and Ctrl/Cmd+I are the
  inline toolbar's marks, and **Ctrl/Cmd+S saves**.
- **Autosave** after 4 s of quiet, plus one last attempt when a tab closes.

## The vendored Editor.js, and why it is vendored

The pack ships **zero npm dependencies**: the profile installs every bundle as a
live link, so a `dependency` is not installed and a plugin cannot `import` one at
runtime. The editor is therefore fetched from its own upstream, pinned by hash, and
committed — the same bargain the vendored Konva, CodeMirror, Mermaid, pdf.js and
fonts make.

| Piece | Where |
|---|---|
| pins and the fetch/build | `packages/dsh-writing/vendor/editorjs/` (`build.mjs`, `--check` re-hashes offline) |
| the committed artifacts | `lib/vendor/editorjs/` — the core (`@editorjs/editorjs` 2.31.7, Apache-2.0) plus `paragraph`, `header`, `list`, `quote`, `code` (MIT), each upstream's own self-contained UMD build, with the licence text beside it |
| served at | `/api/dsh-writing/vendor/editorjs/<file>`, one exact route per file, ETag from the record, `503 VENDOR_MISSING` if the artifact is not in the checkout |
| the model bridge | `lib/editorjs.js` (pure, host side) and the same translation in the browser half, driven by the checks from both sides |

Nothing is forked and nothing is patched: the only mechanical change is CRLF→LF with
one trailing newline, because `.gitattributes` stores text as LF and the bytes are
hashed.

## How it plugs in

| Piece | Value |
|---|---|
| row | `writing` (one inserted row; no core row disabled, no fork) |
| tab | `conversation.view` id `writing` at `order: 30` — right of Canvas (20), Trajectory (10), Chat (0) |
| panes | `sidebar.right.pane.tab` keys `dsh-writing` (.docx), `dsh-writing-sheet` (.xlsx), `dsh-writing-outline` (headings) |
| tools | `writing_list`, `writing_read`, `writing_write` (`lib/tools.js`), registered into `ctx.tools` BEFORE the connection check, so a profile without a web carrier still gets them; `inject` is `['connection', 'tools']` |
| skill | `research`, from `skills/research/SKILL.md`, registered on `ctx.skills` and copied into `$DSH_HOME/skills` by both installers |
| state | `$DSH_HOME/dsh-writing/sessions/<session>.json`, `$DSH_HOME/dsh-writing/library.json` |
| client services | `slots`; `sidebarRight` and `sidebarRightTabs` are resolved LAZILY, so the tab works with the right bar unmounted |
| checks | `check-writing-node.mjs`, `check-writing-browser.mjs`, and the `dsh-writing` section of `check-client-bundles.mjs` |

Routes are exact paths, `GET`/`HEAD`/`POST` only, all behind the harness's session
auth:

| Method | Path |
|---|---|
| `GET`/`HEAD` | `/state`, `/document`, `/outline`, `/fonts`, `/page.js` (the block splitter — served, and NOT read by the tab any more), `/vendor/editorjs/<file>` |
| `POST` | `/document`, `/delete`, `/publish`, `/import`, `/export`, `/create-file`, `/save-file`, `/open-file` |

The workspace root is resolved on the host from the live session header, else from
session persistence — the lookup `@deepseek-ai/dsh-api-workspace-files` does — and
every path is realpath-checked inside it. The client names a session and a relative
path, never a root.

## Limits

- **There is no page on screen.** The editor is a block list: no page boxes, no
  margins drawn, no sheet numbers, and a paragraph does not continue "onto the next
  page". `lib/page.js` (the block splitter) is still part of this package, still
  served, and still driven by `check-writing-node.mjs` against synthetic line data —
  but the tab does not import it, and a page view that came back would be new work.
- **Inline marks are attribute-based, so a paste can lose one.** The pack's own
  tools round trip all six marks; a mark Editor.js's stock tools do not know comes
  back as text, and the banner says so.
- **Per-run font and size do not survive an edit.** They ride in the model and in
  the `.docx`, and they are applied on screen; a run that names its own family or
  size is reported as a counted loss, because Editor.js's tools hold text.
- **The block menu is Editor.js's, so a `pageBreak` is shown as a separator.** A
  document imported from a `.docx` with a page break keeps it in the model (and in
  the file it writes), and the banner says it cannot be drawn as a page.
- The spreadsheet has no cell formatting, number formats, borders, merged cells,
  column widths, sorting or charts; reading a file that HAS them reports them as
  counted losses rather than silently dropping them. Formulas are never evaluated
  in the tab.
- The page reader does not read `.doc`, `.odt` or `.rtf`; the workbook reader does
  not read `.xls` or `.ods`.
- Budgets: 64 documents a conversation, 512 KiB a document, 4 MiB a conversation,
  4000 blocks, and a workbook's 12 sheets of 200 x 78 cells.
- **Undo is the browser's** (Ctrl+Z inside a block). There is still no document-wide
  undo stack, and Editor.js does not bring one.

## Verify

```
node scripts/checks/check-writing-node.mjs
node scripts/checks/check-client-bundles.mjs
node scripts/checks/check-node-routes.mjs
node scripts/checks/check-writing-browser.mjs   (skips loudly with no Chromium)
```

`check-writing-node.mjs` drives the whole host half with no browser: the model, the
store, the `.docx`/`.xlsx` codecs, the font reader, the block splitter against
synthetic line data — and, new with the editor, **the vendored surface**: every
recorded artifact re-hashed against `lib/vendor/editorjs/VERSION.json`, each of the
six routes driven for its bytes, its recorded ETag and a 304, a name outside the
allowlist refused, and the model↔block-JSON bridge round-tripped (lists and their
nesting included, an unknown block kept as a paragraph with its text and reported).
It ends with the claim that matters: it writes a `.docx` and a `.xlsx` with this
package, hands both to the pinned `@deepseek-ai/libreoffice-kit`, and asserts
LibreOffice opens them — with the document's page break producing exactly one more
page than the same document without it, and the workbook's formula cell surviving to
a PDF. Without the kit on the host that section skips loudly.

`check-client-bundles.mjs` drives the browser half's pure functions with no browser:
the run model, the mark algebra, the block rules, the HTML reader/writer the pack's
tools use, and the SAME Editor.js bridge cases the host check drives — which is what
keeps the two implementations of a translation that cannot be shared (one bundle has
no imports; the other may touch no DOM) in step.

The tools and the skill are driven by `check-writing-node.mjs` against a **stub
run context and the real store**: three tools registered with a JSON-schema
surface, a document created and read back with its marks and its revision, a
second write replacing rather than creating, a stale `expectedRevision` refused
with `CONFLICT`, an unknown id naming what the store does hold, a Markdown table
arriving as paragraphs (the documented limit, asserted so it cannot quietly
become a promise), a workbook refused by name, and the library scope publishing
into the store the conversation does not see. The skill is asserted with it: one
registration named `research`, the rule text present, and **every `reference/*.md`
the document names present on disk** — a skill that points at a file it does not
ship sends the agent into an empty read.

`check-writing-browser.mjs` mounts the real editor in a real browser: six vendored
files loaded from this repository, the holder, the pack's own paragraph tool
rendering a marked run, the document arriving in the editor block for block, and
**Save** reading the editor and posting that document back. With no Chromium-family
browser it skips loudly and exits 0.

**The gap that is left, stated rather than hidden:** synthetic typing does not reach
Editor.js's change event in a headless page (it defers that event to a
`requestIdleCallback`, which a page that never paints does not reliably run), so the
"typing updates the model" path is covered by the pure checks above and by the
person, not by the browser check. It is the first thing to add when a real typing
harness is worth the machinery.

## Install

The launcher (`scripts\install.bat` / `./scripts/install.sh`) auto-discovers the
package as a standard `dsh.bundle`, and the uninstall twins do the same. It is a
live link in the web profile, so a bundle edit needs a hard refresh; a change to a
row (or a new package) needs a restart of `npx @deepseek-ai/dsh web`. A rebuild of
the vendored editor is `node packages/dsh-writing/vendor/editorjs/build.mjs`.
