import { defineConfig } from 'prisma/config';

const url = process.env['DATABASE_MIGRATION_URL'];

// Generation/validation need no database. Mutating CLI commands require an explicit URL.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  ...(url ? { datasource: { url } } : {}),
});
