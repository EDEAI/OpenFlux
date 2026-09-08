import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import sharp from 'sharp';
import type { PresentationQualityIssue } from './model';
import { withCjkLineRepairGuidance, withTextOverflowRepairGuidance } from './model';

export interface PresentationExportOptions {
    pptxPath: string;
    pdfPath?: string;
    previewDir?: string;
    previewPath?: string;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
}

export interface PresentationExportResult {
    pdfPath?: string;
    previewPath?: string;
    /** Readable multi-sheet review images. The overview contact sheet is too
     * small for typography QA once a deck grows beyond a few slides. */
    reviewSheetPaths?: string[];
    slideImages: string[];
    issues: PresentationQualityIssue[];
}

const POWERPOINT_EXPORT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$pptxPath = $env:OPENFLUX_PRESENTATION_PPTX
$pdfPath = $env:OPENFLUX_PRESENTATION_PDF
$previewDir = $env:OPENFLUX_PRESENTATION_PREVIEW_DIR
$qaPath = $env:OPENFLUX_PRESENTATION_QA
$powerPoint = $null
$presentation = $null
$ownsPowerPointProcess = $false
$existingPowerPointPids = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$issues = New-Object System.Collections.Generic.List[object]
try {
    $powerPoint = New-Object -ComObject PowerPoint.Application
    try {
        if (-not ('OpenFlux.PresentationNativeWindow' -as [type])) {
            Add-Type -TypeDefinition @'
namespace OpenFlux {
    using System;
    using System.Runtime.InteropServices;
    public static class PresentationNativeWindow {
        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    }
}
'@
        }
        [uint32]$powerPointPid = 0
        [void][OpenFlux.PresentationNativeWindow]::GetWindowThreadProcessId([IntPtr]$powerPoint.HWND, [ref]$powerPointPid)
        $ownsPowerPointProcess = $powerPointPid -gt 0 -and $existingPowerPointPids -notcontains [int]$powerPointPid
    } catch {
        # Conservative fallback: only quit when no PowerPoint process existed.
        $ownsPowerPointProcess = $existingPowerPointPids.Count -eq 0
    }
    $presentation = $powerPoint.Presentations.Open($pptxPath, -1, 0, 0)
    $slideWidth = $presentation.PageSetup.SlideWidth
    $slideHeight = $presentation.PageSetup.SlideHeight
    for ($slideIndex = 1; $slideIndex -le $presentation.Slides.Count; $slideIndex++) {
        $slide = $presentation.Slides.Item($slideIndex)
        $textBoxes = @()
        for ($shapeIndex = 1; $shapeIndex -le $slide.Shapes.Count; $shapeIndex++) {
            $shape = $slide.Shapes.Item($shapeIndex)
            try {
                if ($shape.HasTextFrame -eq -1 -and $shape.TextFrame2.HasText -eq -1) {
                    $frame = $shape.TextFrame2
                    $range = $frame.TextRange
                    $availableWidth = [Math]::Max(1, $shape.Width - $frame.MarginLeft - $frame.MarginRight)
                    $availableHeight = [Math]::Max(1, $shape.Height - $frame.MarginTop - $frame.MarginBottom)
                    # Read PowerPoint's wrapped lines once: the overflow
                    # measurement below and the CJK checks after it both need
                    # them. Some partial TextFrame2 implementations do not
                    # expose Lines(), so treat the count as best-effort.
                    $lineTexts = @()
                    try {
                        $renderedLines = $range.Lines()
                        for ($lineIndex = 1; $lineIndex -le $renderedLines.Count; $lineIndex++) {
                            $lineText = [string]$renderedLines.Item($lineIndex).Text
                            $lineTexts += (($lineText -replace '[\r\n]+', '').Trim())
                        }
                    } catch {
                    }
                    # PowerPoint reports BoundWidth for the unwrapped run on some
                    # Office builds even when WordWrap is active. Height is the
                    # reliable signal for clipped wrapped text in our layouts.
                    if ($range.BoundHeight -gt ($availableHeight + 2)) {
                        $fullText = (([string]$range.Text) -replace '[\r\n]+', ' ').Trim()
                        $snippet = $fullText
                        if ($snippet.Length -gt 72) { $snippet = $snippet.Substring(0, 72) + '…' }
                        $issues.Add([pscustomobject]@{
                            severity = 'error'
                            code = 'text_overflow'
                            slide = $slideIndex
                            shape = [string]$shape.Name
                            message = "Text '$snippet' exceeds its box on slide $slideIndex (shape $shapeIndex)."
                            # Carry the geometry so the caller is told how much
                            # copy has to go instead of guessing at it.
                            overflow = [pscustomobject]@{
                                boundHeight = [Math]::Round([double]$range.BoundHeight, 1)
                                availableHeight = [Math]::Round([double]$availableHeight, 1)
                                lineCount = $lineTexts.Count
                                textLength = $fullText.Length
                                firstLineText = $(if ($lineTexts.Count -gt 0) { [string]$lineTexts[0] } else { '' })
                                lineTexts = @($lineTexts)
                            }
                        })
                    }
                    # Inspect PowerPoint's actual wrapped lines. This catches
                    # CJK defects that BoundHeight cannot see: punctuation at
                    # line start and one-to-three-character orphan endings.
                    if ($lineTexts.Count -gt 1) {
                        $plainText = (([string]$range.Text) -replace '\s+', '').Trim()
                        $lastLine = [string]$lineTexts[-1]
                        # Quote the run itself. A shape index alone cannot be
                        # mapped back to a content channel by the caller, and a
                        # slide may hold several runs sharing the same words.
                        $cjkSnippet = $plainText
                        if ($cjkSnippet.Length -gt 72) { $cjkSnippet = $cjkSnippet.Substring(0, 72) + '…' }
                        # The first rendered line is this box's real capacity at
                        # this size, which is what makes a character target
                        # possible instead of "shorten the copy".
                        $cjkMeasurement = [pscustomobject]@{
                            lineCount = $lineTexts.Count
                            firstLineChars = ([string]$lineTexts[0]).Length
                            lastLineChars = $lastLine.Length
                            textLength = $plainText.Length
                            firstLineText = [string]$lineTexts[0]
                            lineTexts = @($lineTexts)
                        }
                        $badLeadingLine = $lineTexts | Where-Object { $_ -match '^[，。；：！？、）》】」』％%]' } | Select-Object -First 1
                        # A time, a decimal or a thousands group broken across
                        # lines ("17:" / "00 UTC") reads as two numbers. The
                        # renderer keeps such tokens whole in its own breaks;
                        # this catches PowerPoint re-wrapping past them.
                        for ($lineIndex = 1; $lineIndex -lt $lineTexts.Count; $lineIndex++) {
                            $previousLine = [string]$lineTexts[$lineIndex - 1]
                            $currentLine = [string]$lineTexts[$lineIndex]
                            if ($previousLine -match '\d[:：.,]$' -and $currentLine -match '^\d') {
                                $issues.Add([pscustomobject]@{
                                    severity = 'warning'
                                    code = 'numeric_token_split'
                                    slide = $slideIndex
                                    shape = [string]$shape.Name
                                    message = "A number is split across rendered lines on slide $slideIndex (shape $shapeIndex): '$previousLine' / '$currentLine'. The run reads '$cjkSnippet'."
                                    cjkLine = $cjkMeasurement
                                })
                                break
                            }
                        }
                        if ($badLeadingLine) {
                            $issues.Add([pscustomobject]@{
                                severity = 'error'
                                code = 'cjk_line_start_punctuation'
                                slide = $slideIndex
                                shape = [string]$shape.Name
                                message = "CJK punctuation starts a rendered line on slide $slideIndex (shape $shapeIndex): '$badLeadingLine'. The run reads '$cjkSnippet'."
                                cjkLine = $cjkMeasurement
                            })
                        }
                        if ($plainText.Length -ge 12 -and $lastLine -match '^[\u3400-\u9fff]{1,3}[，。；：！？、）》】」』％%]?$') {
                            # A stranded tail is a typesetting blemish on an
                            # otherwise correct slide, so it is reported for
                            # repair but never withholds a finished deck.
                            $issues.Add([pscustomobject]@{
                                severity = 'warning'
                                code = 'cjk_orphan_line'
                                slide = $slideIndex
                                shape = [string]$shape.Name
                                message = "Only '$lastLine' remains on the final rendered line on slide $slideIndex (shape $shapeIndex), in the run '$cjkSnippet'."
                                cjkLine = $cjkMeasurement
                            })
                        }
                    }
                    if ($shape.Left -lt -2 -or $shape.Top -lt -2 -or
                        ($shape.Left + $shape.Width) -gt ($slideWidth + 2) -or
                        ($shape.Top + $shape.Height) -gt ($slideHeight + 2)) {
                        $issues.Add([pscustomobject]@{
                            severity = 'error'
                            code = 'text_out_of_bounds'
                            slide = $slideIndex
                            shape = [string]$shape.Name
                            message = "Text box leaves the slide canvas on slide $slideIndex (shape $shapeIndex)."
                        })
                    }
                    $textBoxes += [pscustomobject]@{
                        ShapeIndex = $shapeIndex
                        ShapeName = [string]$shape.Name
                        # PowerPoint text boxes often reserve generous layout
                        # space around the rendered glyphs. Use the native text
                        # bounds for overlap QA so whitespace inside a title or
                        # centered table header is not reported as a collision.
                        Left = [double]$range.BoundLeft
                        Top = [double]$range.BoundTop
                        Width = [double]$range.BoundWidth
                        Height = [double]$range.BoundHeight
                        Text = (([string]$range.Text) -replace '[\r\n]+', '').Trim()
                        FontSize = [double]$range.Font.Size
                    }
                }
            } catch {
                # Some non-text Office shapes expose partial TextFrame2 implementations.
            }
        }
        for ($firstIndex = 0; $firstIndex -lt $textBoxes.Count; $firstIndex++) {
            for ($secondIndex = $firstIndex + 1; $secondIndex -lt $textBoxes.Count; $secondIndex++) {
                $first = $textBoxes[$firstIndex]
                $second = $textBoxes[$secondIndex]
                # Large two-digit folios are deliberately placed behind the
                # foreground insight strip in editorial directions. They are
                # decorative signatures, not competing readable text boxes.
                $firstIsDecorativeFolio = $first.Text -match '^\d{2}$' -and $first.FontSize -ge 36
                $secondIsDecorativeFolio = $second.Text -match '^\d{2}$' -and $second.FontSize -ge 36
                if ($firstIsDecorativeFolio -or $secondIsDecorativeFolio) { continue }
                $overlapWidth = [Math]::Min($first.Left + $first.Width, $second.Left + $second.Width) - [Math]::Max($first.Left, $second.Left)
                $overlapHeight = [Math]::Min($first.Top + $first.Height, $second.Top + $second.Height) - [Math]::Max($first.Top, $second.Top)
                if ($overlapWidth -gt 4 -and $overlapHeight -gt 4) {
                    $overlapArea = $overlapWidth * $overlapHeight
                    $smallerArea = [Math]::Max(1, [Math]::Min($first.Width * $first.Height, $second.Width * $second.Height))
                    if (($overlapArea / $smallerArea) -gt 0.15) {
                        $issues.Add([pscustomobject]@{
                            severity = 'error'
                            code = 'text_overlap'
                            slide = $slideIndex
                            shapes = @([string]$first.ShapeName, [string]$second.ShapeName)
                            message = "Text boxes overlap on slide $slideIndex (shapes $($first.ShapeIndex) and $($second.ShapeIndex))."
                        })
                    }
                }
            }
        }
        if ($previewDir) {
            $slidePath = Join-Path $previewDir ("slide-{0:D2}.png" -f $slideIndex)
            $slide.Export($slidePath, 'PNG', 1600, 900)
        }
    }
    if ($pdfPath) {
        try {
            # ppSaveAsPDF = 32. SaveAs has better COM compatibility across
            # Office 2016/365 builds than ExportAsFixedFormat's long signature.
            $presentation.SaveAs($pdfPath, 32)
        } catch {
            $issues.Add([pscustomobject]@{
                severity = 'warning'
                code = 'pdf_export_failed'
                message = "PowerPoint could not export PDF: $($_.Exception.Message)"
            })
        }
    }
    $payload = [pscustomobject]@{
        slideCount = $presentation.Slides.Count
        issues = $issues
    }
    [System.IO.File]::WriteAllText($qaPath, ($payload | ConvertTo-Json -Depth 6), [System.Text.UTF8Encoding]::new($false))
} finally {
    if ($presentation) {
        try { $presentation.Close() } catch {}
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($presentation)
    }
    if ($powerPoint) {
        if ($ownsPowerPointProcess) {
            try { $powerPoint.Quit() } catch {}
        }
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint)
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
`;

function abortError(signal?: AbortSignal): Error {
    const reason = signal?.reason;
    const error = new Error(reason instanceof Error ? reason.message : 'Presentation export aborted');
    error.name = 'AbortError';
    return error;
}

/**
 * Run the QA script from a file rather than the command line.
 *
 * It used to travel as -EncodedCommand, whose base64 of UTF-16 runs about 2.7x
 * the script length. That put a 12KB script within a hundred characters of the
 * 32767-character Windows command line, so the next edit to it �?any edit �?made
 * every export die with ENAMETOOLONG before PowerPoint was even reached, and the
 * caller saw only "no readable previews". A file has no such ceiling.
 *
 * The BOM is not optional: the script matches CJK punctuation classes, and
 * PowerShell 5.1 reads a BOM-less file as ANSI and mangles them.
 */
async function runPowerShell(
    script: string,
    env: NodeJS.ProcessEnv,
    signal?: AbortSignal,
): Promise<void> {
    if (signal?.aborted) throw abortError(signal);
    const scriptPath = join(
        await fs.mkdtemp(join(tmpdir(), 'openflux-pptx-qa-')),
        'presentation-qa.ps1',
    );
    await fs.writeFile(scriptPath, `\ufeff${script}`, 'utf8');
    try {
        await new Promise<void>((resolve, reject) => {
            const child = spawn('powershell.exe', [
                '-NoLogo',
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy', 'Bypass',
                '-File', scriptPath,
            ], {
                env,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stderr = '';
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', chunk => { stderr += String(chunk); });
            const onAbort = () => {
                child.kill();
                reject(abortError(signal));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            child.once('error', error => {
                signal?.removeEventListener('abort', onAbort);
                reject(error);
            });
            child.once('exit', code => {
                signal?.removeEventListener('abort', onAbort);
                if (signal?.aborted) return reject(abortError(signal));
                if (code === 0) resolve();
                else reject(new Error(stderr.trim() || `PowerPoint export exited with code ${code}`));
            });
        });
    } finally {
        await fs.rm(dirname(scriptPath), { recursive: true, force: true }).catch(() => undefined);
    }
}

function slideNumber(path: string): number {
    return Number(basename(path).match(/(\d+)/)?.[1] || 0);
}

export async function createPresentationContactSheet(
    slideImages: string[],
    outputPath: string,
    options: { columns?: number; cellWidth?: number; cellHeight?: number } = {},
): Promise<string> {
    if (!slideImages.length) throw new Error('Cannot create a presentation preview without slide images');
    const ordered = [...slideImages].sort((a, b) => slideNumber(a) - slideNumber(b));
    const columns = options.columns || (ordered.length === 1 ? 1 : Math.min(3, ordered.length));
    const cellW = options.cellWidth || 400;
    const cellH = options.cellHeight || 225;
    const gutter = 18;
    const rows = Math.ceil(ordered.length / columns);
    const width = columns * cellW + (columns + 1) * gutter;
    const height = rows * cellH + (rows + 1) * gutter;
    const composites: sharp.OverlayOptions[] = [];
    for (let index = 0; index < ordered.length; index++) {
        const image = await sharp(ordered[index])
            .resize(cellW, cellH, { fit: 'contain', background: '#ffffff' })
            .extend({ top: 1, bottom: 1, left: 1, right: 1, background: '#d8ddd9' })
            .png()
            .toBuffer();
        composites.push({
            input: image,
            left: gutter + (index % columns) * (cellW + gutter),
            top: gutter + Math.floor(index / columns) * (cellH + gutter),
        });
    }
    await sharp({
        create: { width, height, channels: 3, background: '#eef1ef' },
    }).composite(composites).png().toFile(outputPath);
    return outputPath;
}

/** Four slides per sheet at 960x540 each. Six at 720x405 rendered 15pt body
 * copy about six pixels tall, and the reviewing model graded it unreadable
 * and scored typography down for text that reads fine on a projector. */
export async function createPresentationReviewSheets(
    slideImages: string[],
    outputDir: string,
    batchSize = 4,
): Promise<string[]> {
    const ordered = [...slideImages].sort((a, b) => slideNumber(a) - slideNumber(b));
    const paths: string[] = [];
    for (let start = 0; start < ordered.length; start += batchSize) {
        const batch = ordered.slice(start, start + batchSize);
        const path = join(outputDir, `.openflux-review-${String(paths.length + 1).padStart(2, '0')}.png`);
        await createPresentationContactSheet(batch, path, { columns: 2, cellWidth: 960, cellHeight: 540 });
        paths.push(path);
    }
    return paths;
}

export async function exportPresentationWithPowerPoint(
    options: PresentationExportOptions,
): Promise<PresentationExportResult> {
    const qaPath = join(options.previewDir || dirname(options.pptxPath), `.openflux-ppt-qa-${Date.now()}.json`);
    if (options.previewDir) await fs.mkdir(options.previewDir, { recursive: true });
    options.onProgress?.('Rendering every slide and checking text fit in PowerPoint');
    try {
        await runPowerShell(POWERPOINT_EXPORT_SCRIPT, {
            ...process.env,
            OPENFLUX_PRESENTATION_PPTX: options.pptxPath,
            OPENFLUX_PRESENTATION_PDF: options.pdfPath || '',
            OPENFLUX_PRESENTATION_PREVIEW_DIR: options.previewDir || '',
            OPENFLUX_PRESENTATION_QA: qaPath,
        }, options.signal);
        const qaRaw = JSON.parse(await fs.readFile(qaPath, 'utf8')) as {
            issues?: PresentationQualityIssue[];
        };
        const slideImages = options.previewDir
            ? (await fs.readdir(options.previewDir))
                .filter(name => /^slide-\d+\.png$/i.test(name))
                .map(name => join(options.previewDir!, name))
                .sort((a, b) => slideNumber(a) - slideNumber(b))
            : [];
        let previewPath: string | undefined;
        let reviewSheetPaths: string[] | undefined;
        if (options.previewPath && slideImages.length) {
            options.onProgress?.('Building a contact sheet for visual review');
            previewPath = await createPresentationContactSheet(slideImages, options.previewPath);
            if (options.previewDir) {
                options.onProgress?.('Building readable six-slide review sheets');
                reviewSheetPaths = await createPresentationReviewSheets(slideImages, options.previewDir);
            }
        }
        return {
            pdfPath: options.pdfPath,
            previewPath,
            reviewSheetPaths,
            slideImages,
            issues: Array.isArray(qaRaw.issues)
                ? qaRaw.issues
                    .map(withTextOverflowRepairGuidance)
                    .map(withCjkLineRepairGuidance)
                : [],
        };
    } finally {
        await fs.rm(qaPath, { force: true }).catch(() => undefined);
    }
}
