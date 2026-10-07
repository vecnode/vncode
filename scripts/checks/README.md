# scripts/checks

Standalone verification for everything this pack ships. No check needs a running
harness, none is part of the installers, and all of them are Node-only — identical
on Windows, macOS and Linux. Run the one that owns the area you touched, before
you claim a fix.

```sh
node scripts/checks/check-no-secrets.mjs        # before anything is pushed
node scripts/checks/check-client-bundles.mjs    # every browser bundle, loaded and driven
node scripts/checks/check-node-routes.mjs       # every Node route, tool, the manifest, the pack-wide patches
node scripts/checks/check-dist-layout.mjs       # the distribution, the console contract, the ship list
node scripts/checks/check-media-node.mjs        # dsh-media: tools, routes, the ffmpeg pin
node scripts/checks/check-pdf-node.mjs          # dsh-pdf: the five tools and the routes
node scripts/checks/check-canvas-node.mjs       # dsh-canvas: engine, painters, store, tools, routes
node scripts/checks/check-writing-node.mjs      # dsh-writing: model, page breaker, ZIP/XML, .docx + .xlsx codecs, fonts, store, tools, the research skill, routes, and LibreOffice reading what it writes
node scripts/checks/check-skill-examples.mjs    # every fenced example in the shipped skills
node scripts/checks/check-media-examples.mjs    # every media/PDF example, shaped and really RUN
node scripts/checks/check-browser-node.mjs      # dsh-browser: the host renderer and its policy
node scripts/checks/check-splash.mjs            # the launcher window's own two halves
DSH_CHECK_LAUNCH=1 node scripts/checks/check-node-routes.mjs   # also opens a real directory picker
```

Windows PowerShell: `$env:DSH_CHECK_LAUNCH='1'; node scripts/checks/check-node-routes.mjs`.

## What each check covers

| script | what it proves |
|---|---|
| `check-no-secrets.mjs` | nothing credential-shaped would be staged by `git add -A`; the `.gitignore` credential rules are present; the scanner fires on a synthetic key, hides the value and stays quiet on clean text |
| `check-client-bundles.mjs` | every browser half loads through the real module table (`window.__ModuleLoader__.load`), activates against a stub cordis context, and is rendered/driven with a **real React runtime**; the exported `__internals` pure halves are driven directly (e.g. the audio/image byte decode in every shape a carrier could use) |
| `check-node-routes.mjs` | every Node route and tool of every host half, the git routes against a real repository, the skills registry, the manifest ⇄ `package.json` agreement, and the master's pack-wide row patches |
| `check-dist-layout.mjs` | the ship/skip list, every bundle declared, the two halves of every launcher, and the console layer — by actually RUNNING a launcher with no arguments |
| `check-media-node.mjs` | `dsh-media`'s pin against a **synthetic archive** built and served over loopback (download, hash verification, mismatch refusal, atomic install, resolution order), plus the ffmpeg-dependent half, which skips loudly without ffmpeg |
| `check-pdf-node.mjs` | the five `pdf_*` tools and the PDF routes against documents the check builds itself, including the engine's buffer semantics |
| `check-canvas-node.mjs` | the canvas host half hermetically in a temp `DSH_HOME`: engine, both painters, store, assets, all tools, every route, and the whole render round trip with a synthetic browser |
| `check-writing-node.mjs` | `dsh-writing`: the block model and Markdown round trip, the page breaker (splits, breaks, overflow, landscape), the ZIP and XML containers (CRC, corruption, refusals), the `.docx` codec both ways with fonts and sizes and its loss report, the `.xlsx` codec and its single-cell boundary against the sheet document, the machine's font reader against a **synthetic TrueType font it builds itself** (name table, OS/2 styles, truncated-file refusals), the document store with both kinds and every budget, all twelve routes, the **three `writing_*` tools driven against that same store** (a document created, read back with its marks and its revision, a stale `expectedRevision` refused, a workbook refused by name, a Markdown table arriving as paragraphs because the model has no table), the **bundled `research` skill** (registered, its rule present, every `reference/*.md` it names shipped) — and, last and most important, the pinned `@deepseek-ai/libreoffice-kit` opening the `.docx` AND the `.xlsx` this package writes (the page break makes a page; the formula cell reaches a PDF) — loud skip when the kit is absent |
| `check-skill-examples.mjs` | every fenced example in the shipped skills parses or compiles (Mermaid, TikZ, PDF, canvas, media) |
| `check-media-examples.mjs` | every media/PDF example is a well-formed tool call and, where this host can run one, actually runs |
| `check-browser-node.mjs` | `dsh-browser`'s host half: the disposable sandboxed renderer and the fetch policy in front of it |
| `check-splash.mjs` | the launcher window's payload and the console line it prints, including that a key-shaped value never reaches the page |

## The checks that need a real browser

These drive the shipped bundles in a headless Chromium-family browser. With none
installed they **SKIP LOUDLY** and exit 0, so a green run on a machine without a
browser is not evidence — read the output.

| script | what it proves |
|---|---|
| `check-canvas-panel.mjs` | the Canvas tab's right bar and direct manipulation, with the real bundle, engine and vendored faces — driven twice in one run: its own handlers (the editor it falls back to when the interaction layer cannot load) and the vendored Konva layer (the shipped path: hit testing, the hit graph, a drag that repaints before the host is asked, and one patch per gesture) — plus the bar's own menus, whose panels are **hit-tested** at their head, middle and foot, because a panel that drops out of a bar with `overflow:hidden` is clipped away however high its z-index ranks |
| `check-writing-browser.mjs` | the Writing tab's editor in a real page: the **six vendored Editor.js files loaded from this repository**, the pack's own paragraph/header tools rendering a marked run, the document arriving in the editor block for block, and **Save** reading the editor and posting that document back — plus the four behaviours that exist only once a page has run them: the **column is as wide as its pane** and the zoom doubles the TYPE (16px to 32px) without widening the column, a size set on a **selection** lands as a sized span, keeps the selection, survives the editor's own save as `size: 18` in the model and leaves the block next door alone, a **quote is refused** rather than losing the size later, and **Proof** hands the workspace copy to the preview under the kind the registry names, expands a collapsed right bar and opens the Desktop file in its own application |
| `check-canvas-browser.mjs` | the engine imported from a blob URL, the vendored faces loading and measuring, ink on the canvas, and the exported PNG |
| `check-audio-browser.mjs` | the audio console's device/routing/tone claims against the real browser APIs |

## The standard a check follows

1. **Drive behaviour, don't grep a call shape.** A source-text assertion is only
   acceptable next to a test that runs the same code; the pack has shipped a bug
   (a Remote method that does not exist) precisely because a grep stood in for a
   call.
2. **Build your own input.** A check makes the PDF, WAV, archive or design it
   needs instead of depending on a fixture that can rot.
3. **Skip loudly, never silently.** A missing browser, `git`, ffmpeg or TeX engine
   is reported as a skip with the reason; it must never read as a pass.
4. **Never weaken a check to make a change fit.** Fix the code, or change the
   check deliberately and say why in the commit.

There is **no CI on purpose**: these are run by hand. Wiring them into Actions
would re-add a workflow the maintainer deleted, and `check-dist-layout.mjs`
asserts that it has not come back.
