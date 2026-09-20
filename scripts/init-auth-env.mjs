import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const apiPassword = randomBytes(24).toString('hex');
const authPassword = randomBytes(24).toString('hex');
const content = [
  '# Local authentication settings. Generated secrets; never commit or share.',
  `POSTGRES_API_PASSWORD=${apiPassword}`,
  `POSTGRES_AUTH_PASSWORD=${authPassword}`,
  `DATABASE_URL=postgresql://ctp_api_login:${apiPassword}@127.0.0.1:5432/ctp`,
  `DATABASE_AUTH_URL=postgresql://ctp_auth_login:${authPassword}@127.0.0.1:5432/ctp`,
  'AUTH_ORIGIN=http://127.0.0.1:3000',
  `AUTH_CSRF_SECRET=${randomBytes(32).toString('hex')}`,
  'SMTP_HOST=127.0.0.1',
  'SMTP_PORT=1025',
  'SMTP_SECURE=false',
  'SMTP_REQUIRE_TLS=false',
  'SMTP_FROM=accounts@ctp.invalid',
  '',
].join('\n');
try {
  await writeFile(new URL('../.env.auth', import.meta.url), content, { flag: 'wx', mode: 0o600 });
  console.log('Created .env.auth. Existing .env and database passwords are unchanged.');
} catch (error) {
  console.error(
    error?.code === 'EEXIST'
      ? '.env.auth already exists; left unchanged.'
      : 'Could not create .env.auth.',
  );
  process.exitCode = 1;
}
