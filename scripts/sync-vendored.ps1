#Requires -Version 5.1
<#
.SYNOPSIS
    Re-syncs the vendored DeepSeek Harness client bundles this pack forks.

.DESCRIPTION
    The pack owns its right bar: instead of depending on the shipped
    @deepseek-ai/dsh-client-ui-sidebar-right / -sidebar-files rows, it ships
    byte-for-byte copies (module-table client bundles) under its own package
    names, and its bundle layer hard-disables the core rows so only the pack's
    copies run.

    It owns the file-manager half of "Open In..." the same way: the shipped
    @deepseek-ai/dsh-client-ui-open-in-app browser bundle is forked into
    dsh-open-in-app with the module-table id rewritten AND a small documented
    patch list applied (each fork entry's Patches). The patch list is part of
    this script on purpose - a plain copy would be overwritten on the next
    re-sync, and a hand-edited vendored file would drift silently.

    Run this after bumping the pinned harness line to move the forks forward:
    it copies each core bundle from the harness installation, rewrites the
    module-table id to the pack's package name, applies that fork's patches,
    stamps a generated-file banner, and reports versions + hashes.

.PARAMETER CoreModules
    Directory holding the harness's own node_modules (the one with
    @deepseek-ai/dsh-client-ui-sidebar-right inside). Discovered automatically
    when omitted: the profile first, then the npx cache / global installs.

.PARAMETER DshHome
    Harness home to look in first (default: $env:DSH_HOME, else ~/.dsh).

.PARAMETER Check
    Report what would change without writing anything (exit 1 when out of sync).

.NOTES
    Runs on Windows PowerShell 5.1 and on PowerShell 7+ (pwsh) on Windows, macOS
    and Linux: paths are built with Join-Path, and the candidate roots cover the
    Windows npm cache as well as the POSIX ~/.npm/_npx and global module
    directories.
