import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as server from '../src/risk.js';
import * as pure from '../src/index.js';
import { canonical } from '@ctp/portfolio';
import { executionRiskFixture } from './execution-risk-fixtures.js';
import { wireNow } from './admission-wire-fixtures.js';
const fake = vi.hoisted(() => ({
  risk: null as unknown,
  inventory: null as unknown,
  queries: [] as { text: string; values: readonly unknown[]; client: number }[],
  clients: 0,
  duplicate: 0,
  failedQuery: 0,
  calls: 0,
  afterInventory: null as null | (() => void),
  afterCommit: null as null | (() => void),
  commitError: false,
}));
vi.mock('pg', () => ({
  Client: class {
    id = ++fake.clients;
    on() {}
    async connect() {}
    async end() {}
    query(text: string, values: readonly unknown[] = []) {
      fake.queries.push({ text, values, client: this.id });
      if (text.includes(' AS safe')) return Promise.resolve({ rows: [{ safe: true }] });
      if (text.includes(' AS result')) {
        const call = ++fake.calls;
        if (call === fake.failedQuery) return Promise.reject(Error('private wire failure'));
        const kind = JSON.parse(values[0] as string).kind as string;
        const inventory = kind === 'PAPER_PREPARATION_INVENTORY_CAPTURE';
        if (inventory) fake.afterInventory?.();
        return Promise.resolve({
          rows: Array.from({ length: fake.duplicate === call ? 2 : 1 }, () => ({
            result: inventory ? fake.inventory : fake.risk,
          })),
        });
      }
      if (text === 'COMMIT') {
        fake.afterCommit?.();
        if (fake.commitError) return Promise.reject(Error('private COMMIT loss'));
      }
      return Promise.resolve({ rows: [] });
    }
  },
}));
interface View {
  kind: string;
  asOf: number;
  validUntil: number;
  hash: string;
  risk: {
    preparation: unknown;
    source: { candidates: unknown[] };
    evaluation: { kind: string };
    retained: { budget: { orders: { current: number; projected: number } } };
  };
  inventory: { entries: { kind: string; intentId: string; key?: string; preparation?: unknown }[] };
}
interface Port {
  read(request: unknown, io: { signal: AbortSignal; deadline: number }): Promise<View>;
  close(): Promise<void>;
}
function factory() {
  const f = (server as unknown as Record<string, unknown>)[
    'createPostgresPaperExecutionContextSource'
  ];
  if (typeof f !== 'function') throw Error('PAPER_EXECUTION_CONTEXT_SOURCE_MISSING');
  return f as (options: unknown) => Promise<Port>;
}
function fixture(count = 2) {
  const f = executionRiskFixture(count);
  const inventoryRequest = {
    kind: 'PAPER_PREPARATION_INVENTORY_CAPTURE',
    admission: f.request.admission,
    authorization: f.request.authorization,
  };
  const inventory = structuredClone({
    kind: 'PAPER_PREPARATION_INVENTORY_CAPTURE',
    request: inventoryRequest,
    asOf: wireNow,
    capture: f.packet.capture,
    entries: f.packet.capture.candidates.map((c, i) =>
      i === 0
        ? {
            kind: 'PREPARED',
            intentId: c.intentId,
            key: f.request.preparationKey,
            preparation: f.preparation,
          }
        : { kind: 'MISSING', intentId: c.intentId },
    ),
  });
  fake.risk = f.packet;
  fake.inventory = inventory;
  return { ...f, inventory };
}
const io = () => ({ signal: new AbortController().signal, deadline: wireNow + 2000 });
const open = () =>
  factory()({
    connectionString: 'postgresql://fixture:private@127.0.0.1/paper',
    environment: 'test',
  });
