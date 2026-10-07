param(
    [Parameter(Mandatory = $true)]
    [string]$ExecutablePath,

    [string]$ScreenshotPath = "output/windows-smoke.png",

    [ValidateRange(5, 120)]
    [int]$TimeoutSeconds = 30,

    [switch]$RestoreOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$screenshot = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $ScreenshotPath))
$outputDirectory = Split-Path -Parent $screenshot
$diagnostic = Join-Path $outputDirectory "windows-smoke.txt"
$renderScript = Join-Path $PSScriptRoot "windows-render-smoke.mjs"
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

$process = $null
$wallpaperJob = $null
$wallpaperCaptured = $false
$originalWallpaper = $null
$wallpaperFirst = $null
$wallpaperSecond = $null
$wallpaperRequest = Join-Path $outputDirectory "wallpaper-change.request"
$wallpaperDone = Join-Path $outputDirectory "wallpaper-change.done"
$wallpaperRestoreError = $null
$browserArgumentsName = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"
$previousBrowserArguments = [Environment]::GetEnvironmentVariable($browserArgumentsName, "Process")
$browserArguments = "--remote-debugging-port=9222 --remote-allow-origins=*"
$policyPath = "HKLM:\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments"
$policyKeyExisted = Test-Path -LiteralPath $policyPath
$policyValueExisted = $false
$previousPolicyValue = $null
$policyValueName = $null

function Add-SmokeDiagnostics {
    param([System.Diagnostics.Process]$AppProcess)

    if ($null -eq $AppProcess) {
        return
    }

    $AppProcess.Refresh()
    $exitState = if ($AppProcess.HasExited) { "exited=$($AppProcess.ExitCode)" } else { "alive" }
    "Host: pid=$($AppProcess.Id); $exitState; window=$($AppProcess.MainWindowHandle); title=$($AppProcess.MainWindowTitle)" |
        Add-Content -LiteralPath $diagnostic

    Get-CimInstance Win32_Process -Filter "ParentProcessId = $($AppProcess.Id)" -ErrorAction SilentlyContinue |
        ForEach-Object {
            "Child: pid=$($_.ProcessId); name=$($_.Name); command=$($_.CommandLine)" |
                Add-Content -LiteralPath $diagnostic
        }

    Get-NetTCPConnection -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object {
            "Listener: $($_.LocalAddress):$($_.LocalPort); pid=$($_.OwningProcess)" |
                Add-Content -LiteralPath $diagnostic
        }
}

