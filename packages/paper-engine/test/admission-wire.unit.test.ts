import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonical, reducePortfolio, type PortfolioState } from '@ctp/portfolio';
import { evaluateRiskPolicy } from '@ctp/risk-engine';
import { admissionWire, wireHash, wireNow } from './admission-wire-fixtures.js';
const fake = vi.hoisted<{
  payload: unknown;
  duplicateRow?: boolean;
  queries: { text: string; values: unknown[] }[];
}>(() => ({
  payload: null,
  queries: [],
}));
// Fixed wire only. Other suites test real hung sockets and COMMIT failures;
// none of these fixtures is proof of a financial PostgreSQL authority.
vi.mock('pg', () => ({
  Client: class {
    on() {}
    async connect() {}
    query(text: string, values: unknown[] = []) {
      fake.queries.push({ text, values });
      return Promise.resolve({
        rows: text.includes(' AS safe')
          ? [{ safe: true }]
          : text.includes(' AS result')
            ? Array.from({ length: fake.duplicateRow ? 2 : 1 }, () => ({ result: fake.payload }))
            : [],
      });
    }
    async end() {}
  },
}));
import { createPostgresPaperOrderRiskPort } from '../src/postgres-admission.js';
const options = {
  connectionString: 'postgresql://fixture:private@127.0.0.1/paper',
  environment: 'test',
};
const io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2000 });
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(wireNow);
  fake.queries = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  fake.duplicateRow = false;
});

it('verifies the common PAPER policy, full vector and hold transition before COMMIT', async () => {
  const f = admissionWire();
  expect(evaluateRiskPolicy(f.packet.policy)).toMatchObject({ kind: 'EVALUATED' });
  fake.payload = f.packet;
  const port = await createPostgresPaperOrderRiskPort(options);
  fake.queries = [];
  try {
    expect(await port.approve(f.request, io())).toEqual(f.packet.receipt);
    expect(fake.queries.filter((q) => q.text.includes(' AS result'))).toEqual([
      {
        text: 'SELECT ctp_paper.evaluate_and_reserve($1::jsonb) AS result',
        values: [canonical(f.expected)],
      },
    ]);
    expect(fake.queries.at(-1)?.text).toBe('COMMIT');
    expect(fake.queries.some((q) => q.text === 'ROLLBACK')).toBe(false);
  } finally {
    await port.close();
  }
});

