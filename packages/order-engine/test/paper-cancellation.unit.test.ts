import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { authorizationSchema, computeCommandHash, operations } from '@ctp/exchange-core';
import { canonical, grantSchema, hash, stateSchema, type OrderState } from '../src/domain.js';
import * as paper from '../src/paper.js';
import * as root from '../src/index.js';
import { prepareOrderCancellation } from '../src/cancellation.js';
import { native, state } from './fixtures.js';

type Plan = {
  kind: string;
  request: { key: string; binding: OrderState['binding']; orderId: string; operation: string };
  requestHash: string;
  command: { instrumentId: string; locator: { kind: string; id: string } };
  commandHash: string;
  placeCommandHash: string;
  evidence: { withdrawalHash: string; releaseHash: string };
  transition: {
    previousVersion: string;
    nextVersion: string;
    from: string;
    to: string;
    source: string;
  };
};
function prepare(raw: unknown, now = 1000): Plan {
  const fn = (paper as unknown as Record<string, unknown>)['preparePaperUnsentCancellation'];
  expect(fn, 'A PAPER content plan must not fabricate native exchange evidence').toBeTypeOf(
    'function',
  );
  return (fn as (raw: unknown, now: number) => Plan)(raw, now);
}
function fixture() {
  const s = state();
  s.binding = {
    ...s.binding,
    mode: 'PAPER',
    connectionId: null,
    profile: {
      ...s.binding.profile,
      accountMode: 'SIMULATED',
      endpointProfileId: 'paper-spot-v1',
      profileVersion: 'spot-l2-taker-v1',
    },
  };
  s.command.clientOrderId = '9223372036854775807';
  const withdrawal = {
    outcome: 'NOT_SENT',
    collateral: 'RETAINED',
    eventId: randomUUID(),
    reservationId: randomUUID(),
    orderId: s.id,
    intentId: s.intentId,
    decisionId: randomUUID(),
    commandHash: hash({ operation: 'createOrder', command: s.command, binding: s.binding }),
    stateRevision: '1',
    observedAt: 200,
    bookId: randomUUID(),
    bookRevision: '2',
    bookHash: 'a'.repeat(64),
  };
  const release = {
    outcome: 'NOT_SENT',
    collateral: 'RELEASED',
    eventId: randomUUID(),
    withdrawalEventId: withdrawal.eventId,
    reservationId: withdrawal.reservationId,
    orderId: s.id,
    intentId: s.intentId,
    decisionId: withdrawal.decisionId,
    commandHash: withdrawal.commandHash,
    releaseVersion: '1',
    releasedAt: 300,
    bookId: withdrawal.bookId,
    bookRevision: '3',
    bookHash: 'b'.repeat(64),
    debits: [{ asset: 'USDT', amount: '1000', holdId: randomUUID() }],
  };
  return { kind: 'PAPER_PREPARE_UNSENT_CANCEL', key: 'cancel-once', state: s, withdrawal, release };
}
type Fixture = ReturnType<typeof fixture>;
function rebind(f: Fixture) {
  const { clientOrderId: omitted, ...order } = f.state.command;
  void omitted;
  f.state.draft.order = order;
  f.withdrawal.commandHash = hash({
    operation: 'createOrder',
    command: f.state.command,
    binding: f.state.binding,
  });
  f.release.commandHash = f.withdrawal.commandHash;
}
afterEach(() => vi.restoreAllMocks());

