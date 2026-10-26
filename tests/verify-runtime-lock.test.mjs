import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validatePrimaryRuntimeLock } from '../scripts/verify-runtime-lock.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/primary-runtime-lock.minimal.json', import.meta.url), 'utf8'));

test('minimal upstream runtime lock fixture is structurally valid', () => {
  assert.deepEqual(validatePrimaryRuntimeLock(fixture), []);
});

test('missing Windows x64 target is rejected', () => {
  const copy = structuredClone(fixture);
  delete copy.targets['win-x64'];
  assert.ok(validatePrimaryRuntimeLock(copy).some((error) => error.includes('targets.win-x64 is required')));
});

test('invalid artifact digest is rejected', () => {
  const copy = structuredClone(fixture);
  copy.targets['win-x64'].nodeSha256 = 'sha256-placeholder';
  assert.ok(validatePrimaryRuntimeLock(copy).some((error) => error.includes('nodeSha256')));
});

test('non-HTTPS wheel source is rejected', () => {
  const copy = structuredClone(fixture);
  copy.targets['win-x64'].wheels[0].url = 'http://example.invalid/wheel.whl';
  assert.ok(validatePrimaryRuntimeLock(copy).some((error) => error.includes('.url must use HTTPS')));
});