#>
[CmdletBinding()]
param(
    [string]$CoreModules = '',
    [string]$DshHome = '',
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

# ---------------------------------------------------------------------------
# Platform facts (Windows PowerShell 5.1 has no $IsWindows/$IsMacOS/$IsLinux)
# ---------------------------------------------------------------------------
$script:Platform = 'linux'
if ($PSVersionTable.PSEdition -ne 'Core') { $script:Platform = 'windows' }
elseif ($IsWindows) { $script:Platform = 'windows' }
elseif ($IsMacOS) { $script:Platform = 'macos' }
$script:IsWindowsHost = $script:Platform -eq 'windows'

<#
    The user's home directory without assuming Windows: HOME is what macOS/Linux
    (and pwsh on Windows) set, USERPROFILE is the Windows fallback, and the
    profile-folder API is the last resort on Windows.
#>
function Get-HomeDir {
    if ($env:HOME) { return $env:HOME }
    if ($env:USERPROFILE) { return $env:USERPROFILE }
    return [Environment]::GetFolderPath('UserProfile')
}

function Write-Step($msg) { Write-Host "[sync-vendored] $msg" -ForegroundColor Cyan }

<#
    One run of `$n` tab characters: the bundles are tab-indented, and a
    here-string cannot carry a literal tab safely, so patch text is assembled
    from explicit pieces.
#>
function T($n) { return ("`t" * $n) }

# The fork's own Chinese `dock.splitPaneDisabled` label, built from code points
# so this script keeps its ASCII-only rule (see AGENTS.md): the bundle carries
# the literal characters, so a patch that matches (and rewrites) them has to
# produce the same characters without putting them in this file.
$splitCapTwo = (-join ([char[]](0x5DF2, 0x8FBE, 0x4E24, 0x683C, 0x4E0A, 0x9650)))
$splitCapFour = (-join ([char[]](0x5DF2, 0x8FBE, 0x56DB, 0x683C, 0x4E0A, 0x9650)))

<#
    The fork's ONE hand-written piece: the dock renderer. It lives as a source
    fragment in the package's own `vendor/` folder - the same place dsh-editor,
    dsh-pdf and dsh-diagrams keep the inputs that generate what they ship - and is
    spliced into the generated bundle below. Reading it here is what keeps it a
    real file: a component this size spelled as a patch literal would be neither
    readable nor reviewable, and the generated fork itself must never be edited.
#>
$dockTreePath = Join-Path (Join-Path (Join-Path (Join-Path $repoRoot 'packages') 'dsh-rightbar') 'vendor') 'dock-tree.js'
if (-not (Test-Path -LiteralPath $dockTreePath)) { throw "missing $dockTreePath" }
$dockTreeSource = ([System.IO.File]::ReadAllText($dockTreePath, [System.Text.Encoding]::UTF8)).Replace("`r`n", "`n").TrimEnd([char]10)

# Vendored package -> the core package it forks, plus the patches applied after
# the module-table id is rewritten. A patch is a literal Find/Replace pair: the
# Find text must appear exactly once (tab-indented), and a re-sync that cannot
# place one fails loudly instead of shipping a fork that silently lost it.
$vendored = @(
    # The sidebar-right bundle caps its dock at TWO panes in five places, while
    # the docking kit it builds on allows `MAX_DOCK_PANES` (4) and offers all five
    # of its drop zones. These patches hand the limit back to the kit's own
    # `canSplit` (fewer than four), re-open the top/bottom bands - a tab dragged
    # into a pane's upper or lower quarter stacks a pane there, which is how a 2x2
    # is built, since the Split control itself always adds a column to the right -
    # and let the disabled Split hint name the ceiling that is actually in force.
    #
    # Lifting the cap is not enough on its own: the kit also DRAWS that layout with
    # the wrong component. `DockLayout` renders one pane or two side by side and
    # throws on anything else ("DockLayout requires one pane or two horizontally
    # split panes"), so a stacked pane - and with it the 2x2 the top/bottom bands
    # exist for - reached the shell's slot boundary as a crash, and an abdicated
    # slot entry took the whole right bar away until a page reload. The last two
    # patches render the kit's own `DockSurface` (the same drop-zone host, with the
    # recursive renderer) and splice in the wrapper that keeps everything the flat
    # renderer provided for free; the long version of that reasoning is the
    # wrapper's own comment in packages/dsh-rightbar/vendor/dock-tree.js.
    [pscustomobject]@{
        Name    = 'dsh-rightbar'
        Core    = '@deepseek-ai/dsh-client-ui-sidebar-right'
        Patches = @(
            [pscustomobject]@{
                Label   = 'lift the two-pane cap: the split intent is bounded by the kit own canSplit'
                Find    = '(0, _deepseek_ai_dsh_client_ui_dockkit.dockPaneIds)(state).length >= 2 || '
                Replace = ''
            },
            [pscustomobject]@{
                Label   = 'lift the two-pane cap: an edge drop is bounded by the kit own canSplit, top and bottom included'
                Find    = (@(
                        ((T 7) + 'if (zone === "top" || zone === "bottom") return [];'),
                        ((T 7) + 'if (zone !== "center" && (0, _deepseek_ai_dsh_client_ui_dockkit.dockPaneIds)(state).length >= 2) return [];'),
                        ''
                    ) -join "`n")
                Replace = ''
            },
            [pscustomobject]@{
                Label   = 'lift the two-pane cap: the dock surface is bounded by the kit own canSplit'
                Find    = '(0, _deepseek_ai_dsh_client_ui_dockkit.canSplit)(surface.layout) && (0, _deepseek_ai_dsh_client_ui_dockkit.dockPaneIds)(surface.layout).length < 2'
                Replace = '(0, _deepseek_ai_dsh_client_ui_dockkit.canSplit)(surface.layout)'
            },
            [pscustomobject]@{
                Label   = 'offer every drop band a pane has, not left and right only'
                Find    = 'dropZones: "horizontal",'
                Replace = 'dropZones: "edges",'
            },
            [pscustomobject]@{
                Label   = 'lift the two-pane cap: the split command is bounded by the kit own canSplit'
                Find    = ' || (0, _deepseek_ai_dsh_client_ui_dockkit.dockPaneIds)(layout).length >= 2'
                Replace = ''
            },
            [pscustomobject]@{
                Label   = 'the disabled split hint names the kit own ceiling'
                Find    = '"dock.splitPaneDisabled": "Two panes is the limit",'
                Replace = '"dock.splitPaneDisabled": "Four panes is the limit",'
            },
            [pscustomobject]@{
                Label   = 'the Chinese disabled split hint names the same ceiling'
                Find    = '"dock.splitPaneDisabled": "' + $splitCapTwo + '",'
                Replace = '"dock.splitPaneDisabled": "' + $splitCapFour + '",'
            },
            [pscustomobject]@{
                Label   = 'draw the tree the kit plans, not the flat grid that refuses it'
                Find    = '_deepseek_ai_dsh_client_ui_dockkit.DockLayout, {'
                Replace = 'DockTree, {'
            },
            [pscustomobject]@{
                Label   = 'splice in DockTree (packages/dsh-rightbar/vendor/dock-tree.js) above intentsFor'
                Find    = (T 2) + 'function intentsFor(sessionId, actions, openTab, closeTab, splitPane) {'
                Replace = ($dockTreeSource + "`n" + (T 2) + 'function intentsFor(sessionId, actions, openTab, closeTab, splitPane) {')
            },
            # WHAT THE FLAT RENDERER'S TAB HOST GAVE THE DOCKED SURFACE - the second
            # thing the renderer swap above took away with the 2x2, and the reason a
            # fullscreen bar shows the conversation through it. Both of these hang off
            # markup ONLY `DockLayout` emits:
            #
            #   ._tabHost_<hash>:not(._float_<hash>)   {background:var(--dsw-alias-bg-base)}
            #   ._tabCell_<hash>[data-dockkit-host=dock][data-dockkit-column="0"]>._tabHost_<hash>
            #     {border-left:.5px solid var(--dsw-alias-border-l4)}
            #
            # `DockSurface` draws a bare `_pane_` section with NO background and
            # NEITHER attribute (the tab cell only exists on the `DockLayout` path), so
            # a surface-rendered bar is TRANSPARENT and has no left boundary:
            #
            #   - the SEAM was the visible one in push mode. The bar and the centre
            #     column are both `--dsw-alias-bg-base`, so with the selector matching
            #     nothing the two ran together with no line between them.
            #   - the FILL only shows in FULLSCREEN, because that is the one state
            #     where the panel overlays something it is NOT the same colour as: the
            #     conversation. Every pixel the active tab does not paint itself then
            #     shows the chat through it, and WHICH tab is in front decides how bad
            #     it looks - the editor and the PDF viewer paint their own background,
            #     while the History tab (its rail, its commit list, its diff detail)
            #     paints none, so it reads as "sometimes it does not cover".
            #
            # `DockTree` does re-emit `data-dockkit-host="dock"` on a real box (the
            # bar's own stylesheet slides and hides the docked content through that
            # selector), so BOTH go there: the fill the flat renderer's tab host had,
            # and the seam, on the token the app's OWN column separators use -
            # `border-right:.5px solid var(--dsw-alias-border-l3)` on the left sidebar
            # column, and the same declaration on the centre column under
            # `[data-platform=darwin]`. (The kit's cell rule asked for `-l4`, one step
            # stronger; the bar is pinned to `-l3` so the two sides of the frame wear
            # the same hairline, which is what a person compares.)
            #
            # Three facts keep this honest: the wrapper is `panelBody`'s FIRST child
            # and the flat fallback renders no such box, so neither declaration can
            # double the kit's own; both ride the `[data-sidebar-right-open]` gate the
            # rule above puts on that box, so a COLLAPSED bar carries the fill and the
            # seam off-screen with its content instead of painting a one-bar-wide
            # rectangle over the conversation; and the box is what the tab bodies are
            # MOUNTED IN, so the fill cannot be defeated by a tab that paints nothing -
            # which is the actual bug this closes.
            [pscustomobject]@{
                Label   = 'give the DockTree wrapper what the flat tab host provided: the opaque bg-base fill and the bar own left seam'
                Find    = '.P3OORG_panelBody{flex:auto;min-height:0;display:flex}'
                Replace = '.P3OORG_panelBody{flex:auto;min-height:0;display:flex}.P3OORG_panelBody>[data-dockkit-host=dock]{background:var(--dsw-alias-bg-base);border-left:.5px solid var(--dsw-alias-border-l3)}'
            },
            # THE FULLSCREEN BAR'S LAYER - a third thing the renderer swap took away,
            # and the reason a fullscreen bar showed the conversation THROUGH it even
            # once it had an opaque fill. `.P3OORG_panel` is `position:absolute` and
            # leaves `z-index` at `auto`, so it paints above the chat only because
            # positioned boxes paint after in-flow ones. Every POSITIONED element in
            # the app with a positive z-index therefore paints ABOVE it, and the
            # pinned line has plenty that are not transient - measured from its own
            # bundles:
            #
            #   - dsh-client-ui-layout: the column resize handles are 11, the
            #     leading seat (the header's left controls) is 15, and the frame's
            #     overlay layer is 20;
            #   - dsh-client-ui-conversation: the composer seat is
            #     `position:sticky; bottom:0; z-index:7` - 9 with a trigger menu
            #     open - its width handle is 8 and its workspace row is 10, so the
            #     INPUT BOX sat on top of the fullscreen bar, and its background is a
            #     gradient that fades to transparent over its top 36px, which is how
            #     chat text came through it;
            #   - dsh-client-ui-sidebar: its fixed controls are 30 under
            #     `[data-windows-titlebar]`;
            #   - and this pack's OWN command dock (dsh-cmdbar) is
            #     `position:fixed; bottom:0; z-index:21`, deliberately above the
            #     columns - so it is covered by a fullscreen bar too, which is what
            #     "on top of everything" means for a fullscreen surface. Should the
            #     dock ever need to survive a fullscreen bar, it is THAT package's
            #     number to raise above 40, not this one's to lower.
            #
            # The kit had already answered this for the FLAT renderer: the fullscreen
            # panel sets `--dsh-dockkit-dock-layer:40` (against 10 when pushed), and
            # that is the z-index of its tab CELLS. Because the panel itself does not
            # create a stacking context, those cells were ordered in the ROOT
            # stacking context - above the app's persistent chrome, below the kit's
            # own tab menu (70) and everything the app opens over the interface
            # (tooltips and hovercards 100, submenus 101, the modal root and its
            # backdrops 1000, toasts and portals 1100). `DockSurface` draws no tab
            # cell, so the surface path lost that layer too and the fullscreen bar
            # sat UNDER the shell. The layer goes on the PANEL here, which restores
            # the intent and covers what the cells never could: the bar's own fill,
            # and the float layer - floats are children of the panel, so keeping them
            # inside its stacking context (their inline z-indexes above the wrapper's
            # `auto`) preserves the kit's own float-above-dock relation rather than
            # stranding them underneath it.
            #
            # 40 is taken from that ladder, not invented: above everything persistent
            # (a maximum of 30) and below every transient layer (a minimum of 70), so
            # dropdowns, dialogs and toasts still win - which "the bar is on top" must
            # not break. PUSH mode is deliberately left alone: upstream's pushed dock
            # layer is 10, below the shell's own 11/15/20 chrome, and the two columns
            # do not overlap there anyway.
            [pscustomobject]@{
                Label   = 'put the fullscreen bar on the dock layer above the shell chrome and below the app popovers'
                Find    = '.P3OORG_panel[data-sidebar-right-panel=fullscreen]{--dsh-dockkit-dock-layer:40}'
                Replace = '.P3OORG_panel[data-sidebar-right-panel=fullscreen]{--dsh-dockkit-dock-layer:40;z-index:40}'
            },
            # The right bar opens EMPTY on the first paint of a fresh session and
            # fills only once the user does something. A store action that changes
            # the layout plans through `advance`, which ends with `planSettle` - the
            # rule that seeds the default page into an expanded, tab-less pane. But
            # `open` (the action that materializes a session's surface) calls `seat`
            # directly and plans nothing, and `createSurface` is deliberately
            # collapsed and tab-less. So a bar that is already on screen and expanded
            # at boot never runs a settle: the pane shows the kit's "Empty pane"
            # label until the first click on the strip's "+" or a link, and that
            # click is what creates the Start tab. This runs the settle at
            # materialization, which is the one place the intent is missing.
            # `planSettle` with an undefined factory leaves a COLLAPSED surface
            # alone, so the documented "a collapsed column never holds a page nobody
            # asked for" behaviour is preserved.
            [pscustomobject]@{
                Label   = 'seed the default page when a surface is first materialized, not only on the next action'
                Find    = @(
                    ((T 2) + 'function seat(state, sessionId, next) {'),
                    ''
                ) -join "`n"
                Replace = @(
                    ((T 2) + 'function settleSurface(surface, seed) {'),
                    ((T 3) + 'const counter = counting(surface.minted);'),
                    ((T 3) + 'const makeTab = (id) => seedRecord(id, seed);'),
                    ((T 3) + 'const settled = (0, _deepseek_ai_dsh_client_ui_dockkit.planSettle)(surface.layout, counter.mint, surface.layout.expanded ? makeTab : void 0);'),
                    ((T 3) + 'if (settled.length === 0) return surface;'),
                    ((T 3) + 'const stepped = (0, _deepseek_ai_dsh_client_ui_dockkit.record)(surface.history, surface.layout, settled);'),
                    ((T 3) + 'return {'),
                    ((T 4) + 'layout: stepped.state,'),
                    ((T 4) + 'history: stepped.history,'),
                    ((T 4) + 'minted: counter.used()'),
                    ((T 3) + '};'),
                    ((T 2) + '}'),
                    ((T 2) + 'function seat(state, sessionId, next) {'),
                    ''
                ) -join "`n"
            },
            [pscustomobject]@{
                Label   = 'materializing a surface settles it, so an already-open bar is not left empty'
                Find    = ((T 5) + 'd.bySession = seat(d, sessionId, (surface) => surface);')
                Replace = ((T 5) + 'd.bySession = seat(d, sessionId, (surface) => settleSurface(surface, seed));')
            },
            # The bar's default page was chosen from how many guide entries happened
            # to be registered at the instant of the first seed: with exactly ONE
            # registered it opened THAT plugin's page instead of Start, and with zero
            # or several it opened Start. The pack's bundles apply asynchronously, so
            # which one won was a boot-order race - and the page a user calls "Start"
            # must not depend on a race. It is always the guide's own page.
            [pscustomobject]@{
                Label   = 'the default page is always the guide, not whichever single entry won the boot race'
                Find    = @(
                    ((T 3) + 'const [only, ...others] = tabs.guide();'),
                    ((T 3) + 'const kind = only !== void 0 && others.length === 0 ? only.kind : GUIDE_KIND;'),
                    ''
                ) -join "`n"
                Replace = @(
                    ((T 3) + 'const kind = GUIDE_KIND;'),
                    ''
                ) -join "`n"
            }
        )
    },
    [pscustomobject]@{
        Name    = 'dsh-rightbar-files'
        Core    = '@deepseek-ai/dsh-client-ui-sidebar-files'
        Patches = @()
    },
    [pscustomobject]@{
        Name    = 'dsh-open-in-app'
        Core    = '@deepseek-ai/dsh-client-ui-open-in-app'
        Patches = @(
            [pscustomobject]@{
                Label   = 'declare the pack launcher route and the file-manager catalog ids'
                # 0.2.0-rc.2 publishes these as BROWSER-RELATIVE forms of the Host
                # paths (".slice(1)"), so the anchor carries the suffix.
                Find    = (T 2) + 'const OPEN_IN_APP_OPEN_ROUTE = "/open-in-app/open".slice(1);'
                # Every element is parenthesized: the comma operator binds tighter
                # than "+", so bare concatenations would collapse into one line.
                Replace = (@(
                        ((T 2) + 'const OPEN_IN_APP_OPEN_ROUTE = "/open-in-app/open".slice(1);'),
                        ((T 2) + '/** dsh-open-in-app: the pack''s own cross-platform file-browser route. */'),
                        ((T 2) + 'const NATIVE_OPEN_ROUTE = "/api/dsh-open-in-app/open";'),
                        ((T 2) + '/** Catalog ids whose launch is a file manager, not an editor or terminal. */'),
                        ((T 2) + 'const NATIVE_FILE_MANAGER_APPS = new Set(["finder", "explorer", "filemanager"]);')
                    ) -join "`n")
            },
            [pscustomobject]@{
                # The 0.2.0 controller hands the route to its fetcher AS A STRING
                # (the default fetcher is plain `fetch`, which resolves it against
                # the page origin), so the pack's absolute route rides the same
                # call - no `new URL(..., hostBase())` wrapper any more.
                Label   = 'send the file managers through the pack launcher, everything else unchanged'
                Find    = (T 5) + 'const response = await this.fetcher(OPEN_IN_APP_OPEN_ROUTE, {'
                Replace = (@(
                        ((T 5) + 'const route = NATIVE_FILE_MANAGER_APPS.has(appId) ? NATIVE_OPEN_ROUTE : OPEN_IN_APP_OPEN_ROUTE;'),
                        ((T 5) + 'const response = await this.fetcher(route, {')
                    ) -join "`n")
            }
        )
    }
)

function Write-Step($msg) { Write-Host "[sync-vendored] $msg" -ForegroundColor Cyan }

<#
    Candidate node_modules roots, best first: an explicit -CoreModules, the
    profile's own modules, then every npx cache / global install that carries
    the harness packages (newest first).
#>
function Get-CandidateRoots {
    param([string]$Explicit, [string]$HomeDir)
    $roots = @()
    if ($Explicit) { $roots += $Explicit }
    if (-not $HomeDir) { $HomeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path (Get-HomeDir) '.dsh' } }
    $roots += (Join-Path (Join-Path (Join-Path $HomeDir 'profiles') 'web') 'node_modules')
    # npm's on-demand cache lives in different places per platform: the Windows
    # Local/AppData roaming folders, and ~/.npm/_npx on macOS/Linux.
    $caches = @()
    if ($env:LOCALAPPDATA) { $caches += (Join-Path (Join-Path $env:LOCALAPPDATA 'npm-cache') '_npx') }
    if ($env:APPDATA) { $caches += (Join-Path (Join-Path $env:APPDATA 'npm-cache') '_npx') }
    $caches += (Join-Path (Join-Path (Get-HomeDir) '.npm') '_npx')
    foreach ($cache in $caches) {
        if (-not (Test-Path $cache)) { continue }
        $hits = Get-ChildItem $cache -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName 'node_modules' } |
            Where-Object { Test-Path (Join-Path $_ '@deepseek-ai') }
        foreach ($hit in $hits) { $roots += $hit }
    }
    # Global installs, the shape "npm i -g @deepseek-ai/dsh" leaves behind.
    $globals = @('/usr/local/lib/node_modules', '/usr/lib/node_modules')
    if ($env:APPDATA) { $globals += (Join-Path $env:APPDATA 'npm\node_modules') }
    foreach ($global in $globals) {
        if (Test-Path (Join-Path $global '@deepseek-ai')) { $roots += $global }
    }
    return ($roots | Select-Object -Unique)
}

