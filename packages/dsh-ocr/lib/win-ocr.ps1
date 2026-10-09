#Requires -Version 5.1
<#
.SYNOPSIS
    Recognize the text in an image or in a PDF page with the OCR engine Windows
    itself ships.

.DESCRIPTION
    This is dsh-ocr's Windows engine: the half of the row that needs no install
    at all. Windows has had a real OCR engine since Windows 10
    (Windows.Media.Ocr), and it reads an image the WinRT imaging stack can
    decode AND a PDF page Windows itself can rasterize (Windows.Data.Pdf) - so a
    scanned PDF is readable on a machine with no tesseract, no poppler and no
    Ghostscript on it.

    WHY THIS FILE IS PURE ASCII. Windows PowerShell 5.1 reads a .ps1 file that
    has no byte-order mark as ANSI, not UTF-8, so a single accented character in
    a literal here would be decoded as two wrong ones before the script ever
    runs. Every message is built from ASCII, and anything that comes back from
    the engine (accented text, a translated error) is written to a FILE as UTF-8
    - never echoed to this process's stdout, whose encoding is not ours to trust.

    WHY THE ANSWER IS A JSON LINE AND A FILE. The text of a document is data,
    not a status, and mixing them on one stream means neither survives intact.
    The recognized text goes to -OutFile (UTF-8, no BOM), and stdout carries
    exactly one compact JSON object: the verdict, the engine, the language, how
    many pages were read and where the text is. A caller that gets no JSON at all
    knows the script never reached its own reporting.

    Everything here is 5.1- and 7-compatible in principle, but the WinRT type
    projection it depends on is a Windows PowerShell feature: PowerShell 7 needs
    an extra SDK assembly to load these types, so dsh-ocr resolves
    powershell.exe (5.1) for this engine and keeps looking for a different engine
    when there is none. This script is never run by 7.

.PARAMETER Path
    The image or PDF to read.

.PARAMETER Lang
    The exact recognizer language tag to use, as Windows spells it (pt-PT,
    en-US). Empty means "the user's own profile languages, else the first
    recognizer this machine has" - and the answer says which one was used.

.PARAMETER Pages
    For a PDF: a page list like 1,3-5 (1-based), or "all", or empty for "all".
    Ignored for an image.

.PARAMETER Dpi
    For a PDF: the resolution to rasterize at, 50-400. The page is drawn at the
    requested size unless that would exceed the engine's own maximum, in which
    case it is scaled to fit - a page the engine refuses is not a page read.

.PARAMETER OutFile
    Where the recognized text is written, UTF-8 without a BOM. Required unless
    -Probe or -ListLanguages is given.

.PARAMETER Probe
    Report the engine's capabilities and read nothing: the JSON carries the
    languages this machine can recognize, the one that would be used by default
    and the engine's maximum image dimension.

.PARAMETER ListLanguages
    The same report, named for what a caller usually wants from it.

.OUTPUTS
    One compact JSON object on stdout. On success
    `{ ok: true, engine, kind, lang, pages, total, chars, ms, path }`; on
    failure `{ ok: false, code, message }` plus whatever the failure can say
    (usually `languages`). The exit code is 0 only for `ok: true`.
#>
[CmdletBinding()]
param(
    [string]$Path = '',
    [string]$Lang = '',
    [string]$Pages = '',
    [int]$Dpi = 200,
    [string]$OutFile = '',
    [switch]$Probe,
    [switch]$ListLanguages
)

$ErrorActionPreference = 'Stop'

# The most pages one call rasterizes when the caller did not choose a range.
$script:MaxPages = 20
# The engine's own ceiling on the pixels it will accept; replaced by the real
# OcrEngine.MaxImageDimension once the type is loaded.
$script:MaxDimension = 2600

function ConvertTo-AsciiText {
    param([string]$Text)
    # A message from this script reaches a caller that reads UTF-8; the console
    # this process inherited may be in any code page at all, so anything that
    # could be translated is reduced to the ASCII it can always carry.
    return ([regex]::Replace([string]$Text, '[^\x20-\x7E]', '?'))
}

