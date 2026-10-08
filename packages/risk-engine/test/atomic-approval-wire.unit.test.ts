/* eslint-disable @typescript-eslint/require-await -- SQL boundary fixture; native concurrency is verified separately. */
import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { computeCommandHash } from '@ctp/exchange-core';
import { captureFixture } from './snapshot-fixtures.js';
import * as risk from '../src/index.js';
interface SqlFixture {
  safe: boolean;
  prepare: unknown;
  receipt: unknown;
  queries: string[];
  values: unknown[][];
  failCommit: boolean;
  persisted: unknown;
  destroyed: number;
  commitAction: (() => void) | null;
}
const sql = vi.hoisted<SqlFixture>(() => ({
  safe: true,
  prepare: null,
  receipt: null,
  queries: [],
  values: [],
  failCommit: false,
  persisted: null,
  destroyed: 0,
  commitAction: null,
}));
vi.mock('pg', () => ({
  Pool: class {
    on() {
      return this;
    }
    async end() {}
    async connect() {
      return {
        on() {},
        once() {},
        async query(q: string, v: unknown[] = []) {
          sql.queries.push(q);
          sql.values.push(v);
          if (q.includes('AS safe')) return { rows: [{ safe: sql.safe }] };
          if (q.includes('ctp_admission.prepare(')) return { rows: [{ result: sql.prepare }] };
          if (q.includes('ctp_admission.persist(')) {
            sql.persisted = JSON.parse(String(v[1])) as unknown;
            return { rows: [{ result: sql.receipt }] };
          }
          if (q === 'COMMIT' && sql.failCommit)
            throw new Error('commit response lost secret=private');
          if (q === 'COMMIT') sql.commitAction?.();
          return { rows: [] };
        },
        release(destroy = false) {
          if (destroy) sql.destroyed++;
        },
      };
    }
  },
}));
interface Port {
  approve(input: unknown, io: { signal: AbortSignal; deadline: number }): Promise<unknown>;
  close(): Promise<void>;
}
const io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2500 });
async function open() {
  const fn: unknown = Reflect.get(risk, 'createPostgresOrderRiskPort');
  expect(fn).toBeTypeOf('function');
  return (fn as (o: unknown) => Promise<Port>)({
    connectionString: 'postgresql://gateway:private@127.0.0.1/isolated',
    environment: 'test',
  });
}
function fixture() {
  const f = captureFixture(),
    orderId = randomUUID();
  const input = {
    binding: f.key.binding,
    state: { id: orderId },
    intentId: f.key.intentId,
    operation: 'PLACE',
    commandHash: computeCommandHash('createOrder', f.raw.intent.command, {
      profile: f.key.binding.profile,
      account: {
        tenantId: f.key.binding.tenantId,
        connectionId: f.key.binding.connectionId,
        externalAccountId: f.key.binding.externalAccountId,
      },
    }),
  };
  const allocation = {
    certificateId: randomUUID(),
    revision: '1',
    decisionId: randomUUID(),
    reservationId: randomUUID(),
  };
  const receipt = {
    decisionId: allocation.decisionId,
    reservationId: allocation.reservationId,
    permissionEpoch: '1',
    expiresAt: Date.now() + 1500,
  };
  sql.prepare = {
    replay: null,
    key: f.key,
    capture: f.raw,
    allocation,
    commandHash: input.commandHash,
    orderId,
  };
  sql.receipt = receipt;
  return { ...f, input, receipt };
}
beforeEach(() => {
  sql.safe = true;
  sql.prepare = null;
  sql.receipt = null;
  sql.queries = [];
  sql.values = [];
  sql.failCommit = false;
  sql.persisted = null;
  sql.destroyed = 0;
  sql.commitAction = null;
});
it('approves only after one ordered transaction re-evaluates current sources and atomically persists its Portfolio commitment', async () => {
  const f = fixture(),
    port = await open();
  expect(await port.approve(f.input, io())).toEqual(f.receipt);
  const work = sql.queries.slice(sql.queries.lastIndexOf('BEGIN ISOLATION LEVEL READ COMMITTED'));
  expect(work.filter((q) => q.includes('ctp_admission.prepare('))).toHaveLength(1);
  expect(work.filter((q) => q.includes('ctp_admission.persist('))).toHaveLength(1);
  expect(work.at(-1)).toBe('COMMIT');
  expect(work.findIndex((q) => q.includes('pg_advisory_xact_lock_shared'))).toBeLessThan(
    work.findIndex((q) => q.includes('pg_advisory_xact_lock(')),
  );
  expect(sql.persisted).toMatchObject({
    evaluation: { kind: 'EVALUATED' },
    portfolio: {
      event: {
        type: 'COMMITMENT',
        hold: { id: f.receipt.reservationId, status: 'RESERVED', reflected: false },
      },
    },
  });
  await port.close();
});
it('returns no grant after uncertain COMMIT even when persistence produced an approved receipt', async () => {
  const f = fixture(),
    port = await open();
  sql.failCommit = true;
  await expect(port.approve(f.input, io())).rejects.toThrow('RISK_SNAPSHOT_STORE_FAILED');
  expect(sql.persisted).not.toBeNull();
  await port.close();
});
it.each(['FX', 'RULE', 'CAPABILITY'] as const)(
  'never returns a grant outliving its current %s proof',
  async (kind) => {
    const f = fixture(),
      port = await open(),
      expiresAt = Date.now() + 200;
    if (kind === 'FX') {
      f.observation.fx[0]!.asOf = expiresAt - 5000;
      f.rehashObservation();
    } else if (kind === 'RULE') {
      f.raw.metadata.value.record.rules.expiresAt = expiresAt;
      f.rehashMarket();
    } else
      f.raw.metadata.value.capabilities.forEach((capability) => {
        capability.expiresAt = expiresAt;
      });
    await expect(port.approve(f.input, io())).rejects.toThrow('RISK_ADMISSION_RECEIPT');
    expect(sql.persisted).toMatchObject({ certificate: { expiresAt } });
    await port.close();
  },
);
it('returns no grant when its original certified expiry passes while a known COMMIT settles', async () => {
  const f = fixture(),
    port = await open();
  const clock = vi.spyOn(Date, 'now');
  try {
    sql.commitAction = () => clock.mockReturnValue(f.receipt.expiresAt + 1);
    await expect(port.approve(f.input, io())).rejects.toThrow('RISK_ADMISSION_EXPIRED');
    expect(sql.persisted).not.toBeNull();
  } finally {
    clock.mockRestore();
    await port.close();
  }
});
it('permanent exact replay returns the same decision/reservation without new capture or Portfolio effect', async () => {
  const f = fixture(),
    port = await open();
  sql.prepare = { replay: f.receipt };
  expect(await port.approve(f.input, io())).toEqual(f.receipt);
  expect(sql.persisted).toBeNull();
  await port.close();
});
it('current policy rejection creates no approval or commitment', async () => {
  const f = fixture(),
    port = await open();
  f.raw.controls.value.pauses.global = true;
  await expect(port.approve(f.input, io())).rejects.toThrow('RISK_PAUSED');
  expect(sql.persisted).toBeNull();
  await port.close();
});
it('refuses source/intent hash conflict before durable admission', async () => {
  const f = fixture(),
    port = await open();
  await expect(port.approve({ ...f.input, commandHash: 'f'.repeat(64) }, io())).rejects.toThrow(
    'RISK_ADMISSION_CONFLICT',
  );
  expect(sql.persisted).toBeNull();
  await port.close();
});
it('does not accept a caller RiskSnapshot or monetary proposal', async () => {
  const f = fixture(),
    port = await open();
  await expect(
    port.approve({ ...f.input, snapshot: f.risk.snapshot, proposal: { amount: '0' } }, io()),
  ).rejects.toThrow('RISK_ADMISSION_INPUT');
  expect(sql.persisted).toBeNull();
  await port.close();
});
