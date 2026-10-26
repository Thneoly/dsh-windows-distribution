import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createBuildManifest,
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
  assert.equal(manifest.artifacts[0].sha256, 'a'.repeat(64));
});
