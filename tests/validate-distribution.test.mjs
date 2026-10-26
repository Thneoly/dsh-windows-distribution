import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateDistribution, verifyPayloadFiles } from '../scripts/validate-distribution.mjs';

const manifest = JSON.parse(await readFile(new URL('../examples/desktop-distribution.json', import.meta.url), 'utf8'));
const payloadRoot = fileURLToPath(new URL('../examples/payload/', import.meta.url));

test('example distribution manifest is structurally valid', () => {
  assert.deepEqual(validateDistribution(manifest), []);
});

test('example payload file digests match', async () => {
  assert.deepEqual(await verifyPayloadFiles(manifest, payloadRoot), []);
});

test('duplicate component IDs are rejected', () => {
  const copy = structuredClone(manifest);
  copy.components[1].id = copy.components[0].id;
  assert.ok(validateDistribution(copy).some((error) => error.includes('duplicate component id')));
});

test('missing component dependency is rejected', () => {
  const copy = structuredClone(manifest);
  copy.components[1].requires = ['plugin.not-installed'];
  assert.ok(validateDistribution(copy).some((error) => error.includes('requires missing component')));
});

test('path traversal is rejected', () => {
  const copy = structuredClone(manifest);
  copy.components[0].files[0].path = '../outside.txt';
  assert.ok(validateDistribution(copy).some((error) => error.includes('safe relative POSIX path')));
});

test('malformed digest is rejected', () => {
  const copy = structuredClone(manifest);
  copy.components[0].files[0].sha256 = 'not-a-digest';
  assert.ok(validateDistribution(copy).some((error) => error.includes('64-character SHA-256')));
});

test('wrong payload digest is rejected', async () => {
  const copy = structuredClone(manifest);
  copy.components[0].files[0].sha256 = '0'.repeat(64);
  assert.ok((await verifyPayloadFiles(copy, payloadRoot)).some((error) => error.includes('SHA-256 mismatch')));
});
