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
if ($manifest.customDistributionComponentsIncluded -ne $true) {
    throw 'Release manifest does not attest to verified built-in distribution components.'
}
if ($null -eq $manifest.distributionBundle -or $manifest.distributionBundle.version -ne '1.0.0') {
    throw 'Release manifest does not contain the expected versioned distribution bundle.'
}

$distributionLockPath = Join-Path $ArtifactDirectory 'desktop-distribution.lock.json'
if (-not (Test-Path -LiteralPath $distributionLockPath -PathType Leaf)) { throw "Missing distribution lock: $distributionLockPath" }
$distributionLockHash = (Get-FileHash -LiteralPath $distributionLockPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($distributionLockHash -ne $manifest.distributionComponentsLockSha256.ToLowerInvariant()) {
    throw 'Distribution component lock SHA-256 does not match release provenance.'
}
$componentLock = Get-Content -LiteralPath $distributionLockPath -Raw | ConvertFrom-Json

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
    $dshRoot = Join-Path $resources 'dsh'
    $dshPackagePath = Join-Path $dshRoot 'package.json'
    $dshRuntimeDescriptor = Join-Path $dshRoot 'runtime.json'
    $primaryRuntime = Join-Path $resources 'runtime\primary-runtime'
    $primaryRuntimeDescriptor = Join-Path $primaryRuntime 'runtime.json'
    $nodePath = Join-Path $primaryRuntime 'dependencies\node\bin\node.exe'
    $pythonPath = Join-Path $primaryRuntime 'dependencies\python\python.exe'
    $pnpmPath = Join-Path $primaryRuntime 'dependencies\pnpm\bin\pnpm.mjs'
    $officeCliPath = Join-Path $dshRoot 'node_modules\@deepseek-ai\libreoffice-kit\lib\cli.js'
    $bundleRoot = Join-Path $dshRoot 'node_modules\@thneoly\dsh-distribution-bundle'
    $bundlePackagePath = Join-Path $bundleRoot 'package.json'
    $bundleEntryPath = Join-Path $bundleRoot 'lib\index.js'
    $bundleWorkflowPath = Join-Path $bundleRoot 'workflows\distribution-smoke.md'
    $appBootEntryPath = Join-Path $dshRoot 'node_modules\@deepseek-ai\dsh-app-boot\lib\index.js'

    $requiredPaths = @(
        $appExecutable, $appArchive, $dshPackagePath, $dshRuntimeDescriptor,
        $primaryRuntimeDescriptor, $nodePath, $pythonPath, $pnpmPath, $officeCliPath,
        $bundlePackagePath, $bundleEntryPath, $bundleWorkflowPath, $appBootEntryPath
    )
    foreach ($requiredPath in $requiredPaths) {
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            throw "Installed application payload is missing: $requiredPath"
        }
    }

    $dshPackage = Get-Content -LiteralPath $dshPackagePath -Raw | ConvertFrom-Json
    if ($dshPackage.version -ne $pin.release.version) {
        throw "Installed DSH runtime version mismatch: expected $($pin.release.version), found $($dshPackage.version)"
    }
    $null = Get-Content -LiteralPath $dshRuntimeDescriptor -Raw | ConvertFrom-Json
    if ($manifest.releaseVersion -ne $pin.release.version -or $manifest.upstreamCommit -ne $pin.commit) {
        throw 'Release provenance does not match the pinned DSH source.'
    }

    $bundlePackage = Get-Content -LiteralPath $bundlePackagePath -Raw | ConvertFrom-Json
    if ($bundlePackage.name -ne $manifest.distributionBundle.name
        -or $bundlePackage.version -ne $manifest.distributionBundle.version
        -or $bundlePackage.dsh.bundle.patch -ne './cordis.patch.yml') {
        throw 'Installed distribution bundle identity/version does not match release provenance.'
    }
    $compiledProfile = Get-Content -LiteralPath $appBootEntryPath -Raw
    if (-not $compiledProfile.Contains($manifest.distributionBundle.name)) {
        throw 'Installed DSH app-boot catalog does not contain the bundled distribution extension.'
    }

    $verifiedComponentFiles = @{}
    foreach ($component in $componentLock.components) {
        foreach ($file in $component.files) {
            if ($file.path -notlike 'distribution-bundle/*') { continue }
            $relativePath = $file.path.Substring('distribution-bundle/'.Length).Replace('/', '\')
            if ($relativePath -eq 'package.json' -or $verifiedComponentFiles.ContainsKey($relativePath)) { continue }
            $installedFile = Join-Path $bundleRoot $relativePath
            if (-not (Test-Path -LiteralPath $installedFile -PathType Leaf)) {
                throw "Installed distribution component file is missing: $relativePath"
            }
            $installedHash = (Get-FileHash -LiteralPath $installedFile -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($installedHash -ne $file.sha256.ToLowerInvariant()) {
                throw "Installed distribution component digest mismatch: $relativePath"
            }
            $verifiedComponentFiles[$relativePath] = $true
        }
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
    $bundleSmokeScript = Join-Path $PSScriptRoot 'smoke-distribution-bundle.mjs'
    & $nodePath $bundleSmokeScript $bundleEntryPath
    if ($LASTEXITCODE -ne 0) { throw 'Bundled distribution tools/workflow smoke test failed.' }

    Write-Host 'PASS: unsigned installer installed successfully.'
    Write-Host "PASS: installed DSH runtime and release provenance match pinned DSH $($pin.release.version)."
    Write-Host "PASS: bundled Node.js $nodeVersion; Python $pythonVersion; pnpm $pnpmVersion."
    Write-Host "PASS: bundled Python can import lxml.etree, python-docx, openpyxl, and python-pptx."
    Write-Host "PASS: installed app, DSH runtime, Office conversion CLI, and version-locked distribution bundle are present."
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