function reseal(f: ReturnType<typeof admissionWire>) {
  let after: PortfolioState = f.packet.portfolio.before;
  for (const event of f.packet.portfolio.events)
    after = reducePortfolio(after, event, { now: () => wireNow, holdWatermark: null }).state;
  f.packet.portfolio.afterText = canonical(after);
  f.packet.portfolio.afterHash = wireHash(after);
}
it.each([
  [
    'cash balance disagrees with the budget',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.portfolio.before.balances[0]!.available = '1';
      reseal(f);
    },
  ],
  [
    'hidden Portfolio hold',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.portfolio.before.holds.push({
        id: 'unaccounted',
        asset: 'USDT',
        amount: '999',
        status: 'UNKNOWN',
        reflected: false,
      });
      reseal(f);
    },
  ],
  [
    'unreconciled Portfolio book',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.portfolio.before.status = 'GAP';
      reseal(f);
    },
  ],
  [
    'pending Portfolio economic evidence',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.portfolio.before.pending.push('missing-fill');
      reseal(f);
    },
  ],
  [
    'expiry renews an older policy source timestamp',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.policy.snapshot.sourceAt = wireNow - 4999;
      f.packet.policy.snapshot.positionEvidence.asOf = wireNow - 4999;
    },
  ],
  [
    'expiry renews an older market timestamp',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.policy.snapshot.market.asOf = wireNow - 4999;
    },
  ],
  [
    'expiry renews earlier capability expiry',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.policy.capabilities.forEach((c) => {
        c.expiresAt = wireNow + 10;
      });
    },
  ],
] as const)(
  'rolls back %s, even with a coherently rehashed resulting book',
  async (_name, change) => {
    const f = admissionWire();
    change(f);
    fake.payload = f.packet;
    const port = await createPostgresPaperOrderRiskPort(options);
    fake.queries = [];
    try {
      await expect(port.approve(f.request, io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
      expect(fake.queries.at(-1)?.text).toBe('ROLLBACK');
      expect(fake.queries.some((q) => q.text === 'COMMIT')).toBe(false);
    } finally {
      await port.close();
    }
  },
);

it.each([
  [
    'different decision scope',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.request.orderId = '00000000-0000-4000-8000-000000000999';
    },
  ],
  [
    'different intent scope',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.request.intentId = '00000000-0000-4000-8000-000000000999';
    },
  ],
  [
    'different original command',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.policy.order.clientOrderId = 'replaced';
    },
  ],
  [
    'different debit amount',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.debits[0]!.amount = '1';
    },
  ],
  [
    'different debit asset',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.debits[0]!.asset = 'BTC';
    },
  ],
  [
    'duplicate debit legs',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.debits.push({ ...f.packet.debits[0]! });
    },
  ],
  [
    'different hold amount',
    (f: ReturnType<typeof admissionWire>) => {
      const e = f.packet.portfolio.events[0]!;
      if (e.type === 'COMMITMENT') e.hold.amount = '1';
      reseal(f);
    },
  ],
  [
    'reflected initial hold',
    (f: ReturnType<typeof admissionWire>) => {
      const e = f.packet.portfolio.events[0]!;
      if (e.type === 'COMMITMENT') e.hold.reflected = true;
      reseal(f);
    },
  ],
  [
    'pending initial hold',
    (f: ReturnType<typeof admissionWire>) => {
      const e = f.packet.portfolio.events[0]!;
      if (e.type === 'COMMITMENT') e.hold.status = 'PENDING';
      reseal(f);
    },
  ],
  [
    'wrong Portfolio account',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.portfolio.before.binding.accountId = '00000000-0000-4000-8000-000000000999';
      reseal(f);
    },
  ],
  [
    'wrong Portfolio wallet',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.portfolio.before.binding.walletId = 'other-wallet';
      reseal(f);
    },
  ],
  [
    'unsafe rounded book revision',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.portfolio.revision = '9007199254740992';
    },
  ],
  [
    'inexact permission epoch',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.permissionEpoch = '9007199254740992';
    },
  ],
  [
    'source ID outside certificate',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.policy.snapshot.sourceId = 'caller-json';
    },
  ],
  [
    'certificate revision disagreement',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.certificate.revision = '2';
    },
  ],
  [
    'expired receipt',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.receipt.expiresAt = wireNow;
    },
  ],
  [
    'receipt outlives certificate',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.receipt.expiresAt++;
    },
  ],
  [
    'prior UTC day',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.loss.utcDayStart -= 86400000;
    },
  ],
  [
    'guessed UTC opening',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.loss.openingEquity = '101';
    },
  ],
  [
    'unproven loss baseline',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.policy.snapshot.lossBaselineComplete = false;
    },
  ],
  [
    'UNKNOWN flag',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.policy.snapshot.unknownExposure = true;
    },
  ],
  [
    'GLOBAL pause',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.policy.snapshot.pauses.global = true;
    },
  ],
  [
    'unhealthy executor',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.policy.snapshot.health.privateStream = 'UNKNOWN';
    },
  ],
  [
    'open circuit',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.policy.snapshot.circuit = 'OPEN';
    },
  ],
  [
    'missing synthetic capability',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.policy.capabilities = [];
    },
  ],
  [
    'native capability substituted',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.policy.capabilities.forEach((c) => {
        c.implementation = 'NATIVE';
      });
    },
  ],
  [
    'stale rules',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.policy.record.rules.expiresAt = wireNow;
    },
  ],
  [
    'stale market',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.policy.snapshot.market.asOf = wireNow - 6000;
    },
  ],
  [
    'new tighter policy',
    (f: ReturnType<typeof admissionWire>) => {
      f.packet.policy.platform.maxUserExposure = '1';
      f.packet.budget.platform.maxUserExposure = '1';
    },
  ],
] as const)('rejects %s with no COMMIT or secret payload disclosure', async (_name, change) => {
  const f = admissionWire();
  change(f);
  fake.payload = f.packet;
  const port = await createPostgresPaperOrderRiskPort(options);
  fake.queries = [];
  try {
    await expect(port.approve(f.request, io())).rejects.toThrow(
      /^PAPER_ADMISSION_(EVIDENCE|CONFLICT|EXPIRED|LIMIT)$/u,
    );
    expect(fake.queries.at(-1)?.text).toBe('ROLLBACK');
    expect(fake.queries.some((q) => q.text === 'COMMIT')).toBe(false);
  } finally {
    await port.close();
  }
});