beforeEach(() => {
  factory();
  vi.spyOn(Date, 'now').mockReturnValue(wireNow);
  fake.queries = [];
  fake.clients = 0;
  fake.duplicate = 0;
  fake.failedQuery = 0;
  fake.calls = 0;
  fake.afterInventory = null;
  fake.afterCommit = null;
  fake.commitError = false;
});
afterEach(() => vi.restoreAllMocks());
async function rejected(f: ReturnType<typeof fixture>, error = /PAPER_ADMISSION_/u) {
  const p = await open();
  fake.queries = [];
  try {
    await expect(p.read(f.request, io())).rejects.toThrow(error);
  } finally {
    await p.close();
  }
  expect(
    fake.queries.some((q) => q.text.startsWith('SELECT ctp_paper.evaluate_and_reserve(')),
  ).toBe(false);
}
it.each([1, 2, 300])(
  'joins %i contenders with current Risk under one transaction without implicit START',
  async (count) => {
    const f = fixture(count),
      before = canonical({ risk: f.packet, inventory: f.inventory }),
      p = await open();
    fake.queries = [];
    try {
      const v = await p.read(f.request, io());
      expect(v.kind).toBe('PAPER_EXECUTION_CONTEXT_SOURCE');
      expect(v.risk.evaluation.kind).toBe('EVALUATED');
      expect(v.risk.source.candidates).toHaveLength(count);
      expect(v.inventory.entries).toEqual(f.inventory.entries);
      expect(v.risk.retained.budget.orders).toEqual({ current: count - 1, projected: count });
      const queries = fake.queries.filter((q) => q.text.includes(' AS result'));
      expect(queries).toHaveLength(2);
      expect(queries.map((q) => JSON.parse(q.values[0] as string).kind)).toEqual([
        'PAPER_EXECUTION_RISK_CAPTURE',
        'PAPER_PREPARATION_INVENTORY_CAPTURE',
      ]);
      expect(new Set(fake.queries.map((q) => q.client)).size).toBe(1);
      expect(fake.queries.filter((q) => q.text.startsWith('BEGIN'))).toHaveLength(1);
      expect(fake.queries.filter((q) => q.text === 'COMMIT')).toHaveLength(1);
      for (const key of [
        'permit',
        'grant',
        'startedAt',
        'submittedAt',
        'fills',
        'allocation',
        'postings',
      ])
        expect(v).not.toHaveProperty(key);
      expect(Object.isFrozen(v)).toBe(true);
      expect(Object.isFrozen(v.inventory.entries)).toBe(true);
      expect(canonical({ risk: f.packet, inventory: f.inventory })).toBe(before);
      expect((await p.read(f.request, io())).hash).toBe(v.hash);
    } finally {
      await p.close();
    }
  },
);
it('does not export the server coordinator or wire decoders through calculation/runtime entrypoints', () => {
  expect(pure).not.toHaveProperty('createPostgresPaperExecutionContextSource');
  expect(server).not.toHaveProperty('decodePaperPreparationInventory');
});
it('allows later read timestamps while requiring identical stable execution content', async () => {
  const f = fixture(),
    p = await open();
  f.inventory.asOf += 1;
  f.inventory.capture.asOf += 1;
  vi.mocked(Date.now).mockReturnValue(wireNow + 1);
  try {
    const v = await p.read(f.request, io());
    expect(v.asOf).toBe(wireNow + 1);
  } finally {
    await p.close();
  }
});
it('reopens without cached preparation, permission or authority', async () => {
  const f = fixture(),
    a = await open();
  const before = await a.read(f.request, io());
  await a.close();
  const b = await open();
  try {
    expect(await b.read(f.request, io())).toEqual(before);
  } finally {
    await b.close();
  }
  expect(fake.calls).toBe(4);
});
it.each([
  'book',
  'missing-target',
  'wrong-key',
  'original-attempt',
  'time-regression',
  'capture-time-regression',
  'candidate-set',
])('rejects independently shaped but incompatible %s evidence', async (kind) => {
  const f = fixture();
  if (kind === 'book') f.inventory.capture.portfolio.revision = '999';
  if (kind === 'missing-target')
    f.inventory.entries[0] = {
      kind: 'MISSING',
      intentId: f.request.admission.intentId,
    } as (typeof f.inventory.entries)[number];
  if (kind === 'wrong-key') f.inventory.entries[0]!.key = 'other-real-key';
  if (kind === 'original-attempt') {
    const a = f.inventory.entries[0]!.preparation!;
    f.inventory.entries[0]!.preparation = pure.preparePaperExecutionAttempt({
      ...a.request,
      attemptId: '99999999-0000-4000-8000-000000000001',
    });
  }
  if (kind === 'time-regression') f.inventory.asOf -= 1;
  if (kind === 'capture-time-regression') f.inventory.capture.asOf -= 1;
  if (kind === 'candidate-set') {
    const other = fixture(3);
    fake.risk = f.packet;
    fake.inventory = other.inventory;
  }
  await rejected(f);
});
it.each([1, 2])('rejects duplicate RPC row at stage %i before COMMIT', async (stage) => {
  const f = fixture();
  fake.duplicate = stage;
  await rejected(f);
  expect(fake.queries.some((q) => q.text === 'COMMIT')).toBe(false);
});
it.each([1, 2])(
  'does not retry failed readonly stage %i or publish partial evidence',
  async (stage) => {
    const f = fixture();
    fake.failedQuery = stage;
    await rejected(f);
    expect(fake.calls).toBe(stage);
    expect(fake.queries.some((q) => q.text === 'COMMIT')).toBe(false);
  },
);
it('returns no evidence on uncertain COMMIT; explicit readonly recapture succeeds without writes', async () => {
  const f = fixture(),
    p = await open();
  fake.commitError = true;
  try {
    await expect(p.read(f.request, io())).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
    expect(fake.calls).toBe(2);
    fake.commitError = false;
    expect((await p.read(f.request, io())).kind).toBe('PAPER_EXECUTION_CONTEXT_SOURCE');
    expect(fake.calls).toBe(4);
  } finally {
    await p.close();
  }
});
it.each(['abort', 'deadline', 'freshness'])('checks %s after committed delivery', async (kind) => {
  const f = fixture(),
    p = await open(),
    control = new AbortController(),
    context = { signal: control.signal, deadline: wireNow + 1000 };
  fake.afterCommit = () => {
    if (kind === 'abort') control.abort();
    else
      vi.mocked(Date.now).mockReturnValue(
        kind === 'deadline' ? context.deadline : f.packet.capture.validUntil,
      );
  };
  if (kind === 'freshness') context.deadline = f.packet.capture.validUntil + 10000;
  try {
    await expect(p.read(f.request, context)).rejects.toThrow(
      /PAPER_ADMISSION_(UNCERTAIN|EXPIRED|ABORTED)/u,
    );
  } finally {
    await p.close();
  }
});
it('revalidates earlier Risk at the second-stage time before committing', async () => {
  const f = fixture();
  fake.afterInventory = () => vi.mocked(Date.now).mockReturnValue(f.packet.reservation.expiresAt);
  await rejected(f, /PAPER_ADMISSION_(EXPIRED|ABORTED)/u);
  expect(fake.queries.some((q) => q.text === 'COMMIT')).toBe(false);
});
it.each(['authorization', 'pause', 'rules', 'unknown'])(
  'does not weaken current %s rejection',
  async (kind) => {
    const f = fixture();
    if (kind === 'authorization') f.packet.runtime.current.permissionEpoch = '999';
    if (kind === 'pause') {
      f.controls.activePauses.push('99999999-0000-4000-8000-000000000001');
      f.seal();
    }
    if (kind === 'rules') f.packet.capture.market.record.rules.expiresAt = wireNow;
    if (kind === 'unknown') f.packet.reservation.status = 'UNKNOWN';
    await rejected(f);
    expect(fake.calls).toBe(1);
  },
);
it('rejects request callbacks and foreign authority before SQL', async () => {
  const f = fixture(),
    p = await open();
  fake.queries = [];
  try {
    await expect(p.read({ ...f.request, permit: () => true }, io())).rejects.toThrow(
      'PAPER_ADMISSION_INPUT',
    );
    expect(fake.queries).toHaveLength(0);
  } finally {
    await p.close();
  }
});
