import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';
import {
  createPostgresPaperConfiguration,
  paperConfigurationSchema,
} from '@ctp/paper-engine/configuration';
import { createPostgresPaperFunding, paperFundingSchema } from '@ctp/paper-engine/funding';
import { createPostgresPaperInitialPortfolio } from '@ctp/paper-engine/portfolio';
import { createPostgresPortfolioStore, restorePortfolio, valuePortfolio } from '@ctp/portfolio';
import { fixture as modelFixture } from '../../paper-engine/test/fixtures.js';
import { registryCommitProxy } from './fixtures/registry-commit-proxy.js';
if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('ISOLATED_PAPER_RUNNER_REQUIRED');
const required = (key: string) => {
  const v = process.env[key];
  if (!v) throw new Error('ISOLATED_PAPER_VARIABLE_REQUIRED');
  return v;
};
const admin = new Pool({
  connectionString: required('DATABASE_MIGRATION_URL'),
  max: 3,
  query_timeout: 5000,
});
const direct = new Pool({
  connectionString: required('DATABASE_PAPER_PORTFOLIO_URL'),
  max: 2,
  query_timeout: 5000,
});
const io = (signal = new AbortController().signal, ms = 2500) => ({
  signal,
  deadline: Date.now() + ms,
});
const handles: { close(): Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
  await direct.end();
  await admin.end();
});
async function open(connectionString = required('DATABASE_PAPER_PORTFOLIO_URL')) {
  const h = await createPostgresPaperInitialPortfolio({ connectionString, environment: 'test' });
  handles.push(h);
  return h;
}
async function fixture(fund = true, mode = 'PAPER') {
  const c = paperConfigurationSchema.parse({
    id: randomUUID(),
    owner: { tenantId: randomUUID(), accountId: randomUUID(), mode: 'PAPER' },
    source: { exchange: 'BINANCE', market: 'SPOT', region: 'global', environment: 'LIVE' },
    valuationAsset: 'USDT',
    model: modelFixture().model,
  });
  await admin.query(
    'INSERT INTO public."user"(id,"emailNormalized",status,"emailVerifiedAt","updatedAt") VALUES($1,$2,\'ACTIVE\',now(),now())',
    [c.owner.tenantId, `${c.owner.tenantId}@example.invalid`],
  );
  await admin.query(
    `INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") VALUES($1,$2,'BINANCE',$3,$4,'global','SIMULATED','ACTIVE','paper-epoch',now())`,
    [c.owner.accountId, c.owner.tenantId, mode, `paper:${c.owner.accountId}`],
  );
  if (mode === 'PAPER') {
    const config = await createPostgresPaperConfiguration({
      connectionString: required('DATABASE_PAPER_CONFIGURATION_URL'),
      environment: 'test',
    });
    try {
      await config.register(c, io());
    } finally {
      await config.close();
    }
  }
  const f = paperFundingSchema.parse({
    id: randomUUID(),
    owner: c.owner,
    configurationId: c.id,
    balances: [
      { asset: 'BTC', amount: '0.000000000000000001' },
      { asset: 'USDT', amount: '9007199254740993' },
    ],
  });
  if (fund && mode === 'PAPER') {
    const funding = await createPostgresPaperFunding({
      connectionString: required('DATABASE_PAPER_FUNDING_URL'),
      environment: 'test',
    });
    try {
      await funding.initialize(f, io());
    } finally {
      await funding.close();
    }
  }
  return f;
}
async function monetary(f: Awaited<ReturnType<typeof fixture>>) {
  return (
    await admin.query<{ asset: string; bucket: string; amount: string; entryIndex: number }>(
      'SELECT asset,bucket,amount::text,"entryIndex" FROM public.ledger_entry WHERE "transactionId"=$1 ORDER BY "entryIndex"',
      [f.id],
    )
  ).rows;
}
it('concurrent capture and restart reuse initial funding in common Portfolio with zero second monetary effects', async () => {
  const f = await fixture(),
    h = await open(),
    before = await monetary(f);
  const [a, b] = await Promise.all([h.read(f.owner, io()), h.read(f.owner, io())]);
  expect(a.funding).toEqual(b.funding);
  expect(a.state.balances).toEqual(b.state.balances);
  expect(restorePortfolio(a.state)).toEqual(a.state);
  expect(a.state.binding.connectionId).toBeNull();
  expect(a.state.balances[1]?.total).toBe('9007199254740993');
  const v = valuePortfolio(
    [a.state],
    [
      {
        asset: 'BTC',
        quote: 'USDT',
        price: '1',
        kind: 'LAST',
        asOf: a.asOf,
        sourceId: 'public-market-evidence',
        fresh: true,
      },
    ],
    { quote: 'USDT', now: a.asOf, reconciledAfterRestart: true },
  );
  expect(v.total).toBe('9007199254740993.000000000000000001');
  await h.close();
  const restarted = await open(),
    s = await restarted.read(f.owner, io());
  expect(s.funding).toEqual(a.funding);
  expect(s.state.balances).toEqual(a.state.balances);
  expect(await monetary(f)).toEqual(before);
  expect(
    (
      await admin.query<{ n: number }>(
        'SELECT count(*)::int n FROM public.ledger_transaction WHERE "accountId"=$1',
        [f.owner.accountId],
      )
    ).rows[0]?.n,
  ).toBe(1);
  for (const table of [
    'ctp_portfolio.book',
    'public.order_intent',
    'public.risk_reservation',
    'public.paper_account',
  ])
    expect(
      (
        await admin.query<{ n: number }>(
          `SELECT count(*)::int n FROM ${table} WHERE "accountId"=$1`,
          [f.owner.accountId],
        )
      ).rows[0]?.n,
    ).toBe(0);
  const native = await createPostgresPortfolioStore({
    connectionString: required('DATABASE_PORTFOLIO_URL'),
    environment: 'test',
  });
  try {
    expect(() => native.read(s.state.binding, io())).toThrow('PORTFOLIO_BINDING_DENIED');
  } finally {
    await native.close();
  }
  expect(
    (
      await admin.query<{ n: number }>(
        'SELECT count(*)::int n FROM ctp_portfolio.book WHERE "accountId"=$1',
        [f.owner.accountId],
      )
    ).rows[0]?.n,
  ).toBe(0);
});
it('current lossless permission/reconciliation epochs and revision are captured without re-funding', async () => {
  const f = await fixture(),
    h = await open();
  await admin.query(
    'UPDATE public.exchange_account SET "permissionEpoch"=9007199254740993,"reconciliationEpoch"=9007199254740994,version=version+1 WHERE id=$1',
    [f.owner.accountId],
  );
  const s = await h.read(f.owner, io());
  expect(s.accountState).toEqual({
    permissionEpoch: '9007199254740993',
    reconciliationEpoch: '9007199254740994',
    version: 1,
  });
  expect(await monetary(f)).toHaveLength(4);
});
it('missing funding and wrong tenant do not export a guessed Portfolio', async () => {
  const f = await fixture(false),
    h = await open();
  await expect(h.read(f.owner, io())).rejects.toThrow('PAPER_PORTFOLIO_MISSING');
  const other = await fixture();
  await expect(h.read({ ...other.owner, tenantId: f.owner.tenantId }, io())).rejects.toThrow(
    'PAPER_PORTFOLIO_MISSING',
  );
  const p = await direct.connect();
  try {
    await p.query('BEGIN');
    await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.owner.tenantId]);
    await expect(
      p.query('SELECT ctp_paper.capture_initial_portfolio($1::jsonb)', [
        JSON.stringify(other.owner),
      ]),
    ).rejects.toMatchObject({ message: 'PAPER_PORTFOLIO_OWNERSHIP' });
  } finally {
    await p.query('ROLLBACK');
    p.release();
  }
});
it.each(['TESTNET', 'DEMO', 'LIVE'])('native %s cannot obtain a PAPER source', async (mode) => {
  const f = await fixture(false, mode),
    h = await open();
  await expect(h.read(f.owner, io())).rejects.toThrow('PAPER_PORTFOLIO_MISSING');
  expect(await monetary(f)).toHaveLength(0);
});
it.each(['status', 'region', 'exchange', 'externalAccountId', 'clientIdEpoch'] as const)(
  'current %s replacement cannot reuse initial source',
  async (key) => {
    const f = await fixture(),
      h = await open();
    const change = {
      status: "status='DISABLED'",
      region: "region='changed'",
      exchange: "exchange='OKX'",
      externalAccountId: '"externalAccountId"=\'changed\'',
      clientIdEpoch: '"clientIdEpoch"=\'changed\'',
    }[key];
    await admin.query(`UPDATE public.exchange_account SET ${change} WHERE id=$1`, [
      f.owner.accountId,
    ]);
    await expect(h.read(f.owner, io())).rejects.toThrow('PAPER_PORTFOLIO_OWNERSHIP');
    expect(await monetary(f)).toHaveLength(4);
  },
);
it.each(['SUSPENDED', 'UNVERIFIED'])('%s tenant cannot export Portfolio source', async (kind) => {
  const f = await fixture(),
    h = await open();
  await admin.query(
    kind === 'SUSPENDED'
      ? 'UPDATE public."user" SET status=\'SUSPENDED\' WHERE id=$1'
      : 'UPDATE public."user" SET "emailVerifiedAt"=NULL WHERE id=$1',
    [f.owner.tenantId],
  );
  await expect(h.read(f.owner, io())).rejects.toThrow('PAPER_PORTFOLIO_OWNERSHIP');
});
it.each(['ledger', 'book', 'UNKNOWN-book', 'legacy-paper'] as const)(
  'later %s activity fails closed rather than exporting stale seed balances',
  async (part) => {
    const f = await fixture(),
      h = await open(),
      s = await h.read(f.owner, io());
    if (part === 'ledger') {
      const id = randomUUID(),
        p = await admin.connect();
      try {
        await p.query('BEGIN');
        await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.owner.tenantId]);
        await p.query(
          'INSERT INTO public.ledger_transaction(id,"tenantId","accountId",mode,cause,"causeIdentity","effectiveAt","descriptionCode") VALUES($1,$2,$3,\'PAPER\',\'PAPER_SEED\',$4,now(),\'PAPER_TEST_EXTRA\')',
          [id, f.owner.tenantId, f.owner.accountId, `test-extra:${id}`],
        );
        await p.query(
          "INSERT INTO public.ledger_entry(\"tenantId\",\"transactionId\",\"accountId\",mode,\"entryIndex\",asset,bucket,amount) VALUES($1,$2,$3,'PAPER',0,'USDT','AVAILABLE',1),($1,$2,$3,'PAPER',1,'USDT','EXTERNAL',-1)",
          [f.owner.tenantId, id, f.owner.accountId],
        );
        await p.query('COMMIT');
      } finally {
        await p.query('ROLLBACK');
        p.release();
      }
    } else if (part === 'book' || part === 'UNKNOWN-book')
      await admin.query(
        'INSERT INTO ctp_portfolio.book("tenantId","accountId",mode,wallet,state,state_hash) VALUES($1,$2,\'PAPER\',$3,$4,sha256(convert_to($4,\'UTF8\')))',
        [
          f.owner.tenantId,
          f.owner.accountId,
          s.state.binding.walletId,
          JSON.stringify(
            part === 'UNKNOWN-book'
              ? {
                  ...s.state,
                  holds: [
                    {
                      id: 'unproven-hold',
                      asset: 'USDT',
                      amount: '100',
                      status: 'UNKNOWN',
                      reflected: false,
                    },
                  ],
                  pending: ['unproven-hold'],
                }
              : s.state,
          ),
        ],
      );
    else
      await admin.query(
        'INSERT INTO public.paper_account(id,"tenantId","accountId",mode,"modelVersion",seed,"valuationAsset","initialCapital","slippageModel","feeModel") VALUES($1,$2,$3,\'PAPER\',\'spot-l2-taker-v1\',1,\'USDT\',1,\'{}\',\'{}\')',
        [randomUUID(), f.owner.tenantId, f.owner.accountId],
      );
    await expect(h.read(f.owner, io())).rejects.toThrow('PAPER_PORTFOLIO_INCOMPLETE');
  },
);
it.each([
  'SELECT * FROM public.ledger_entry LIMIT 0',
  'SELECT * FROM ctp_paper.initial_funding LIMIT 0',
  "SELECT ctp_paper.initialize_funding('{}'::text)",
  "SELECT ctp_paper.read_funding('{}'::jsonb)",
  "SELECT ctp_risk.capture_portfolio('{}'::jsonb)",
])('reader SQL has no inherited financial authority: %s', async (sql) => {
  await expect(direct.query(sql)).rejects.toMatchObject({ code: '42501' });
});
it.each(['DATABASE_PAPER_FUNDING_URL', 'DATABASE_PORTFOLIO_URL'])(
  'reader refuses other purpose %s',
  async (key) => {
    await expect(open(required(key))).rejects.toThrow('PAPER_PORTFOLIO_ROLE_UNSAFE');
  },
);
it('SQL rejects a LOGIN grouping role after startup', async () => {
  const f = await fixture(),
    h = await open();
  await admin.query('ALTER ROLE ctp_paper_portfolio_reader LOGIN');
  try {
    await expect(h.read(f.owner, io())).rejects.toThrow('PAPER_PORTFOLIO_ROLE_UNSAFE');
  } finally {
    await admin.query('ALTER ROLE ctp_paper_portfolio_reader NOLOGIN');
  }
});
it('SQL rejects newly granted funding function authority after startup', async () => {
  const f = await fixture(),
    h = await open();
  await admin.query(
    'GRANT EXECUTE ON FUNCTION ctp_paper.initialize_funding(text) TO ctp_paper_portfolio_reader',
  );
  try {
    await expect(h.read(f.owner, io())).rejects.toThrow('PAPER_PORTFOLIO_ROLE_UNSAFE');
  } finally {
    await admin.query(
      'REVOKE EXECUTE ON FUNCTION ctp_paper.initialize_funding(text) FROM ctp_paper_portfolio_reader',
    );
  }
});
it.each([
  {},
  { tenantId: randomUUID(), accountId: randomUUID(), mode: 'LIVE' },
  { tenantId: randomUUID(), accountId: randomUUID(), mode: 'PAPER', balance: '1000' },
])('SQL independently rejects malformed scope %#', async (scope) => {
  await expect(
    direct.query('SELECT ctp_paper.capture_initial_portfolio($1::jsonb)', [JSON.stringify(scope)]),
  ).rejects.toMatchObject({ message: 'PAPER_PORTFOLIO_INPUT' });
});
it('physically lost read COMMIT yields no source and restart preserves exactly one original seed', async () => {
  const f = await fixture(),
    before = await monetary(f),
    proxy = await registryCommitProxy(required('DATABASE_PAPER_PORTFOLIO_URL'), 'PAPER_PORTFOLIO');
  try {
    const h = await open(proxy.connectionString);
    proxy.arm();
    await expect(h.read(f.owner, io())).rejects.toThrow('PAPER_PORTFOLIO_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
    await h.close();
    const r = await open();
    expect((await r.read(f.owner, io())).funding.funding).toEqual(f);
    expect(await monetary(f)).toEqual(before);
  } finally {
    await proxy.close();
  }
});
it.each(['abort', 'deadline'] as const)(
  'hung initial Portfolio lock %s settles physically and slots become reusable',
  async (kind) => {
    const f = await fixture(),
      h = await open(),
      p = await admin.connect(),
      c = new AbortController();
    try {
      await p.query('BEGIN');
      await p.query('SELECT id FROM public.exchange_account WHERE id=$1 FOR UPDATE', [
        f.owner.accountId,
      ]);
      const op = h.read(f.owner, io(c.signal, kind === 'deadline' ? 100 : 2500));
      const rejected = expect(op).rejects.toThrow('PAPER_PORTFOLIO_ABORTED');
      if (kind === 'abort') {
        await wait(50);
        c.abort();
      }
      await rejected;
      await p.query('ROLLBACK');
      await wait(50);
      expect((await h.read(f.owner, io())).funding.funding).toEqual(f);
    } finally {
      await p.query('ROLLBACK');
      p.release();
    }
  },
);
it('four pending physical reader slots retain ownership until abort settlement', async () => {
  const f = await fixture(),
    h = await open(),
    p = await admin.connect(),
    c = new AbortController();
  try {
    await p.query('BEGIN');
    await p.query('SELECT id FROM public.exchange_account WHERE id=$1 FOR UPDATE', [
      f.owner.accountId,
    ]);
    const jobs = Array.from({ length: 4 }, () =>
      h.read(f.owner, io(c.signal)).then(
        () => 'unexpected',
        (e: unknown) => (e instanceof Error ? e.message : 'unknown'),
      ),
    );
    await wait(50);
    await expect(h.read(f.owner, io())).rejects.toThrow('PAPER_PORTFOLIO_BUSY');
    c.abort();
    expect(await Promise.all(jobs)).toEqual(
      Array.from({ length: 4 }, () => 'PAPER_PORTFOLIO_ABORTED'),
    );
    await p.query('ROLLBACK');
    await wait(50);
    expect((await h.read(f.owner, io())).funding.funding).toEqual(f);
  } finally {
    await p.query('ROLLBACK');
    p.release();
  }
});
it.each([
  'configuration',
  'coherent-rewrite',
  'ledger',
  'funding-seal',
  'configuration-seal',
] as const)('corrupt %s after restart fails closed without repairing provenance', async (part) => {
  const f = await fixture(),
    h = await open();
  await h.read(f.owner, io());
  await h.close();
  const orig = (
    await admin.query<{ receipt_text: string; request: unknown }>(
      'SELECT receipt_text,request FROM ctp_paper.initial_funding WHERE id=$1',
      [f.id],
    )
  ).rows[0]!;
  const config = (
    await admin.query<{ receipt_text: string }>(
      'SELECT receipt_text FROM ctp_paper.configuration WHERE id=$1',
      [f.configurationId],
    )
  ).rows[0]!.receipt_text;
  const fs = (
    await admin.query<{ receipt_hash: Buffer }>(
      'SELECT receipt_hash FROM ctp_paper.funding_seal WHERE id=$1',
      [f.id],
    )
  ).rows[0]!.receipt_hash;
  const cs = (
    await admin.query<{ receipt_hash: Buffer }>(
      'SELECT receipt_hash FROM ctp_paper.configuration_seal WHERE id=$1',
      [f.configurationId],
    )
  ).rows[0]!.receipt_hash;
  const p = await admin.connect();
  try {
    await p.query('BEGIN');
    await p.query("SET LOCAL session_replication_role='replica'");
    if (part === 'configuration')
      await p.query(
        `UPDATE ctp_paper.configuration SET receipt_text=jsonb_set(receipt_text::jsonb,'{configuration,model,takerFeeRate}','"0.002"')::text WHERE id=$1`,
        [f.configurationId],
      );
    if (part === 'coherent-rewrite') {
      await p.query(
        `UPDATE ctp_paper.initial_funding SET receipt_text=jsonb_set(receipt_text::jsonb,'{funding,balances,1,amount}','"2000"')::text,request=jsonb_set(request,'{balances,1,amount}','"2000"') WHERE id=$1`,
        [f.id],
      );
    }
    if (part === 'ledger' || part === 'coherent-rewrite')
      await p.query(
        `UPDATE public.ledger_entry SET amount=CASE WHEN bucket='AVAILABLE' THEN 2000 ELSE -2000 END WHERE "transactionId"=$1 AND asset='USDT'`,
        [f.id],
      );
    if (part === 'funding-seal')
      await p.query('DELETE FROM ctp_paper.funding_seal WHERE id=$1', [f.id]);
    if (part === 'configuration-seal')
      await p.query('DELETE FROM ctp_paper.configuration_seal WHERE id=$1', [f.configurationId]);
    await p.query('COMMIT');
    const r = await open();
    await expect(r.read(f.owner, io())).rejects.toThrow('PAPER_PORTFOLIO_CORRUPT');
  } finally {
    await p.query('ROLLBACK');
    await p.query('BEGIN');
    await p.query("SET LOCAL session_replication_role='replica'");
    await p.query(
      'UPDATE ctp_paper.initial_funding SET receipt_text=$2,request=$3::jsonb WHERE id=$1',
      [f.id, orig.receipt_text, JSON.stringify(orig.request)],
    );
    await p.query('UPDATE ctp_paper.configuration SET receipt_text=$2 WHERE id=$1', [
      f.configurationId,
      config,
    ]);
    if (part === 'ledger' || part === 'coherent-rewrite')
      await p.query(
        `UPDATE public.ledger_entry SET amount=CASE WHEN bucket='AVAILABLE' THEN $2::numeric ELSE -$2::numeric END WHERE "transactionId"=$1 AND asset='USDT'`,
        [f.id, f.balances[1]!.amount],
      );
    if (part === 'funding-seal')
      await p.query(
        'INSERT INTO ctp_paper.funding_seal(id,tenant_id,account_id,receipt_hash) VALUES($1,$2,$3,$4)',
        [f.id, f.owner.tenantId, f.owner.accountId, fs],
      );
    if (part === 'configuration-seal')
      await p.query(
        'INSERT INTO ctp_paper.configuration_seal(id,tenant_id,account_id,receipt_hash) VALUES($1,$2,$3,$4)',
        [f.configurationId, f.owner.tenantId, f.owner.accountId, cs],
      );
    await p.query('COMMIT');
    p.release();
  }
});
