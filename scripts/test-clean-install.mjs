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
  for (const tool of ['prisma', 'typescript', 'vitest', 'eslint', 'prettier', 'smtp-server']) {
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
  for (const name of [
    'api',
    'database',
    'exchange-core',
    'exchange-binance',
    'exchange-bybit',
    'exchange-okx',
    'exchange-htx',
  ]) {
    // Frozen install can verify release age via online attestation without caching
    // full registry metadata. Verify the exact derived graph before offline deploy.
    const policyDirectory = path.join(directory, `deployment-${name}-policy`);
    await run(
      process.execPath,
      [
        pnpm,
        '--filter',
        `@ctp/${name}`,
        '--store-dir',
        path.join(workspace, '.pnpm-store'),
        'deploy',
        '--prod',
        '--lockfile-only',
        policyDirectory,
      ],
      options,
    );
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
    assert.deepEqual(
      await readFile(path.join(directory, `deployment-${name}`, 'pnpm-lock.yaml')),
      await readFile(path.join(policyDirectory, 'pnpm-lock.yaml')),
      'Offline deployment must use the exact graph verified by the online policy check',
    );
  }
  await verifyDeployment(
    path.join(directory, 'deployment-api'),
    String.raw`
      await import('./dist/app.js'); await import('./dist/health.js'); await import('./dist/lifecycle.js');
      const { createPasswordHasher } = await import('@ctp/auth');
      const hasher = await createPasswordHasher();
      try {
        const encoded = await hasher.hash('Production deployment verification');
        assert.ok(encoded.startsWith('$argon2id$v=19$'));
        assert.deepEqual(encoded.split('$')[3].split(',').sort(), ['m=65536', 'p=1', 't=3']);
        assert.equal(await hasher.verify(encoded, 'Production deployment verification'), true);
        assert.equal(await hasher.verify(encoded, 'A different verification value'), false);
      } finally { await hasher.close(); }
    `,
    options,
  );
  await verifyDeployment(
    path.join(directory, 'deployment-exchange-binance'),
    String.raw`
      const binance = await import('@ctp/exchange-binance');
      const { createInstrumentRegistry } = await import('@ctp/exchange-core');
      const { existsSync } = await import('node:fs');
      assert.equal(typeof binance.createBinanceAdapter, 'function');
      assert.equal('createBinanceAdapterWithIo' in binance, false);
      assert.equal('createNetworkIo' in binance, false);
      assert.equal('createBinanceSigner' in binance, false);
      assert.equal(existsSync('./test'), false, 'Protocol fixtures must not be packaged');
      assert.equal(existsSync('./src'), false, 'Production package must use compiled output');
      assert.throws(() => import.meta.resolve('@ctp/exchange-binance/io'));
      const options = { profileId: 'binance-spot-testnet-v1', symbols: ['BTCUSDT'], capabilities: [], limiter: { reserve: async () => false, observe: async () => {} } };
      assert.throws(() => binance.createBinanceAdapter({ ...options, rest: 'https://user.example' }), /INVALID_BINANCE_CONFIGURATION/);
      assert.throws(() => binance.createBinanceAdapter(options), /INVALID_BINANCE_CONFIGURATION/);
      const adapter = binance.createBinanceAdapter({ ...options, registry: createInstrumentRegistry({ capacity: 1 }) });
      assert.equal(adapter.account, null);
      assert.equal(adapter.profile.environment, 'TESTNET');
      await adapter.disconnect();
    `,
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
  await verifyDeployment(
    path.join(directory, 'deployment-exchange-bybit'),
    String.raw`
      const bybit = await import('@ctp/exchange-bybit');
      const { createInstrumentRegistry } = await import('@ctp/exchange-core');
      const { existsSync } = await import('node:fs');
      assert.deepEqual(Object.keys(bybit), ['createBybitAdapter']);
      assert.equal(existsSync('./test'), false, 'Bybit protocol fixtures must not be packaged');
      assert.equal(existsSync('./src'), false, 'Bybit must use compiled output');
      for (const subpath of ['io', 'auth', 'profiles', 'testing']) assert.throws(() => import.meta.resolve('@ctp/exchange-bybit/' + subpath));
      const options = { profileId: 'bybit-spot-testnet-v1', symbols: ['BTCUSDT'], capabilities: [], limiter: { reserve: async () => false, observe: async () => {} } };
      assert.throws(() => bybit.createBybitAdapter({ ...options, rest: 'https://user.example' }), /INVALID_BYBIT_CONFIGURATION/);
      assert.throws(() => bybit.createBybitAdapter(options), /INVALID_BYBIT_CONFIGURATION/);
      const adapter = bybit.createBybitAdapter({ ...options, registry: createInstrumentRegistry({ capacity: 1 }) });
      assert.equal(adapter.account, null);
      assert.equal(adapter.profile.environment, 'TESTNET');
      await adapter.disconnect();
    `,
    options,
  );
  await verifyDeployment(
    path.join(directory, 'deployment-exchange-okx'),
    String.raw`
      const okx = await import('@ctp/exchange-okx');
      const { createInstrumentRegistry } = await import('@ctp/exchange-core');
      const { existsSync } = await import('node:fs');
      assert.deepEqual(Object.keys(okx), ['createOkxAdapter']);
      assert.equal(existsSync('./test'), false, 'OKX protocol fixtures must not be packaged');
      assert.equal(existsSync('./src'), false, 'OKX must use compiled output');
      for (const subpath of ['io', 'auth', 'profiles', 'testing']) assert.throws(() => import.meta.resolve('@ctp/exchange-okx/' + subpath));
      const options = { profileId: 'okx-spot-demo-v1', symbols: ['BTC-USDT'], capabilities: [], limiter: { reserve: async () => false, observe: async () => {} } };
      assert.throws(() => okx.createOkxAdapter({ ...options, rest: 'https://user.example' }), /INVALID_OKX_CONFIGURATION/);
      assert.throws(() => okx.createOkxAdapter(options), /INVALID_OKX_CONFIGURATION/);
      const adapter = okx.createOkxAdapter({ ...options, registry: createInstrumentRegistry({ capacity: 1 }) });
      assert.equal(adapter.account, null);
      assert.equal(adapter.profile.environment, 'DEMO');
      await adapter.disconnect();
    `,
    options,
  );
  await verifyDeployment(
    path.join(directory, 'deployment-exchange-htx'),
    String.raw`
      const htx = await import('@ctp/exchange-htx');
      const { createInstrumentRegistry } = await import('@ctp/exchange-core');
      const { existsSync } = await import('node:fs');
      assert.deepEqual(Object.keys(htx), ['createHtxAdapter']);
      assert.equal(existsSync('./test'), false, 'HTX protocol fixtures must not be packaged');
      assert.equal(existsSync('./src'), false, 'HTX must use compiled output');
      for (const subpath of ['io', 'auth', 'profiles', 'testing']) assert.throws(() => import.meta.resolve('@ctp/exchange-htx/' + subpath));
      const options = { profileId: 'htx-spot-live-v1', symbols: ['btcusdt'], capabilities: [], limiter: { reserve: async () => false, observe: async () => {} } };
      assert.throws(() => htx.createHtxAdapter({ ...options, rest: 'https://user.example' }), /INVALID_HTX_CONFIGURATION/);
      assert.throws(() => htx.createHtxAdapter({ ...options, profileId: 'htx-spot-testnet-v1' }), /INVALID_HTX_CONFIGURATION/);
      assert.throws(() => htx.createHtxAdapter(options), /INVALID_HTX_CONFIGURATION/);
      const adapter = htx.createHtxAdapter({ ...options, registry: createInstrumentRegistry({ capacity: 1 }) });
      assert.equal(adapter.account, null);
      assert.equal(adapter.profile.environment, 'LIVE');
      await adapter.disconnect();
    `,
    options,
  );
  await verifyDeployment(
    path.join(directory, 'deployment-exchange-core'),
    String.raw`
      const core = await import('@ctp/exchange-core');
      const { existsSync } = await import('node:fs');
      assert.equal(core.decimalAdd(core.parseDecimal('0.1'), core.parseDecimal('0.2')), '0.3');
      assert.equal(core.quantize(core.parseDecimal('1.03'), core.parseDecimal('0.05'), 'DOWN'), '1');
      assert.equal(typeof core.createExchangeAdapter, 'function');
      assert.equal(typeof core.createInstrumentRegistry, 'function');
      assert.equal(existsSync('./test'), false, 'Test adapter must not be packaged');
      assert.equal(existsSync('./src'), false, 'Production package must use compiled output');
      assert.equal('createTestAdapter' in core, false, 'Test adapter must not be exported');
      assert.throws(() => import.meta.resolve('@ctp/exchange-core/testing'));
    `,
    options,
  );
  assert.equal(digest(await readFile(path.join(directory, 'pnpm-lock.yaml'))), lockfileSha256);
  assert.equal(digest(await readFile(path.join(workspace, 'pnpm-lock.yaml'))), lockfileSha256);
  await report('clean-install', {
    status: 'PASS',
    startedAt,
    completedAt: new Date().toISOString(),
    directory: path.relative(workspace, directory),
    lockfileSha256,
    node: process.version,
    deployments: [
      '@ctp/api',
      '@ctp/database',
      '@ctp/exchange-core',
      '@ctp/exchange-binance',
      '@ctp/exchange-bybit',
      '@ctp/exchange-okx',
      '@ctp/exchange-htx',
    ],
    scope:
      'Fresh source copy without generated code, frozen offline install, workspace build, online policy verification of derived lockfiles, exact offline deployment, isolated API/database/exchange-core/Binance/Bybit/OKX/HTX production imports, native Argon2id and PostgreSQL WASM without dev tools, mail sink or database connections; test adapters/protocol fixtures and raw IO overrides excluded from deployment and package exports',
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
