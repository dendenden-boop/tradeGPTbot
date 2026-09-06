import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const workspace = fileURLToPath(new URL('../', import.meta.url));

export function testEnvironment(kind) {
  if (!['integration', 'smoke'].includes(kind)) throw new Error('Invalid test kind');
  const project = `ctp-${kind}-${process.pid}-${randomBytes(6).toString('hex')}`;
  const postgresPassword = randomBytes(24).toString('hex');
  const redisPassword = randomBytes(24).toString('hex');
  return {
    project,
    secrets: [postgresPassword, redisPassword],
    env: {
      ...process.env,
      POSTGRES_PASSWORD: postgresPassword,
      REDIS_PASSWORD: redisPassword,
      API_PORT: '0',
      LOG_LEVEL: 'info',
    },
  };
}

export function sanitize(text, secrets) {
  return secrets.reduce((result, secret) => result.replaceAll(secret, '[REDACTED]'), text);
}

export function run(
  binary,
  args,
  { env = process.env, timeoutMs = 120_000, secrets = [], echo = false, cwd = workspace } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let finished = false;
    const finish = (error, code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const safeOutput = sanitize(output, secrets);
      if (echo && safeOutput) console.log(safeOutput);
      if (error) reject(error);
      else if (code !== 0) reject(new Error(`Command failed (${code}): ${binary}\n${safeOutput}`));
      else resolve(output);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`Command deadline exceeded: ${binary}`));
    }, timeoutMs);
    const receive = (chunk) => {
      output += chunk.toString();
      if (output.length > 2_000_000) {
        child.kill('SIGKILL');
        finish(new Error(`Command output exceeded safety bound: ${binary}`));
      }
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.once('error', () =>
      finish(
        new Error(`Cannot start ${binary}. Install the required executable or configure PATH.`),
      ),
    );
    child.once('close', (code) => finish(undefined, code));
  });
}

export function composeArgs(file, project, args) {
  if (!/^ctp-(integration|smoke)-\d+-[a-f0-9]{12}$/.test(project)) {
    throw new Error('Refusing an unowned Docker test project');
  }
  if (!['infra/compose.test.yml', 'infra/compose.dev.yml'].includes(file))
    throw new Error('Invalid test compose path');
  return ['compose', '--env-file', '.env.example', '-f', file, '--project-name', project, ...args];
}

export async function requireDocker(options) {
  await run('docker', ['version', '--format', '{{.Server.Os}}'], options).then((output) => {
    if (output.trim() !== 'linux')
      throw new Error('Linux Docker Engine is required for these integration tests');
  });
  await run('docker', ['compose', 'version'], options);
}

export function localPort(output) {
  const match = /^127\.0\.0\.1:(\d+)$/m.exec(output.trim());
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535)
    throw new Error('Unexpected Docker loopback port mapping');
  return Number(match[1]);
}

export async function report(name, value) {
  if (!/^[a-z-]+$/.test(name)) throw new Error('Invalid report name');
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  await writeFile(
    new URL(`../test-results/${name}.json`, import.meta.url),
    JSON.stringify(value, null, 2) + '\n',
  );
}
