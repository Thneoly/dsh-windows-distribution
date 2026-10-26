import { cp, lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyDistributionLock } from './lock-distribution.mjs';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BUNDLE_NAME = '@thneoly/dsh-distribution-bundle';
const WORKSPACE_GLOB = '  - packages/*/*';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function patchCliDependency(upstreamRoot) {
  const manifestPath = path.join(upstreamRoot, 'apps', 'cli', 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.name !== '@deepseek-ai/dsh') throw new Error('expected pinned DSH CLI package at apps/cli/package.json');
  if (manifest.dependencies === null || typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies)) {
    throw new Error('pinned DSH CLI package has no dependency object');
  }
  const current = manifest.dependencies[BUNDLE_NAME];
  if (current !== undefined && current !== 'workspace:*') {
    throw new Error('conflicting dependency already exists for ' + BUNDLE_NAME + ': ' + String(current));
  }
  if (current === undefined) {
    manifest.dependencies[BUNDLE_NAME] = 'workspace:*';
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }
}

async function patchOptionalBundleCatalog(upstreamRoot) {
  const sourcePath = path.join(upstreamRoot, 'packages', 'boot', 'app-boot', 'src', 'profile.ts');
  let source = await readFile(sourcePath, 'utf8');
  const marker = 'export const OPTIONAL_BUNDLES: readonly string[] = [';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error('pinned DSH OPTIONAL_BUNDLES declaration was not found');
  const end = source.indexOf('\n]', start);
  if (end < 0) throw new Error('pinned DSH OPTIONAL_BUNDLES declaration is unterminated');
  const list = source.slice(start, end);
  if (list.includes("'" + BUNDLE_NAME + "'")) return;
  if (!list.includes("'@deepseek-ai/dsh-experimental-tool-worktree',")) {
    throw new Error('pinned DSH OPTIONAL_BUNDLES list no longer matches the expected release baseline');
  }
  source = source.slice(0, end) + "\n  '" + BUNDLE_NAME + "'," + source.slice(end);
  await writeFile(sourcePath, source, 'utf8');
}

export async function applyDistributionComponents(upstreamDirectory) {
  const distribution = await verifyDistributionLock();
  const upstreamRoot = path.resolve(upstreamDirectory);
  const rootInfo = await lstat(upstreamRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error('upstream source root must be a real directory');
  }

  const pin = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'upstream.lock.json'), 'utf8'));
  if (distribution.manifest.runtime.upstreamCommit !== pin.commit) {
    throw new Error('distribution lock targets a different upstream commit');
  }

  const workspacePath = path.join(upstreamRoot, 'pnpm-workspace.yaml');
  const workspace = await readFile(workspacePath, 'utf8');
  if (!workspace.split(/\r?\n/).includes(WORKSPACE_GLOB.trim())) {
    throw new Error('pinned upstream workspace no longer includes packages/*/*');
  }

  const sourcePackage = path.join(distribution.payloadRoot, 'distribution-bundle');
  const destinationPackage = path.join(upstreamRoot, 'packages', 'experimental', 'dsh-distribution-bundle');
  try {
    await lstat(destinationPackage);
    throw new Error('distribution bundle destination already exists; refusing to overwrite upstream files');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await cp(sourcePackage, destinationPackage, { recursive: true, errorOnExist: true, force: false });
  await patchCliDependency(upstreamRoot);
  await patchOptionalBundleCatalog(upstreamRoot);

  return {
    included: true,
    lockSha256: distribution.lockSha256,
    bundleName: distribution.bundleName,
    bundleVersion: distribution.bundleVersion,
    componentIds: distribution.componentIds,
    payloadFileCount: new Set(distribution.manifest.components.flatMap((component) => component.files.map((file) => file.path))).size,
  };
}

export async function verifyBundledDistributionComponents(upstreamDirectory, distribution) {
  if (distribution?.included !== true) throw new Error('distribution components were not applied before the upstream build');
  const upstreamRoot = path.resolve(upstreamDirectory);
  const runtimeRoot = path.join(upstreamRoot, 'apps', 'desktop', '.desktop-build', 'targets', 'win-x64', 'dsh');
  const packageRoot = path.join(runtimeRoot, 'node_modules', '@thneoly', 'dsh-distribution-bundle');
  const packageManifestPath = path.join(packageRoot, 'package.json');
  const runtimePackagePath = path.join(runtimeRoot, 'package.json');
  const compiledProfilePath = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'profile.js');

  const packageManifest = JSON.parse(await readFile(packageManifestPath, 'utf8'));
  if (packageManifest.name !== distribution.bundleName || packageManifest.version !== distribution.bundleVersion) {
    throw new Error('built DSH runtime contains the wrong distribution bundle identity/version');
  }
  if (packageManifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
    throw new Error('built distribution bundle is missing its DSH bundle patch declaration');
  }

  const runtimePackage = JSON.parse(await readFile(runtimePackagePath, 'utf8'));
  if (runtimePackage.dependencies?.[distribution.bundleName] !== distribution.bundleVersion) {
    throw new Error('built DSH package manifest does not lock the distribution bundle dependency');
  }

  const compiledProfile = await readFile(compiledProfilePath, 'utf8');
  if (!compiledProfile.includes(distribution.bundleName)) {
    throw new Error('built DSH profile catalog does not contain the distribution optional bundle');
  }

  const locked = await verifyDistributionLock();
  const packageFiles = new Map([
    ['distribution-bundle/lib/index.js', 'lib/index.js'],
    ['distribution-bundle/cordis.patch.yml', 'cordis.patch.yml'],
    ['distribution-bundle/icon.svg', 'icon.svg'],
    ['distribution-bundle/locale/en.json', 'locale/en.json'],
    ['distribution-bundle/locale/zh.json', 'locale/zh.json'],
    ['distribution-bundle/workflows/distribution-smoke.md', 'workflows/distribution-smoke.md'],
  ]);
  for (const component of locked.manifest.components) {
    for (const file of component.files) {
      const packageRelativePath = packageFiles.get(file.path);
      if (packageRelativePath === undefined) continue;
      const actual = sha256(await readFile(path.join(packageRoot, packageRelativePath)));
      if (actual !== file.sha256) throw new Error('built distribution payload digest mismatch: ' + file.path);
    }
  }

  return {
    ...distribution,
    included: true,
    payloadVerified: true,
    runtimeRoot,
  };
}
