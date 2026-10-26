import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  computeGitBlobSha,
  validateCheckoutMetadata
} from '../scripts/verify-upstream-checkout.mjs';

const pin = JSON.parse(await readFile(new URL('../upstream.lock.json', import.meta.url), 'utf8'));
const runtimeLock = JSON.parse(await readFile(new URL('../fixtures/primary-runtime-lock.minimal.json', import.meta.url), 'utf8'));

function validInput(overrides = {}) {
  return {
    headSha: pin.commit,
    pin,
    rootPackage: { version: pin.release.version, packageManager: 'pnpm@' + pin.toolchain.pnpmVersion },
    desktopPackage: { version: pin.release.version },
    workspaceText: '- electron@' + pin.toolchain.electronVersion + '\n- pnpm@' + pin.toolchain.pnpmVersion + '\n',
    runtimeLock,
    dirtyFiles: [],
    ...overrides
  };
}

test('Git blob SHA uses Git object framing', () => {
  assert.equal(computeGitBlobSha(Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
});

test('matching upstream metadata passes validation', () => {
  assert.deepEqual(validateCheckoutMetadata(validInput()), []);
});

test('a different checkout commit is rejected', () => {
  assert.ok(validateCheckoutMetadata(validInput({ headSha: '0'.repeat(40) })).some((error) => error.includes('HEAD does not match')));
});

test('dirty tracked files are rejected', () => {
  assert.ok(validateCheckoutMetadata(validInput({ dirtyFiles: ['package.json'] })).some((error) => error.includes('tracked modifications')));
});

test('Electron version drift is rejected', () => {
  const input = validInput({ workspaceText: '- electron@44.8.0\n- pnpm@' + pin.toolchain.pnpmVersion + '\n' });
  assert.ok(validateCheckoutMetadata(input).some((error) => error.includes('expected Electron version')));
});

test('primary runtime version drift is rejected', () => {
  const copy = structuredClone(runtimeLock);
  copy.pythonVersion = '3.13.0';
  assert.ok(validateCheckoutMetadata(validInput({ runtimeLock: copy })).some((error) => error.includes('Python version differs')));
});
