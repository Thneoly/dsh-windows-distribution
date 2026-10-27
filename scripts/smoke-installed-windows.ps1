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
if ($null -eq $manifest.distributionBundle) {
    throw 'Release manifest does not contain the expected versioned distribution bundle.'
}

$distributionLockPath = Join-Path $ArtifactDirectory 'desktop-distribution.lock.json'
if (-not (Test-Path -LiteralPath $distributionLockPath -PathType Leaf)) { throw "Missing distribution lock: $distributionLockPath" }
$distributionLockHash = (Get-FileHash -LiteralPath $distributionLockPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($distributionLockHash -ne $manifest.distributionComponentsLockSha256.ToLowerInvariant()) {
    throw 'Distribution component lock SHA-256 does not match release provenance.'
}
$componentLock = Get-Content -LiteralPath $distributionLockPath -Raw | ConvertFrom-Json
$bundleComponent = @($componentLock.components | Where-Object { $_.kind -eq 'plugin' })[0]
if ($null -eq $bundleComponent -or $manifest.distributionBundle.version -ne $bundleComponent.version) {
    throw "Distribution bundle version drift between manifest and component lock: manifest=$($manifest.distributionBundle.version)."
}

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
$installDirectory = if ($env:GITHUB_RUN_ID) {
    "C:\dsh-smoke-$env:GITHUB_RUN_ID"
} else {
    Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-smoke-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 12))
}
if (Test-Path -LiteralPath $installDirectory) {
    throw "Refusing to overwrite an existing smoke-test installation: $installDirectory"
}

