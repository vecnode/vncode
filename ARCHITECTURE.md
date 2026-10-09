# ARCHITECTURE.md — the pack on one page

A plugin pack for **one install target**: the DeepSeek Harness **web** profile
(`npx @deepseek-ai/dsh web`, profile `web` under `$DSH_HOME`, default `~/.dsh`).
Every plugin here is a standard dsh **bundle**; nothing patches a harness file,
and there is no desktop edition. (`app/` + `scripts/run-desktop.bat` is a
*launcher*: it starts the same pinned `dsh web` on a free loopback port and shows
that URL in a native window. It installs nothing and touches no profile file.)

## How a plugin ships

- An npm package with `dsh.bundle` plus `cordis.patch.yml`. A UI plugin adds
  `dsh.client` and an `exports["./client"]` browser bundle.
- The browser bundle is a hand-written **module table** entry
  (`window.__ModuleLoader__.load({ id, factory })`) — no build step — except the
  few bundles marked GENERATED, which are forks of shipped ones or vendored
  engines.
- The installer live-links the package folders into the profile. A bundle edit
  shows up on a **page refresh** — the host stat-polls every client bundle
  (`dsh-client-hmr`, 500 ms) and republishes it through `rebuilt()`, re-reading
  the file, so nothing has to be restarted for it; a change to a *row*, or to a
  package's `lib/index.js` host half, is composed at boot, so it needs a
  **restart**.

## Rows, and who owns them

Core rows come from the pinned line. The pack adds its own rows and may
disable/replace a core row **in its own layer** — a later layer wins per row.

- `dsh-vn-master` installs **last**, so it is the pack's final word on any row.
  Pack-wide patches belong there: today it disables the four feedback/telemetry
  rows **and** the pack's own `browser` row (built, shipped and deliberately off —
  only this layer's two lines re-enable it).
- A package that **replaces** a row carries that row's disable with it
  (`dsh-rightbar` disables `ui-sidebar-right` / `ui-sidebar-files`,
  `dsh-open-in-app` disables `ui-open-in-app`), so a partial install still mounts
  exactly one of each surface.

## The plugins

| package | row | what it is |
|---|---|---|
| `dsh-vn-master` | `master` | the final layer: no-op host row + pack-wide row patches |
| `dsh-rightbar` | `rightbar` | the right bar: tab strip, docking panel, Start page, `sidebarRightTabs` registry + `sidebarRight` controller |
| `dsh-rightbar-files` | `rightbar-files` | the Files tab type on that bar (fork of the shipped file tree) |
| `dsh-editor` | `editor` | text/code editor tab (vendored CodeMirror 6), create-on-save, Markdown preview hand-off |
| `dsh-gittree` | `gittree` | read-only **History** tab: commit graph, message, changed files |
| `dsh-image` | `image` | image viewer tab: fit/zoom/pan, pixel readout |
| `dsh-audio` | `audio` | waveform tab (WAV/AIFF/FLAC) + the Audio console (devices, routing, test tone) |
| `dsh-video` | `video` | video player tab; the bytes stay on the host and stream through a Range route |
| `dsh-media` | `media` | the pack's ffmpeg owner: `media_probe` / `media_run` / `media_frames`, the Range file route, remux jobs |
| `dsh-supercollider` | `supercollider` | SuperCollider the agent can play: ten `sc_*` tools over one warm `sclang` session (~31 ms a call, state kept) and a hand-written OSC client to `scsynth`, the installed `.schelp` reference indexed for `sc_help`, the `.scd` file workflow, five skills whose every example is compiled by a check, and one small console tab |
| `dsh-diagrams` | `diagrams` | Mermaid + TikZ surfaces and the six `diagram_*` tools, validated on the host |
| `dsh-pdf` | `pdf` | PDF reader tab + `pdf_info` / `pdf_read` / `pdf_find` / `pdf_render` / `pdf_scan` over vendored pdf.js |
| `dsh-ocr` | `ocr` | the pack's OCR owner: one tool, `ocr`, over `tesseract` from PATH or the OCR engine Windows itself ships (`lib/win-ocr.ps1` + `Windows.Media.Ocr`, which rasterizes a PDF page through `Windows.Data.Pdf`). Host-only — no client, no route |
| `dsh-canvas` | `canvas` | Canvas tab: a JSON design language, a browser painter, PNG export |
| `dsh-writing` | `writing` | Writing tab (a document) + right-bar panes (a `.xlsx` grid, a Headings navigator, an editable `.docx`) + the three `writing_*` tools the agent writes documents with + the `research` skill: documents in its own store, real files on disk, and three hand-written codecs (`.docx`, `.xlsx`, the machine's fonts) — with the harness's own LibreOffice as the proof renderer and the formula engine (`Proof` writes a file and hands it to the shipped office preview; nothing here renders or computes) |
| `dsh-browser` | `browser` | web surface: the host fetches and renders a page in a disposable sandboxed browser (**currently disabled by the master**) |
| `dsh-themes` | `themes` | extra palettes (Nord, Monokai, Hacker, Cyber), header controls, branding, account-menu trimming |
| `dsh-cmdbar` | `cmdbar` | the command bar: a read-only transcript of the agent's own commands |
| `dsh-modal` | `modal` | the shared dialog surface (`modals` service) |
| `dsh-skills` | `skills` | the Skills browser: list, read and edit the skills the harness loads |
| `dsh-ui-state` | `ui-state` | UI state that outlives the process (column widths, dock height, zoom) |
| `dsh-open-in-app` | `native-open-in-app` | the file-manager half of Open In |

## Rules that hold everywhere

- **Zero npm dependencies.** Every engine is vendored in `lib/vendor/` or resolved
  from the harness already on disk. No plugin reaches the network on its own.
- **OS-neutral JavaScript.** The only per-OS code allowed is a launcher choosing a
  command: Windows runs PowerShell (5.1 *and* 7 — never assume 7), macOS/Linux run
  POSIX shell and never PowerShell.
- **Client-only by default.** Bytes and paths come from the harness's own
  `remote.workspaceFiles` (`readBytes`) or from the plugin's own authenticated
  route under `/api`. A plugin publishes a path policy only when it must, and then
  it realpath-checks on the host side.
- **Routes are exact paths, `GET`/`HEAD`/`POST` only** (plus the editor's `PUT`),
  registered through the connection's fetch registry, all behind the harness's
  session auth.
- **State** lives under `$DSH_HOME/<package>/`, scoped per conversation where that
  is the scope, written atomically, with an LRU cap where it can grow.
- **Everything is a bundle**: to change a row, add a layer; never edit core.

## Where the detail lives

- one page per plugin: `packages/<name>/README.md`;
- operations: `docs/INSTALL.md`, `docs/BUILD.md`, `docs/DEPLOY.md`,
  `docs/DISTRIBUTE.md`, `docs/RELEASE.md`, `docs/PATHS.md`,
  `docs/COMPATIBILITY.md`;
- security: `SECURITY.md`;
- **the checks are the contract**: `scripts/checks/*.mjs` are run by hand (there
  is no CI, on purpose) and pin route registrations, bundle wiring, budgets, the
  launcher contract and the credential rules. `scripts/checks/README.md` lists
  them.
