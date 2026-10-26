import { createHash, randomBytes } from 'node:crypto';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import {
  copyFile, lstat, mkdir, readFile, readdir, rm, stat, writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BUILD_ROOT = path.join(PROJECT_ROOT, '.build');
const UPSTREAM_ROOT = path.join(BUILD_ROOT, 'upstream-dsh');
const DEFAULT_CONFIG = path.join(PROJECT_ROOT, 'config', 'windows.env');
const EXPECTED_PLATFORM = 'win32-x64';

export function parseInstallerVersion(filename) {
  const match = /^deepseek-harness-(.+)-win-x64-unsigned\.exe$/i.exec(filename);
  if (!match) throw new Error('unexpected unsigned Windows installer filename: ' + filename);
  return match[1];
}

export function selectInstallerArtifact(artifacts) {
  const installer = artifacts.find((artifact) =>
    /^deepseek-harness-.+-win-x64-unsigned\.exe$/i.test(path.basename(artifact.file))
  );
  if (!installer) throw new Error('unsigned Windows installer artifact is missing from the artifact manifest');
  return installer;
}

export function validateBuildVersion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error('build version must be a semantic version');
  }
  return value;
}

export function createUnsignedPreflightArgs() {
  return ['--dir', 'apps/desktop', 'run', 'package:win:x64:unsigned', '--', '--check'];
}

export function createUnsignedBuildArgs(buildVersion) {
  return [
    '--dir', 'apps/desktop', 'run', 'package:win:x64:unsigned', '--',
    '--build-version', buildVersion
  ];
}

export function createBuildManifest({ pin, buildVersion, artifacts, builtAt = new Date().toISOString(), profile = 'configured-test' }) {
  if (!['build-only', 'configured-test'].includes(profile)) throw new Error('build profile must be build-only or configured-test');
  return {
    schemaVersion: 1,
    product: 'deepseek-harness',
    releaseVersion: pin.release.version,
    releaseTag: pin.release.tag,
    upstreamCommit: pin.commit,
    target: EXPECTED_PLATFORM,
    buildMode: profile === 'build-only' ? 'unsigned-build-only' : 'unsigned-test',
    distributionProfile: profile,
    networkServicesConfigured: profile === 'configured-test',
    distributionEligible: false,
    buildVersion,
    toolchain: pin.toolchain,
    buildHostToolchain: pin.buildHostToolchain,
    customDistributionComponentsIncluded: false,
    builtAt,
    artifacts
  };
}

async function exists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function removeOwnedCheckout() {
  if (!(await exists(UPSTREAM_ROOT))) return;
  const info = await lstat(UPSTREAM_ROOT);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('refusing to remove non-directory or symlink at build-owned path: ' + UPSTREAM_ROOT);
  }
  await rm(UPSTREAM_ROOT, { recursive: true, force: true });
}

async function runNodeScript(scriptPath, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      windowsHide: true
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(path.basename(scriptPath) + ' failed with ' + String(code ?? signal)));
    });
  });
}

async function runPnpm(args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, {
      cwd,
      stdio: 'inherit',
      windowsHide: true,
      shell: process.platform === 'win32'
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error('pnpm ' + args.join(' ') + ' failed with ' + String(code ?? signal)));
    });
  });
}

async function readCommandVersion(command, args) {
  const options = { windowsHide: true, encoding: 'utf8', shell: process.platform === 'win32' };
  const result = await execFile(command, args, options);
  return (result.stdout || result.stderr).trim();
}