$setup = $null
$script:extractRoot = $null
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
    $appUnpacked = Join-Path $resources 'app.asar.unpacked'
    $primaryRuntime = Join-Path $resources 'runtime\primary-runtime'
    $primaryRuntimeDescriptor = Join-Path $primaryRuntime 'runtime.json'
    $nodePath = Join-Path $primaryRuntime 'dependencies\node\bin\node.exe'
    $pythonPath = Join-Path $primaryRuntime 'dependencies\python\python.exe'
    $pnpmPath = Join-Path $primaryRuntime 'dependencies\pnpm\bin\pnpm.mjs'
    # electron-builder 只把原生依赖留在 app.asar.unpacked；纯 JS 的 dsh 运行时
    # （含发行 bundle）整体在 app.asar 内，文件级校验需要先抽出。
    $officeCliPath = Join-Path $appUnpacked 'dsh\node_modules\@deepseek-ai\libreoffice-kit\lib\cli.js'

    $requiredPaths = @(
        $appExecutable, $appArchive, $primaryRuntimeDescriptor, $nodePath, $pythonPath, $pnpmPath, $officeCliPath
    )
    foreach ($requiredPath in $requiredPaths) {
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            throw "Installed application payload is missing: $requiredPath"
        }
    }

    $asarTool = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot '..\.build\upstream-dsh\node_modules\.pnpm') -Directory -Filter '@electron+asar@*' |
        Sort-Object Name -Descending | Select-Object -First 1 |
        ForEach-Object { Join-Path $_.FullName 'node_modules\@electron\asar\bin\asar.js' }
    if ($null -eq $asarTool -or -not (Test-Path -LiteralPath $asarTool -PathType Leaf)) {
        throw 'asar extraction tool not found in the upstream workspace.'
    }
    $script:extractRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-smoke-asar-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 12))
    # 本档案由 electron-builder 在 Windows 生成，内部路径是反斜杠风格；
    # @electron/asar extract-file 需要与档案头一致的分隔符。
    function Extract-AsarFile([string]$archiveFile) {
        $destination = Join-Path $script:extractRoot (($archiveFile -replace '[/\\]', '_'))
        $null = New-Item -ItemType Directory -Path $destination -Force
        Push-Location $destination
        try {
            & $nodePath $asarTool extract-file $appArchive $archiveFile
            if ($LASTEXITCODE -ne 0) { throw "app.asar is missing the expected file: $archiveFile" }
        }
        finally { Pop-Location }
        Join-Path $destination (Split-Path $archiveFile -Leaf)
    }

    $dshPackagePath = Extract-AsarFile 'dsh\package.json'
    $dshRuntimeDescriptor = Extract-AsarFile 'dsh\desktop-runtime.json'
    $appBootEntryPath = Extract-AsarFile 'dsh\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js'

    $dshPackage = Get-Content -LiteralPath $dshPackagePath -Raw | ConvertFrom-Json
    if ($dshPackage.version -ne $pin.release.version) {
        throw "Installed DSH runtime version mismatch: expected $($pin.release.version), found $($dshPackage.version)"
    }
    $null = Get-Content -LiteralPath $dshRuntimeDescriptor -Raw | ConvertFrom-Json
    if ($manifest.releaseVersion -ne $pin.release.version -or $manifest.upstreamCommit -ne $pin.commit) {
        throw 'Release provenance does not match the pinned DSH source.'
    }

    $bundleArchiveRoot = 'dsh\node_modules\@thneoly\dsh-distribution-bundle'
    $extractedBundleFiles = @{}
    foreach ($component in $componentLock.components) {
        foreach ($file in $component.files) {
            if ($file.path -notlike 'distribution-bundle/*') { continue }
            $relativePath = $file.path.Substring('distribution-bundle/'.Length).Replace('/', '\')
            if (-not $extractedBundleFiles.ContainsKey($relativePath)) {
                $extractedBundleFiles[$relativePath] = Extract-AsarFile ($bundleArchiveRoot + '\' + $relativePath)
            }
            if ($relativePath -eq 'package.json') { continue }
            # pnpm pack 会把 workspace: 协议解析成实版本并重写 package.json（与构建期
            # 验证器一致地跳过其摘要，身份/版本用随后的字段校验兜底）。
            $installedFile = $extractedBundleFiles[$relativePath]
            $installedHash = (Get-FileHash -LiteralPath $installedFile -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($installedHash -ne $file.sha256.ToLowerInvariant()) {
                throw "Installed distribution component digest mismatch: $relativePath"
            }
        }
    }
    $bundlePackagePath = $extractedBundleFiles['package.json']
    $bundlePackage = Get-Content -LiteralPath $bundlePackagePath -Raw | ConvertFrom-Json
    if ($bundlePackage.name -ne $manifest.distributionBundle.name -or
        $bundlePackage.version -ne $manifest.distributionBundle.version -or
        $bundlePackage.dsh.bundle.patch -ne './cordis.patch.yml') {
        throw 'Installed distribution bundle identity/version does not match release provenance.'
    }
    $compiledProfile = Get-Content -LiteralPath $appBootEntryPath -Raw
    if (-not $compiledProfile.Contains($manifest.distributionBundle.name)) {
        throw 'Installed DSH app-boot catalog does not contain the bundled distribution extension.'
    }

    $runtimeDescriptor = Get-Content -LiteralPath $primaryRuntimeDescriptor -Raw | ConvertFrom-Json
    if ($runtimeDescriptor.node -ne $pin.toolchain.nodeVersion -or
        $runtimeDescriptor.python -ne $pin.toolchain.pythonVersion -or
        $runtimeDescriptor.pnpm -ne $pin.toolchain.pnpmVersion) {
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

    # 工具执行冒烟跑在舞台副本上（依赖在 workspace 内可解析）：
    # extracted 摘要 == 组件锁 == 构建期已验证的舞台副本，字节等价传递执行正确性。
    $stagedBundleEntry = Join-Path $PSScriptRoot '..\.build\upstream-dsh\distribution-bundle\lib\index.js'
    if (-not (Test-Path -LiteralPath $stagedBundleEntry -PathType Leaf)) {
        throw "Staged distribution bundle entry not found: $stagedBundleEntry"
    }
    $bundleSmokeScript = Join-Path $PSScriptRoot 'smoke-distribution-bundle.mjs'
    & $nodePath $bundleSmokeScript $stagedBundleEntry $bundleComponent.version
    if ($LASTEXITCODE -ne 0) { throw 'Bundled distribution tools/workflow smoke test failed.' }

    Write-Host 'PASS: unsigned installer installed successfully.'
    Write-Host "PASS: installed DSH runtime and release provenance match pinned DSH $($pin.release.version)."
    Write-Host "PASS: bundled Node.js $nodeVersion; Python $pythonVersion; pnpm $pnpmVersion."
    Write-Host 'PASS: bundled Python can import lxml.etree, python-docx, openpyxl, and python-pptx.'
    Write-Host 'PASS: installed app, DSH runtime, Office conversion CLI, and version-locked distribution bundle are present.'
    Write-Host "Installer SHA-256: $actualInstallerHash"
}
finally {
    if ($null -ne $setup) {
        if (-not $setup.HasExited) { $setup.Kill(); $setup.WaitForExit() }
        $setup.Dispose()
    }
    if (Test-Path -LiteralPath $installDirectory) {
        $uninstaller = Join-Path $installDirectory 'Uninstall DeepSeek Harness.exe'
        if (Test-Path -LiteralPath $uninstaller) {
            $null = Start-Process -FilePath $uninstaller -ArgumentList @('/S', '/currentuser') -Wait -WindowStyle Hidden
        }
        if (Test-Path -LiteralPath $installDirectory) {
            Remove-Item -LiteralPath $installDirectory -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    if ($null -ne $script:extractRoot -and (Test-Path -LiteralPath $script:extractRoot)) {
        Remove-Item -LiteralPath $script:extractRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
