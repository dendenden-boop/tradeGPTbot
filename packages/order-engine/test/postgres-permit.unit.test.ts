/* eslint-disable @typescript-eslint/require-await -- Finite SQL wire fixtures. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPostgresOrderStore } from '../src/postgres-store.js';
import { randomUUID } from 'node:crypto';
import { computeCommandHash } from '@ctp/exchange-core';
import { state } from './fixtures.js';
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
        on() {},
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
it('final authorization acquires GLOBAL then exclusive tenant before the control gate can acquire a weaker lock', async () => {
  const store = await createPostgresOrderStore(options);
  try {
    wire.calls = [];
    const s = state();
    const account = {
      tenantId: s.binding.tenantId,
      connectionId: s.binding.connectionId,
      externalAccountId: s.binding.externalAccountId,
    };
    const profile = s.binding.profile;
    await store.authorize(
      'createOrder',
      {
        command: s.command,
        authorization: {
          commandId: s.intentId,
          dispatchAttemptId: randomUUID(),
          commandHash: computeCommandHash('createOrder', s.command, { profile, account }),
          account,
          profile,
          issuedAt: Date.now(),
          expiresAt: Date.now() + 1000,
        },
      },
      {
        signal: new AbortController().signal,
        deadline: Date.now() + 2000,
        profile,
        account,
        correlationId: randomUUID(),
      },
    );
    const gate = wire.calls.findIndex((sql) => sql.includes('ctp_risk.dispatch_gate'));
    expect(gate).toBeGreaterThan(0);
    const beforeGate = wire.calls.slice(0, gate);
    const global = beforeGate.findIndex((sql) =>
      sql.includes('pg_advisory_xact_lock_shared(1129599058,12)'),
    );
    const tenant = beforeGate.findIndex((sql) =>
      sql.includes("pg_advisory_xact_lock(hashtextextended('ctp:risk:'"),
    );
    expect(global).toBeGreaterThan(0);
    expect(tenant).toBeGreaterThan(global);
  } finally {
    await store.close();
  }
});