async function assertHostToolchain(pin) {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Windows installer builds require a Windows x64 host');
  }
  const host = pin.buildHostToolchain;
  if (!host) throw new Error('upstream.lock.json must define buildHostToolchain');

  if (process.versions.node !== host.nodeVersion) {
    throw new Error('build host Node.js must be ' + host.nodeVersion + ', found ' + process.versions.node);
  }

  const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const pnpmVersion = await readCommandVersion(pnpmCommand, ['--version']);
  if (pnpmVersion !== host.pnpmVersion) {
    throw new Error('build host pnpm must be ' + host.pnpmVersion + ', found ' + pnpmVersion);
  }

  const pythonCommand = process.env.PYTHON || 'python';
  const pythonVersion = await readCommandVersion(pythonCommand, ['--version']);
  const pythonMatch = /^Python\s+(\d+\.\d+\.\d+)$/u.exec(pythonVersion);
  if (!pythonMatch || pythonMatch[1] !== host.pythonVersion) {
    throw new Error('build host Python must be ' + host.pythonVersion + ', found ' + pythonVersion);
  }

  const gitVersion = await readCommandVersion('git', ['--version']);
  if (!gitVersion.toLowerCase().startsWith('git version ')) {
    throw new Error('Git is required on the build host');
  }
}

export function createBuildOnlyConfig(releaseId = randomBytes(16).toString('hex')) {
  if (!/^[a-f0-9]{32}$/u.test(releaseId)) throw new Error('build-only release ID must be 32 lowercase hexadecimal characters');
  return [
    'DSH_DESKTOP_APP_ID=com.deepseek.harness',
    'DSH_DESKTOP_AUTO_UPDATE_ENV=test',
    'DOWNLOAD_TEST_ORIGIN=https://dsh-build-only.invalid',
    'DOWNLOAD_TEST_RELEASE_ID=' + releaseId,
    'DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN=https://dsh-mandatory-update-build-only.invalid',
    `DSH_DESKTOP_MANDATORY_UPDATE_CONFIG='{"allowedAuthOrigins":["https://dsh-login-build-only.invalid"]}'`,
    ''
  ].join('\n');
}

async function resolveConfig(configArgument, upstreamRoot, profile) {
  if (profile === 'build-only') {
    if (configArgument !== undefined) {
      throw new Error('--config cannot be combined with --profile build-only; the build-only profile owns its reserved .invalid configuration');
    }
    const configPath = path.join(PROJECT_ROOT, 'config', 'windows-build-only.env');
    await mkdir(path.dirname(configPath), { recursive: true });
    if (await exists(configPath)) {
      const info = await lstat(configPath);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error('build-only config must be a regular, non-symlink file: ' + configPath);
      }
    }
    await writeFile(configPath, createBuildOnlyConfig(), { encoding: 'utf8' });
    console.warn('Generated local build-only config with reserved .invalid endpoints. Login and updates are intentionally unavailable; do not distribute this installer.');
    return configPath;
  }

  const configPath = path.resolve(PROJECT_ROOT, configArgument || path.relative(PROJECT_ROOT, DEFAULT_CONFIG));
  if (!(await exists(configPath))) {
    const template = path.join(upstreamRoot, 'apps', 'desktop', '.env.windows.example');
    const examplePath = path.join(PROJECT_ROOT, 'config', 'windows.env.example');
    await mkdir(path.dirname(examplePath), { recursive: true });
    if (!(await exists(examplePath))) await copyFile(template, examplePath);
    console.error('Windows build configuration is missing: ' + configPath);
    console.error('A template from the pinned DSH release is available at: ' + examplePath);
    console.error('Copy it to config/windows.env and fill the required HTTPS origins before a configured-test build, or pass --profile build-only to build with reserved .invalid endpoints.');
    return undefined;
  }
  const info = await lstat(configPath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('build config must be a regular, non-symlink file: ' + configPath);
  }
  return configPath;
}
async function listFiles(root) {
  const files = [];
  if (!(await exists(root))) return files;
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('symbolic links are not allowed in build artifacts: ' + fullPath);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile()) files.push({ fullPath, relativePath: path.relative(root, fullPath) });
    }
  }
  await walk(root);
  return files;
}

