// Private CI resource lifecycle. Uses the existing pinned test Compose file.
import { createServer } from 'node:net';
import { composeArgs, localPort, run as execute } from './docker-test-utils.mjs';
import { secondaryNativeProject } from './native-cluster-isolation.mjs';

const file = 'infra/compose.test.yml';
const image =
  'postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0';
const fail = () => {
  throw Error('OWNED_NATIVE_SECONDARY');
};
async function selectPort() {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') fail();
    return address.port;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
export async function inspectOwnedPostgres(project, expectedPort, options, run = execute) {
  const id = (
    await run('docker', composeArgs(file, project, ['ps', '--all', '--quiet', 'postgres']), {
      ...options,
      echo: false,
    })
  ).trim();
  if (!/^[a-f0-9]{64}$/u.test(id)) fail();
  const raw = await run('docker', ['inspect', id, '--format', '{{json .}}'], {
    ...options,
    echo: false,
  });
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail();
  }
  const labels = value.Config?.Labels,
    bindings = value.NetworkSettings?.Ports?.['5432/tcp'];
  if (
    value.Id !== id ||
    value.Config?.Image !== image ||
    labels?.['com.docker.compose.project'] !== project ||
    labels?.['com.docker.compose.service'] !== 'postgres' ||
    value.State?.Running !== true ||
    value.State?.Health?.Status !== 'healthy' ||
    !Array.isArray(bindings) ||
    bindings.length !== 1 ||
    bindings[0].HostIp !== '127.0.0.1' ||
    bindings[0].HostPort !== String(expectedPort) ||
    !Number.isFinite(Date.parse(value.State.StartedAt))
  )
    fail();
  return Object.freeze({
    project,
    containerId: id,
    port: expectedPort,
    startedAt: value.State.StartedAt,
    image,
  });
}
export function createOwnedSecondaryPostgres({
  project,
  env,
  secrets = [],
  run = execute,
  reservePort = selectPort,
}) {
  const secondary = secondaryNativeProject(project);
  if (
    !env ||
    typeof env.POSTGRES_PASSWORD !== 'string' ||
    !/^[a-f0-9]{48}$/u.test(env.POSTGRES_PASSWORD)
  )
    fail();
  const primaryPort = Number(env.CTP_TEST_POSTGRES_PORT);
  if (!Number.isSafeInteger(primaryPort) || primaryPort < 1 || primaryPort > 65535) fail();
  const options = { env: { ...env }, secrets, echo: false };
  let mayExist = false,
    started = false,
    closed = false,
    port,
    initial,
    closing;
  async function identity() {
    if (!started || closed) fail();
    const current = await inspectOwnedPostgres(secondary, port, options, run);
    if (
      initial &&
      (current.containerId !== initial.containerId || current.startedAt !== initial.startedAt)
    )
      fail();
    return current;
  }
  return Object.freeze({
    project: secondary,
    async start() {
      if (closed || mayExist || started) fail();
      port = await reservePort();
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || port === primaryPort) fail();
      options.env.CTP_TEST_POSTGRES_PORT = String(port);
      await run('docker', composeArgs(file, secondary, ['config', '--quiet']), options);
      if (
        (
          await run('docker', composeArgs(file, secondary, ['ps', '--all', '--quiet']), options)
        ).trim() !== ''
      )
        fail();
      if (
        (
          await run(
            'docker',
            [
              'volume',
              'ls',
              '--filter',
              'label=com.docker.compose.project=' + secondary,
              '--format',
              '{{.Name}}',
            ],
            options,
          )
        ).trim() !== ''
      )
        fail();
      mayExist = true;
      await run(
        'docker',
        composeArgs(file, secondary, [
          'up',
          '-d',
          '--wait',
          '--wait-timeout',
          '60',
          '--pull',
          'never',
          'postgres',
        ]),
        { ...options, timeoutMs: 120000 },
      );
      const actual = localPort(
        await run('docker', composeArgs(file, secondary, ['port', 'postgres', '5432']), options),
      );
      if (actual !== port) fail();
      started = true;
      initial = await identity();
      return initial;
    },
    identity,
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        if (!mayExist) return;
        await run(
          'docker',
          composeArgs(file, secondary, ['down', '--volumes', '--remove-orphans']),
          options,
        );
        if (
          (
            await run('docker', composeArgs(file, secondary, ['ps', '--all', '--quiet']), options)
          ).trim() !== ''
        )
          fail();
        if (
          (
            await run(
              'docker',
              [
                'volume',
                'ls',
                '--filter',
                'label=com.docker.compose.project=' + secondary,
                '--format',
                '{{.Name}}',
              ],
              options,
            )
          ).trim() !== ''
        )
          fail();
        mayExist = false;
      })();
      return closing;
    },
  });
}
