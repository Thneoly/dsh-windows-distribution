import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const sha256Pattern = /^[a-fA-F0-9]{64}$/;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateDistribution(manifest) {
  const errors = [];
  if (!isRecord(manifest)) return ['manifest must be a JSON object'];
  if (manifest.schemaVersion !== 1) errors.push('schemaVersion must equal 1');
  if (manifest.product !== 'deepseek-harness') errors.push('product must equal deepseek-harness');
  if (typeof manifest.releaseVersion !== 'string' || !semverPattern.test(manifest.releaseVersion)) {
    errors.push('releaseVersion must be a semantic version');
  }

  if (!isRecord(manifest.target)) {
    errors.push('target must be an object');
  } else {
    if (manifest.target.platform !== 'win32') errors.push('target.platform must equal win32');
    if (manifest.target.arch !== 'x64') errors.push('target.arch must equal x64');
  }

  if (!isRecord(manifest.runtime)) {
    errors.push('runtime must be an object');
  } else {
    for (const field of ['dshVersion', 'electronVersion', 'primaryNodeVersion', 'pythonVersion', 'pnpmVersion']) {
      if (typeof manifest.runtime[field] !== 'string' || !semverPattern.test(manifest.runtime[field])) {
        errors.push('runtime.' + field + ' must be a semantic version');
      }
    }
    if (typeof manifest.runtime.primaryRuntimeLockSource !== 'string' || manifest.runtime.primaryRuntimeLockSource.length === 0) {
      errors.push('runtime.primaryRuntimeLockSource must be a non-empty string');
    }
    if (typeof manifest.runtime.upstreamCommit !== 'string' || !/^[a-fA-F0-9]{40}$/.test(manifest.runtime.upstreamCommit)) {
      errors.push('runtime.upstreamCommit must be a 40-character Git commit SHA');
    }
    if (typeof manifest.runtime.primaryRuntimeLockGitBlobSha !== 'string' || !/^[a-fA-F0-9]{40}$/.test(manifest.runtime.primaryRuntimeLockGitBlobSha)) {
      errors.push('runtime.primaryRuntimeLockGitBlobSha must be a 40-character Git blob SHA');
    }
    const expectedLockUrl = 'https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/' + manifest.runtime.upstreamCommit + '/scripts/primary-runtime/lock.json';
    if (manifest.runtime.primaryRuntimeLockSource !== expectedLockUrl) {
      errors.push('runtime.primaryRuntimeLockSource must point to the pinned upstream commit');
    }
  }

  if (!Array.isArray(manifest.components)) {
    errors.push('components must be an array');
    return errors;
  }

  const ids = new Set();
  for (const [index, component] of manifest.components.entries()) {
    const prefix = 'components[' + index + ']';
    if (!isRecord(component)) {
      errors.push(prefix + ' must be an object');
      continue;
    }
    if (typeof component.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(component.id)) {
      errors.push(prefix + '.id is invalid');
    } else if (ids.has(component.id)) {
      errors.push('duplicate component id: ' + component.id);
    } else {
      ids.add(component.id);
    }
    if (!['plugin', 'workflow', 'tool'].includes(component.kind)) errors.push(prefix + '.kind must be plugin, workflow or tool');
    if (typeof component.version !== 'string' || !semverPattern.test(component.version)) errors.push(prefix + '.version must be a semantic version');
    if (typeof component.required !== 'boolean') errors.push(prefix + '.required must be boolean');
    if (!Array.isArray(component.requires)) {
      errors.push(prefix + '.requires must be an array');
    } else {
      if (new Set(component.requires).size !== component.requires.length) errors.push(prefix + '.requires must not contain duplicates');
      for (const dependency of component.requires) {
        if (typeof dependency !== 'string' || dependency.length === 0) errors.push(prefix + '.requires contains an invalid id');
      }
    }
    if (!Array.isArray(component.files) || component.files.length === 0) {
      errors.push(prefix + '.files must be a non-empty array');
      continue;
    }
    for (const [fileIndex, file] of component.files.entries()) {
      const filePrefix = prefix + '.files[' + fileIndex + ']';
      if (!isRecord(file)) {
        errors.push(filePrefix + ' must be an object');
        continue;
      }
      if (typeof file.path !== 'string' || !isSafeRelativePath(file.path)) errors.push(filePrefix + '.path must be a safe relative POSIX path');
      if (typeof file.sha256 !== 'string' || !sha256Pattern.test(file.sha256)) errors.push(filePrefix + '.sha256 must be a 64-character SHA-256 hex digest');
    }
  }

  for (const component of manifest.components) {
    if (!isRecord(component) || !Array.isArray(component.requires)) continue;
    for (const dependency of component.requires) {
      if (typeof dependency === 'string' && !ids.has(dependency)) {
        errors.push('component ' + String(component.id) + ' requires missing component: ' + dependency);
      }
    }
  }

  return errors;
}

function isSafeRelativePath(value) {
  if (value.length === 0 || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export async function verifyPayloadFiles(manifest, rootDirectory) {
  const errors = [];
  const root = path.resolve(rootDirectory);
  if (!Array.isArray(manifest.components)) return ['components must be an array before verifying payload files'];

  for (const component of manifest.components) {
    if (!isRecord(component) || !Array.isArray(component.files)) continue;
    for (const file of component.files) {
      if (!isRecord(file) || typeof file.path !== 'string' || !isSafeRelativePath(file.path)
        || typeof file.sha256 !== 'string' || !sha256Pattern.test(file.sha256)) continue;
      const resolved = path.resolve(root, ...file.path.split('/'));
      const relative = path.relative(root, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        errors.push('payload path escapes root: ' + file.path);
        continue;
      }
      try {
        const info = await stat(resolved);
        if (!info.isFile()) {
          errors.push('payload is not a regular file: ' + file.path);
          continue;
        }
        const bytes = await readFile(resolved);
        const actual = createHash('sha256').update(bytes).digest('hex');
        if (actual.toLowerCase() !== file.sha256.toLowerCase()) {
          errors.push('SHA-256 mismatch for ' + file.path + ': expected ' + file.sha256 + ', got ' + actual);
        }
      } catch {
        errors.push('payload file is missing or unreadable: ' + file.path);
      }
    }
  }
  return errors;
}

async function main() {
  const args = process.argv.slice(2);
  const manifestPath = args.find((arg) => !arg.startsWith('--'));
  if (!manifestPath || args.includes('--help')) {
    console.log('Usage: node scripts/validate-distribution.mjs <manifest.json> [--root <payload-dir>]');
    process.exitCode = manifestPath ? 0 : 2;
    return;
  }
  let rootDirectory;
  const rootIndex = args.indexOf('--root');
  if (rootIndex >= 0) rootDirectory = args[rootIndex + 1];
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.resolve(manifestPath), 'utf8'));
  } catch (error) {
    console.error('Unable to read manifest: ' + error.message);
    process.exitCode = 2;
    return;
  }
  const errors = validateDistribution(manifest);
  if (rootDirectory) errors.push(...await verifyPayloadFiles(manifest, rootDirectory));
  if (errors.length > 0) {
    console.error('Distribution validation failed:');
    for (const error of errors) console.error(' - ' + error);
    process.exitCode = 1;
    return;
  }
  console.log('Distribution manifest valid' + (rootDirectory ? ' and payload digests verified.' : '.'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
