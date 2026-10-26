import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const gitSha = /^[a-fA-F0-9]{40}$/;
const requiredFiles = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'apps/desktop/package.json',
  'scripts/primary-runtime/lock.json'
];

export function validateUpstreamPin(pin) {
  const errors = [];
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) return ['pin must be a JSON object'];
  if (pin.schemaVersion !== 1) errors.push('schemaVersion must equal 1');
  if (pin.repository !== 'deepseek-ai/deepseek-harness') errors.push('repository must be deepseek-ai/deepseek-harness');

  if (!pin.release || typeof pin.release !== 'object') {
    errors.push('release must be an object');
  } else {
    const release = pin.release;
    if (typeof release.version !== 'string' || !exactVersion.test(release.version)) errors.push('release.version must be an exact semantic version');
    if (release.tag !== 'dsh-v' + release.version) errors.push('release.tag must match dsh-v + release.version');
    if (release.url !== 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/' + release.tag) errors.push('release.url must point to the pinned release tag');
    if (typeof release.prerelease !== 'boolean') errors.push('release.prerelease must be boolean');
    if (release.immutable !== true) errors.push('release.immutable must be true');
    if (typeof release.publishedAt !== 'string' || Number.isNaN(Date.parse(release.publishedAt))) errors.push('release.publishedAt must be an ISO date');
  }

  if (typeof pin.commit !== 'string' || !gitSha.test(pin.commit)) errors.push('commit must be a 40-character Git commit SHA');
  if (typeof pin.checkedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(pin.checkedAt)) errors.push('checkedAt must be YYYY-MM-DD');

  if (!pin.files || typeof pin.files !== 'object' || Array.isArray(pin.files)) {
    errors.push('files must be an object');
  } else {
    for (const filePath of requiredFiles) {
      const entry = pin.files[filePath];
      if (!entry || typeof entry !== 'object' || !gitSha.test(entry.gitBlobSha ?? '')) {
        errors.push('files.' + filePath + '.gitBlobSha must be a 40-character Git blob SHA');
      }
    }
  }

  if (!pin.toolchain || typeof pin.toolchain !== 'object') {
    errors.push('toolchain must be an object');
  } else {
    for (const field of ['nodeVersion', 'pythonVersion', 'pnpmVersion', 'electronVersion']) {
      if (typeof pin.toolchain[field] !== 'string' || !exactVersion.test(pin.toolchain[field])) {
        errors.push('toolchain.' + field + ' must be an exact version');
      }
    }
    if (typeof pin.toolchain.pythonRelease !== 'string' || !/^\d{8}$/.test(pin.toolchain.pythonRelease)) {
      errors.push('toolchain.pythonRelease must be YYYYMMDD');
    }
  }
  return errors;
}

async function main() {
  const pinPath = process.argv[2];
  if (!pinPath || process.argv.includes('--help')) {
    console.log('Usage: node scripts/validate-upstream-pin.mjs <upstream.lock.json>');
    process.exitCode = pinPath ? 0 : 2;
    return;
  }

  let pin;
  try {
    pin = JSON.parse(await readFile(path.resolve(pinPath), 'utf8'));
  } catch (error) {
    console.error('Unable to read upstream pin: ' + error.message);
    process.exitCode = 2;
    return;
  }

  const errors = validateUpstreamPin(pin);
  if (errors.length) {
    console.error('Upstream release pin validation failed:');
    for (const error of errors) console.error(' - ' + error);
    process.exitCode = 1;
    return;
  }
  console.log('Upstream DSH release pin is structurally valid.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
