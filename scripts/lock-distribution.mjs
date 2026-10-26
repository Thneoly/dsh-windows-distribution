import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDistribution, verifyPayloadFiles } from './validate-distribution.mjs';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DISTRIBUTION_DECLARATION_PATH = path.join(PROJECT_ROOT, 'components', 'desktop-distribution.json');
export const DISTRIBUTION_LOCK_PATH = path.join(PROJECT_ROOT, 'components', 'desktop-distribution.lock.json');
export const DISTRIBUTION_PAYLOAD_ROOT = path.join(PROJECT_ROOT, 'components', 'payload');
const UPSTREAM_PIN_PATH = path.join(PROJECT_ROOT, 'upstream.lock.json');
const EXPECTED_BUNDLE_NAME = '@thneoly/dsh-distribution-bundle';

function safeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(label + ' is missing or invalid JSON: ' + error.message);
  }
}

async function listPayloadFiles(rootDirectory) {
  const root = path.resolve(rootDirectory);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('payload root must be a real directory');
  const files = [];

  async function visit(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : prefix + '/' + entry.name;
      const fullPath = path.join(directory, entry.name);
      const info = await lstat(fullPath);
      if (info.isSymbolicLink()) throw new Error('payload must not contain symlinks: ' + relative);
      if (info.isDirectory()) await visit(fullPath, relative);
      else if (info.isFile()) files.push(relative);
      else throw new Error('payload contains a non-regular filesystem entry: ' + relative);
    }
  }

  await visit(root, '');
  return files.sort();
}

function assertDependencyGraph(manifest) {
  const byId = new Map(manifest.components.map((component) => [component.id, component]));
  const visiting = new Set();
  const visited = new Set();

  function visit(id, chain) {
    if (visiting.has(id)) throw new Error('component dependency cycle: ' + [...chain, id].join(' -> '));
    if (visited.has(id)) return;
    const component = byId.get(id);
    if (!component) throw new Error('component dependency is missing: ' + id);
    visiting.add(id);
    for (const dependency of component.requires) visit(dependency, [...chain, id]);
    visiting.delete(id);
    visited.add(id);
  }

  for (const component of manifest.components) visit(component.id, []);
}

function assertRuntimeMatchesPin(manifest, pin) {
  const runtime = manifest.runtime;
  const expected = {
    dshVersion: pin.release.version,
    upstreamCommit: pin.commit,
    electronVersion: pin.toolchain.electronVersion,
    primaryNodeVersion: pin.toolchain.nodeVersion,
    pythonVersion: pin.toolchain.pythonVersion,
    pnpmVersion: pin.toolchain.pnpmVersion,
    primaryRuntimeLockGitBlobSha: pin.files['scripts/primary-runtime/lock.json']?.gitBlobSha,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (runtime[field] !== value) {
      throw new Error('distribution runtime pin mismatch for ' + field + ': expected ' + String(value) + ', found ' + String(runtime[field]));
    }
  }
  const expectedSource = 'https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/'
    + pin.commit + '/scripts/primary-runtime/lock.json';
  if (runtime.primaryRuntimeLockSource !== expectedSource) {
    throw new Error('distribution primary runtime lock source does not match the pinned upstream commit');
  }
}

async function assertPayloadInventory(manifest, payloadRoot) {
  const expected = new Set();
  for (const component of manifest.components) {
    for (const file of component.files) {
      if (!safeRelativePath(file.path)) throw new Error('unsafe component payload path: ' + String(file.path));
      expected.add(file.path);
    }
  }
  const actual = new Set(await listPayloadFiles(payloadRoot));
  const missing = [...expected].filter((file) => !actual.has(file));
  const unlisted = [...actual].filter((file) => !expected.has(file));
  if (missing.length || unlisted.length) {
    throw new Error([
      'component payload inventory mismatch',
      ...missing.map((file) => 'missing: ' + file),
      ...unlisted.map((file) => 'unlisted: ' + file),
    ].join('\n'));
  }
}

async function assertBundlePackageIdentity(manifest, payloadRoot) {
  const plugin = manifest.components.find((component) => component.kind === 'plugin' && component.id === 'org.thneoly.distribution-bundle');
  if (!plugin) throw new Error('distribution manifest must declare org.thneoly.distribution-bundle as a plugin component');
  const packagePath = path.join(payloadRoot, 'distribution-bundle', 'package.json');
  const packageManifest = await readJson(packagePath, 'distribution bundle package.json');
  if (packageManifest.name !== EXPECTED_BUNDLE_NAME) {
    throw new Error('distribution bundle package name must equal ' + EXPECTED_BUNDLE_NAME);
  }
  if (packageManifest.version !== plugin.version) {
    throw new Error('distribution bundle package version must match its plugin component version');
  }
  if (packageManifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
    throw new Error('distribution bundle package must declare its Cordis profile patch');
  }
}

