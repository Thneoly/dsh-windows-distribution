import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { validatePrimaryRuntimeLock } from './verify-runtime-lock.mjs';

const execFile = promisify(execFileCallback);
const gitShaPattern = /^[a-fA-F0-9]{40}$/;

export function computeGitBlobSha(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const header = Buffer.from('blob ' + bytes.length + String.fromCharCode(0));
  return createHash('sha1').update(header).update(bytes).digest('hex');
}

export function validateCheckoutMetadata({
  headSha, pin, rootPackage, desktopPackage, workspaceText, runtimeLock, dirtyFiles = []
}) {
  const errors = [];
  if (headSha !== pin.commit) errors.push('checkout HEAD does not match upstream.lock.json commit');
  if (dirtyFiles.length > 0) errors.push('upstream checkout has tracked modifications: ' + dirtyFiles.join(', '));

  if (rootPackage?.version !== pin.release?.version) errors.push('root package version does not match pinned release version');
  if (rootPackage?.packageManager !== 'pnpm@' + pin.toolchain?.pnpmVersion) errors.push('root packageManager does not match pinned pnpm version');
  if (desktopPackage?.version !== pin.release?.version) errors.push('Desktop package version does not match pinned release version');

  const workspaceLines = typeof workspaceText === 'string'
    ? workspaceText.split(/\r?\n/).map((line) => line.trim())
    : [];
  if (!workspaceLines.includes('- electron@' + pin.toolchain?.electronVersion)) {
    errors.push('pnpm-workspace.yaml does not pin the expected Electron version');
  }
  if (!workspaceLines.includes('- pnpm@' + pin.toolchain?.pnpmVersion)) {
    errors.push('pnpm-workspace.yaml does not pin the expected pnpm version');
  }

  errors.push(...validatePrimaryRuntimeLock(runtimeLock).map((error) => 'primary-runtime lock: ' + error));
  if (runtimeLock?.nodeVersion !== pin.toolchain?.nodeVersion) errors.push('primary-runtime Node.js version differs from upstream.lock.json');
  if (runtimeLock?.pythonVersion !== pin.toolchain?.pythonVersion) errors.push('primary-runtime Python version differs from upstream.lock.json');
  if (runtimeLock?.pythonRelease !== pin.toolchain?.pythonRelease) errors.push('primary-runtime Python release differs from upstream.lock.json');
  return errors;
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

async function verifyCheckout(checkoutPath) {
  const root = path.resolve(checkoutPath);
  const pin = JSON.parse(await readFile(new URL('../upstream.lock.json', import.meta.url), 'utf8'));
  const errors = [];
  let headSha = '';
  let dirtyFiles = [];

  try {
    const head = await execFile('git', ['-C', root, 'rev-parse', 'HEAD']);
    headSha = head.stdout.trim();
    const status = await execFile('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no']);
    dirtyFiles = status.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    throw new Error('Unable to inspect Git checkout: ' + error.message);
  }

  for (const [filePath, expected] of Object.entries(pin.files ?? {})) {
    if (!isSafeRelativePath(filePath)) {
      errors.push('unsafe path in upstream.lock.json: ' + filePath);
      continue;
    }
    try {
      const bytes = await readFile(path.resolve(root, ...filePath.split('/')));
      const actual = computeGitBlobSha(bytes);
      if (actual.toLowerCase() !== String(expected.gitBlobSha).toLowerCase()) {
        errors.push(filePath + ' Git blob SHA mismatch: expected ' + expected.gitBlobSha + ', got ' + actual);
      }
    } catch {
      errors.push('required pinned source file is missing or unreadable: ' + filePath);
    }
  }

  const readJson = async (filePath) => JSON.parse(await readFile(path.resolve(root, filePath), 'utf8'));
  let rootPackage, desktopPackage, runtimeLock, workspaceText;
  try {
    [rootPackage, desktopPackage, runtimeLock, workspaceText] = await Promise.all([
      readJson('package.json'),
      readJson('apps/desktop/package.json'),
      readJson('scripts/primary-runtime/lock.json'),
      readFile(path.resolve(root, 'pnpm-workspace.yaml'), 'utf8')
    ]);
  } catch (error) {
    errors.push('unable to read pinned release metadata files: ' + error.message);
    return { errors, headSha };
  }

  errors.push(...validateCheckoutMetadata({
    headSha, pin, rootPackage, desktopPackage, workspaceText, runtimeLock, dirtyFiles
  }));

  return { errors, headSha, releaseVersion: pin.release.version, commit: pin.commit };
}

async function main() {
  const checkoutPath = process.argv[2];
  if (!checkoutPath || process.argv.includes('--help')) {
    console.log('Usage: node scripts/verify-upstream-checkout.mjs <path-to-pinned-dsh-checkout>');
    process.exitCode = checkoutPath ? 0 : 2;
    return;
  }

  try {
    const result = await verifyCheckout(checkoutPath);
    if (result.errors.length > 0) {
      console.error('Pinned DSH checkout verification failed:');
      for (const error of result.errors) console.error(' - ' + error);
      process.exitCode = 1;
      return;
    }
    console.log('Pinned DSH checkout verified.');
    console.log('Release: ' + result.releaseVersion);
    console.log('Commit: ' + result.commit);
    console.log('Verified source file identities: ' + Object.keys(JSON.parse(await readFile(new URL('../upstream.lock.json', import.meta.url), 'utf8')).files).length);
  } catch (error) {
    console.error('Unable to verify pinned DSH checkout: ' + error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
