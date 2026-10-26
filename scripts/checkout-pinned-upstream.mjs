import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

async function main() {
  const destination = process.argv[2];
  if (!destination || process.argv.includes('--help')) {
    console.log('Usage: node scripts/checkout-pinned-upstream.mjs <destination-directory>');
    process.exitCode = destination ? 0 : 2;
    return;
  }

  const pin = JSON.parse(await (await import('node:fs/promises')).readFile(
    new URL('../upstream.lock.json', import.meta.url), 'utf8'
  ));
  const target = path.resolve(destination);
  await mkdir(path.dirname(target), { recursive: true });

  try {
    const entries = await readdir(target);
    if (entries.length > 0) throw new Error('destination directory must be empty: ' + target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const cloneArgs = [
    'clone', '--depth', '1', '--single-branch',
    '--branch', pin.release.tag,
    'https://github.com/' + pin.repository + '.git',
    target
  ];
  const result = await execFile('git', cloneArgs);
  if (result.stdout.trim()) process.stdout.write(result.stdout);
  if (result.stderr.trim()) process.stderr.write(result.stderr);
  console.log('Checked out upstream tag ' + pin.release.tag + ' into ' + target);
  console.log('Next: node scripts/verify-upstream-checkout.mjs "' + target + '"');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('Unable to check out pinned DSH release: ' + error.message);
    process.exitCode = 1;
  });
}
