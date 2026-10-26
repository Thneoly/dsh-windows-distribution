import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256Pattern = /^[a-fA-F0-9]{64}$/;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateWheel(wheel, label, errors) {
  if (!isRecord(wheel)) {
    errors.push(label + ' must be an object');
    return;
  }
  if (typeof wheel.url !== 'string' || !wheel.url.startsWith('https://')) errors.push(label + '.url must use HTTPS');
  if (typeof wheel.sha256 !== 'string' || !sha256Pattern.test(wheel.sha256)) errors.push(label + '.sha256 must be a 64-character SHA-256 hex digest');
}

export function validatePrimaryRuntimeLock(lock) {
  const errors = [];
  if (!isRecord(lock)) return ['runtime lock must be a JSON object'];
  for (const field of ['nodeVersion', 'pythonVersion']) {
    if (typeof lock[field] !== 'string' || !/^\d+\.\d+\.\d+$/.test(lock[field])) errors.push(field + ' must be an exact x.y.z version');
  }
  if (typeof lock.pythonRelease !== 'string' || !/^\d{8}$/.test(lock.pythonRelease)) errors.push('pythonRelease must be YYYYMMDD');
  if (!isRecord(lock.targets) || !isRecord(lock.targets['win-x64'])) {
    errors.push('targets.win-x64 is required');
    return errors;
  }

  const target = lock.targets['win-x64'];
  if (target.nodeArchive !== 'win-x64.zip') errors.push('targets.win-x64.nodeArchive must be win-x64.zip');
  if (typeof target.nodeSha256 !== 'string' || !sha256Pattern.test(target.nodeSha256)) errors.push('targets.win-x64.nodeSha256 must be a 64-character SHA-256 hex digest');
  if (target.pythonTarget !== 'x86_64-pc-windows-msvc') errors.push('targets.win-x64.pythonTarget must be x86_64-pc-windows-msvc');
  if (typeof target.pythonSha256 !== 'string' || !sha256Pattern.test(target.pythonSha256)) errors.push('targets.win-x64.pythonSha256 must be a 64-character SHA-256 hex digest');
  if (!Array.isArray(target.wheels)) {
    errors.push('targets.win-x64.wheels must be an array');
  } else {
    target.wheels.forEach((wheel, index) => validateWheel(wheel, 'targets.win-x64.wheels[' + index + ']', errors));
  }
  if (lock.wheels !== undefined) {
    if (!Array.isArray(lock.wheels)) errors.push('wheels must be an array when provided');
    else lock.wheels.forEach((wheel, index) => validateWheel(wheel, 'wheels[' + index + ']', errors));
  }
  return errors;
}

async function main() {
  const lockPath = process.argv[2];
  if (!lockPath || process.argv.includes('--help')) {
    console.log('Usage: node scripts/verify-runtime-lock.mjs <upstream-primary-runtime-lock.json>');
    process.exitCode = lockPath ? 0 : 2;
    return;
  }
  let lock;
  try {
    lock = JSON.parse(await readFile(path.resolve(lockPath), 'utf8'));
  } catch (error) {
    console.error('Unable to read runtime lock: ' + error.message);
    process.exitCode = 2;
    return;
  }
  const errors = validatePrimaryRuntimeLock(lock);
  if (errors.length > 0) {
    console.error('Primary runtime lock validation failed:');
    for (const error of errors) console.error(' - ' + error);
    process.exitCode = 1;
    return;
  }
  console.log('Primary runtime lock is structurally valid for Windows x64.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
