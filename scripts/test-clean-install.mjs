import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { report, run, workspace } from './docker-test-utils.mjs';

const startedAt = new Date().toISOString();
let directory;
try {
  const pnpm = process.env.npm_execpath;
  if (!pnpm) throw new Error('Run this check with pnpm test:clean');
  await mkdir(path.join(workspace, '.cache'), { recursive: true });
  directory = await mkdtemp(path.join(workspace, '.cache', 'clean-'));
  const entries = [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    'tsconfig.json',
    'apps',
    'packages',
    'scripts',
  ];
  for (const entry of entries) {
    await cp(path.join(workspace, entry), path.join(directory, entry), {
      recursive: true,
      filter: (source) =>
        !path
          .relative(workspace, source)
          .split(path.sep)
          .some((part) => ['node_modules', 'dist'].includes(part) || part.startsWith('.env')),
    });
  }
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const lockfileSha256 = digest(await readFile(path.join(directory, 'pnpm-lock.yaml')));
  const options = { cwd: directory, env: { ...process.env, CI: 'true' }, echo: true };
  await run(
    process.execPath,
    [
      pnpm,
      'install',
      '--offline',
      '--frozen-lockfile',
      '--store-dir',
      path.join(workspace, '.pnpm-store'),
    ],
    options,
  );
  assert.equal(digest(await readFile(path.join(directory, 'pnpm-lock.yaml'))), lockfileSha256);
  await run(process.execPath, [pnpm, 'build'], options);
  await run(
    process.execPath,
    [
      pnpm,
      '--filter',
      '@ctp/api',
      '--offline',
      '--store-dir',
      path.join(workspace, '.pnpm-store'),
      'deploy',
      '--prod',
      path.join(directory, 'deployment'),
    ],
    options,
  );
  // Resolve all runtime imports solely from the deployed package, without starting sockets.
  await run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "await import('./dist/app.js'); await import('./dist/health.js'); await import('./dist/lifecycle.js');",
    ],
    { ...options, cwd: path.join(directory, 'deployment') },
  );
  await report('clean-install', {
    status: 'PASS',
    startedAt,
    completedAt: new Date().toISOString(),
    directory: path.relative(workspace, directory),
    lockfileSha256,
    node: process.version,
    scope:
      'Fresh source copy, offline store, frozen install, workspace build, production deploy and runtime import resolution',
  });
  console.log('Clean install/build/deploy PASS; original source and lockfile left unchanged.');
} catch (error) {
  const reason = error instanceof Error ? error.message : 'Clean install failed';
  console.error(reason);
  await report('clean-install', {
    status: 'FAIL',
    startedAt,
    directory: directory ? path.relative(workspace, directory) : null,
    reason,
  });
  process.exitCode = 1;
}