export async function createLockedManifest({
  declarationPath = DISTRIBUTION_DECLARATION_PATH,
  payloadRoot = DISTRIBUTION_PAYLOAD_ROOT,
} = {}) {
  const declaration = await readJson(declarationPath, 'distribution declaration');
  const locked = {
    ...declaration,
    components: declaration.components.map((component) => ({
      ...component,
      files: component.files.map((file) => {
        if (!safeRelativePath(file.path)) throw new Error('unsafe component payload path: ' + String(file.path));
        return { path: file.path, sha256: '' };
      }),
    })),
  };

  for (const component of locked.components) {
    for (const file of component.files) {
      const fullPath = path.resolve(payloadRoot, ...file.path.split('/'));
      const relative = path.relative(path.resolve(payloadRoot), fullPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('payload path escapes root: ' + file.path);
      const info = await lstat(fullPath);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('payload must be a regular non-symlink file: ' + file.path);
      file.sha256 = sha256(await readFile(fullPath));
    }
  }

  return locked;
}

export async function verifyDistributionLock({
  declarationPath = DISTRIBUTION_DECLARATION_PATH,
  lockPath = DISTRIBUTION_LOCK_PATH,
  payloadRoot = DISTRIBUTION_PAYLOAD_ROOT,
  upstreamPinPath = UPSTREAM_PIN_PATH,
} = {}) {
  const lockText = await readFile(lockPath, 'utf8');
  const manifest = JSON.parse(lockText);
  const expected = await createLockedManifest({ declarationPath, payloadRoot });
  const errors = validateDistribution(manifest);
  errors.push(...await verifyPayloadFiles(manifest, payloadRoot));
  if (JSON.stringify(manifest, null, 2) + '\n' !== lockText) errors.push('distribution lock is stale; run npm run lock:distribution');
  await assertPayloadInventory(manifest, payloadRoot);
  assertDependencyGraph(manifest);
  await assertBundlePackageIdentity(manifest, payloadRoot);
  const pin = await readJson(upstreamPinPath, 'upstream.lock.json');
  assertRuntimeMatchesPin(manifest, pin);
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) errors.push('distribution lock does not match the declaration and current payload files');
  if (errors.length > 0) throw new Error('distribution lock verification failed:\n - ' + errors.join('\n - '));
  return {
    manifest,
    lockSha256: sha256(Buffer.from(lockText, 'utf8')),
    payloadRoot: path.resolve(payloadRoot),
    bundleName: EXPECTED_BUNDLE_NAME,
    bundleVersion: manifest.components.find((component) => component.id === 'org.thneoly.distribution-bundle').version,
    componentIds: manifest.components.map((component) => component.id),
  };
}

export async function writeDistributionLock({
  declarationPath = DISTRIBUTION_DECLARATION_PATH,
  lockPath = DISTRIBUTION_LOCK_PATH,
  payloadRoot = DISTRIBUTION_PAYLOAD_ROOT,
  upstreamPinPath = UPSTREAM_PIN_PATH,
} = {}) {
  const manifest = await createLockedManifest({ declarationPath, payloadRoot });
  const errors = validateDistribution(manifest);
  errors.push(...await verifyPayloadFiles(manifest, payloadRoot));
  await assertPayloadInventory(manifest, payloadRoot);
  assertDependencyGraph(manifest);
  await assertBundlePackageIdentity(manifest, payloadRoot);
  const pin = await readJson(upstreamPinPath, 'upstream.lock.json');
  assertRuntimeMatchesPin(manifest, pin);
  if (errors.length > 0) throw new Error('cannot write invalid distribution lock:\n - ' + errors.join('\n - '));
  const text = JSON.stringify(manifest, null, 2) + '\n';
  await writeFile(lockPath, text, 'utf8');
  return { manifest, lockSha256: sha256(Buffer.from(text, 'utf8')) };
}

async function main() {
  const mode = process.argv[2] ?? '--check';
  if (mode === '--write') {
    const result = await writeDistributionLock();
    console.log('Wrote components/desktop-distribution.lock.json (' + result.lockSha256 + ').');
    return;
  }
  if (mode === '--check') {
    const result = await verifyDistributionLock();
    console.log('Distribution lock valid; ' + result.componentIds.length + ' components, payload digests verified.');
    return;
  }
  if (mode === '--help') {
    console.log('Usage: node scripts/lock-distribution.mjs [--check|--write]');
    return;
  }
  throw new Error('expected --check, --write, or --help');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('Distribution lock failed: ' + error.message);
    process.exitCode = 1;
  });
}
