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
    Add-SmokeDiagnostics -AppProcess $process
    throw
}
finally {
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
}
