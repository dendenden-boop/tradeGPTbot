import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
export async function preparePortfolioUpgrade(db, tenantId, accountId) {
  const book = randomUUID();
  const hold = {
    id: 'legacy-reservation',
    asset: 'USDT',
    amount: '1',
    status: 'RESERVED',
    reflected: false,
  };
  const state = JSON.stringify({
    binding: {
      tenantId,
      accountId,
      connectionId: randomUUID(),
      externalAccountId: 'upgrade',
      mode: 'PAPER',
      walletId: 'legacy',
      scope: { exchange: 'BINANCE', region: 'global', environment: 'LIVE', market: 'SPOT' },
    },
    balances: [],
    positions: [],
    holds: [hold],
    pending: [],
    status: 'RECONCILED',
    snapshotAt: 0,
    snapshotId: 'legacy-anchor',
    lastEconomicAt: null,
    differences: [],
  });
  await db.query(
    'INSERT INTO ctp_portfolio.book(id,"tenantId","accountId",mode,wallet,state,state_hash) VALUES($1,$2,$3,\'PAPER\',\'legacy\',$4,$5)',
    [book, tenantId, accountId, state, createHash('sha256').update(state).digest()],
  );
  const events = [
    { type: 'COMMITMENT', id: 'legacy-new', timestamp: 900, hold: { ...hold, amount: '100' } },
    { type: 'COMMITMENT', id: 'legacy-old', timestamp: 800, hold },
    {
      type: 'RELEASE',
      id: 'legacy-release',
      timestamp: 950,
      holdId: 'legacy-closed',
      resolved: true,
    },
  ];
  for (const event of events) {
    const payload = JSON.stringify(event);
    await db.query(
      'INSERT INTO ctp_portfolio.evidence("tenantId",book,"accountId",mode,id,fingerprint,payload) VALUES($1,$2,$3,\'PAPER\',$4,$5,$6)',
      [tenantId, book, accountId, event.id, createHash('sha256').update(payload).digest(), payload],
    );
  }
  return { book, events };
}
export async function verifyPortfolioUpgrade(db, fixture) {
  const state = JSON.parse(
    (await db.query('SELECT state FROM ctp_portfolio.book WHERE id=$1', [fixture.book])).rows[0]
      .state,
  );
  assert.equal(state.status, 'GAP');
  assert.equal(state.holds[0].status, 'UNKNOWN');
  assert.equal(state.holds[0].amount, '1');
  const rows = (
    await db.query(
      'SELECT "holdId",timestamp,unknown,released FROM ctp_portfolio.hold_watermark WHERE book=$1 ORDER BY "holdId"',
      [fixture.book],
    )
  ).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.holdId === 'legacy-reservation').timestamp, '900');
  assert.equal(rows.find((r) => r.holdId === 'legacy-closed').timestamp, '950');
  assert(rows.every((r) => r.unknown === true && r.released === false));
  for (const event of fixture.events) {
    const row = (
      await db.query(
        'SELECT payload,fingerprint FROM ctp_portfolio.evidence WHERE book=$1 AND id=$2',
        [fixture.book, event.id],
      )
    ).rows[0];
    assert.equal(row.payload, JSON.stringify(event));
    assert(row.fingerprint.equals(createHash('sha256').update(row.payload).digest()));
  }
  const rls = await db.query(
    "SELECT relforcerowsecurity FROM pg_class WHERE oid IN ('ctp_portfolio.book'::regclass,'ctp_portfolio.evidence'::regclass,'ctp_portfolio.hold_watermark'::regclass)",
  );
  assert.equal(rls.rows.length, 3);
  assert(rls.rows.every((r) => r.relforcerowsecurity));
}
