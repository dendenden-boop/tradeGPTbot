import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as server from '../src/risk.js';
import * as pure from '../src/index.js';
import { canonical } from '@ctp/portfolio';
import { wireNow } from './admission-wire-fixtures.js';
import { executionRiskFixture } from './execution-risk-fixtures.js';
const fake = vi.hoisted(() => ({
  payload: null as unknown,
  queries: [] as { text: string; values: readonly unknown[] }[],
  duplicate: false,
  commitError: false,
  afterCommit: null as null | (() => void),
}));
vi.mock('pg', () => ({
  Client: class {
    on() {}
    async connect() {}
    async end() {}
    query(text: string, values: readonly unknown[] = []) {
      fake.queries.push({ text, values });
      if (text.includes(' AS safe')) return Promise.resolve({ rows: [{ safe: true }] });
      if (text.includes(' AS result'))
        return Promise.resolve({
          rows: Array.from({ length: fake.duplicate ? 2 : 1 }, () => ({ result: fake.payload })),
        });
      if (text === 'COMMIT') {
        fake.afterCommit?.();
        if (fake.commitError) return Promise.reject(Error('private commit loss'));
      }
      return Promise.resolve({ rows: [] });
    }
  },
}));
interface View {
  kind: string;
  hash: string;
  asOf: number;
  validUntil: number;
  preparation: ReturnType<typeof pure.preparePaperExecutionAttempt>;
  evaluation: { kind: string; notional: string };
  retained: ReturnType<typeof pure.calculatePaperRetainedRiskBudget>;
  policies: { platform: { version: string }; user: { version: string } };
  source: { candidates: unknown[] };
}
interface Port {
  read(request: unknown, io: { signal: AbortSignal; deadline: number }): Promise<View>;
  close(): Promise<void>;
}
function factory() {
  const f = (server as unknown as Record<string, unknown>)[
    'createPostgresPaperExecutionRiskSource'
  ];
  if (typeof f !== 'function') throw Error('PAPER_EXECUTION_RISK_SOURCE_MISSING');
  return f as (options: unknown) => Promise<Port>;
}
const open = () =>
  factory()({
    connectionString: 'postgresql://fixture:private@127.0.0.1/paper',
    environment: 'test',
  });
