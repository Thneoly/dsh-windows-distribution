import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const entryPath = process.argv[2];
if (!entryPath) throw new Error('Usage: node smoke-distribution-bundle.mjs <installed-bundle-entry.js>');

const bundle = await import(pathToFileURL(entryPath).href);
assert.equal(typeof bundle.apply, 'function', 'bundle must export its Cordis apply function');

const registered = new Map();
bundle.apply({
  tools: {
    register(tool) {
      assert.equal(typeof tool?.name, 'string', 'registered tool must have a name');
      if (registered.has(tool.name)) throw new Error('duplicate registered tool: ' + tool.name);
      registered.set(tool.name, tool);
    }
  }
});

const infoTool = registered.get('distribution_bundle_info');
const workflowTool = registered.get('distribution_workflow_read');
assert.ok(infoTool, 'distribution_bundle_info was not registered');
assert.ok(workflowTool, 'distribution_workflow_read was not registered');

const infoText = await infoTool.execute({});
assert.equal(typeof infoText, 'string');
const info = JSON.parse(infoText);
assert.equal(info.bundle, '@thneoly/dsh-distribution-bundle');
assert.equal(info.version, '1.0.0');
assert.ok(info.workflows.includes('distribution-smoke'));

const workflowText = await workflowTool.execute({ id: 'distribution-smoke' });
assert.match(workflowText, /Workflow version:.*1\.0\.0/);
assert.match(workflowText, /This workflow is read-only/i);

await assert.rejects(
  () => workflowTool.execute({ id: '../package.json' }),
  /unknown bundled workflow/
);

console.log('PASS: distribution bundle registered both tools, reported version 1.0.0, and read its locked workflow.');
