import { expect, it, vi } from 'vitest';
import { createOwnedSecondaryPostgres } from './owned-native-secondary.mjs';

function fixture({ failUp = false, existing = false, foreign = false, wrongPort = false } = {}) {
  const project = 'ctp-integration-901-aabbcc112233',
    secondary = 'ctp-integration-901-aabbcc112232';
  let running = false,
    startedAt = '2026-11-07T00:00:00.000Z',
    id = 'b'.repeat(64);
  const env = {
    POSTGRES_PASSWORD: '1'.repeat(48),
    CTP_TEST_POSTGRES_PORT: '34001',
    CTP_TEST_REDIS_PORT: '34003',
    REDIS_PASSWORD: '2'.repeat(48),
  };
  const run = vi.fn(async (_binary, args, options) => {
    expect(options.echo).toBe(false);
    if (args[0] === 'inspect')
      return JSON.stringify({
        Id: id,
        Config: {
          Image:
            'postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0',
          Labels: {
            'com.docker.compose.project': foreign ? project : secondary,
            'com.docker.compose.service': 'postgres',
          },
        },
        State: { Running: running, Health: { Status: 'healthy' }, StartedAt: startedAt },
        NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '34002' }] } },
      });
    if (args[0] === 'volume') return existing ? 'unowned-volume' : '';
    expect(args[args.indexOf('--project-name') + 1]).toBe(secondary);
    if (args.includes('config')) return '';
    if (args.includes('up')) {
      running = true;
      if (failUp) throw Error('LOST_START_ACK');
      return '';
    }
    if (args.includes('down')) {
      running = false;
      return '';
    }
    if (args.includes('port')) return '127.0.0.1:' + (wrongPort ? '34004' : '34002');
    if (args.includes('ps')) return running ? id : '';
    throw Error('UNREVIEWED_COMPOSE_OPERATION');
  });
  const handle = createOwnedSecondaryPostgres({
    project,
    env,
    secrets: [env.POSTGRES_PASSWORD],
    run,
    reservePort: async () => 34002,
  });
  return {
    project,
    secondary,
    env,
    run,
    handle,
    replace() {
      id = 'c'.repeat(64);
    },
    restart() {
      startedAt = '2026-11-07T00:01:00.000Z';
    },
  };
}
it('starts only the pinned postgres service in a distinct owned project without mutating primary bindings', async () => {
  const f = fixture(),
    profile = await f.handle.start();
  expect(profile.project).toBe(f.secondary);
  expect(profile.port).toBe(34002);
  expect(f.env.CTP_TEST_POSTGRES_PORT).toBe('34001');
  const up = f.run.mock.calls.find(([, args]) => args.includes('up'));
  expect(up[1].slice(-3)).toEqual(['--pull', 'never', 'postgres']);
  expect(up[2].env.CTP_TEST_POSTGRES_PORT).toBe('34002');
  await f.handle.close();
  expect(f.run.mock.calls.filter(([, args]) => args.includes('down'))).toHaveLength(1);
});
it('cleans up its own possibly-created cluster after an ambiguous start without deleting the primary project', async () => {
  const f = fixture({ failUp: true });
  await expect(f.handle.start()).rejects.toThrow('LOST_START_ACK');
  await f.handle.close();
  await f.handle.close();
  expect(f.run.mock.calls.filter(([, args]) => args.includes('down'))).toHaveLength(1);
});
it('refuses pre-existing secondary volumes and never adopts or deletes them', async () => {
  const f = fixture({ existing: true });
  await expect(f.handle.start()).rejects.toThrow('OWNED_NATIVE_SECONDARY');
  await f.handle.close();
  expect(f.run.mock.calls.some(([, args]) => args.includes('up') || args.includes('down'))).toBe(
    false,
  );
});
it.each([{ foreign: true }, { wrongPort: true }])(
  'rejects a foreign owner or wrong physical binding and still closes only its allocated project %j',
  async (options) => {
    const f = fixture(options);
    await expect(f.handle.start()).rejects.toThrow('OWNED_NATIVE_SECONDARY');
    await f.handle.close();
    expect(f.run.mock.calls.some(([, args]) => args.includes('down'))).toBe(true);
  },
);
it.each(['replace', 'restart'])(
  'rejects a changed container identity after setup: %s',
  async (method) => {
    const f = fixture();
    await f.handle.start();
    f[method]();
    await expect(f.handle.identity()).rejects.toThrow('OWNED_NATIVE_SECONDARY');
    await f.handle.close();
  },
);
it('closing before start creates no resources and permanently rejects later start', async () => {
  const f = fixture();
  await f.handle.close();
  await expect(f.handle.start()).rejects.toThrow('OWNED_NATIVE_SECONDARY');
  expect(f.run).not.toHaveBeenCalled();
});