it('prepares one immutable local CANCEL plan with the original lossless client locator and common permanent-key hash', () => {
  const f = fixture(),
    before = canonical(f),
    p = prepare(f);
  expect(p.kind).toBe('PAPER_UNSENT_CANCEL_PLAN');
  expect(p.request).toEqual({
    binding: f.state.binding,
    orderId: f.state.id,
    operation: 'CANCEL',
    key: f.key,
  });
  expect(p.requestHash).toBe(
    hash({ binding: f.state.binding, orderId: f.state.id, operation: 'CANCEL' }),
  );
  expect(p.command).toEqual({
    instrumentId: f.state.command.instrumentId,
    locator: { kind: 'CLIENT_ID', id: '9223372036854775807' },
  });
  expect(p.commandHash).toBe(
    hash({ operation: 'cancelOrder', command: p.command, binding: f.state.binding }),
  );
  expect(p.placeCommandHash).toBe(f.withdrawal.commandHash);
  expect(p.evidence).toEqual({ withdrawalHash: hash(f.withdrawal), releaseHash: hash(f.release) });
  expect(p.transition).toEqual({
    previousVersion: '0',
    nextVersion: '1',
    from: 'CREATED',
    to: 'CANCELED',
    source: 'PAPER_NOT_SENT_CANCEL',
  });
  expect(canonical(f)).toBe(before);
  expect(Object.isFrozen(p)).toBe(true);
  expect(Object.isFrozen(p.command.locator)).toBe(true);
  expect(Object.isFrozen(p.request.binding.profile)).toBe(true);
  f.state.command.clientOrderId = 'changed-after-calculation';
  expect(p.command.locator.id).toBe('9223372036854775807');
});
it('uses a valid common cancellation locator without inventing a native connection or observed exchange target', () => {
  const f = fixture(),
    p = prepare(f);
  expect(operations.cancelOrder.input.shape.command.parse(p.command)).toEqual(p.command);
  expect(p.command).not.toHaveProperty('target');
  expect(p.request.binding.connectionId).toBeNull();
  expect(() =>
    computeCommandHash('cancelOrder', p.command, {
      profile: f.state.binding.profile,
      account: {
        tenantId: f.state.binding.tenantId,
        connectionId: null,
        externalAccountId: f.state.binding.externalAccountId,
      },
    }),
  ).toThrow('INVALID_COMMAND_HASH_INPUT');
});
it('is deterministic across JSON reconstruction, later explicit time and current metadata replacement', () => {
  const f = fixture(),
    p = prepare(f);
  vi.spyOn(Date, 'now').mockImplementation(() => {
    throw new Error('NO_AMBIENT_CLOCK_OR_METADATA_ADMISSION');
  });
  expect(prepare(JSON.parse(canonical(f)), 2000)).toEqual(p);
  expect(prepare(f, 3000)).toEqual(p);
});
it('binds the semantic target independently from the caller key without generating another client ID', () => {
  const f = fixture(),
    p = prepare(f),
    q = prepare({ ...f, key: 'another-key' });
  expect(q.command).toEqual(p.command);
  expect(q.commandHash).toBe(p.commandHash);
  expect(q.requestHash).toBe(p.requestHash);
  expect(q.request.key).not.toBe(p.request.key);
  const other = fixture();
  other.key = f.key;
  expect(prepare(other).requestHash).not.toBe(p.requestHash);
});
it('accepts an original supported LIMIT with its immutable old rule, without pricing or admitting another order', () => {
  const f = fixture();
  f.state.command = { ...f.state.command, type: 'LIMIT', limitPrice: '10', timeInForce: 'GTC' };
  rebind(f);
  const p = prepare(f);
  expect(p.command).not.toHaveProperty('quantity');
  expect(p.command).not.toHaveProperty('ruleVersion');
  expect(p.placeCommandHash).toBe(f.withdrawal.commandHash);
});
it('compares original book revisions losslessly and tolerates unrelated intervening causal book changes', () => {
  const f = fixture();
  f.withdrawal.bookRevision = '9007199254740990';
  f.release.bookRevision = '9007199254740991';
  expect(prepare(f).kind).toBe('PAPER_UNSENT_CANCEL_PLAN');
  f.withdrawal.bookRevision = '2';
  f.release.bookRevision = '100';
  expect(prepare(f).kind).toBe('PAPER_UNSENT_CANCEL_PLAN');
});

