import { expect, it, vi } from 'vitest';
import { createDependencyLifecycle } from './dependency-lifecycle.mjs';

const project = 'ctp-integration-123-0123456789ab';
const id = 'a'.repeat(64);
function fixture(options = {}) {
  let running = true;
  let startedAt = '2026-11-06T14:21:53.402Z';
  const compose = vi.fn(async (args) => {
    if (args[0] === 'ps') return id;
    // Reproduce the observed Compose success without a new container start.
    if (args[0] === 'stop') running = false;
    return '';
  });
  const docker = vi.fn(async (args) => {
    if (args[0] === 'inspect')
      return JSON.stringify([
        {
          Id: options.foreignId ? 'b'.repeat(64) : id,
          Config: {
            Labels: {
              'com.docker.compose.project': options.foreignProject ? 'other' : project,
              'com.docker.compose.service': 'postgres',
            },
          },
          State: {
            Running: running,
            Status: running ? 'running' : 'exited',
            StartedAt: startedAt,
          },
        },
      ]);
    if (args[0] === 'stop') running = false;
    if (args[0] === 'start' && !options.noOp) {
      running = true;
      startedAt = '2026-11-06T14:21:59.000Z';
    }
    return id;
  });
  return {
    compose,
    docker,
    lifecycle: createDependencyLifecycle({ project, service: 'postgres', compose, docker }),
  };
}

it('starts the exact owned stopped container through the daemon despite a Compose no-op', async () => {
  const { lifecycle, compose, docker } = fixture();
  await lifecycle.stop();
  await lifecycle.start();
  expect(docker.mock.calls.filter(([args]) => args[0] === 'start')).toEqual([[['start', id]]]);
  expect(compose.mock.calls.some(([args]) => args[0] === 'start')).toBe(false);
});

it('rejects a successful start ACK without an actual new running incarnation and never retries', async () => {
  const { lifecycle, docker } = fixture({ noOp: true });
  await lifecycle.stop();
  await expect(lifecycle.start()).rejects.toThrow('DEPENDENCY_START_NOT_CONFIRMED');
  expect(docker.mock.calls.filter(([args]) => args[0] === 'start')).toHaveLength(1);
  await expect(lifecycle.start()).rejects.toThrow();
  expect(docker.mock.calls.filter(([args]) => args[0] === 'start')).toHaveLength(1);
});

for (const scope of ['foreignId', 'foreignProject'])
  it(`rejects ${scope} before stopping any container`, async () => {
    const { lifecycle, docker } = fixture({ [scope]: true });
    await expect(lifecycle.stop()).rejects.toThrow('DEPENDENCY_OWNERSHIP');
    expect(docker.mock.calls.every(([args]) => args[0] === 'inspect')).toBe(true);
  });

it('does not start without a confirmed stop or reuse the completed lifecycle', async () => {
  const { lifecycle, docker } = fixture();
  await expect(lifecycle.start()).rejects.toThrow();
  await lifecycle.stop();
  await lifecycle.start();
  await expect(lifecycle.start()).rejects.toThrow();
  await expect(lifecycle.stop()).rejects.toThrow();
  expect(docker.mock.calls.filter(([args]) => args[0] === 'start')).toHaveLength(1);
});
