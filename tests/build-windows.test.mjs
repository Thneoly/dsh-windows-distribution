import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createBuildManifest,
  createBuildOnlyConfig,
  createUnsignedBuildArgs,
  createUnsignedPreflightArgs,
  parseInstallerVersion,
  selectInstallerArtifact,
  validateBuildVersion
} from '../scripts/build-windows.mjs';

const pin = JSON.parse(await readFile(new URL('../upstream.lock.json', import.meta.url), 'utf8'));

test('installer filename yields the exact build version', () => {
  assert.equal(parseInstallerVersion('deepseek-harness-0.2.1-rc.3.20261026.1-win-x64-unsigned.exe'), '0.2.1-rc.3.20261026.1');
});

test('installer filename rejects unexpected artifact naming', () => {
  assert.throws(() => parseInstallerVersion('setup.exe'), /unexpected unsigned Windows installer filename/);
});

test('installer artifact selection ignores bundled helper executables', () => {
  const artifacts = [
    { file: '.nsis-directory-installer/7za.exe', sha256: 'a'.repeat(64) },
    { file: 'deepseek-harness-0.2.1-rc.3.20261026.4.1-win-x64-unsigned.exe.blockmap', sha256: 'b'.repeat(64) },
    { file: 'deepseek-harness-0.2.1-rc.3.20261026.4.1-win-x64-unsigned.exe', sha256: 'c'.repeat(64) }
  ];
  assert.equal(selectInstallerArtifact(artifacts).sha256, 'c'.repeat(64));
  assert.throws(() => selectInstallerArtifact([{ file: '7za.exe', sha256: 'a'.repeat(64) }]), /installer artifact is missing/);
});

test('build versions must be semantic versions, not paths or floating labels', () => {
  assert.equal(validateBuildVersion('0.2.1-rc.3.20261026.1'), '0.2.1-rc.3.20261026.1');
  assert.throws(() => validateBuildVersion('../outside'), /semantic version/);
  assert.throws(() => validateBuildVersion('latest'), /semantic version/);
});

test('build manifest records the pinned source and unsigned mode', () => {
  const manifest = createBuildManifest({
    pin,
    buildVersion: '0.2.1-rc.3.20261026.1',
    artifacts: [{ file: 'installer.exe', sizeBytes: 10, sha256: 'a'.repeat(64) }],
    builtAt: '2026-10-26T00:00:00.000Z'
  });
  assert.equal(manifest.releaseVersion, '0.2.1-rc.3');
  assert.equal(manifest.upstreamCommit, pin.commit);
  assert.equal(manifest.buildMode, 'unsigned-test');
  assert.equal(manifest.customDistributionComponentsIncluded, false);
  assert.equal(manifest.toolchain.pythonVersion, '3.12.14');
  assert.deepEqual(manifest.buildHostToolchain, pin.buildHostToolchain);
  assert.equal(manifest.artifacts[0].sha256, 'a'.repeat(64));
});

test('build manifest records component lock provenance only after runtime verification', () => {
  const distributionComponents = {
    included: true,
    payloadVerified: true,
    lockSha256: 'c'.repeat(64),
    patchedPnpmLockSha256: 'd'.repeat(64),
    componentIds: ['org.thneoly.distribution-bundle', 'workflow.distribution-smoke', 'tool.distribution-bundle-info'],
    bundleName: '@thneoly/dsh-distribution-bundle',
    bundleVersion: '1.0.0',
    payloadFileCount: 7
  };
  const manifest = createBuildManifest({
    pin,
    buildVersion: '0.2.1-rc.3.20261026.2.1',
    artifacts: [],
    builtAt: '2026-10-26T00:00:00.000Z',
    distributionComponents
  });
  assert.equal(manifest.customDistributionComponentsIncluded, true);
  assert.equal(manifest.distributionComponentsLockSha256, 'c'.repeat(64));
  assert.equal(manifest.distributionPatchedPnpmLockSha256, 'd'.repeat(64));
  assert.equal(manifest.distributionBundle.name, '@thneoly/dsh-distribution-bundle');
  assert.equal(manifest.distributionBundle.version, '1.0.0');
  assert.equal(manifest.distributionBundle.payloadFileCount, 7);
});

test('preflight runs the exact upstream unsigned package target', () => {
  assert.deepEqual(createUnsignedPreflightArgs(), [
    '--dir', 'apps/desktop', 'run', 'package:win:x64:unsigned', '--', '--check'
  ]);
});