<#
    The harness LINE the pack is pinned to - the same field the tracked checks
    grade the forks against. A re-sync must move the forks to that line and no
    other, because more than one harness generation sits on an ordinary machine:
    this one carries 0.1.5-rc.1 in the npx cache beside the pinned 0.2.0-rc.2, and
    the older line's sidebar-right is a different bundle entirely (140 KB against
    331 KB, no `DockLayout` JSX at all). A plain "first root that has the file"
    walk finds the OLD one, and the sync would then quietly regenerate every fork
    from a line the pack does not target.
#>
function Get-PinnedLine {
    try {
        $manifest = Get-Content -LiteralPath (Join-Path $repoRoot '.dsh-version.json') -Raw | ConvertFrom-Json
        if ($manifest.vendoredFrom) { return [string]$manifest.vendoredFrom }
        if ($manifest.dsh) { return [string]$manifest.dsh }
    } catch {}
    return ''
}

<# The line one candidate root carries (the core packages share the harness version). #>
function Get-RootLine {
    param([string]$Root)
    $probe = Join-Path (Join-Path (Join-Path $Root '@deepseek-ai') 'dsh-client-ui-sidebar-right') 'package.json'
    try { return [string](Get-Content -LiteralPath $probe -Raw | ConvertFrom-Json).version } catch { return 'unknown' }
}

