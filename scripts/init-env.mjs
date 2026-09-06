import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const postgresPassword = randomBytes(24).toString('hex');
const redisPassword = randomBytes(24).toString('hex');
const content = [
  '# Local development only. Generated secrets; do not commit or share this file.',
  'NODE_ENV=development',
  'HOST=127.0.0.1',
  'PORT=3000',
  'API_PORT=3000',
  'LOG_LEVEL=info',
  `POSTGRES_PASSWORD=${postgresPassword}`,
  `REDIS_PASSWORD=${redisPassword}`,
  `DATABASE_URL=postgresql://ctp:${postgresPassword}@127.0.0.1:5432/ctp`,
  `REDIS_URL=redis://:${redisPassword}@127.0.0.1:6379/0`,
  '',
].join('\n');
try {
  await writeFile(new URL('../.env', import.meta.url), content, { flag: 'wx', mode: 0o600 });
  console.log(
    'Created .env with unique development passwords. Existing files are never overwritten.',
  );
} catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
    console.error('.env already exists; left unchanged.');
  } else console.error('Could not create .env. Check workspace permissions.');
  process.exitCode = 1;
}
