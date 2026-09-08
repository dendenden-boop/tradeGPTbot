import { createRequire } from 'node:module';
import { PrismaClient } from '../packages/database/dist/generated/client.js';
import { seedDevelopment } from '../packages/database/dist/seed.js';

const { PrismaPg } = createRequire(new URL('../packages/database/package.json', import.meta.url))(
  '@prisma/adapter-pg',
);

let client;
try {
  if (process.env.NODE_ENV !== 'development')
    throw new Error('Development seed requires NODE_ENV=development');
  if (!process.env.DATABASE_MIGRATION_URL)
    throw new Error('Set an explicit DATABASE_MIGRATION_URL for development seed');
  const url = new URL(process.env.DATABASE_MIGRATION_URL);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/ctp' ||
    !url.username ||
    !url.password ||
    url.hash ||
    url.search
  ) {
    throw new Error('Development seed requires the explicitly selected loopback ctp database');
  }
  client = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: url.href,
      max: 1,
      connectionTimeoutMillis: 1000,
      statement_timeout: 10000,
      query_timeout: 11000,
      options: '-c idle_in_transaction_session_timeout=10000',
    }),
    log: [],
  });
  await seedDevelopment(client);
  console.log(
    'Development seed complete: disabled user, disabled PAPER account and inactive fixture instrument.',
  );
} catch {
  console.error(
    'Development seed failed; check development environment, explicit migration URL and applied migrations. No secrets are logged.',
  );
  process.exitCode = 1;
} finally {
  if (client)
    await client.$disconnect().catch(() => {
      console.error('Development seed connection close failed.');
      process.exitCode = 1;
    });
}
