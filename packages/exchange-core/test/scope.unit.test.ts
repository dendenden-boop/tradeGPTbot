import { describe, expect, it } from 'vitest';

import {
  accountScopeSchema,
  adapterProfileSchema,
  capabilityRecordSchema,
  environmentSchema,
  evaluateCapability,
  featureSchema,
  idSchema,
  marketScopeSchema,
  timestampSchema,
} from '../src/scope.js';
import type { CapabilityEvaluationInput } from '../src/scope.js';

const profile = {
  exchange: 'BINANCE',
  region: 'GLOBAL',
  market: 'SPOT',
  environment: 'TESTNET',
  accountMode: 'STANDARD',
  profileVersion: 'v1',
  endpointProfileId: 'binance-spot-testnet-v1',
  credentialRef: 'connection-credential-1',
} as const;
const record = {
  profile,
  feature: 'MARKET_ORDER',
  support: 'SUPPORTED',
  implementation: 'NATIVE',
  constraints: {},
  evidenceUrl: 'https://developers.binance.com/docs/example',
  checkedAt: 1_000,
  expiresAt: 2_000,
  adapterVersion: '1.0.0',
} as const;
const input: CapabilityEvaluationInput = {
  profile,
  record,
  feature: 'MARKET_ORDER',
  now: 1_500,
  adapterVersion: '1.0.0',
};

describe('scope boundary schemas', () => {
  it('preserves opaque external IDs without numeric coercion or trimming', () => {
    expect(idSchema.parse('900719925474099312345')).toBe('900719925474099312345');
    expect(idSchema.parse('00012:A/B-1')).toBe('00012:A/B-1');
    expect(idSchema.parse('a'.repeat(128))).toHaveLength(128);
  });

  it.each([
    '',
    'a'.repeat(129),
    ' leading',
    'trailing ',
    'a b',
    'a\nb',
    'a\tb',
    'a\0b',
    'a\u007fb',
    'a\u0085b',
    'a\u00a0b',
    'a\u200bb',
    123,
    null,
  ])('rejects invalid external ID %j', (value) =>
    expect(idSchema.safeParse(value).success).toBe(false),
  );

  it('accepts the complete bounded UTC millisecond interval', () => {
    expect(timestampSchema.parse(0)).toBe(0);
    expect(timestampSchema.parse(8_640_000_000_000_000)).toBe(8_640_000_000_000_000);
  });

  it.each([
    -1,
    0.1,
    8_640_000_000_000_001,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Infinity,
    '1000',
  ])('rejects invalid timestamp %j', (value) => {
    expect(timestampSchema.safeParse(value).success).toBe(false);
  });

  it('freezes an independent profile without changing caller-owned values', () => {
    const raw = { ...profile };
    const parsed = adapterProfileSchema.parse(raw);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(raw)).toBe(false);
    expect(Reflect.set(parsed, 'environment', 'LIVE')).toBe(false);
    Reflect.set(raw, 'region', 'US');
    expect(parsed.region).toBe('GLOBAL');
  });

  it.each([
    { exchange: 'UNKNOWN' },
    { market: 'MARGIN' },
    { environment: 'EXCHANGE_DEMO' },
    { environment: 'PAPER' },
    { accountMode: 'standard' },
    { accountMode: 'A'.repeat(129) },
    { region: 'GLOBAL ' },
    { region: '' },
    { region: 'a'.repeat(129) },
    { profileVersion: '' },
    { endpointProfileId: 'https://untrusted.invalid' },
    { credentialRef: 'https://user:secret@untrusted.invalid' },
    { credentialRef: { apiKey: 'raw-secret' } },
    { credentialRef: 'apiKey=raw-secret' },
    { apiKey: 'raw-secret' },
    { endpointUrl: 'https://untrusted.invalid' },
  ])('rejects malformed or expanded profile %j', (change) => {
    expect(adapterProfileSchema.safeParse({ ...profile, ...change }).success).toBe(false);
  });

  it('keeps market scope strict and the three environments distinct', () => {
    const scope = marketScopeSchema.parse({
      exchange: 'OKX',
      region: 'EU',
      market: 'INVERSE_FUTURE',
      environment: 'DEMO',
    });
    expect(Object.isFrozen(scope)).toBe(true);
    expect(marketScopeSchema.safeParse({ ...scope, tenantId: 'hidden' }).success).toBe(false);
    expect(environmentSchema.options).toEqual(['LIVE', 'TESTNET', 'DEMO']);
  });

  it('validates immutable tenant and connection identity without numeric account IDs', () => {
    const scope = {
      tenantId: 'c6ee3b5a-e566-4c4f-b3e7-171a925237dc',
      connectionId: '40f4cbec-92d9-4278-8f07-a5f114971940',
      externalAccountId: '900719925474099312345',
    };
    expect(Object.isFrozen(accountScopeSchema.parse(scope))).toBe(true);
    expect(accountScopeSchema.safeParse({ ...scope, tenantId: 'someone' }).success).toBe(false);
    expect(accountScopeSchema.safeParse({ ...scope, connectionId: 'someone' }).success).toBe(false);
    expect(accountScopeSchema.safeParse({ ...scope, externalAccountId: 123 }).success).toBe(false);
    expect(accountScopeSchema.safeParse({ ...scope, userId: scope.tenantId }).success).toBe(false);
  });
});

