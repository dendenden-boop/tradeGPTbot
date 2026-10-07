import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPostgresPolicies } from '../src/postgres-policies.js';
import { policyUpdateSchema } from '../src/policies.js';
import { fixture } from './fixtures.js';
const wire = vi.hoisted(() => ({
  safe: true,
  commitFailure: false,
  abortAtCommit: null as AbortController | null,
  calls: [] as string[],
  released: [] as boolean[],
}));
vi.mock('pg', () => ({
  Pool: class {
    on() {
      return this;
    }
    async end() {}
    connect() {
      return Promise.resolve({
        query: (sql: string, args?: unknown[]) => {
          wire.calls.push(sql);
          if (sql === 'COMMIT') {
            wire.abortAtCommit?.abort();
            if (wire.commitFailure) return Promise.reject(new Error('wire lost after COMMIT'));
          }
          if (sql.includes(' AS safe ')) return Promise.resolve({ rows: [{ safe: wire.safe }] });
          if (sql.includes('update_user_policy')) {
            const payload = JSON.parse(args?.[0] as string) as {
              eventId: string;
              expectedVersion: string;
            };
            return Promise.resolve({
              rows: [
                {
                  result: {
                    eventId: payload.eventId,
                    version: (BigInt(payload.expectedVersion) + 1n).toString(),
                    replayed: false,
                  },
                },
              ],
            });
          }
          return Promise.resolve({ rows: [] });
        },
        release: (destroy?: boolean) => {
          wire.released.push(destroy === true);
        },
        on() {},
        once() {},
      });
    }
  },
}));
const options = {
  connectionString: 'postgresql://policy:unused@127.0.0.1/policy_test',
  environment: 'test' as const,
  authority: 'USER' as const,
};
const io = (signal = new AbortController().signal) => ({ signal, deadline: Date.now() + 2500 });
const request = () =>
  policyUpdateSchema.parse({
    scope: { kind: 'USER', tenantId: randomUUID() },
    mode: 'TESTNET',
    eventId: randomUUID(),
    expectedVersion: '0',
    reason: 'SERVER_POLICY',
    limits: fixture().user,
  });
beforeEach(() => {
  wire.safe = true;
  wire.commitFailure = false;
  wire.abortAtCommit = null;
  wire.calls = [];
  wire.released = [];
});
afterEach(() => vi.restoreAllMocks());
it('policy publisher explicitly uses READ COMMITTED instead of inherited snapshot isolation', async () => {
  const store = await createPostgresPolicies(options);
  try {
    await store.update(request(), io());
    expect(wire.calls.filter((sql) => sql.startsWith('BEGIN'))).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      'BEGIN ISOLATION LEVEL READ COMMITTED',
    ]);
  } finally {
    await store.close();
  }
});
it('uncertain COMMIT produces no successful publisher result', async () => {
  const store = await createPostgresPolicies(options);
  wire.commitFailure = true;
  try {
    await expect(store.update(request(), io())).rejects.toThrow('RISK_POLICY_STORE_FAILED');
    expect(wire.calls).toContain('ROLLBACK');
  } finally {
    await store.close();
  }
});
it('abort after COMMIT settling still produces no successful result', async () => {
  const store = await createPostgresPolicies(options),
    abort = new AbortController();
  wire.abortAtCommit = abort;
  try {
    await expect(store.update(request(), io(abort.signal))).rejects.toThrow('RISK_POLICY_ABORTED');
    expect(wire.released.at(-1)).toBe(true);
  } finally {
    await store.close();
  }
});
it('unsafe SQL authority fails startup before policy publication', async () => {
  wire.safe = false;
  await expect(createPostgresPolicies(options)).rejects.toThrow('RISK_POLICY_ROLE_UNSAFE');
  expect(wire.calls.some((sql) => sql.startsWith('SELECT ctp_risk.update_user_policy('))).toBe(
    false,
  );
});
it('wrong authority and expired IO cannot publish a revision', async () => {
  const store = await createPostgresPolicies(options);
  try {
    const p = request();
    await expect(store.update({ ...p, scope: { kind: 'PLATFORM' } }, io())).rejects.toThrow(
      'RISK_POLICY_AUTHORITY',
    );
    await expect(store.update(p, { ...io(), deadline: 0 })).rejects.toThrow('RISK_POLICY_ABORTED');
    expect(wire.calls.some((sql) => sql.includes(' AS result'))).toBe(false);
  } finally {
    await store.close();
  }
});