try {
    Add-Type -AssemblyName System.Drawing
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CodeFlowWallpaperSmoke {
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool GetWallpaper(uint action, uint parameter, StringBuilder value, uint flags);
    [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SetWallpaper(uint action, uint parameter, string value, uint flags);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(IntPtr window, out Rect rectangle);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr window);
}
"@
    if (-not $RestoreOnly) {
    $wallpaperBuffer = New-Object System.Text.StringBuilder 32768
    if (-not [CodeFlowWallpaperSmoke]::GetWallpaper(0x0073, $wallpaperBuffer.Capacity, $wallpaperBuffer, 0)) {
        throw "Windows could not capture the original wallpaper."
    }
    $originalWallpaper = $wallpaperBuffer.ToString()
    $wallpaperCaptured = $true
    $runnerTemp = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { [System.IO.Path]::GetTempPath() } else { $env:RUNNER_TEMP }
    $wallpaperFirst = Join-Path $runnerTemp "codeflow-wallpaper-first-$PID.jpg"
    $wallpaperSecond = Join-Path $runnerTemp "codeflow-wallpaper-second-$PID.jpg"
    $wallpapers = @(
        [pscustomobject]@{ Path = $wallpaperFirst; Red = 220; Green = 55; Blue = 45 },
        [pscustomobject]@{ Path = $wallpaperSecond; Red = 35; Green = 80; Blue = 220 }
    )
    foreach ($wallpaper in $wallpapers) {
        $bitmap = [System.Drawing.Bitmap]::new(1920, 1080)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.Clear([System.Drawing.Color]::FromArgb($wallpaper.Red, $wallpaper.Green, $wallpaper.Blue))
            $bitmap.Save($wallpaper.Path, [System.Drawing.Imaging.ImageFormat]::Jpeg)
        }
        finally {
            $graphics.Dispose()
            $bitmap.Dispose()
        }
    }
    Remove-Item -LiteralPath $wallpaperRequest, $wallpaperDone -Force -ErrorAction SilentlyContinue
    if (-not [CodeFlowWallpaperSmoke]::SetWallpaper(0x0014, 0, $wallpaperFirst, 3)) {
        throw "Windows could not set the first smoke wallpaper."
    }
    $wallpaperJob = Start-Job -ArgumentList $wallpaperRequest, $wallpaperDone, $wallpaperSecond -ScriptBlock {
        param($RequestPath, $DonePath, $WallpaperPath)
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CodeFlowWallpaperWatcher {
    [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SetWallpaper(uint action, uint parameter, string value, uint flags);
}
"@
        $limit = [Diagnostics.Stopwatch]::StartNew()
        while (-not (Test-Path -LiteralPath $RequestPath) -and $limit.Elapsed.TotalSeconds -lt 120) {
            Start-Sleep -Milliseconds 100
        }
        if (-not (Test-Path -LiteralPath $RequestPath)) { throw "Wallpaper change request timed out." }
        if (-not [CodeFlowWallpaperWatcher]::SetWallpaper(0x0014, 0, $WallpaperPath, 3)) {
            throw "Windows could not set the second smoke wallpaper."
        }
        Set-Content -LiteralPath $DonePath -Value "changed"
    }
    }

    $executable = (Resolve-Path -LiteralPath $ExecutablePath).Path
    $renderScript = (Resolve-Path -LiteralPath $renderScript).Path
    $policyValueName = [System.IO.Path]::GetFileName($executable)
    if ($policyKeyExisted) {
        $existingPolicy = Get-ItemProperty -LiteralPath $policyPath -Name $policyValueName -ErrorAction SilentlyContinue
        if ($null -ne $existingPolicy) {
            $policyValueExisted = $true
            $previousPolicyValue = $existingPolicy.$policyValueName
        }
    }
    New-Item -Path $policyPath -Force | Out-Null
    New-ItemProperty -LiteralPath $policyPath -Name $policyValueName -PropertyType String -Value $browserArguments -Force |
        Out-Null
    [Environment]::SetEnvironmentVariable(
        $browserArgumentsName,
        $browserArguments,
        "Process"
    )

    if ($RestoreOnly -and (Get-NetTCPConnection -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue)) {
        throw "WebView2 CDP port 9222 is still owned before installer recovery verification."
    }
    $process = Start-Process -FilePath $executable -PassThru
    if ($RestoreOnly) {
        & node $renderScript --port 9222 --output $outputDirectory --timeout $TimeoutSeconds --restore-only
    }
    else {
        & node $renderScript --port 9222 --output $outputDirectory --timeout $TimeoutSeconds
        if ($LASTEXITCODE -ne 0) {
            throw "WebView2 render smoke exited with code $LASTEXITCODE."
        }
        $wallpaperJob | Wait-Job -Timeout 5 | Out-Null
        if ($wallpaperJob.State -ne "Completed") {
            throw "Wallpaper watcher did not complete: $($wallpaperJob.State)."
        }
        Receive-Job -Job $wallpaperJob -ErrorAction Stop | Out-Null
        Remove-Job -Job $wallpaperJob
        $wallpaperJob = $null

        $process.Refresh()
        if ($process.HasExited) {
            throw "CodeFlow exited during render verification (exit code $($process.ExitCode))."
        }

        Stop-Process -Id $process.Id -Force
        if (-not $process.WaitForExit(5000)) {
            throw "CodeFlow process $($process.Id) did not stop for recovery restart."
        }
        $process.Dispose()
        $process = $null
        $process = Start-Process -FilePath $executable -PassThru
        & node $renderScript --port 9222 --output $outputDirectory --timeout $TimeoutSeconds --restore-only
    }
    if ($LASTEXITCODE -ne 0) {
        throw "WebView2 recovery restore smoke exited with code $LASTEXITCODE."
    }

    $process.Refresh()
    if ($process.HasExited) {
        throw "CodeFlow exited during recovery verification (exit code $($process.ExitCode))."
    }
    if ($process.MainWindowHandle -eq [IntPtr]::Zero) {
        throw "CodeFlow has no native window for compositor capture."
    }
    [void][CodeFlowWallpaperSmoke]::SetForegroundWindow($process.MainWindowHandle)
    Start-Sleep -Milliseconds 500
    $windowRectangle = [CodeFlowWallpaperSmoke+Rect]::new()
    if (-not [CodeFlowWallpaperSmoke]::GetWindowRect($process.MainWindowHandle, [ref]$windowRectangle)) {
        throw "Windows could not read the CodeFlow window rectangle."
    }
    $windowWidth = $windowRectangle.Right - $windowRectangle.Left
    $windowHeight = $windowRectangle.Bottom - $windowRectangle.Top
    if ($windowWidth -lt 100 -or $windowHeight -lt 100) {
        throw "CodeFlow window rectangle is invalid: $windowWidth x $windowHeight."
    }
    $nativeCapturePath = Join-Path $outputDirectory "windows-native-compositor.png"
    $nativeCapture = [System.Drawing.Bitmap]::new($windowWidth, $windowHeight)
    $nativeGraphics = [System.Drawing.Graphics]::FromImage($nativeCapture)
    try {
        $nativeGraphics.CopyFromScreen(
            $windowRectangle.Left,
            $windowRectangle.Top,
            0,
            0,
            $nativeCapture.Size,
            [System.Drawing.CopyPixelOperation]::SourceCopy
        )
        $nativeCapture.Save($nativeCapturePath, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $nativeGraphics.Dispose()
        $nativeCapture.Dispose()
    }

    $wide = Get-Item -LiteralPath (Join-Path $outputDirectory "windows-smoke-wide.png")
    $compact = Get-Item -LiteralPath (Join-Path $outputDirectory "windows-smoke-compact.png")
    $native = Get-Item -LiteralPath $nativeCapturePath
    $recovery = Get-Item -LiteralPath (Join-Path $outputDirectory "windows-recovery-expected.json")
    "PASS: CodeFlow process $($process.Id); wide $($wide.Length) bytes; compact $($compact.Length) bytes; native compositor $($native.Length) bytes; recovery restart $($recovery.Length) bytes." |
        Set-Content -LiteralPath $diagnostic
    Write-Host (Get-Content -LiteralPath $diagnostic -Raw)
}
catch {
    "FAIL: $($_.Exception.Message)" | Set-Content -LiteralPath $diagnostic
    Add-SmokeDiagnostics -AppProcess $process
    throw
}
finally {
    if ($null -ne $wallpaperJob) {
        Stop-Job -Job $wallpaperJob -ErrorAction SilentlyContinue
        Remove-Job -Job $wallpaperJob -Force -ErrorAction SilentlyContinue
    }
    if ($wallpaperCaptured) {
        try {
            if (-not [CodeFlowWallpaperSmoke]::SetWallpaper(0x0014, 0, $originalWallpaper, 3)) {
                throw "Windows could not restore the original wallpaper."
            }
            $restoredWallpaper = New-Object System.Text.StringBuilder 32768
            if (-not [CodeFlowWallpaperSmoke]::GetWallpaper(0x0073, $restoredWallpaper.Capacity, $restoredWallpaper, 0) -or
                $restoredWallpaper.ToString() -ne $originalWallpaper) {
                throw "Windows did not restore the original wallpaper path exactly."
            }
        }
        catch {
            $wallpaperRestoreError = $_
        }
    }
    if (-not $RestoreOnly) {
        Remove-Item -LiteralPath $wallpaperFirst, $wallpaperSecond, $wallpaperRequest, $wallpaperDone -Force -ErrorAction SilentlyContinue
    }

    [Environment]::SetEnvironmentVariable(
        $browserArgumentsName,
        $previousBrowserArguments,
        "Process"
    )

    if ($null -ne $policyValueName) {
        if ($policyValueExisted) {
            New-ItemProperty -LiteralPath $policyPath -Name $policyValueName -PropertyType String `
                -Value $previousPolicyValue -Force | Out-Null
        }
        elseif (Test-Path -LiteralPath $policyPath) {
            Remove-ItemProperty -LiteralPath $policyPath -Name $policyValueName -ErrorAction SilentlyContinue
        }

        if (-not $policyKeyExisted -and (Test-Path -LiteralPath $policyPath)) {
            $remainingValues = (Get-Item -LiteralPath $policyPath).GetValueNames()
            if ($remainingValues.Count -eq 0) {
                Remove-Item -LiteralPath $policyPath
            }
        }
    }

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
    if ($null -ne $wallpaperRestoreError) {
        throw $wallpaperRestoreError
    }
}
