import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { applyDistributionComponents, verifyBundledDistributionComponents } from '../scripts/apply-distribution-components.mjs';
import { verifyDistributionLock } from '../scripts/lock-distribution.mjs';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const payloadRoot = path.join(projectRoot, 'components', 'payload');

test('checked-in distribution lock matches declaration, runtime pin, and every payload digest', async () => {
  const result = await verifyDistributionLock();
  assert.equal(result.bundleName, '@thneoly/dsh-distribution-bundle');
  assert.equal(result.bundleVersion, '1.0.0');
  assert.equal(result.componentIds.length, 4);
  assert.equal(result.lockSha256.length, 64);
});

test('distribution component adapter stages an optional bundle and verifies the prepared runtime', async () => {
  const upstreamRoot = await mkdtemp(path.join(tmpdir(), 'dsh-distribution-upstream-'));
  try {
    await mkdir(path.join(upstreamRoot, 'apps', 'cli'), { recursive: true });
    await mkdir(path.join(upstreamRoot, 'packages', 'boot', 'app-boot', 'src'), { recursive: true });
    await writeFile(path.join(upstreamRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*/*\n', 'utf8');
    await writeFile(path.join(upstreamRoot, 'apps', 'cli', 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      version: '0.2.1-rc.3',
      dependencies: {}
    }, null, 2) + '\n', 'utf8');
    await writeFile(path.join(upstreamRoot, 'packages', 'boot', 'app-boot', 'src', 'profile.ts'), [
      'export const OPTIONAL_BUNDLES: readonly string[] = [',
      "  '@deepseek-ai/dsh-experimental-tool-worktree',",
      ']',
      ''
    ].join('\n'), 'utf8');

    const distribution = await applyDistributionComponents(upstreamRoot);
    assert.equal(distribution.included, true);
    assert.equal(distribution.payloadFileCount, 7);

    const cliPackage = JSON.parse(await readFile(path.join(upstreamRoot, 'apps', 'cli', 'package.json'), 'utf8'));
    assert.equal(cliPackage.dependencies['@thneoly/dsh-distribution-bundle'], 'workspace:*');
    const profileSource = await readFile(path.join(upstreamRoot, 'packages', 'boot', 'app-boot', 'src', 'profile.ts'), 'utf8');
    assert.ok(profileSource.includes("'@thneoly/dsh-distribution-bundle'"));
    assert.ok(await readFile(path.join(upstreamRoot, 'packages', 'experimental', 'dsh-distribution-bundle', 'workflows', 'distribution-smoke.md'), 'utf8'));

    const runtimeRoot = path.join(upstreamRoot, 'apps', 'desktop', '.desktop-build', 'targets', 'win-x64', 'dsh');
    const runtimePackageRoot = path.join(runtimeRoot, 'node_modules', '@thneoly', 'dsh-distribution-bundle');
    await mkdir(path.dirname(runtimePackageRoot), { recursive: true });
    await cp(path.join(payloadRoot, 'distribution-bundle'), runtimePackageRoot, { recursive: true });
    await writeFile(path.join(runtimeRoot, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      dependencies: { '@thneoly/dsh-distribution-bundle': '1.0.0' }
    }, null, 2) + '\n', 'utf8');
    const compiledProfile = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib');
    await mkdir(compiledProfile, { recursive: true });
    await writeFile(path.join(compiledProfile, 'index.js'), "export const OPTIONAL_BUNDLES = ['@thneoly/dsh-distribution-bundle'];\n", 'utf8');

    const verified = await verifyBundledDistributionComponents(upstreamRoot, distribution);
    assert.equal(verified.payloadVerified, true);
    assert.equal(verified.bundleName, '@thneoly/dsh-distribution-bundle');
  } finally {
    await rm(upstreamRoot, { recursive: true, force: true });
  }
});