test('build forwards the exact version through pnpm script argument separator', () => {
  assert.deepEqual(createUnsignedBuildArgs('0.2.1-rc.3.20261026.40.1'), [
    '--dir', 'apps/desktop', 'run', 'package:win:x64:unsigned', '--',
    '--build-version', '0.2.1-rc.3.20261026.40.1'
  ]);
});

test('build-only config uses only reserved invalid origins and valid line delimiters', () => {
  const config = createBuildOnlyConfig('b'.repeat(32));
  assert.match(config, /DOWNLOAD_TEST_ORIGIN=https:\/\/dsh-build-only\.invalid/);
  assert.match(config, /DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN=https:\/\/dsh-mandatory-update-build-only\.invalid/);
  assert.match(config, /https:\/\/dsh-login-build-only\.invalid/);
  assert.equal(config.includes('\\n'), false);
  assert.equal(config.split('\n').length, 7);
  assert.throws(() => createBuildOnlyConfig('not-a-release-id'), /32 lowercase hexadecimal/);
});

test('build-only manifest clearly marks the artifact as non-distributable and unconfigured', () => {
  const manifest = createBuildManifest({
    pin,
    buildVersion: '0.2.1-rc.3.20261026.40.1',
    artifacts: [{ file: 'installer.exe', sizeBytes: 10, sha256: 'b'.repeat(64) }],
    builtAt: '2026-10-26T00:00:00.000Z',
    profile: 'build-only'
  });
  assert.equal(manifest.buildMode, 'unsigned-build-only');
  assert.equal(manifest.distributionProfile, 'build-only');
  assert.equal(manifest.networkServicesConfigured, false);
  assert.equal(manifest.distributionEligible, false);
});

const windowsWorkflow = await readFile(new URL('../.github/workflows/windows-unsigned.yml', import.meta.url), 'utf8');

test('GitHub Windows packaging uses a physical short workspace and copies artifacts back', () => {
  assert.ok(windowsWorkflow.includes("$shortRoot = 'C:\\w'"));
  assert.ok(windowsWorkflow.includes('robocopy "$env:GITHUB_WORKSPACE" $shortRoot'));
  assert.ok(windowsWorkflow.includes('if ($resolvedRoot -ne $shortRoot)'));
  assert.ok(windowsWorkflow.includes('robocopy $sourceArtifacts $destinationArtifacts'));
  assert.match(windowsWorkflow, /Expected lxml extension path length/);
  assert.doesNotMatch(windowsWorkflow, /\bsubst\s+\$drive/i);
});

const installedSmokeScript = await readFile(new URL('../scripts/smoke-installed-windows.ps1', import.meta.url), 'utf8');
const bundleSmokeScript = await readFile(new URL('../scripts/smoke-distribution-bundle.mjs', import.meta.url), 'utf8');

test('Windows workflow installs the built EXE and validates bundled runtimes before artifact upload', () => {
  const smokeStep = windowsWorkflow.indexOf('- name: Install unsigned installer and verify bundled runtime');
  const uploadStep = windowsWorkflow.indexOf('- name: Upload unsigned installer and provenance');
  assert.ok(smokeStep >= 0 && uploadStep > smokeStep);
  assert.ok(windowsWorkflow.slice(smokeStep, uploadStep).includes('smoke-installed-windows.ps1'));
  assert.match(installedSmokeScript, /runtime\\primary-runtime/);
  // 纯 JS 运行时在 app.asar 内，原生依赖在 app.asar.unpacked；冒烟需抽档校验。
  assert.match(installedSmokeScript, /appUnpacked = Join-Path \$resources 'app\.asar\.unpacked'/);
  assert.match(installedSmokeScript, /extract-file/);
  assert.match(installedSmokeScript, /desktop-runtime\.json/);
  assert.match(installedSmokeScript, /relativePath -eq 'package\.json'/);
  assert.match(installedSmokeScript, /distributionComponentsLockSha256/);
  assert.match(installedSmokeScript, /smoke-distribution-bundle\.mjs/);
  assert.match(bundleSmokeScript, /distribution_bundle_info/);
  assert.match(bundleSmokeScript, /distribution_workflow_read/);
  assert.match(installedSmokeScript, /dependencies\\node\\bin\\node\.exe/);
  assert.match(installedSmokeScript, /dependencies\\python\\python\.exe/);
  assert.match(installedSmokeScript, /dependencies\\pnpm\\bin\\pnpm\.mjs/);
  assert.match(installedSmokeScript, /import lxml\.etree, docx, openpyxl, pptx/);
  assert.match(installedSmokeScript, /Get-FileHash/);
  assert.match(installedSmokeScript, /distributionEligible -ne \$false/);
});
