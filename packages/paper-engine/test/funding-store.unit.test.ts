import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { createPostgresPaperFunding } from '../src/postgres-funding.js';
import { paperFundingSchema } from '../src/funding-domain.js';
interface WireState {
  safe: boolean;
  commitFailure: boolean;
  corruptHash: boolean;
  wrongOwner: boolean;
  wrongModel: boolean;
  fail: string;
  abortAtCommit: AbortController | null;
  calls: string[];
  request: unknown;
}
const wire = vi.hoisted((): WireState => ({
  safe: true,
  commitFailure: false,
  corruptHash: false,
  wrongOwner: false,
  wrongModel: false,
  fail: '',
  abortAtCommit: null,
  calls: [],
  request: null,
}));
vi.mock('pg', () => ({
  Client: class {
    on() {}
    async connect() {}
    async end() {}
    async query(sql: string, args?: unknown[]) {
      await Promise.resolve();
      wire.calls.push(sql);
      if (sql.includes(' AS safe')) return { rows: [{ safe: wire.safe }] };
      if (sql === 'COMMIT') {
        wire.abortAtCommit?.abort();
        if (wire.commitFailure) throw new Error('connection-secret-loss');
      }
      if (sql.includes('initialize_funding(') || sql.includes('read_funding(')) {
        if (wire.fail) throw new Error(wire.fail);
        if (sql.includes('initialize_funding(')) wire.request = JSON.parse(args?.[0] as string);
        const c = structuredClone(wire.request) as ReturnType<typeof funding>;
        if (wire.wrongOwner) c.owner.accountId = '55555555-5555-4555-8555-555555555555';
        if (wire.wrongModel)
          c.balances[0]!.amount = paperFundingSchema.parse({
            ...c,
            balances: [{ asset: 'USDT', amount: '2000' }],
          }).balances[0]!.amount;
        const receiptText = JSON.stringify({
          funding: c,
          configurationHash: 'b'.repeat(64),
          ledgerTransactionId: c.id,
          accountIdentity: { externalAccountId: 'paper-account', clientIdEpoch: 'paper-epoch' },
          createdAt: Date.now(),
        });
        return {
          rows: [
            {
              result: {
                receiptText,
                hash: wire.corruptHash
                  ? 'a'.repeat(64)
                  : createHash('sha256').update(receiptText).digest('hex'),
              },
            },
          ],
        };
      }
      return { rows: [] };
    }
  },
}));
const options = {
  connectionString: 'postgresql://paper:fixture@127.0.0.1/test',
  environment: 'test' as const,
};
const io = (signal = new AbortController().signal) => ({ signal, deadline: Date.now() + 2500 });
function funding() {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    configurationId: '33333333-3333-4333-8333-333333333333',
    owner: {
      tenantId: '11111111-1111-4111-8111-111111111111',
      accountId: '22222222-2222-4222-8222-222222222222',
      mode: 'PAPER' as const,
    },
    balances: [
      {
        asset: 'USDT',
        amount: '1000' as ReturnType<typeof paperFundingSchema.parse>['balances'][number]['amount'],
      },
    ],
  };
}
beforeEach(() => {
  wire.safe = true;
  wire.commitFailure = false;
  wire.corruptHash = false;
  wire.wrongOwner = false;
  wire.wrongModel = false;
  wire.fail = '';
  wire.abortAtCommit = null;
  wire.calls = [];
  wire.request = funding();
});
it('commits before returning immutable funding without Risk or transport grants', async () => {
  const store = await createPostgresPaperFunding(options);
  wire.calls = [];
  try {
    const r = await store.initialize(funding(), io());
    expect(r.funding).toEqual(funding());
    expect(Object.isFrozen(r.funding.balances)).toBe(true);
    expect(wire.calls.at(-1)).toBe('COMMIT');
    expect(wire.calls.filter((c) => /^(INSERT|UPDATE)|ledger|persist\(/iu.test(c))).toEqual([]);
  } finally {
    await store.close();
  }
});
it('returns no receipt after uncertain COMMIT and does not retry', async () => {
  const store = await createPostgresPaperFunding(options);
  wire.calls = [];
  wire.commitFailure = true;
  try {
    await expect(store.initialize(funding(), io())).rejects.toThrow('PAPER_FUNDING_UNCERTAIN');
    expect(wire.calls.filter((c) => c.includes('initialize_funding('))).toHaveLength(1);
  } finally {
    await store.close();
  }
});
it('abort at COMMIT returns uncertain instead of authority', async () => {
  const store = await createPostgresPaperFunding(options),
    controller = new AbortController();
  wire.abortAtCommit = controller;
  try {
    await expect(store.initialize(funding(), io(controller.signal))).rejects.toThrow(
      'PAPER_FUNDING_UNCERTAIN',
    );
  } finally {
    await store.close();
  }
});
it.each(['corruptHash', 'wrongOwner', 'wrongModel'] as const)(
  'rejects corrupt receipt %s before COMMIT',
  async (key) => {
    const store = await createPostgresPaperFunding(options);
    wire[key] = true;
    wire.calls = [];
    try {
      await expect(store.initialize(funding(), io())).rejects.toThrow(/PAPER_FUNDING_/u);
      expect(wire.calls).not.toContain('COMMIT');
    } finally {
      await store.close();
    }
  },
);
it('read binds receipt to requested tenant/account', async () => {
  const store = await createPostgresPaperFunding(options);
  wire.wrongOwner = true;
  try {
    await expect(store.read(funding().owner, io())).rejects.toThrow('PAPER_FUNDING_CORRUPT');
  } finally {
    await store.close();
  }
});
it.each(['CONFLICT', 'OWNERSHIP', 'MISSING', 'INPUT', 'ROLE_UNSAFE'])(
  'preserves fail-closed %s',
  async (code) => {
    const store = await createPostgresPaperFunding(options);
    wire.fail = `PAPER_FUNDING_${code}`;
    try {
      await expect(store.initialize(funding(), io())).rejects.toThrow(wire.fail);
    } finally {
      await store.close();
    }
  },
);
it('sanitizes driver errors and rejects unsafe grouping role startup', async () => {
  wire.safe = false;
  await expect(createPostgresPaperFunding(options)).rejects.toThrow('PAPER_FUNDING_ROLE_UNSAFE');
  wire.safe = true;
  const store = await createPostgresPaperFunding(options);
  wire.fail = 'password=secret SQL-body';
  try {
    await expect(store.initialize(funding(), io())).rejects.toThrow('PAPER_FUNDING_STORE_FAILED');
  } finally {
    await store.close();
  }
});
it('pre-aborted, expired and closed requests never dispatch SQL', async () => {
  const store = await createPostgresPaperFunding(options);
  wire.calls = [];
  const controller = new AbortController();
  controller.abort();
  await expect(store.read(funding().owner, io(controller.signal))).rejects.toThrow(
    'PAPER_FUNDING_ABORTED',
  );
  await expect(store.read(funding().owner, { ...io(), deadline: Date.now() - 1 })).rejects.toThrow(
    'PAPER_FUNDING_ABORTED',
  );
  await store.close();
  await store.close();
  await expect(store.read(funding().owner, io())).rejects.toThrow('PAPER_FUNDING_CLOSED');
  expect(wire.calls).toEqual([]);
});
it('malformed internal IO is rejected before slot allocation or any SQL', async () => {
  const store = await createPostgresPaperFunding(options);
  wire.calls = [];
  try {
    for (let i = 0; i < 8; i++)
      await expect(
        store.read(funding().owner, { signal: {} as AbortSignal, deadline: Date.now() + 2500 }),
      ).rejects.toThrow('PAPER_FUNDING_INPUT');
    expect(wire.calls).toEqual([]);
    expect((await store.initialize(funding(), io())).funding).toEqual(funding());
  } finally {
    await store.close();
  }
});
it.each([
  'https://example.invalid',
  'postgresql://paper:fixture@remote.invalid/test',
  'postgresql://paper@127.0.0.1/test',
  'postgresql://paper:fixture@127.0.0.1/test?sslmode=disable&sslmode=verify-full',
])('rejects unsafe test URL %#', async (connectionString) => {
  await expect(createPostgresPaperFunding({ ...options, connectionString })).rejects.toThrow(
    'PAPER_FUNDING_DATABASE_URL',
  );
});
it.each(['staging', 'production'] as const)('requires verify-full in %s', async (environment) => {
  await expect(createPostgresPaperFunding({ ...options, environment })).rejects.toThrow(
    'PAPER_FUNDING_DATABASE_URL',
  );
});
