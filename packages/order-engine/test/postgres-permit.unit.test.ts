/* eslint-disable @typescript-eslint/require-await -- Finite SQL wire fixtures. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPostgresOrderStore } from '../src/postgres-store.js';
const wire = vi.hoisted(() => ({
  permitSafe: true,
  calls: [] as string[],
  released: [] as boolean[],
}));
vi.mock('pg', () => ({
  Pool: class {
    on() {
      return this;
    }
    async end() {}
    async connect() {
      return {
        async query(sql: string) {
          wire.calls.push(sql);
          return {
            rows: sql.includes(' AS safe')
              ? [{ safe: !sql.includes('deferred_permit_insert()') || wire.permitSafe }]
              : [],
          };
        },
        release(destroy?: boolean) {
          wire.released.push(destroy === true);
        },
        once() {},
      };
    }
  },
}));
const options = {
  connectionString: 'postgresql://execution:unused@127.0.0.1/orders',
  environment: 'test' as const,
};
beforeEach(() => {
  wire.permitSafe = true;
  wire.calls = [];
  wire.released = [];
});
afterEach(() => vi.restoreAllMocks());
it('execution explicitly requests READ COMMITTED for final gate transactions', async () => {
  const store = await createPostgresOrderStore(options);
  try {
    expect(wire.calls.filter((sql) => sql.startsWith('BEGIN'))).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
    ]);
  } finally {
    await store.close();
  }
});
it('unsafe deferred permit authority closes the store before any execution write', async () => {
  wire.permitSafe = false;
  await expect(createPostgresOrderStore(options)).rejects.toThrow('ORDER_DATABASE_ROLE_UNSAFE');
  expect(wire.calls).toContain('ROLLBACK');
  expect(wire.calls.some((sql) => /^(INSERT|UPDATE)/.test(sql))).toBe(false);
  expect(wire.released).toEqual([false]);
});
