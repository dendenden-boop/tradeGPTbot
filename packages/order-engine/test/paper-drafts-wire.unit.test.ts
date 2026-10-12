/* eslint-disable @typescript-eslint/require-await -- Finite SQL wire contract fixtures. */
import { beforeEach, expect, it, vi } from 'vitest';
import { createPostgresOrderStore } from '../src/postgres-store.js';
import { bindingSchema } from '../src/domain.js';
import { state } from './fixtures.js';
const wire = vi.hoisted(() => ({
  calls: [] as { sql: string; args: unknown[] }[],
  proofDenied: false,
  failCommit: false,
}));
vi.mock('pg', () => ({
  Pool: class {
    on() {
      return this;
    }
    async end() {}
    async connect() {
      return {
        async query(sql: string, args: unknown[] = []) {
          wire.calls.push({ sql, args });
          if (sql.startsWith('SELECT ctp_execution.paper_order_identity')) {
            if (wire.proofDenied) throw new Error('ORDER_PAPER_CONFIGURATION');
            return {
              rows: [
                { identity: { externalAccountId: 'test-account-1', clientIdEpoch: 'paper-epoch' } },
              ],
            };
          }
          if (sql === 'COMMIT' && wire.failCommit)
            throw new Error('lost response with private data');
          return {
            rows: sql.includes(' AS safe')
              ? [{ safe: true }]
              : sql.includes(' AS epoch')
                ? [{ epoch: 'paper-epoch', counter: '0', permission: '0', status: 'ACTIVE' }]
                : [],
          };
        },
        release() {},
        on() {},
        once() {},
      };
    }
  },
}));
beforeEach(() => {
  wire.calls = [];
  wire.proofDenied = false;
  wire.failCommit = false;
});
const io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2000 });
const open = () =>
  createPostgresOrderStore({
    connectionString: 'postgresql://execution:unused@127.0.0.1/orders',
    environment: 'test',
  });
function binding(environment: 'TESTNET' | 'DEMO' | 'LIVE' = 'TESTNET') {
  const b = state().binding;
  return bindingSchema.parse({
    ...b,
    mode: 'PAPER',
    connectionId: null,
    profile: {
      ...b.profile,
      environment,
      accountMode: 'SIMULATED',
      endpointProfileId: 'paper-spot-v1',
      profileVersion: 'spot-l2-taker-v1',
    },
  });
}
it.each(['TESTNET', 'DEMO', 'LIVE'] as const)(
  'PAPER metadata targets configured public %s mode, not account storage mode',
  async (environment) => {
    const store = await open();
    try {
      await expect(store.create(binding(environment), state().draft, io())).rejects.toThrow(
        'ORDER_METADATA',
      );
      const metadata = wire.calls.find((c) => c.sql.includes(' AS base'));
      expect(metadata?.args[3]).toBe(environment);
      expect(metadata?.sql).toContain("r.rules->'scope'");
    } finally {
      await store.close();
    }
  },
);
it('PAPER binding proof precedes account write lock and counter allocation', async () => {
  const store = await open();
  try {
    await expect(store.create(binding(), state().draft, io())).rejects.toThrow('ORDER_METADATA');
    const proof = wire.calls.findIndex((c) =>
      c.sql.includes('SELECT ctp_execution.paper_order_identity'),
    );
    const account = wire.calls.findIndex((c) => c.sql.includes(' AS epoch'));
    const counter = wire.calls.findIndex((c) => c.sql.startsWith('UPDATE public.exchange_account'));
    expect(proof).toBeGreaterThan(0);
    expect(account).toBeGreaterThan(proof);
    expect(counter).toBeGreaterThan(account);
  } finally {
    await store.close();
  }
});
it('missing or conflicting PAPER proof stops lookup before command/counter writes', async () => {
  const store = await open();
  try {
    wire.calls = [];
    wire.proofDenied = true;
    await expect(store.findCreate(binding(), state().draft, io())).rejects.toThrow(
      'ORDER_PAPER_CONFIGURATION',
    );
    expect(wire.calls.some((c) => /^(INSERT|UPDATE)/u.test(c.sql))).toBe(false);
    expect(wire.calls.some((c) => c.sql.includes('FROM ctp_execution.command'))).toBe(false);
  } finally {
    await store.close();
  }
});
it('lost PAPER read COMMIT returns uncertainty without leaking or retrying the query', async () => {
  const store = await open();
  try {
    wire.calls = [];
    wire.failCommit = true;
    await expect(store.findCreate(binding(), state().draft, io())).rejects.toThrow(
      'ORDER_PAPER_STORE_UNCERTAIN',
    );
    expect(wire.calls.filter((c) => c.sql === 'COMMIT')).toHaveLength(1);
    expect(wire.calls.filter((c) => c.sql.includes('FROM ctp_execution.command'))).toHaveLength(1);
  } finally {
    await store.close();
  }
});
it('native metadata keeps its exact storage mode and never calls PAPER proof', async () => {
  const store = await open();
  try {
    wire.calls = [];
    await expect(store.create(state().binding, state().draft, io())).rejects.toThrow(
      'ORDER_METADATA',
    );
    expect(wire.calls.find((c) => c.sql.includes(' AS base'))?.args[3]).toBe('TESTNET');
    expect(
      wire.calls.some((c) => c.sql.includes('SELECT ctp_execution.paper_order_identity')),
    ).toBe(false);
  } finally {
    await store.close();
  }
});
