import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateUpstreamPin } from '../scripts/validate-upstream-pin.mjs';

const pin = JSON.parse(await readFile(new URL('../upstream.lock.json', import.meta.url), 'utf8'));

test('pinned upstream release metadata is structurally valid', () => {
  assert.deepEqual(validateUpstreamPin(pin), []);
});

test('floating branch names are not accepted as commit pins', () => {
  const copy = structuredClone(pin);
  copy.commit = 'master';
  assert.ok(validateUpstreamPin(copy).some((error) => error.includes('40-character Git commit SHA')));
});

test('missing lockfile blob identity is rejected', () => {
  const copy = structuredClone(pin);
  delete copy.files['scripts/primary-runtime/lock.json'];
  assert.ok(validateUpstreamPin(copy).some((error) => error.includes('scripts/primary-runtime/lock.json.gitBlobSha')));
});

test('tag and version mismatch is rejected', () => {
  const copy = structuredClone(pin);
  copy.release.tag = 'dsh-v0.2.1';
  assert.ok(validateUpstreamPin(copy).some((error) => error.includes('release.tag must match')));
});