async function sha256(filePath) {
  const bytes = await readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

async function prepareArtifactDirectory(files, installer, pin, profile) {
  const buildVersion = parseInstallerVersion(path.basename(installer.fullPath));
  const destination = path.join(BUILD_ROOT, 'artifacts', buildVersion);
  if (await exists(destination)) {
    throw new Error('artifact output already exists; refusing to overwrite: ' + destination);
  }

  await mkdir(destination, { recursive: true });
  const artifacts = [];
  for (const file of files) {
    const target = path.join(destination, file.relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(file.fullPath, target);
    artifacts.push({
      file: file.relativePath.replaceAll(path.sep, '/'),
      sizeBytes: (await stat(target)).size,
      sha256: await sha256(target)
    });
  }

  const manifest = createBuildManifest({ pin, buildVersion, artifacts, profile });
  const manifestPath = path.join(destination, 'release-manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const checksumLines = [];
  for (const artifact of artifacts) checksumLines.push(artifact.sha256 + '  ' + artifact.file);
  checksumLines.push((await sha256(manifestPath)) + '  release-manifest.json');
  await writeFile(path.join(destination, 'SHA256SUMS.txt'), checksumLines.join('\n') + '\n', 'utf8');

  const installerArtifact = selectInstallerArtifact(artifacts);
  console.log('Windows installer: ' + path.join(destination, installerArtifact.file));
  console.log('Installer SHA-256: ' + installerArtifact.sha256);
  console.log('Release manifest: ' + manifestPath);
  console.log('Artifact bundle: ' + destination);
}

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      'build-version': { type: 'string', default: 'auto' },
      profile: { type: 'string', default: 'configured-test' },
      check: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    },
    strict: true
  });

  if (values.help) {
    console.log('Usage: node scripts/build-windows.mjs [--profile build-only|configured-test] [--config config/windows.env] [--build-version auto|<version>] [--check]');
    return;
  }

  const pin = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'upstream.lock.json'), 'utf8'));
  if (!['build-only', 'configured-test'].includes(values.profile)) throw new Error('--profile must be build-only or configured-test');
  if (values['build-version'] !== 'auto') validateBuildVersion(values['build-version']);
  await assertHostToolchain(pin);
  await mkdir(BUILD_ROOT, { recursive: true });
  await removeOwnedCheckout();

  await runNodeScript(path.join(PROJECT_ROOT, 'scripts', 'checkout-pinned-upstream.mjs'), [path.relative(PROJECT_ROOT, UPSTREAM_ROOT)]);
  await runNodeScript(path.join(PROJECT_ROOT, 'scripts', 'verify-upstream-checkout.mjs'), [UPSTREAM_ROOT]);

  const configPath = await resolveConfig(values.config, UPSTREAM_ROOT, values.profile);
  if (!configPath) {
    process.exitCode = 2;
    return;
  }
  const upstreamConfig = path.join(UPSTREAM_ROOT, 'apps', 'desktop', '.env.windows');
  await copyFile(configPath, upstreamConfig);

  await runPnpm(['install', '--frozen-lockfile'], UPSTREAM_ROOT);
  await runPnpm(createUnsignedPreflightArgs(), UPSTREAM_ROOT);
  if (values.check) {
    console.log('Windows packaging preflight passed; installer build was not started.');
    return;
  }

  const artifactSource = path.join(UPSTREAM_ROOT, 'apps', 'desktop', '.desktop-build', 'targets', 'win-x64', 'unsigned-artifacts');
  const beforeFiles = await listFiles(artifactSource);
  const beforeNames = new Set(beforeFiles.map((file) => file.relativePath));
  if (values['build-version'] !== 'auto') {
    const stem = 'deepseek-harness-' + values['build-version'] + '-win-x64-unsigned';
    if (beforeFiles.some((file) => path.basename(file.relativePath).startsWith(stem))) {
      throw new Error('the requested build version already exists in the upstream build output: ' + values['build-version']);
    }
  }

  await runPnpm(createUnsignedBuildArgs(values['build-version']), UPSTREAM_ROOT);

  const afterFiles = await listFiles(artifactSource);
  const newFiles = afterFiles.filter((file) => !beforeNames.has(file.relativePath));
  const installers = newFiles.filter((file) => /^deepseek-harness-.+-win-x64-unsigned\.exe$/i.test(path.basename(file.relativePath)));
  if (installers.length !== 1) {
    throw new Error('expected exactly one newly created unsigned Windows installer, found ' + installers.length);
  }
  await prepareArtifactDirectory(newFiles, installers[0], pin, values.profile);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('Windows distribution build failed: ' + error.message);
    process.exitCode = 1;
  });
}