describe('capability evidence', () => {
  it('deep freezes profile, constraints, and their arrays as independent copies', () => {
    const raw = { ...record, constraints: { instrumentIds: ['BTCUSDT'], timeframes: ['1m'] } };
    const parsed = capabilityRecordSchema.parse(raw);
    for (const value of [
      parsed,
      parsed.profile,
      parsed.constraints,
      parsed.constraints.instrumentIds,
      parsed.constraints.timeframes,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(Reflect.set(parsed.constraints.instrumentIds ?? [], 0, 'ETHUSDT')).toBe(false);
    raw.constraints.instrumentIds.push('ETHUSDT');
    expect(parsed.constraints.instrumentIds).toEqual(['BTCUSDT']);
    expect(raw.constraints.instrumentIds).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it.each([
    { checkedAt: -1 },
    { checkedAt: 1_500.5 },
    { expiresAt: 1_000 },
    { expiresAt: 999 },
    { expiresAt: 8_640_000_000_000_001 },
    { evidenceUrl: 'http://docs.example.test' },
    { evidenceUrl: 'javascript:alert(1)' },
    { evidenceUrl: 'not-a-url' },
    { evidenceUrl: '' },
    { evidenceUrl: 'https://user:secret@docs.example.test' },
    { evidenceUrl: 'https://docs.example.test/has space' },
    { evidenceUrl: 'https://docs.example.test/' + 'a'.repeat(2048) },
    { constraints: { instruments: ['BTCUSDT'] } },
    { constraints: { instrumentIds: [123] } },
    { constraints: { timeframes: [''] } },
    { constraints: { timeframes: Array<string>(257).fill('1m') } },
    { support: 'MAYBE' },
    { implementation: 'FALLBACK' },
    { feature: 'UNKNOWN' },
    { adapterVersion: '' },
    { checkedBy: 'someone' },
  ])('rejects malformed evidence %j', (change) => {
    expect(capabilityRecordSchema.safeParse({ ...record, ...change }).success).toBe(false);
    expect(evaluateCapability({ ...input, record: { ...record, ...change } })).toEqual({
      allowed: false,
      code: 'MALFORMED',
    });
  });
});

describe('scoped capability evaluation', () => {
  it.each(featureSchema.options)('permits explicit native evidence for feature %s', (feature) => {
    expect(evaluateCapability({ ...input, feature, record: { ...record, feature } })).toEqual({
      allowed: true,
      implementation: 'NATIVE',
    });
  });

  it.each([
    { exchange: 'BYBIT' },
    { region: 'US' },
    { region: 'global' },
    { market: 'LINEAR_PERPETUAL' },
    { environment: 'DEMO' },
    { environment: 'LIVE' },
    { accountMode: 'UNIFIED' },
    { profileVersion: 'v2' },
    { endpointProfileId: 'binance-spot-live-v1' },
    { credentialRef: 'another-credential' },
  ])('denies evidence from a different exact profile %j', (change) => {
    expect(evaluateCapability({ ...input, profile: { ...profile, ...change } })).toEqual({
      allowed: false,
      code: 'SCOPE_MISMATCH',
    });
  });

  it('binds the optional credential reference and feature without fallback', () => {
    const { credentialRef, ...publicProfile } = profile;
    expect(credentialRef).toBeDefined();
    expect(evaluateCapability({ ...input, profile: publicProfile })).toEqual({
      allowed: false,
      code: 'SCOPE_MISMATCH',
    });
    expect(evaluateCapability({ ...input, feature: 'LIMIT_ORDER' })).toEqual({
      allowed: false,
      code: 'SCOPE_MISMATCH',
    });
    expect(
      evaluateCapability({
        ...input,
        profile: publicProfile,
        record: { ...record, profile: publicProfile },
      }),
    ).toEqual({ allowed: true, implementation: 'NATIVE' });
  });

  it.each(['UNSUPPORTED', 'UNVERIFIED'] as const)(
    'does not treat %s evidence as supported',
    (support) => {
      expect(evaluateCapability({ ...input, record: { ...record, support } })).toEqual({
        allowed: false,
        code: support,
      });
    },
  );

  it('enforces the half-open validity interval and refuses future-dated evidence', () => {
    expect(evaluateCapability({ ...input, now: 999 })).toEqual({ allowed: false, code: 'EXPIRED' });
    expect(evaluateCapability({ ...input, now: 1_000 }).allowed).toBe(true);
    expect(evaluateCapability({ ...input, now: 1_999 }).allowed).toBe(true);
    expect(evaluateCapability({ ...input, now: 2_000 })).toEqual({
      allowed: false,
      code: 'EXPIRED',
    });
    expect(evaluateCapability({ ...input, now: 2_001 })).toEqual({
      allowed: false,
      code: 'EXPIRED',
    });
    expect(evaluateCapability({ ...input, now: Number.NaN })).toEqual({
      allowed: false,
      code: 'MALFORMED',
    });
  });

  it('requires the exact adapter version used when evidence was checked', () => {
    expect(evaluateCapability({ ...input, adapterVersion: '1.0.1' })).toEqual({
      allowed: false,
      code: 'VERSION_MISMATCH',
    });
  });

  it.each([undefined, false])(
    'disables synthetic implementations unless explicitly enabled: %j',
    (allowSynthetic) => {
      const syntheticInput = { ...input, record: { ...record, implementation: 'SYNTHETIC' } };
      const request =
        allowSynthetic === undefined ? syntheticInput : { ...syntheticInput, allowSynthetic };
      expect(evaluateCapability(request)).toEqual({ allowed: false, code: 'SYNTHETIC_DISABLED' });
      expect(evaluateCapability({ ...syntheticInput, allowSynthetic: true })).toEqual({
        allowed: true,
        implementation: 'SYNTHETIC',
      });
    },
  );

  it('requires every configured dimension, rejecting missing and nonmatching values', () => {
    const constrained = {
      ...record,
      constraints: { instrumentIds: ['BTCUSDT'], timeframes: ['1m'] },
    };
    for (const dimensions of [
      {},
      { instrumentId: 'BTCUSDT' },
      { timeframe: '1m' },
      { instrumentId: 'ETHUSDT', timeframe: '1m' },
      { instrumentId: 'BTCUSDT', timeframe: '5m' },
    ]) {
      expect(evaluateCapability({ ...input, record: constrained, ...dimensions })).toEqual({
        allowed: false,
        code: 'CONSTRAINT',
      });
    }
    expect(
      evaluateCapability({
        ...input,
        record: constrained,
        instrumentId: 'BTCUSDT',
        timeframe: '1m',
      }),
    ).toEqual({ allowed: true, implementation: 'NATIVE' });
  });

  it('treats explicit empty allowlists as allowing nothing and applies dimensions independently', () => {
    expect(
      evaluateCapability({
        ...input,
        record: { ...record, constraints: { instrumentIds: [] } },
        instrumentId: 'BTCUSDT',
      }),
    ).toEqual({ allowed: false, code: 'CONSTRAINT' });
    expect(
      evaluateCapability({
        ...input,
        record: { ...record, constraints: { timeframes: [] } },
        timeframe: '1m',
      }),
    ).toEqual({ allowed: false, code: 'CONSTRAINT' });
    expect(
      evaluateCapability({
        ...input,
        record: { ...record, constraints: { instrumentIds: ['BTCUSDT'] } },
        instrumentId: 'BTCUSDT',
      }).allowed,
    ).toBe(true);
    expect(
      evaluateCapability({
        ...input,
        record: { ...record, constraints: { timeframes: ['1m'] } },
        timeframe: '1m',
      }).allowed,
    ).toBe(true);
  });

  it('returns only static denial information for unknown records and hostile getters', () => {
    for (const missingRecord of [undefined, null, {}, [], 'raw-secret']) {
      expect(evaluateCapability({ ...input, record: missingRecord })).toEqual({
        allowed: false,
        code: 'MALFORMED',
      });
    }
    const hostile = Object.defineProperty({}, 'exchange', {
      get() {
        throw new Error('raw-secret');
      },
    });
    expect(evaluateCapability({ ...input, profile: hostile })).toEqual({
      allowed: false,
      code: 'MALFORMED',
    });
  });
});