<# Whether one root carries every core package this script vendors. #>
function Test-CoreRoot {
    param([string]$Root)
    foreach ($item in $vendored) {
        $probe = Join-Path (Join-Path $Root '@deepseek-ai') (Split-Path $item.Core -Leaf)
        if (-not (Test-Path (Join-Path $probe 'package.json'))) { return $false }
    }
    return $true
}

<#
    The first candidate root that carries every core package we vendor AND the
    pinned line. An explicit -CoreModules is the one way to sync another line on
    purpose; without it a mismatch is an error naming what was found, never a
    silent fork of the wrong generation.
#>
function Resolve-CoreModules {
    param([string]$Explicit, [string]$HomeDir)
    $line = Get-PinnedLine
    $carrying = @()
    foreach ($root in (Get-CandidateRoots -Explicit $Explicit -HomeDir $HomeDir)) {
        if (Test-CoreRoot -Root $root) { $carrying += $root }
    }
    foreach ($root in $carrying) {
        if ($line -ne '' -and (Get-RootLine -Root $root) -eq $line) { return $root }
    }
    if ($Explicit) {
        foreach ($root in $carrying) {
            if ($root -eq $Explicit) { return $root }
        }
        throw "-CoreModules '$Explicit' does not carry every core package we vendor."
    }
    $found = ($carrying | ForEach-Object { (Get-RootLine -Root $_) + ' at ' + $_ }) -join '; '
    if ($found -eq '') { $found = 'nothing that carries them' }
    throw "No harness node_modules carrying the pinned line '$line' was found (found: $found). Pass -CoreModules '<harness>/node_modules' to sync another line on purpose."
}

