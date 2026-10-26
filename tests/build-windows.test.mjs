import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createBuildManifest,
  createBuildOnlyConfig,
  createUnsignedBuildArgs,
  createUnsignedPreflightArgs,
  parseInstallerVersion,
  validateBuildVersion
} from '../scripts/build-windows.mjs';

const pin = JSON.parse(await readFile(new URL('../upstream.lock.json', import.meta.url), 'utf8'));

test('installer filename yields the exact build version', () => {
  assert.equal(parseInstallerVersion('deepseek-harness-0.2.1-rc.3.20261026.1-win-x64-unsigned.exe'), '0.2.1-rc.3.20261026.1');
});

test('installer filename rejects unexpected artifact naming', () => {
  assert.throws(() => parseInstallerVersion('setup.exe'), /unexpected unsigned Windows installer filename/);
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
  assert.doesNotMatch(windowsWorkflow, /\\bsubst\\s+\\$drive/i);
});