const io = () => ({ signal: new AbortController().signal, deadline: wireNow + 2000 });
beforeEach(() => {
  factory();
  vi.spyOn(Date, 'now').mockReturnValue(wireNow);
  fake.queries = [];
  fake.duplicate = false;
  fake.commitError = false;
  fake.afterCommit = null;
});
afterEach(() => vi.restoreAllMocks());
async function rejected(f: ReturnType<typeof executionRiskFixture>, code = /PAPER_ADMISSION_/u) {
  fake.payload = f.packet;
  const p = await open();
  try {
    await expect(p.read(f.request, io())).rejects.toThrow(code);
    expect(fake.queries.some((q) => q.text.includes('evaluate_and_reserve'))).toBe(false);
  } finally {
    await p.close();
  }
}
it('captures current authority and complete retained inventory in one fixed readonly transaction, without a second reserve', async () => {
  const f = executionRiskFixture(),
    before = canonical(f.packet);
  fake.payload = f.packet;
  const p = await open();
  fake.queries = [];
  try {
    const v = await p.read(f.request, io());
    expect(v.kind).toBe('PAPER_EXECUTION_RISK_SOURCE');
    expect(v.preparation).toEqual(f.preparation);
    expect(v.evaluation.kind).toBe('EVALUATED');
    expect(v.retained.reservationId).toBe(f.packet.reservation.id);
    expect(v.retained.budget.orders).toEqual({ current: 0, projected: 1 });
    expect(v.validUntil).toBe(f.preparation.request.admission.expiresAt);
    expect(v.policies.platform.version).toBe('9007199254740993');
    expect(v.policies.user.version).toBe('9007199254740994');
    expect(canonical(f.packet)).toBe(before);
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.retained.retained)).toBe(true);
    const reads = fake.queries.filter((q) => q.text.includes(' AS result'));
    expect(reads).toEqual([
      {
        text: 'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
        values: [canonical(f.request)],
      },
    ]);
    expect(fake.queries.filter((q) => q.text.startsWith('BEGIN'))).toHaveLength(1);
    expect(fake.queries.at(-1)?.text).toBe('COMMIT');
    for (const key of [
      'grant',
      'permit',
      'certificate',
      'startedAt',
      'submittedAt',
      'fills',
      'allocation',
      'postings',
    ])
      expect(v).not.toHaveProperty(key);
    expect(pure).not.toHaveProperty('createPostgresPaperExecutionRiskSource');
  } finally {
    await p.close();
  }
});
it('retains complete300-candidate FIFO and all other liabilities exactly once', async () => {
  const f = executionRiskFixture(300);
  fake.payload = f.packet;
  const p = await open();
  try {
    const v = await p.read(f.request, io());
    expect(v.source.candidates).toHaveLength(300);
    expect(v.retained.budget.orders).toEqual({ current: 299, projected: 300 });
    expect(v.preparation.request.admission.admissionSequence).toBe('9007199254740993');
  } finally {
    await p.close();
  }
});
it('accepts exact current limits without double-counting the retained target', async () => {
  const f = executionRiskFixture(),
    n = f.packet.evidence.reservations[0]!.notional;
  for (const p of f.packet.policies) {
    p.limits.maxOrderNotional =
      p.limits.maxInstrumentExposure =
      p.limits.maxAssetExposure =
      p.limits.maxAccountExposure =
      p.limits.maxUserExposure =
        n;
    p.limits.maxOpenOrders = p.limits.maxConcurrentPositions = 1;
  }
  f.seal();
  fake.payload = f.packet;
  const p = await open();
  try {
    expect((await p.read(f.request, io())).evaluation.kind).toBe('EVALUATED');
  } finally {
    await p.close();
  }
});
it('reopen reads original durable preparation and current policy rather than renewing identities', async () => {
  const f = executionRiskFixture();
  fake.payload = f.packet;
  const p = await open();
  const first = await p.read(f.request, io());
  await p.close();
  f.packet.policies[0]!.version = '9007199254740995';
  f.seal();
  const next = await open();
  try {
    const v = await next.read(f.request, io());
    expect(v.preparation).toEqual(first.preparation);
    expect(v.hash).not.toBe(first.hash);
    expect(v.policies.platform.version).toBe('9007199254740995');
  } finally {
    await next.close();
  }
});
it.each(['global', 'user'] as const)(
  'rejects current %s pause even after original approval',
  async (kind) => {
    const f = executionRiskFixture();
    if (kind === 'global') f.controls.global[0]!.state = 'PAUSED';
    else
      f.controls.tenant.push({
        scope: {
          kind: 'USER',
          tenantId: f.request.admission.binding.tenantId,
          targetId: f.request.admission.binding.tenantId,
        },
        kind: 'KILL_SWITCH',
        key: 'kill',
        state: 'PAUSED',
        epoch: '2',
      });
    f.seal();
    await rejected(f);
  },
);
it.each(['OPEN', 'HALF_OPEN'])('rejects a current %s circuit', async (state) => {
  const f = executionRiskFixture();
  f.controls.circuits.push({ id: '99999999-9999-4999-8999-999999999999', state });
  f.seal();
  await rejected(f);
});
it.each(['FAILED', 'UNKNOWN'] as const)(
  'rejects %s current health without healthy fallback',
  async (status) => {
    const f = executionRiskFixture();
    f.publication.observation.health.executor.status = status;
    f.seal();
    await rejected(f);
  },
);
it.each([
  'maxOrderNotional',
  'maxInstrumentExposure',
  'maxAssetExposure',
  'maxAccountExposure',
  'maxUserExposure',
] as const)('re-evaluates tightened %s', async (limit) => {
  const f = executionRiskFixture();
  f.packet.policies[0]!.limits[limit] = '0';
  f.seal();
  await rejected(f);
});
it('re-evaluates current rate rather than granting a second submission', async () => {
  const f = executionRiskFixture();
  f.packet.ordersInLastMinuteExcludingTarget = 2;
  for (const p of f.packet.policies) p.limits.maxOrdersPerMinute = 2;
  f.seal();
  await rejected(f);
});
const bad: [string, (f: ReturnType<typeof executionRiskFixture>) => void][] = [
  [
    'missing source target',
    (f) => {
      f.packet.capture.candidates = [];
    },
  ],
  [
    'mismatched current command',
    (f) => {
      f.packet.market.order = { ...f.packet.market.order, clientOrderId: 'wrong' };
    },
  ],
  [
    'mismatched DB rule',
    (f) => {
      f.packet.market.dbRuleId = '99999999-9999-4999-8999-999999999999';
    },
  ],
  [
    'mismatched snapshot head',
    (f) => {
      f.packet.market.snapshotId = '99999999-9999-4999-8999-999999999999';
    },
  ],
  [
    'mismatched trade head',
    (f) => {
      f.packet.market.tradeRevision = '99';
    },
  ],
  [
    'wrong reservation',
    (f) => {
      f.packet.reservation.id = '99999999-9999-4999-8999-999999999999';
    },
  ],
  [
    'renewed expiry',
    (f) => {
      f.packet.reservation.expiresAt++;
    },
  ],
  [
    'missing original preparation',
    (f) => {
      f.packet.journal.kind = 'MISSING';
    },
  ],
  [
    'stale current health',
    (f) => {
      f.publication.observation.health.executor.asOf = wireNow - 5001;
      f.seal();
    },
  ],
  [
    'future current health',
    (f) => {
      f.publication.observation.health.executor.asOf = wireNow + 1;
      f.seal();
    },
  ],
  [
    'stale current ticker',
    (f) => {
      f.packet.market.ticker.receivedAt = wireNow - 5001;
    },
  ],
  [
    'future current ticker',
    (f) => {
      f.packet.market.ticker.exchangeTime = wireNow + 1;
    },
  ],
  [
    'policy content conflict',
    (f) => {
      f.packet.policies[0]!.limitsHash = 'a'.repeat(64);
    },
  ],
  [
    'foreign policy tenant',
    (f) => {
      f.packet.policies[1]!.scope = {
        kind: 'USER',
        tenantId: '99999999-9999-4999-8999-999999999999',
      };
    },
  ],
  [
    'missing global controller',
    (f) => {
      f.controls.global = [];
      f.seal();
    },
  ],
  [
    'duplicate global controller',
    (f) => {
      f.controls.global.push({ ...f.controls.global[0]! });
      f.seal();
    },
  ],
  [
    'control hash conflict',
    (f) => {
      f.packet.controls.hash = 'a'.repeat(64);
    },
  ],
  [
    'permission epoch replacement',
    (f) => {
      f.packet.runtime.current.permissionEpoch = '1';
    },
  ],
  [
    'session epoch replacement',
    (f) => {
      f.packet.runtime.current.userSessionEpoch = '1';
    },
  ],
  [
    'different model configuration',
    (f) => {
      f.configuration.configuration.id = '99999999-9999-4999-8999-999999999999';
      f.seal();
    },
  ],
  [
    'current account identity changed',
    (f) => {
      f.packet.runtime.current.externalAccountId = 'other-account';
    },
  ],
  [
    'incomplete inventory',
    (f) => {
      f.packet.evidence.complete = false;
    },
  ],
  [
    'missing retained hold',
    (f) => {
      f.packet.evidence.holds = [];
    },
  ],
  [
    'UNKNOWN retained hold',
    (f) => {
      f.packet.evidence.holds[0]!.unknown = true;
    },
  ],
  [
    'UNKNOWN reservation',
    (f) => {
      f.packet.evidence.reservations[0]!.unknown = true;
    },
  ],
  [
    'missing loss proof',
    (f) => {
      f.packet.loss = { ...f.packet.loss, openingEquity: '0' };
    },
  ],
  [
    'different loss UTC day',
    (f) => {
      f.packet.loss.utcDayStart = 0;
    },
  ],
  [
    'loss proof currency mismatch',
    (f) => {
      f.packet.loss.asset = 'BTC';
    },
  ],
  [
    'future capture',
    (f) => {
      f.packet.asOf = wireNow + 1;
    },
  ],
  [
    'source timestamp future',
    (f) => {
      f.packet.capture.asOf = wireNow + 1;
    },
  ],
];
it.each(bad)('fails closed for %s', async (name, mutate) => {
  void name;
  const f = executionRiskFixture();
  mutate(f);
  await rejected(f);
});
it('rejects a stricter current evidence age for every original witness', async () => {
  const f = executionRiskFixture();
  for (const p of f.packet.policies) p.limits.maxEvidenceAgeMs = 5;
  f.packet.capture.maxEvidenceAgeMs = 5;
  f.packet.capture.validUntil = wireNow - 4;
  f.seal();
  await rejected(f);
});
it('never returns current evidence after uncertain read COMMIT', async () => {
  const f = executionRiskFixture();
  fake.commitError = true;
  await rejected(f, /PAPER_ADMISSION_UNCERTAIN/u);
  expect(fake.queries.filter((q) => q.text.includes(' AS result'))).toHaveLength(1);
});
it('never returns evidence expired during COMMIT delivery', async () => {
  const f = executionRiskFixture();
  fake.afterCommit = () =>
    vi.spyOn(Date, 'now').mockReturnValue(f.preparation.request.admission.expiresAt);
  await rejected(f, /PAPER_ADMISSION_EXPIRED/u);
});
it('rejects duplicate SQL result rows', async () => {
  const f = executionRiskFixture();
  fake.duplicate = true;
  await rejected(f);
});
it('bounds301 candidates before touching poisoned elements', async () => {
  const f = executionRiskFixture();
  f.packet.capture.candidates = Array(301).fill(null) as typeof f.packet.capture.candidates;
  Object.defineProperty(f.packet.capture.candidates, 0, {
    get() {
      throw Error('POISON_VISITED');
    },
  });
  await rejected(f);
});
it.each(['grant', 'permit', 'connectionString', 'tenantId', 'callback', 'policies'])(
  'rejects caller-added %s before I/O',
  async (key) => {
    const f = executionRiskFixture();
    fake.payload = f.packet;
    const p = await open();
    fake.queries = [];
    try {
      await expect(p.read({ ...f.request, [key]: true }, io())).rejects.toThrow(
        /PAPER_ADMISSION_INPUT/u,
      );
      expect(fake.queries).toHaveLength(0);
    } finally {
      await p.close();
    }
  },
);