it('exact durable replay does not re-admit against replacement metadata or create another reservation', async () => {
  const f = admissionWire();
  fake.payload = { kind: 'REPLAY', request: f.expected, receipt: f.packet.receipt };
  const port = await createPostgresPaperOrderRiskPort(options);
  fake.queries = [];
  try {
    expect(await port.approve(f.request, io())).toEqual(f.packet.receipt);
    expect(fake.queries.filter((q) => q.text.includes(' AS result'))).toHaveLength(1);
    expect(fake.queries.at(-1)?.text).toBe('COMMIT');
  } finally {
    await port.close();
  }
});
it('expired permanent replay is historical evidence, not a renewed usable Risk grant', async () => {
  const f = admissionWire();
  f.packet.receipt.expiresAt = wireNow;
  fake.payload = { kind: 'REPLAY', request: f.expected, receipt: f.packet.receipt };
  const port = await createPostgresPaperOrderRiskPort(options);
  fake.queries = [];
  try {
    await expect(port.approve(f.request, io())).rejects.toThrow('PAPER_ADMISSION_EXPIRED');
    expect(fake.queries.at(-1)?.text).toBe('ROLLBACK');
    fake.payload = { kind: 'COMMITTED', request: f.expected, receipt: f.packet.receipt };
    fake.queries = [];
    expect(await port.reconcileApproval(f.request, io())).toMatchObject({
      kind: 'COMMITTED',
      receipt: f.packet.receipt,
    });
    expect(fake.queries.filter((q) => q.text.includes(' AS result'))).toEqual([
      {
        text: 'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
        values: [canonical(f.expected)],
      },
    ]);
  } finally {
    await port.close();
  }
});
it('MISSING reconciliation cannot call reserve, refresh a receipt or authorize release', async () => {
  const f = admissionWire();
  fake.payload = { kind: 'MISSING', request: f.expected };
  const port = await createPostgresPaperOrderRiskPort(options);
  fake.queries = [];
  try {
    expect(await port.reconcileApproval(f.request, io())).toEqual(fake.payload);
    expect(fake.queries.some((q) => q.text.includes('evaluate_and_reserve'))).toBe(false);
  } finally {
    await port.close();
  }
});

it('cannot let a certificate outlive its UTC loss interval across midnight', async () => {
  const now = 3 * 86400000 - 100;
  vi.mocked(Date.now).mockReturnValue(now);
  const f = admissionWire(now);
  fake.payload = f.packet;
  const port = await createPostgresPaperOrderRiskPort(options);
  fake.queries = [];
  try {
    await expect(port.approve(f.request, io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
    expect(fake.queries.at(-1)?.text).toBe('ROLLBACK');
  } finally {
    await port.close();
  }
});

it.each(['approve', 'reconcileApproval'] as const)(
  'rejects multiple contradictory SQL result rows in %s',
  async (method) => {
    const f = admissionWire();
    fake.payload =
      method === 'approve'
        ? { kind: 'REPLAY', request: f.expected, receipt: f.packet.receipt }
        : { kind: 'MISSING', request: f.expected };
    const port = await createPostgresPaperOrderRiskPort(options);
    fake.duplicateRow = true;
    fake.queries = [];
    try {
      await expect(port[method](f.request, io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
      expect(fake.queries.at(-1)?.text).toBe('ROLLBACK');
    } finally {
      await port.close();
    }
  },
);
