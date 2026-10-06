# AGENTS.md — working in vncode

A plugin pack for **one install target**: the DeepSeek Harness **web** profile
(`npx @deepseek-ai/dsh web`; profile `web` under `$DSH_HOME`, default `~/.dsh`).
Everything ships as a standard dsh **bundle**.

Read `ARCHITECTURE.md` for the map, the plugin's own `packages/<name>/README.md`
for its behaviour, `SECURITY.md` before touching credentials or the launcher, and
`scripts/checks/README.md` for what proves a change.

## Hard rules — do not break these

1. **One install target.** The web profile only. No desktop edition, no
   `-Target desktop`, no desktop detection. `app/` plus
   `scripts/run-desktop.bat` is a **launcher** of the same pinned `dsh web` on a
   free loopback port — it installs nothing and touches no profile or core file.
2. **Nothing patches core.** A row change is a new bundle layer.
   `dsh-vn-master` is the pack's final layer (it installs last), so pack-wide row
   patches belong there, and a package that *replaces* a row carries that row's
   disable with it.
3. **Platforms.** Plugin code is OS-neutral. Windows tooling is PowerShell and
   must work on **5.1 and 7** (`Join-Path`, `[System.IO.Path]::PathSeparator`,
   `$PSVersionTable`; never `$IsWindows` unguarded, never a hardcoded `npx.cmd`,
   `%USERPROFILE%` or `\`). macOS/Linux tooling is POSIX shell and must **never**
   require PowerShell — Node.js with npm/npx and nothing else.
4. **Launchers.** Every entry point lives in `scripts/`, one per action per host
   (`install.bat` / `install.sh`, `run-web.*`, `uninstall.*`), and there are **no
   forwarders**. On Windows the entry point calls the PowerShell worker beside it
   and gets its console behaviour from the one shared layer:

       if not defined VNCODE_CONSOLE set "VNCODE_ARGV=%*"
       call "%~dp0console\adapt.cmd" "%~f0" "<window title>"
       if errorlevel 10 exit /b 0         :: a Windows Terminal window owns the run
       if errorlevel 2  goto :nopowershell :: no PowerShell on this machine

   An entry point forwards `%VNCODE_ARGS%` and **never** `%*`; `adapt.cmd` must
   not `setlocal`; colour lives in `scripts/console/theme.ps1` and its POSIX twin
   `theme.sh`.
5. **The launch token is a live credential.** It is read in memory, never written
   to a file, echoed, or handed to a shell, and a URL that is not loopback is
   refused rather than opened. It appears only in `scripts/run-web.ps1` /
   `scripts/run-web.sh`.
6. **No secrets, ever.** Run `node scripts/checks/check-no-secrets.mjs` before
   pushing. A vendored bundle can ship its author's own credentials: redact them
   in the **build** (a patch under that engine's `vendor/<name>/patches/`, read
   before the artifact is committed), never with an allowlist entry.
7. **Zero npm dependencies** in shipped packages, and no network egress a plugin
   starts on its own. Engines are vendored under `lib/vendor/` or resolved from
   the harness already on disk.
8. **No CI, on purpose.** The checks in `scripts/checks/` are run by hand; they
   are the contract, and `scripts/checks/README.md` lists them.

## Layout

- `packages/<bundle>/` — one standalone bundle per plugin, each with its own
  one-page README: `dsh-vn-master` (final layer), `dsh-rightbar` +
  `dsh-rightbar-files` (the right bar and its Files tab), `dsh-editor`,
  `dsh-gittree` (History), `dsh-image`, `dsh-audio`, `dsh-video`, `dsh-media`
  (the only owner of ffmpeg), `dsh-supercollider` (SuperCollider: ten `sc_*` tools
  over a warm `sclang` session and a hand-written OSC client, the `.schelp`
  reference indexed, five skills whose every example a check compiles, one small
  console tab — host half plus UI, no bundled binary), `dsh-diagrams`, `dsh-pdf`,
  `dsh-canvas`,
  `dsh-writing` (the Writing tab, the pack's only `.docx` codec and its only
  method skill — `research`, the one that teaches a practice rather than a tool),
  `dsh-browser`, `dsh-themes`, `dsh-cmdbar`, `dsh-modal`, `dsh-skills`,
  `dsh-ui-state`, `dsh-open-in-app`.
- A package may carry its OWN checks under `packages/<name>/checks/`, run with
  `npm run check` in that folder. They travel with the package (which is what
  makes them useful outside this repository) and they are ADDITIONAL to
  `scripts/checks/`, never a replacement for it: `dsh-supercollider` ships three,
  and the pack-wide checks still own the routes, the bundle and the manifest.
- `scripts/` — the launchers, the installer workers, the shared console layer and
  `scripts/checks/`.
- `app/` — the Rust/Tauri launcher window (a launcher, not a desktop edition).
- `docs/` — install, build, deploy, distribute, release, paths, compatibility.
- `.dsh-version.json` — the pinned harness line and the pack manifest
  (its versions must match every `package.json`; `check-node-routes.mjs` enforces
  that).

## Verifying a change

Run the check that owns the area, and say which ones you ran:

- `check-no-secrets.mjs` — before anything is pushed;
- `check-dist-layout.mjs` — the distribution, the console contract, the ship list;
- `check-node-routes.mjs` — every Node route, the manifest, the pack-wide patches;
- `check-client-bundles.mjs` — every browser bundle, loaded and driven for real;
- `check-media-node.mjs`, `check-pdf-node.mjs`, `check-canvas-node.mjs`,
  `check-browser-node.mjs`, `check-splash.mjs` — the tool
  and host halves;
- `check-canvas-panel.mjs`,
  `check-canvas-browser.mjs`, `check-audio-browser.mjs` — the checks that drive a
  real browser (with none installed they skip loudly);
- `check-skill-examples.mjs`, `check-media-examples.mjs` — every fenced example in
  the shipped skills (parsed, compiled, or actually run);
- `npm run check` **in a package folder that ships its own** — today
  `packages/dsh-supercollider`, whose three checks cover the engine's OSC codec
  and discovery, the skill examples against a real SuperCollider, and the row's
  own contract (ten tools, three routes, five skills, the classic-script client
  bundle and its CSS prefix). They are additional to the list above, not a
  substitute for it.

A check that cannot run on this host says so loudly and exits 0. Never silence a
check, and never weaken one to make a change pass.

## Style

Comments and docs state the rule and the measurement behind it — the fact a
future editor must not break — not the changelog. Docs are **one page each**: no
alpha-by-alpha history, no re-explaining what the harness used to do.
