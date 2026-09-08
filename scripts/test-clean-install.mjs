import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { report, run, workspace } from './docker-test-utils.mjs';

const startedAt = new Date().toISOString();
let directory;

async function verifyDeployment(deployment, entrypoints, options) {
  const moduleDirectories = [
    ...(await readdir(path.join(deployment, 'node_modules'))),
    ...(await readdir(path.join(deployment, 'node_modules', '.pnpm'))),
  ];
  for (const tool of ['prisma', 'typescript', 'vitest', 'eslint', 'prettier']) {
    assert.ok(
      !moduleDirectories.some((entry) => entry === tool || entry.startsWith(`${tool}@`)),
      `Development tool ${tool} must not be included in the production deployment`,
    );
  }
  // The deployment sits below the source workspace. Reject ancestor node_modules fallbacks,
  // including symlinks, so a missing runtime dependency cannot produce a false positive.
  const isolation = String.raw`
    import assert from 'node:assert/strict';
    import { realpathSync } from 'node:fs';
    import { registerHooks } from 'node:module';
    import path from 'node:path';
    import { fileURLToPath } from 'node:url';
    const root = realpathSync(process.cwd());
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context);
        if (resolved.url.startsWith('node:')) return resolved;
        assert.ok(resolved.url.startsWith('file:'), 'Unexpected runtime import URL');
        const relative = path.relative(root, realpathSync(fileURLToPath(resolved.url)));
        assert.ok(
          relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative),
          'Runtime import escaped the production deployment: ' + specifier,
        );
        return resolved;
      },
    });
  `;
  await run(process.execPath, ['--input-type=module', '-e', isolation + entrypoints], {
    ...options,
    cwd: deployment,
  });
}

try {
  const pnpm = process.env.npm_execpath;
  if (!pnpm) throw new Error('Run this check with pnpm test:clean');
  await mkdir(path.join(workspace, '.cache'), { recursive: true });
  directory = await mkdtemp(path.join(workspace, '.cache', 'clean-'));
  const entries = [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.pnpmfile.mjs',
    'tsconfig.base.json',
    'tsconfig.json',
    'apps',
    'packages',
    'scripts',
  ];
  for (const entry of entries) {
    await cp(path.join(workspace, entry), path.join(directory, entry), {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(workspace, source);
        const generated = path.join('packages', 'database', 'src', 'generated');
        return (
          relative !== generated &&
          !relative.startsWith(generated + path.sep) &&
          !relative
            .split(path.sep)
            .some((part) => ['node_modules', 'dist'].includes(part) || part.startsWith('.env'))
        );
      },
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
  for (const name of ['api', 'database']) {
    await run(
      process.execPath,
      [
        pnpm,
        '--filter',
        `@ctp/${name}`,
        '--offline',
        '--store-dir',
        path.join(workspace, '.pnpm-store'),
        'deploy',
        '--prod',
        path.join(directory, `deployment-${name}`),
      ],
      options,
    );
  }
  await verifyDeployment(
    path.join(directory, 'deployment-api'),
    "await import('./dist/app.js'); await import('./dist/health.js'); await import('./dist/lifecycle.js');",
    options,
  );
  await verifyDeployment(
    path.join(directory, 'deployment-database'),
    String.raw`
      const database = await import('@ctp/database');
      assert.equal(typeof database.createDatabase, 'function');
      assert.equal(database.decimalText('0.100000000000000001', 'amount'), '0.100000000000000001');
      await import('@prisma/client/runtime/query_compiler_fast_bg.postgresql.mjs');
      const { wasm } = await import('@prisma/client/runtime/query_compiler_fast_bg.postgresql.wasm-base64.mjs');
      assert.ok(WebAssembly.validate(Buffer.from(wasm, 'base64')), 'Missing or invalid PostgreSQL query compiler');
    `,
    options,
  );
  await report('clean-install', {
    status: 'PASS',
    startedAt,
    completedAt: new Date().toISOString(),
    directory: path.relative(workspace, directory),
    lockfileSha256,
    node: process.version,
    deployments: ['@ctp/api', '@ctp/database'],
    scope:
      'Fresh source copy without generated code, offline store, frozen install, workspace build, isolated API/database production imports and PostgreSQL WASM without dev tools or database connections',
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
