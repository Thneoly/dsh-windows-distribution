[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ArtifactDirectory,
    [Parameter(Mandatory)][string]$BuildVersion
)

$ErrorActionPreference = 'Stop'
$ArtifactDirectory = (Resolve-Path -LiteralPath $ArtifactDirectory).Path
$manifestPath = Join-Path $ArtifactDirectory 'release-manifest.json'
$sumsPath = Join-Path $ArtifactDirectory 'SHA256SUMS.txt'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Missing release manifest: $manifestPath" }
if (-not (Test-Path -LiteralPath $sumsPath -PathType Leaf)) { throw "Missing checksum file: $sumsPath" }

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.product -ne 'deepseek-harness') { throw "Unexpected artifact product: $($manifest.product)" }
if ($manifest.target -ne 'win32-x64') { throw "Unexpected artifact target: $($manifest.target)" }
if ($manifest.buildVersion -ne $BuildVersion) { throw "Build version mismatch: manifest=$($manifest.buildVersion), expected=$BuildVersion" }
if ($manifest.distributionEligible -ne $false) { throw 'Unsigned smoke-test artifact must remain explicitly non-distributable.' }

$installerEntries = @($manifest.artifacts | Where-Object {
    $_.file -match '^deepseek-harness-.+-win-x64-unsigned\.exe$'
})
if ($installerEntries.Count -ne 1) { throw "Expected exactly one unsigned installer in the manifest, found $($installerEntries.Count)." }
$installerEntry = $installerEntries[0]
$installerRelativePath = $installerEntry.file.Replace('/', '\')
$installerPath = Join-Path $ArtifactDirectory $installerRelativePath
if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) { throw "Installer is missing: $installerPath" }

$actualInstallerHash = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualInstallerHash -ne $installerEntry.sha256.ToLowerInvariant()) {
    throw "Installer SHA-256 mismatch: manifest=$($installerEntry.sha256), actual=$actualInstallerHash"
}
$installerSum = @(Get-Content -LiteralPath $sumsPath | Where-Object {
    $_ -match ('^([a-f0-9]{64})  ' + [regex]::Escape($installerEntry.file) + '$')
})
if ($installerSum.Count -ne 1 -or $installerSum[0].Split(' ')[0] -ne $actualInstallerHash) {
    throw 'SHA256SUMS.txt does not contain the matching installer digest.'
}
$manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
$manifestSum = @(Get-Content -LiteralPath $sumsPath | Where-Object { $_ -match '^([a-f0-9]{64})  release-manifest\.json$' })
if ($manifestSum.Count -ne 1 -or $manifestSum[0].Split(' ')[0] -ne $manifestHash) {
    throw 'SHA256SUMS.txt does not contain the matching release-manifest digest.'
}

$pinPath = Join-Path $PSScriptRoot '..\upstream.lock.json'
$pin = Get-Content -LiteralPath $pinPath -Raw | ConvertFrom-Json
$installDirectory = "C:\dsh-smoke-$env:GITHUB_RUN_ID"
if (Test-Path -LiteralPath $installDirectory) {
    throw "Refusing to overwrite an existing smoke-test installation: $installDirectory"
}

$setup = $null
try {
    Write-Host "Installing $installerPath to $installDirectory"
    $setup = Start-Process -FilePath $installerPath -ArgumentList @('/S', "/D=$installDirectory") -PassThru -WindowStyle Hidden
    if (-not $setup.WaitForExit(180000)) {
        $setup.Kill()
        $setup.WaitForExit()
        throw 'Silent installer timed out after 180 seconds.'
    }
    $setup.Refresh()
    if ($setup.ExitCode -ne 0) { throw "Silent installer failed with exit code $($setup.ExitCode)." }
    $setup.Dispose()
    $setup = $null

    $appExecutable = Join-Path $installDirectory 'DeepSeek Harness.exe'
    $resources = Join-Path $installDirectory 'resources'
    $appArchive = Join-Path $resources 'app.asar'
    $dshUnpackedModules = Join-Path $resources 'app.asar.unpacked\dsh\node_modules'
    $primaryRuntime = Join-Path $resources 'runtime\primary-runtime'
    $primaryRuntimeDescriptor = Join-Path $primaryRuntime 'runtime.json'
    $nodePath = Join-Path $primaryRuntime 'dependencies\node\bin\node.exe'
    $pythonPath = Join-Path $primaryRuntime 'dependencies\python\python.exe'
    $pnpmPath = Join-Path $primaryRuntime 'dependencies\pnpm\bin\pnpm.mjs'
    $officeCliPath = Join-Path $dshUnpackedModules '@deepseek-ai\libreoffice-kit\lib\cli.js'

    $requiredPaths = @(
        $appExecutable, $appArchive, $primaryRuntimeDescriptor,
        $nodePath, $pythonPath, $pnpmPath, $officeCliPath
    )
    foreach ($requiredPath in $requiredPaths) {
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            throw "Installed application payload is missing: $requiredPath"
        }
    }

    if ($manifest.releaseVersion -ne $pin.release.version -or $manifest.upstreamCommit -ne $pin.commit) {
        throw 'Release provenance does not match the pinned DSH source.'
    }
    $runtimeDescriptor = Get-Content -LiteralPath $primaryRuntimeDescriptor -Raw | ConvertFrom-Json
    if ($runtimeDescriptor.node -ne $pin.toolchain.nodeVersion
        -or $runtimeDescriptor.python -ne $pin.toolchain.pythonVersion
        -or $runtimeDescriptor.pnpm -ne $pin.toolchain.pnpmVersion) {
        throw 'Installed primary-runtime descriptor does not match the pinned runtime versions.'
    }

    $nodeVersion = (& $nodePath --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne "v$($pin.toolchain.nodeVersion)") {
        throw "Bundled Node.js check failed: expected v$($pin.toolchain.nodeVersion), found '$nodeVersion'."
    }
    $pythonVersion = (& $pythonPath --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $pythonVersion -ne "Python $($pin.toolchain.pythonVersion)") {
        throw "Bundled Python check failed: expected Python $($pin.toolchain.pythonVersion), found '$pythonVersion'."
    }
    $pnpmVersion = (& $nodePath $pnpmPath --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $pnpmVersion -ne $pin.toolchain.pnpmVersion) {
        throw "Bundled pnpm check failed: expected $($pin.toolchain.pnpmVersion), found '$pnpmVersion'."
    }

    $pythonSmoke = (& $pythonPath -c "import lxml.etree, docx, openpyxl, pptx; print('bundled-python-packages-ok')" 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $pythonSmoke -notmatch 'bundled-python-packages-ok') {
        throw "Bundled Python package smoke test failed: $pythonSmoke"
    }

    Write-Host 'PASS: unsigned installer installed successfully.'
    Write-Host "PASS: release provenance matches pinned DSH $($pin.release.version)."
    Write-Host "PASS: bundled Node.js $nodeVersion; Python $pythonVersion; pnpm $pnpmVersion."
    Write-Host "PASS: bundled Python can import lxml.etree, python-docx, openpyxl, and python-pptx."
    Write-Host "PASS: installed app, runtime descriptors, and Office conversion CLI are present."
    Write-Host "Installer SHA-256: $actualInstallerHash"
}
finally {
    if ($null -ne $setup) {
        if (-not $setup.HasExited) { $setup.Kill(); $setup.WaitForExit() }
        $setup.Dispose()
    }
    if (Test-Path -LiteralPath $installDirectory) {
        Remove-Item -LiteralPath $installDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}