function Get-CorePackageDir {
    param([string]$Root, [string]$CoreName)
    return (Join-Path (Join-Path $Root '@deepseek-ai') (Split-Path $CoreName -Leaf))
}

function Get-Sha1 {
    param([byte[]]$Bytes)
    $sha = [System.Security.Cryptography.SHA1]::Create()
    try { return ([System.BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

$coreRoot = Resolve-CoreModules -Explicit $CoreModules -HomeDir $DshHome
Write-Step "core modules: $coreRoot"

$outOfSync = $false
foreach ($item in $vendored) {
    $coreDir = Get-CorePackageDir -Root $coreRoot -CoreName $item.Core
    $sourcePath = Join-Path (Join-Path $coreDir 'lib') 'client.js'
    $targetPath = Join-Path (Join-Path (Join-Path (Join-Path $repoRoot 'packages') $item.Name) 'lib') 'client.js'
    if (-not (Test-Path $sourcePath)) { throw "missing $sourcePath" }
    if (-not (Test-Path $targetPath)) { throw "missing $targetPath (create the package first)" }

    $coreVersion = 'unknown'
    try { $coreVersion = (Get-Content (Join-Path $coreDir 'package.json') -Raw | ConvertFrom-Json).version } catch {}

    $source = [System.IO.File]::ReadAllText($sourcePath, [System.Text.Encoding]::UTF8)
    # We only rewrite the module-table id: the CSS tag ids and the guide slot id
    # stay the core ones on purpose, so a vendored copy keeps its identity.
    $needle = 'id: "' + $item.Core + '"'
    if ($source.IndexOf($needle) -lt 0) { throw "could not find the module-table id in $sourcePath (layout changed?)" }
    $rewritten = $source.Replace($needle, 'id: "' + $item.Name + '"')

    # The fork's documented patches, applied in order. A Find that no longer
    # matches means the core bundle moved: fail here rather than ship a fork
    # that silently lost its behavior.
    $patchLabels = @()
    foreach ($patch in @($item.Patches)) {
        if ($null -eq $patch) { continue }
        if ($rewritten.IndexOf($patch.Find) -lt 0) {
            throw "could not apply the '$($patch.Label)' patch to $sourcePath (layout changed?)"
        }
        $rewritten = $rewritten.Replace($patch.Find, $patch.Replace)
        $patchLabels += $patch.Label
    }

    if ($patchLabels.Count -eq 0) {
        $banner = @"
// GENERATED - do not edit by hand.
//
// Byte-for-byte fork of $($item.Core)@$coreVersion
// (lib/client.js) with only the module-table id rewritten to "$($item.Name)".
// The pack's bundle layer disables the core row, so this copy is the one that
// runs. Re-sync with:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sync-vendored.ps1
//
"@
    }
    else {
        $patchLines = ($patchLabels | ForEach-Object { '//   - ' + $_ }) -join "`n"
        $banner = @"
// GENERATED - do not edit by hand.
//
// Fork of $($item.Core)@$coreVersion (lib/client.js): the module-table id is
// rewritten to "$($item.Name)", and these patches from scripts\sync-vendored.ps1
// are applied on top:
$patchLines
// The pack's bundle layer disables the core row, so this copy is the one that
// runs. Re-sync with:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sync-vendored.ps1
//
"@
    }
    $banner = $banner.Replace("`r`n", "`n")
    # The here-string carries no trailing newline, and without one the banner
    # would comment out the bundle's first line.
    if (-not $banner.EndsWith("`n")) { $banner += "`n" }
    $next = $banner + $rewritten

    $nextBytes = [System.Text.Encoding]::UTF8.GetBytes($next)
    $currentBytes = [System.IO.File]::ReadAllBytes($targetPath)
    $nextHash = Get-Sha1 -Bytes $nextBytes
    $currentHash = Get-Sha1 -Bytes $currentBytes
    $same = ($nextHash -eq $currentHash)
    if ($same) {
        Write-Step "$($item.Name): in sync with $($item.Core)@$coreVersion ($nextHash)"
        continue
    }
    $outOfSync = $true
    if ($Check) {
        Write-Step "$($item.Name): OUT OF SYNC (core $coreVersion, $nextHash vs $currentHash)"
        continue
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($targetPath, $next, $utf8NoBom)
    Write-Step "$($item.Name): updated from $($item.Core)@$coreVersion ($nextHash)"
}

if ($Check -and $outOfSync) { exit 1 }
Write-Step 'done.'
