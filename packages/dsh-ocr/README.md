# dsh-ocr (alpha.1)

**The agent can finally read a picture.** Core DSH has no OCR: `read_image` returns the picture to a model that has eyes, and a text-only model gets nothing from it, while `read` refuses a binary file. The PDF row's OCR needs `tesseract` **and** a rasterizer installed. So a screenshot, a photo of a page, a scanned TIFF - or a scanned PDF on a machine with neither - was unreadable. This is one host row with one tool, `ocr`, and it works on a stock Windows machine with **nothing installed at all**, because Windows has shipped a real OCR engine since Windows 10.

## What it adds

- **One tool, `ocr`** - the path to a file, and the text comes back. `lang` accepts either spelling (`eng`/`por` for tesseract, `en-US`/`pt-PT` for Windows, `eng+por` for two at once); `pages` chooses a PDF's pages (`"3"`, `"1-5"`, `"1,4-6"`, default every page up to 20); `psm` is tesseract's page-segmentation mode for an odd layout; `dpi` (50-400) is the resolution a PDF page is drawn at before it is read.
- **Two engines, chosen by capability, never installed.** `tesseract` from PATH on any platform - preferred for an image, because it is explicit about language and segmentation, and it is *not* offered a PDF, since a PDF is not a raster image and dsh-pdf already owns that route (`pdf_scan` rasterizes with poppler/mutool/Ghostscript and calls tesseract). And on Windows, `Windows.Media.Ocr`, which needs no install and can also rasterize a PDF page through `Windows.Data.Pdf` - so a scanned PDF is readable on a machine with no tesseract, no poppler and no Ghostscript.
- **The answer says what actually read the file**: the engine, the language tag it used, the pixel size, how many pages, and how long it took. A language this machine has no data for is refused **with the list of what it can read**.
- **It is honest about what OCR is.** Every answer that contains text carries the transcription caveat and points at the tool that *extracts* text instead (`pdf_read` for a PDF with a text layer, `read` for anything textual). An engine that found nothing says the page may be blank or the type too small, and offers `dpi`.
- **A mistake is named as one.** A page number past the end is "does not exist in this 3-page document", not "no text found"; `pages` on an image is "that is a single image, drop `pages`"; a text file is refused by what it *is* - its own first bytes, not its extension.

## How it plugs in

| Piece | Value |
|---|---|
| `id` / kind | `dsh-ocr` / `ocr` |
| rows | one: `ocr` (host-only - no `dsh.client`, no route, no tab) |
| injects | `tools` |
| engines | tesseract from PATH; `lib/win-ocr.ps1` through `powershell.exe` (5.1) on Windows |
| deps | **none** - zero npm dependencies, no vendored engine, no download, no network egress |

The tool's path policy is the pack's own, duplicated because a bundle may not reach into another bundle's files: a **relative** path resolves inside the conversation workspace through `realpath` (a symlink out is refused), an **absolute** path is read as given - which is the door a chat attachment under `$DSH_HOME/attachments/v1/files/...` and a screenshot in Downloads come through.

## Rules and limits

- **`lib/win-ocr.ps1` is pure ASCII, and that is load-bearing.** Windows PowerShell 5.1 reads a `.ps1` with no BOM as ANSI, so one accented character in a literal there would be decoded as two wrong ones before the script ran. Everything that comes back from the engine - accented text, a translated error - is written to a **file** as UTF-8, never echoed to a console whose code page is not ours; stdout carries exactly one compact JSON verdict.
- **PowerShell 5.1, not 7, on Windows.** PowerShell 7 cannot project the `Windows.Media.Ocr` type without an extra SDK assembly; the 5.1 inside Windows has the projection built in. `DSH_OCR_POWERSHELL` overrides the path.
- **The engine's own limits are respected, not tripped.** A page is rasterized at the requested `dpi` unless that would exceed `OcrEngine.MaxImageDimension` (10000 px on the machine this was built on), in which case it is scaled to fit; an oversized image is decoded straight to Bgra8 with its EXIF orientation respected. **Lines are read from `OcrResult.Lines`, never `OcrResult.Text`** - the flat text joins an invoice's lines into one sentence, which is how layout is lost.
- **Recognized text comes back whole or says it was cut**, at 200 000 characters, and one call recognizes at most 20 pages.
- **It reads raster images and PDFs only**: PNG, JPEG, GIF, BMP, TIFF, WebP, and HEIC/AVIF where Windows has the codec. A HEIC is offered to the Windows engine alone, because what reads one is a codec and not a parser. A **multi-page TIFF is read as its first page** by the Windows engine, and the count is read out of the TIFF's own IFD chain so the answer says so - tesseract reads every page of one, and the two would otherwise be indistinguishable.
- **Not claimed:** office documents, spreadsheets or archives (convert to an image or a PDF first), and handwriting, which neither engine is trained for. Nothing here writes to the file it reads, and the engine's temporary directory is removed afterwards.

## Verify

```
node --check packages/dsh-ocr/lib/engines.js
node --check packages/dsh-ocr/lib/tools.js
node --check packages/dsh-ocr/lib/index.js
npm run check            # in packages/dsh-ocr
```

`checks/check-ocr-node.mjs` is this package's own tracked check, additional to the pack-wide ones. It drives the pure decisions (language matching across both tag spellings, page specs, content sniffing, the no-engine and blank-page sentences), then the **engines end to end on inputs it builds itself**: a 24-bit BMP whose text is drawn from a 5x7 bitmap font the check carries, and a minimal three-page PDF - no fixtures, no image library, no dependencies. Then the `ocr` tool through the real `buildTools`: a workspace-relative path, an absolute one, a missing file, a text file, `pages` on an image, and a PDF page range that must **not** return another page's text. With no usable engine it **skips loudly** and exits 0, because a green run there is not evidence.

## Install

Both installers pick the package up from `packages/`; it is a new bundle, so the profile learns about it once:

```
scripts\install.bat -Force        # Windows
./scripts/install.sh -Force       # macOS / Linux
```

Then restart `npx @deepseek-ai/dsh web`. On Windows this row works immediately with no install; on macOS and Linux, install `tesseract` (with the traineddata for the languages to read) and it is found on PATH.
