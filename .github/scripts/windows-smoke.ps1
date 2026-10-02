param(
    [Parameter(Mandatory = $true)]
    [string]$ExecutablePath,

    [string]$ScreenshotPath = "output/windows-smoke.png",

    [ValidateRange(5, 120)]
    [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$screenshot = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $ScreenshotPath))
$outputDirectory = Split-Path -Parent $screenshot
$diagnostic = Join-Path $outputDirectory "windows-smoke.txt"
$renderScript = Join-Path $PSScriptRoot "windows-render-smoke.mjs"
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

$process = $null
$browserArgumentsName = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"
$previousBrowserArguments = [Environment]::GetEnvironmentVariable($browserArgumentsName, "Process")

try {
    $executable = (Resolve-Path -LiteralPath $ExecutablePath).Path
    $renderScript = (Resolve-Path -LiteralPath $renderScript).Path
    [Environment]::SetEnvironmentVariable(
        $browserArgumentsName,
        "--remote-debugging-port=9222 --remote-allow-origins=*",
        "Process"
    )

    $process = Start-Process -FilePath $executable -PassThru
    & node $renderScript --port 9222 --output $outputDirectory --timeout $TimeoutSeconds
    if ($LASTEXITCODE -ne 0) {
        throw "WebView2 render smoke exited with code $LASTEXITCODE."
    }

    $process.Refresh()
    if ($process.HasExited) {
        throw "CodeFlow exited during render verification (exit code $($process.ExitCode))."
    }

    $wide = Get-Item -LiteralPath (Join-Path $outputDirectory "windows-smoke-wide.png")
    $compact = Get-Item -LiteralPath (Join-Path $outputDirectory "windows-smoke-compact.png")
    "PASS: CodeFlow process $($process.Id); wide $($wide.Length) bytes; compact $($compact.Length) bytes." |
        Set-Content -LiteralPath $diagnostic
    Write-Host (Get-Content -LiteralPath $diagnostic -Raw)
}
catch {
    "FAIL: $($_.Exception.Message)" | Set-Content -LiteralPath $diagnostic
    throw
}
finally {
    [Environment]::SetEnvironmentVariable(
        $browserArgumentsName,
        $previousBrowserArguments,
        "Process"
    )

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
