import { cp, lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyDistributionLock } from './lock-distribution.mjs';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BUNDLE_NAME = '@thneoly/dsh-distribution-bundle';

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

async function patchWorkspaceMembership(upstreamRoot) {
  const workspacePath = path.join(upstreamRoot, 'pnpm-workspace.yaml');
  const lines = (await readFile(workspacePath, 'utf8')).split(/\r?\n/);
  const packageGlobIndex = lines.findIndex((line) => line.trim() === '- packages/*/*');
  if (packageGlobIndex < 0) throw new Error('pinned upstream workspace no longer includes packages/*/*');
  if (lines.some((line) => line.trim() === '- distribution-bundle')) return;
  lines.splice(packageGlobIndex + 1, 0, '  - distribution-bundle');
  await writeFile(workspacePath, lines.join('\n'), 'utf8');
}

async function patchPackageTarget(upstreamRoot) {
  // 复用上游对 private 包（apps/desktop-host）的既定模式：family 打包后，
  // 直接 pnpm --dir <pkg> pack 进 family 目录，让它进入 prepare-package-set 的闭包。
  const targetPath = path.join(upstreamRoot, 'apps', 'desktop', 'scripts', 'package-target.ts');
  let source = await readFile(targetPath, 'utf8');
  if (source.includes("'distribution-bundle',")) return;
  const anchor = [
    "  await execute([",
    "    '--dir',",
    "    'apps/desktop-host',",
    "    'pack',",
    "    '--pack-destination',",
    "    buildPaths.packedDsh,",
    "  ], buildEnv, REPOSITORY_ROOT)",
  ].join('\n');
  const anchorIndex = source.indexOf(anchor);
  if (anchorIndex < 0) throw new Error('pinned DSH package-target.ts desktop-host pack anchor was not found');
  const insertion = anchor + [
    "",
    "  await execute([",
    "    '--dir',",
    "    'distribution-bundle',",
    "    'pack',",
    "    '--pack-destination',",
    "    buildPaths.packedDsh,",
    "  ], buildEnv, REPOSITORY_ROOT)",
  ].join('\n');
  source = source.slice(0, anchorIndex) + insertion + source.slice(anchorIndex + anchor.length);
  await writeFile(targetPath, source, 'utf8');
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
  if (!workspace.split(/\r?\n/).some((line) => line.trim() === '- packages/*/*')) {
    throw new Error('pinned upstream workspace no longer includes packages/*/*');
  }

  // 注入机制（对齐上游对 private 包 apps/desktop-host 的既定模式）：
  // ① 舞台到仓库顶层 distribution-bundle/，payload 里声明 private: true——
  //    DshFamily 打包按 @deepseek-ai/* 命名 + 全家族同版本约束成员，private 包被跳过；
  //    根部 tsdown 只扫 packages/*/* 与 apps/cli（desktop-host），顶层目录不在扫描内，
  //    安装后的 lib/index.js 得以与锁定 payload 保持字节一致。
  // ② pnpm-workspace 加一行成员，让 apps/cli 的 workspace:* 依赖可解析。
  // ③ package-target.ts 在 desktop-host pack 之后同样把本包 pack 进 packed/dsh，
  //    prepare-package-set 闭包由此把它选进 package set，运行时 pnpm 离线安装后
  //    落在 runtimeRoot/node_modules/@thneoly/...，运行时 package.json 同步收录。
  const sourcePackage = path.join(distribution.payloadRoot, 'distribution-bundle');
  const destinationPackage = path.join(upstreamRoot, 'distribution-bundle');
  try {
    await lstat(destinationPackage);
    throw new Error('distribution bundle destination already exists; refusing to overwrite upstream files');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await cp(sourcePackage, destinationPackage, { recursive: true, errorOnExist: true, force: false });
  await patchWorkspaceMembership(upstreamRoot);
  await patchCliDependency(upstreamRoot);
  await patchOptionalBundleCatalog(upstreamRoot);
  await patchPackageTarget(upstreamRoot);

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
  const compiledProfilePath = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');

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

async function main() {
  const upstreamDirectory = process.argv[2];
  if (!upstreamDirectory) {
    throw new Error('Usage: node scripts/apply-distribution-components.mjs <verified-upstream-directory>');
  }
  const result = await applyDistributionComponents(upstreamDirectory);
  console.log('Staged ' + result.bundleName + '@' + result.bundleVersion
    + ' (' + result.payloadFileCount + ' locked payload files).');
  console.log('Distribution lock SHA-256: ' + result.lockSha256);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('Unable to stage distribution components: ' + error.message);
    process.exitCode = 1;
  });
}