function Write-Report {
    param([hashtable]$Report)
    Write-Output ($Report | ConvertTo-Json -Compress -Depth 6)
}

function Stop-With {
    param([string]$Code, [string]$Message, [hashtable]$Extra = @{})
    $report = @{ ok = $false; code = $Code; message = (ConvertTo-AsciiText $Message) }
    foreach ($key in $Extra.Keys) { $report[$key] = $Extra[$key] }
    Write-Report $report
    exit 2
}

# ---------------------------------------------------------------------------
# WinRT: the types, and awaiting an asynchronous operation from a script
# ---------------------------------------------------------------------------
$script:AsTaskOperation = $null
$script:AsTaskAction = $null

function Initialize-WinRt {
    try {
        [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
        [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
        [void][Windows.Graphics.Imaging.BitmapTransform, Windows.Foundation, ContentType = WindowsRuntime]
        [void][Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
        [void][Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
        [void][Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
        [void][Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
        [void][Windows.Data.Pdf.PdfDocument, Windows.Foundation, ContentType = WindowsRuntime]
        [void][Windows.Data.Pdf.PdfPageRenderOptions, Windows.Foundation, ContentType = WindowsRuntime]
    } catch {
        Stop-With 'no-winrt' ('Windows Runtime types are not available in this PowerShell: ' + $_.Exception.Message)
    }
    try {
        Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
    } catch {
        Stop-With 'no-winrt' ('System.Runtime.WindowsRuntime could not be loaded: ' + $_.Exception.Message)
    }
    $extensions = [System.WindowsRuntimeSystemExtensions].GetMethods()
    $script:AsTaskOperation = ($extensions | Where-Object {
            $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        })[0]
    $script:AsTaskAction = ($extensions | Where-Object {
            $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
        })[0]
    if ($null -eq $script:AsTaskOperation -or $null -eq $script:AsTaskAction) {
        Stop-With 'no-winrt' 'The WinRT task adapters were not found in System.Runtime.WindowsRuntime.'
    }
}

function Wait-Operation {
    param($Operation, [Type]$ResultType)
    $task = $script:AsTaskOperation.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $task.Wait(-1) | Out-Null
    return $task.Result
}

function Wait-Action {
    param($Action)
    $task = $script:AsTaskAction.Invoke($null, @($Action))
    $task.Wait(-1) | Out-Null
}

function Get-RecognizerLanguages {
    $list = @()
    $available = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
    foreach ($language in $available) { $list += [string]$language.LanguageTag }
    return $list
}

function New-Recognizer {
    param([string]$Tag)
    try {
        if ($Tag -ne '') {
            $language = New-Object Windows.Globalization.Language($Tag)
            $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
            if ($null -eq $engine) {
                Stop-With 'no-language' ('This machine has no OCR data for ' + $Tag + '.') @{ languages = (Get-RecognizerLanguages) }
            }
            return $engine
        }
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
        if ($null -ne $engine) { return $engine }
        $available = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
        foreach ($language in $available) {
            $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
            if ($null -ne $engine) { return $engine }
        }
    } catch {
        Stop-With 'no-engine' ('An OCR engine could not be created: ' + $_.Exception.Message) @{ languages = (Get-RecognizerLanguages) }
    }
    Stop-With 'no-engine' 'This Windows installation has no OCR recognizer at all.' @{ languages = @() }
}

# ---------------------------------------------------------------------------
# Decoding: a stream to a bitmap the engine will accept
# ---------------------------------------------------------------------------
function Get-SoftwareBitmap {
    param($Stream, [int]$MaxDimension)
    $decoder = Wait-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($Stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $width = [int]$decoder.PixelWidth
    $height = [int]$decoder.PixelHeight
    $scale = 1.0
    $largest = [Math]::Max($width, $height)
    if ($MaxDimension -gt 0 -and $largest -gt $MaxDimension) { $scale = [double]$MaxDimension / [double]$largest }
    $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
    # A scaled decode is wanted even at scale 1: the engine wants Bgra8, and
    # asking the decoder for it is one pass over the pixels instead of two.
    $transform.ScaledWidth = [uint32][Math]::Max(1, [Math]::Round($width * $scale))
    $transform.ScaledHeight = [uint32][Math]::Max(1, [Math]::Round($height * $scale))
    $transform.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant
    $bitmap = Wait-Operation ($decoder.GetSoftwareBitmapAsync(
            [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
            [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
            $transform,
            [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,
            [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
    return @{ bitmap = $bitmap; width = $transform.ScaledWidth; height = $transform.ScaledHeight }
}

function Get-BitmapText {
    param($Bitmap, $Engine)
    $result = Wait-Operation ($Engine.RecognizeAsync($Bitmap)) ([Windows.Media.Ocr.OcrResult])
    if ($null -eq $result) { return '' }
    $lines = @()
    # The line list, not the flat Text: OcrResult.Text joins every line into one
    # sentence, which loses the shape of an invoice, a table or a list. One
    # element per recognized line is what the document actually looked like.
    foreach ($line in $result.Lines) { $lines += [string]$line.Text }
    return ($lines -join "`n")
}

function Get-FileStream {
    param([string]$FilePath)
    $file = Wait-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($FilePath)) ([Windows.Storage.StorageFile])
    return Wait-Operation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
}

# ---------------------------------------------------------------------------
# Page selection for a PDF
# ---------------------------------------------------------------------------
function Get-PageIndexes {
    param([string]$Spec, [int]$Total)
    $indexes = @()
    $text = ([string]$Spec).Trim()
    if ($text -eq '' -or $text -ieq 'all') {
        $limit = [Math]::Min($Total, $script:MaxPages)
        for ($n = 1; $n -le $limit; $n += 1) { $indexes += $n }
        return $indexes
    }
    # An EXPLICIT page list keeps the numbers that are past the end of the
    # document: the caller needs them to say which pages were not there, and
    # silently dropping a page number would turn a caller's mistake into "the
    # engine found no text".
    foreach ($part in ($text -split ',')) {
        $piece = $part.Trim()
        if ($piece -eq '') { continue }
        $range = $piece -split '-'
        if ($range.Count -eq 1) {
            $one = 0
            if ([int]::TryParse($range[0].Trim(), [ref]$one)) { if ($one -ge 1) { $indexes += $one } }
            continue
        }
        $from = 0; $to = 0
        if ([int]::TryParse($range[0].Trim(), [ref]$from) -and [int]::TryParse($range[1].Trim(), [ref]$to)) {
            if ($from -gt $to) { $swap = $from; $from = $to; $to = $swap }
            for ($n = $from; $n -le $to; $n += 1) { if ($n -ge 1) { $indexes += $n } }
        }
    }
    $unique = @()
    foreach ($index in $indexes) { if ($unique -notcontains $index) { $unique += $index } }
    return $unique
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
$started = Get-Date
Initialize-WinRt
try { $script:MaxDimension = [int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension } catch { $script:MaxDimension = 2600 }

if ($Probe -or $ListLanguages) {
    $languages = Get-RecognizerLanguages
    $default = ''
    try {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
        if ($null -ne $engine) { $default = [string]$engine.RecognizerLanguage.LanguageTag }
    } catch { $default = '' }
    Write-Report @{
        ok            = $true
        engine        = 'windows-ocr'
        languages     = $languages
        default       = $default
        maxDimension  = $script:MaxDimension
        powershell    = [string]$PSVersionTable.PSVersion
    }
    exit 0
}

if ($Path -eq '') { Stop-With 'bad-request' 'A file path is required.' }
# Every WinRT entry point below takes an ABSOLUTE path. A relative one does not
# fail here - it fails deep inside the asynchronous call with a message that says
# nothing about the path, so it is resolved before anything else looks at it.
try {
    $Path = [System.IO.Path]::GetFullPath($Path)
} catch {
    Stop-With 'bad-request' ('That is not a usable path: ' + $Path)
}
if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Stop-With 'not-found' ('No such file: ' + $Path) }
if ($OutFile -eq '') { Stop-With 'bad-request' 'An output file is required (-OutFile).' }
if ($Dpi -lt 50) { $Dpi = 50 }
if ($Dpi -gt 400) { $Dpi = 400 }

$engine = New-Recognizer -Tag $Lang
$tag = [string]$engine.RecognizerLanguage.LanguageTag
$extension = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
$kind = 'image'
if ($extension -eq '.pdf') { $kind = 'pdf' }

$text = ''
$pageCount = 0
$total = 0

if ($kind -eq 'pdf') {
    try {
        $pdfFile = Wait-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
        $document = Wait-Operation ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($pdfFile)) ([Windows.Data.Pdf.PdfDocument])
    } catch {
        Stop-With 'unreadable' ('Windows could not open that PDF: ' + $_.Exception.Message)
    }
    $total = [int]$document.PageCount
    $wanted = Get-PageIndexes -Spec $Pages -Total $total
    # A page number past the end is a caller's mistake, not an empty document:
    # say which ones were not there instead of reporting "no text found".
    $render = @()
    $skipped = @()
    foreach ($number in $wanted) {
        if ($number -ge 1 -and $number -le $total) { $render += $number } else { $skipped += $number }
    }
    if ($render.Count -eq 0) {
        Stop-With 'no-pages' ('This PDF has ' + $total + ' page(s), and none of the pages asked for exist in it: ' + ($wanted -join ', ') + '.') @{ total = $total }
    }
    $pieces = @()
    foreach ($number in $render) {
        $page = $null
        $stream = $null
        try {
            $page = $document.GetPage($number - 1)
            $width = [double]$page.Size.Width
            $height = [double]$page.Size.Height
            $scale = [double]$Dpi / 96.0
            $targetWidth = $width * $scale
            $targetHeight = $height * $scale
            $largest = [Math]::Max($targetWidth, $targetHeight)
            if ($largest -gt $script:MaxDimension) {
                $shrink = [double]$script:MaxDimension / $largest
                $targetWidth = $targetWidth * $shrink
                $targetHeight = $targetHeight * $shrink
            }
            $options = New-Object Windows.Data.Pdf.PdfPageRenderOptions
            $options.DestinationWidth = [uint32][Math]::Max(1, [Math]::Round($targetWidth))
            $options.DestinationHeight = [uint32][Math]::Max(1, [Math]::Round($targetHeight))
            $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
            Wait-Action ($page.RenderToStreamAsync($stream, $options))
            $stream.Seek(0)
            $decoded = Get-SoftwareBitmap -Stream $stream -MaxDimension $script:MaxDimension
            $pageText = Get-BitmapText -Bitmap $decoded.bitmap -Engine $engine
            $pieces += ('----- page ' + $number + ' -----' + "`n`n" + $pageText)
            $pageCount += 1
        } catch {
            $pieces += ('----- page ' + $number + ' -----' + "`n`n" + '(this page could not be read: ' + (ConvertTo-AsciiText $_.Exception.Message) + ')')
        } finally {
            if ($null -ne $stream) { try { $stream.Dispose() } catch { } }
            if ($null -ne $page) { try { $page.Dispose() } catch { } }
        }
    }
    $text = ($pieces -join "`n`n")
} else {
    try {
        $stream = Get-FileStream -FilePath $Path
        $decoded = Get-SoftwareBitmap -Stream $stream -MaxDimension $script:MaxDimension
        $text = Get-BitmapText -Bitmap $decoded.bitmap -Engine $engine
        $pageCount = 1
        $total = 1
    } catch {
        Stop-With 'unreadable' ('Windows could not decode that file as an image: ' + $_.Exception.Message)
    } finally {
        if ($null -ne $stream) { try { $stream.Dispose() } catch { } }
    }
}

$encoding = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($OutFile, $text, $encoding)

Write-Report @{
    ok      = $true
    engine  = 'windows-ocr'
    kind    = $kind
    lang    = $tag
    pages   = $pageCount
    total   = $total
    skipped = $skipped
    chars   = $text.Length
    ms      = [int]((Get-Date) - $started).TotalMilliseconds
    path    = $Path
}
exit 0
