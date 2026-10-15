import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { canonical } from '@ctp/portfolio';
import {
  decodePaperRuntimeSource,
  paperRuntimeDependencies,
  paperRuntimePublicationSchema,
} from '../src/runtime-domain.js';
import { runtimeFixture, replaceRuntimePublication } from './runtime-fixtures.js';

it('binds every original PAPER probe fact to the sealed model and current lossless epochs without Risk authority', () => {
  const f = runtimeFixture(),
    s = decodePaperRuntimeSource(f.w, f.owner, f.now);
  expect(s.current.permissionEpoch).toBe('9007199254740993');
  expect(s.current.userSessionEpoch).toBe('2147483647');
  expect(s.health).toEqual(f.publication.observation.health);
  expect(s.configuration.createdAt).toBe(f.now - 100);
  expect(s.blockedBy).toEqual([]);
  expect(s.validUntil).toBe(
    f.now - 20 + Math.min(5000, f.configuration.configuration.model.maxEvidenceAgeMs) + 1,
  );
  for (const key of [
    'certificate',
    'approval',
    'approve',
    'grant',
    'reservation',
    'permit',
    'capabilities',
    'ready',
  ])
    expect(key in s).toBe(false);
  expect(Object.isFrozen(s.health.executor)).toBe(true);
});
it.each(paperRuntimeDependencies)('missing %s never defaults to HEALTHY', (key) => {
  const f = runtimeFixture();
  delete (f.publication.observation.health as Partial<typeof f.publication.observation.health>)[
    key
  ];
  expect(paperRuntimePublicationSchema.safeParse(f.publication).success).toBe(false);
  replaceRuntimePublication(f.w, f.publication);
  expect(() => decodePaperRuntimeSource(f.w, f.owner, f.now)).toThrow('PAPER_RUNTIME_CORRUPT');
});
it.each(paperRuntimeDependencies)('preserves explicit FAILED %s as blocked evidence', (key) => {
  const f = runtimeFixture();
  f.publication.observation.health[key].status = 'FAILED';
  replaceRuntimePublication(f.w, f.publication);
  expect(decodePaperRuntimeSource(f.w, f.owner, f.now).blockedBy).toEqual([key]);
});
it.each(paperRuntimeDependencies)('preserves UNKNOWN %s without a positive fallback', (key) => {
  const f = runtimeFixture();
  f.publication.observation.health[key].status = 'UNKNOWN';
  replaceRuntimePublication(f.w, f.publication);
  expect(decodePaperRuntimeSource(f.w, f.owner, f.now).health[key].status).toBe('UNKNOWN');
});
it.each(paperRuntimeDependencies)(
  'applies expiry independently to the original %s timestamp',
  (key) => {
    const f = runtimeFixture(),
      age = Math.min(5000, f.configuration.configuration.model.maxEvidenceAgeMs);
    f.configuration.createdAt = f.now - age - 100;
    f.w.configuration.receiptText = canonical(f.configuration);
    f.w.configuration.hash = createHash('sha256')
      .update(f.w.configuration.receiptText)
      .digest('hex');
    f.publication.observation.configurationHash = f.w.configuration.hash;
    f.publication.observation.health[key].asOf = f.now - age - 1;
    replaceRuntimePublication(f.w, f.publication);
    expect(() => decodePaperRuntimeSource(f.w, f.owner, f.now)).toThrow('PAPER_RUNTIME_STALE');
  },
);
it.each([
  'tenant',
  'account',
  'mode',
  'configuration',
  'configurationHash',
  'identity',
  'publicationId',
  'revision',
  'hash',
  'captureFuture',
  'publicationFuture',
  'beforeConfiguration',
] as const)('rejects conflicting %s source evidence wholly', (kind) => {
  const f = runtimeFixture();
  if (kind === 'tenant') f.w.owner.tenantId = randomUUID();
  if (kind === 'account') f.w.owner.accountId = randomUUID();
  if (kind === 'mode') Object.assign(f.w.owner, { mode: 'DEMO' });
  if (kind === 'configuration') f.publication.observation.configurationId = randomUUID();
  if (kind === 'configurationHash') f.publication.observation.configurationHash = '1'.repeat(64);
  if (kind === 'identity') f.w.current.clientIdEpoch = 'replacement';
  if (kind === 'publicationId') f.w.publication.id = randomUUID();
  if (kind === 'revision') f.w.publication.revision = '9007199254740993';
  if (kind === 'captureFuture') f.w.asOf = f.now + 1;
  if (kind === 'publicationFuture') f.w.publication.publishedAt = f.now + 1;
  if (kind === 'beforeConfiguration') f.publication.observation.health.executor.asOf = f.now - 101;
  replaceRuntimePublication(f.w, f.publication);
  if (kind === 'hash') f.w.publication.hash = '1'.repeat(64);
  expect(() => decodePaperRuntimeSource(f.w, f.owner, f.now)).toThrow('PAPER_RUNTIME_CORRUPT');
});
it.each(['permissionEpoch', 'userSessionEpoch', 'accountVersion'] as const)(
  'current %s replacement invalidates old runtime evidence',
  (key) => {
    const f = runtimeFixture();
    if (key === 'permissionEpoch') f.w.current.permissionEpoch = '9007199254740994';
    if (key === 'userSessionEpoch') f.w.current.userSessionEpoch = '1';
    if (key === 'accountVersion') f.w.current.accountVersion = 1;
    expect(() => decodePaperRuntimeSource(f.w, f.owner, f.now)).toThrow('PAPER_RUNTIME_EPOCH');
  },
);
it.each(['-1', '01', '1.0', '+1', '9223372036854775808', '1' + String.fromCharCode(10)])(
  'rejects noncanonical/out-of-range epoch %j',
  (epoch) => {
    const f = runtimeFixture();
    f.publication.observation.permissionEpoch = epoch;
    expect(paperRuntimePublicationSchema.safeParse(f.publication).success).toBe(false);
  },
);
it.each(['2147483648', '9007199254740993'])(
  'rejects session epoch outside actual INTEGER storage %s',
  (epoch) => {
    const f = runtimeFixture();
    f.publication.observation.userSessionEpoch = epoch;
    expect(paperRuntimePublicationSchema.safeParse(f.publication).success).toBe(false);
  },
);
it.each([2147483648, -1, 1.5])('rejects invalid account version %s', (version) => {
  const f = runtimeFixture();
  f.publication.observation.accountVersion = version;
  expect(paperRuntimePublicationSchema.safeParse(f.publication).success).toBe(false);
});
it.each(['privateStream', 'exchangeRest', 'credentials', 'endpointUrl'])(
  'does not accept native/caller %s aliases',
  (key) => {
    const f = runtimeFixture();
    Object.assign(f.publication.observation.health, {
      [key]: f.publication.observation.health.executor,
    });
    expect(paperRuntimePublicationSchema.safeParse(f.publication).success).toBe(false);
  },
);
it.each(['https://caller.invalid', 'probe' + String.fromCharCode(10), '', 'a'.repeat(129)])(
  'rejects nonopaque/unbounded probe identity %j',
  (sourceId) => {
    const f = runtimeFixture();
    f.publication.observation.health.executor.sourceId = sourceId;
    expect(paperRuntimePublicationSchema.safeParse(f.publication).success).toBe(false);
  },
);
it('preserves original fact/receipt deadlines across JSON replay, without renewal from capture time', () => {
  const f = runtimeFixture(),
    a = decodePaperRuntimeSource(f.w, f.owner, f.now);
  const b = decodePaperRuntimeSource(JSON.parse(JSON.stringify(f.w)), f.owner, f.now + 1);
  expect(b).toEqual(a);
  expect(() => decodePaperRuntimeSource(f.w, f.owner, a.validUntil)).toThrow('PAPER_RUNTIME_STALE');
});
it('checks all witnesses against a stricter immutable model age', () => {
  const f = runtimeFixture();
  f.configuration.configuration.model.maxEvidenceAgeMs = 10;
  f.w.configuration.receiptText = canonical(f.configuration);
  f.w.configuration.hash = createHash('sha256').update(f.w.configuration.receiptText).digest('hex');
  f.publication.observation.configurationHash = f.w.configuration.hash;
  replaceRuntimePublication(f.w, f.publication);
  expect(() => decodePaperRuntimeSource(f.w, f.owner, f.now)).toThrow('PAPER_RUNTIME_STALE');
});
it('caps the whole source wire before decoding unbounded retained contents', () => {
  const f = runtimeFixture();
  expect(() =>
    decodePaperRuntimeSource({ ...f.w, caller: 'x'.repeat(65536) }, f.owner, f.now),
  ).toThrow('PAPER_RUNTIME_CAPACITY');
});
