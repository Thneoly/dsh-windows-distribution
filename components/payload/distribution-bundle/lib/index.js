import { readFile } from 'node:fs/promises';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';

export const name = 'dsh-distribution-bundle';
export const inject = ['tools'];
export const Config = z.object({});

const BUNDLE_NAME = '@thneoly/dsh-distribution-bundle';
const BUNDLE_VERSION = '1.0.0';
const WORKFLOWS = new Map([
  ['distribution-smoke', new URL('./workflows/distribution-smoke.md', import.meta.url)]
]);

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }]
};

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'distribution_bundle_info',
    description: 'Report the immutable distribution bundle version and the workflow recipes shipped with this installation.',
    parameters: {},
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: () => JSON.stringify({
      bundle: BUNDLE_NAME,
      version: BUNDLE_VERSION,
      source: 'installed-release',
      workflows: [...WORKFLOWS.keys()]
    }, null, 2)
  }));

  ctx.tools.register(defineTool({
    name: 'distribution_workflow_read',
    description: 'Read a workflow recipe that was packaged and version-locked with this DSH installation.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Workflow id. Use distribution-smoke to read the included acceptance workflow.'
      }
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async ({ id }) => {
      const workflow = WORKFLOWS.get(id);
      if (workflow === undefined) throw new Error('unknown bundled workflow: ' + String(id));
      return await readFile(workflow, 'utf8');
    }
  }));
}