const invalidStates: [string, (f: Fixture) => void][] = [
  [
    'private credential reference',
    (f) => {
      f.state.binding.profile = { ...f.state.binding.profile, credentialRef: 'fixture-credential' };
      rebind(f);
    },
  ],
  [
    'native TESTNET binding',
    (f) => {
      f.state.binding.mode = 'TESTNET';
      f.state.binding.connectionId = randomUUID();
      rebind(f);
    },
  ],
  [
    'LIVE binding',
    (f) => {
      f.state.binding.mode = 'LIVE';
      f.state.binding.connectionId = randomUUID();
      f.state.binding.profile = { ...f.state.binding.profile, environment: 'LIVE' };
      rebind(f);
    },
  ],
  [
    'private connection',
    (f) => {
      f.state.binding.connectionId = randomUUID();
      rebind(f);
    },
  ],
  [
    'native account profile',
    (f) => {
      f.state.binding.profile = { ...f.state.binding.profile, accountMode: 'SPOT' };
      rebind(f);
    },
  ],
  [
    'unrecognized simulated endpoint',
    (f) => {
      f.state.binding.profile = { ...f.state.binding.profile, endpointProfileId: 'user-endpoint' };
      rebind(f);
    },
  ],
  [
    'unrecognized model version',
    (f) => {
      f.state.binding.profile = { ...f.state.binding.profile, profileVersion: 'future-model' };
      rebind(f);
    },
  ],
  [
    'derivative profile',
    (f) => {
      f.state.binding.profile = { ...f.state.binding.profile, market: 'LINEAR_PERPETUAL' };
      rebind(f);
    },
  ],
  [
    'SELL outside the accepted issuance scope',
    (f) => {
      f.state.command.side = 'SELL';
      rebind(f);
    },
  ],
  [
    'UNKNOWN state',
    (f) => {
      f.state.status = 'UNKNOWN';
    },
  ],
  [
    'submitted state',
    (f) => {
      f.state.status = 'SUBMITTED';
    },
  ],
  [
    'already cancelled state',
    (f) => {
      f.state.status = 'CANCELED';
    },
  ],
  [
    'newer public version',
    (f) => {
      f.state.version = 1;
    },
  ],
  [
    'active transport attempt',
    (f) => {
      f.state.activeAttemptId = randomUUID();
      f.state.activeOperation = 'PLACE';
    },
  ],
  [
    'native exchange identifier',
    (f) => {
      f.state.exchangeOrderId = 'native-id';
    },
  ],
  [
    'nonzero filled quantity',
    (f) => {
      f.state.filledQuantity = '1';
    },
  ],
  [
    'unadopted execution',
    (f) => {
      f.state.executedQuantity = '1';
    },
  ],
  [
    'execution notional',
    (f) => {
      f.state.executionNotional = '1';
    },
  ],
  [
    'native observation',
    (f) => {
      f.state.lastExchangeAt = 200;
      f.state.lastNativeStatus = 'SUBMITTED';
      f.state.lastObservationHash = 'c'.repeat(64);
    },
  ],
  [
    'inconsistent original draft',
    (f) => {
      f.state.draft.order.ruleVersion = 'different';
    },
  ],
  [
    'replaced PLACE content',
    (f) => {
      f.state.command.clientOrderId = '2';
    },
  ],
];
it.each(invalidStates)(
  'rejects %s instead of manufacturing NOT_SENT cancellation',
  (_name, change) => {
    const f = fixture();
    change(f);
    expect(() => prepare(f)).toThrow(/ORDER_PAPER_CANCEL_/u);
  },
);
const invalidProofs: [string, (f: Fixture) => void][] = [
  [
    'foreign order',
    (f) => {
      f.release.orderId = randomUUID();
    },
  ],
  [
    'foreign PLACE intent',
    (f) => {
      f.withdrawal.intentId = randomUUID();
    },
  ],
  [
    'foreign decision',
    (f) => {
      f.release.decisionId = randomUUID();
    },
  ],
  [
    'foreign reservation',
    (f) => {
      f.release.reservationId = randomUUID();
    },
  ],
  [
    'foreign book',
    (f) => {
      f.release.bookId = randomUUID();
    },
  ],
  [
    'wrong withdrawal event',
    (f) => {
      f.release.withdrawalEventId = randomUUID();
    },
  ],
  [
    'colliding permanent events',
    (f) => {
      f.release.eventId = f.withdrawal.eventId;
    },
  ],
  [
    'UNKNOWN native outcome',
    (f) => {
      f.withdrawal.outcome = 'UNKNOWN';
    },
  ],
  [
    'unreleased collateral',
    (f) => {
      f.release.collateral = 'RETAINED';
    },
  ],
  [
    'different PLACE hash',
    (f) => {
      f.release.commandHash = 'c'.repeat(64);
    },
  ],
  [
    'release before withdrawal',
    (f) => {
      f.release.releasedAt = 199;
    },
  ],
  [
    'withdrawal before order creation',
    (f) => {
      f.withdrawal.observedAt = 99;
    },
  ],
  [
    'release from a future clock',
    (f) => {
      f.release.releasedAt = 1001;
    },
  ],
  [
    'same causal revision',
    (f) => {
      f.release.bookRevision = '2';
    },
  ],
  [
    'regressing causal revision',
    (f) => {
      f.release.bookRevision = '1';
    },
  ],
  [
    'unsafe causal revision',
    (f) => {
      f.release.bookRevision = '9007199254740992';
    },
  ],
  [
    'noncanonical causal revision',
    (f) => {
      f.release.bookRevision = '03';
    },
  ],
  [
    'negative debit',
    (f) => {
      f.release.debits[0]!.amount = '-1';
    },
  ],
  [
    'empty debit vector',
    (f) => {
      f.release.debits = [];
    },
  ],
  [
    'unexpected second monetary vector',
    (f) => {
      f.release.debits.push({ asset: 'BTC', amount: '1', holdId: randomUUID() });
    },
  ],
];
it.each(invalidProofs)('rejects %s in withdrawal/release content', (_name, change) => {
  const f = fixture();
  change(f);
  expect(() => prepare(f)).toThrow(/ORDER_PAPER_CANCEL_/u);
});
it.each(['', 'with whitespace', 'x'.repeat(129)])('rejects invalid permanent key %j', (key) => {
  expect(() => prepare({ ...fixture(), key })).toThrow('ORDER_PAPER_CANCEL_INPUT');
});
it.each([NaN, Infinity, -1, 1.5, 8_640_000_000_000_001])(
  'rejects invalid explicit clock %s',
  (now) => {
    expect(() => prepare(fixture(), now)).toThrow('ORDER_PAPER_CANCEL_INPUT');
  },
);
it.each([
  'authorization',
  'tenantId',
  'snapshot',
  'clientOrderId',
  'receipt',
  'currentRules',
  'riskGrant',
])('rejects caller override %s', (key) => {
  expect(() => prepare({ ...fixture(), [key]: 'untrusted' })).toThrow('ORDER_PAPER_CANCEL_INPUT');
});
it.each(['BINANCE', 'BYBIT', 'OKX', 'HTX'] as const)(
  'supports %s public source environments without a private adapter dependency',
  (exchange) => {
    for (const environment of ['LIVE', 'TESTNET', 'DEMO'] as const) {
      const f = fixture();
      f.state.binding.profile = { ...f.state.binding.profile, exchange, environment };
      rebind(f);
      expect(prepare(f).request.binding.mode).toBe('PAPER');
    }
  },
);
it.each(['withdrawal', 'release'] as const)('rejects unknown fields inside %s content', (field) => {
  const f = fixture();
  expect(() => prepare({ ...f, [field]: { ...f[field], unknownConstraint: 'untrusted' } })).toThrow(
    'ORDER_PAPER_CANCEL_INPUT',
  );
});
it('never turns internally consistent serialized content into a grant, transport permission, state or acknowledgement', () => {
  const f = fixture(),
    p = prepare(JSON.parse(canonical(f)));
  expect(authorizationSchema.safeParse(p).success).toBe(false);
  expect(grantSchema.safeParse(p).success).toBe(false);
  expect(stateSchema.safeParse(p).success).toBe(false);
  expect(operations.cancelOrder.input.safeParse(p).success).toBe(false);
  for (const key of [
    'receipt',
    'status',
    'outcome',
    'permissionEpoch',
    'expiresAt',
    'permit',
    'postings',
    'intentId',
  ])
    expect(p).not.toHaveProperty(key);
});
it('keeps the native cancellation path closed to PAPER', () => {
  const f = fixture(),
    event = native(f.state);
  if (event.type !== 'NATIVE') throw new Error('TEST_EVENT');
  expect(() =>
    prepareOrderCancellation(f.state, { order: event.order, receivedAt: 500 }, 1000),
  ).toThrow('ORDER_CANCEL_TARGET');
});
it('keeps content preparation off the existing root export and exposes only the explicit PAPER subpath', () => {
  expect(root).not.toHaveProperty('preparePaperUnsentCancellation');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    exports: Record<string, unknown>;
  };
  expect(pkg.exports['./paper']).toEqual({
    types: './dist/paper.d.ts',
    default: './dist/paper.js',
  });
});
