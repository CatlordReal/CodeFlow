param(
    [Parameter(Mandatory = $true)]
    [string]$ExecutablePath,

    [string]$ScreenshotPath = "output/windows-smoke.png",

    [ValidateRange(5, 120)]
    [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class CodeFlowNativeWindow
{
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr window, out Rect rect);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr window, int command);
}
"@

$screenshot = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $ScreenshotPath))
$outputDirectory = Split-Path -Parent $screenshot
$diagnostic = Join-Path $outputDirectory "windows-smoke.txt"
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

$process = $null

try {
    $executable = (Resolve-Path -LiteralPath $ExecutablePath).Path
    $process = Start-Process -FilePath $executable -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $window = [IntPtr]::Zero

    while ([DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 500
        $process.Refresh()
        if ($process.HasExited) {
            throw "CodeFlow exited before opening a window (exit code $($process.ExitCode))."
        }

        $window = $process.MainWindowHandle
        if ($window -ne [IntPtr]::Zero) {
            break
        }
    }

    if ($window -eq [IntPtr]::Zero) {
        throw "CodeFlow did not expose a main window within $TimeoutSeconds seconds."
    }

    # Maximize the task-owned window so its client is visible before screen capture.
    [void][CodeFlowNativeWindow]::ShowWindow($window, 3)
    [void][CodeFlowNativeWindow]::SetForegroundWindow($window)
    Start-Sleep -Seconds 2
    $process.Refresh()
    if ($process.HasExited) {
        throw "CodeFlow exited before screenshot capture (exit code $($process.ExitCode))."
    }

    $window = $process.MainWindowHandle
    $rect = [CodeFlowNativeWindow+Rect]::new()
    if ($window -eq [IntPtr]::Zero -or -not [CodeFlowNativeWindow]::GetWindowRect($window, [ref]$rect)) {
        throw "Unable to read CodeFlow window bounds."
    }

    $windowBounds = [System.Drawing.Rectangle]::FromLTRB($rect.Left, $rect.Top, $rect.Right, $rect.Bottom)
    $captureBounds = [System.Drawing.Rectangle]::Intersect(
        $windowBounds,
        [System.Windows.Forms.SystemInformation]::VirtualScreen
    )
    if ($captureBounds.Width -lt 200 -or $captureBounds.Height -lt 200) {
        throw "CodeFlow window has invalid visible bounds: $($captureBounds.Width)x$($captureBounds.Height)."
    }

    $bitmap = [System.Drawing.Bitmap]::new($captureBounds.Width, $captureBounds.Height)
    try {
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.CopyFromScreen(
                $captureBounds.Location,
                [System.Drawing.Point]::Empty,
                $captureBounds.Size,
                [System.Drawing.CopyPixelOperation]::SourceCopy
            )
        }
        finally {
            $graphics.Dispose()
        }

        $sampledColors = [System.Collections.Generic.HashSet[int]]::new()
        $xStep = [Math]::Max(1, [int]($bitmap.Width / 12))
        $yStep = [Math]::Max(1, [int]($bitmap.Height / 12))
        for ($x = 0; $x -lt $bitmap.Width; $x += $xStep) {
            for ($y = 0; $y -lt $bitmap.Height; $y += $yStep) {
                [void]$sampledColors.Add($bitmap.GetPixel($x, $y).ToArgb())
            }
        }
        if ($sampledColors.Count -lt 4) {
            throw "Windows screenshot appears blank or unavailable."
        }

        $bitmap.Save($screenshot, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $bitmap.Dispose()
    }

    $image = Get-Item -LiteralPath $screenshot
    if ($image.Length -le 0) {
        throw "Windows smoke screenshot is empty."
    }

    "PASS: CodeFlow process $($process.Id), window $($captureBounds.Width)x$($captureBounds.Height), screenshot $($image.Length) bytes." |
        Set-Content -LiteralPath $diagnostic
    Write-Host (Get-Content -LiteralPath $diagnostic -Raw)
}
catch {
    "FAIL: $($_.Exception.Message)" | Set-Content -LiteralPath $diagnostic
    throw
}
finally {
    if ($null -ne $process) {
        $process.Refresh()
        if (-not $process.HasExited) {
            [void]$process.CloseMainWindow()
            if (-not $process.WaitForExit(5000)) {
                Stop-Process -Id $process.Id -Force
                $process.WaitForExit(5000)
            }
        }
        $process.Dispose()
    }
}
