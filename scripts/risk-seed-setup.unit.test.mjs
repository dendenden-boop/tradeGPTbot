import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { captureFixture } from '../packages/risk-engine/test/snapshot-fixtures.js';
import { binding, snapshot } from '../packages/portfolio/test/fixtures.js';
import { bindingSchema as orderBindingSchema } from '@ctp/order-engine';
import { parseDecimal } from '@ctp/exchange-core';
import { riskLimitsSchema, riskNativeObservationSchema } from '@ctp/risk-engine';
import { marketSnapshotPublicationSchema } from '@ctp/market-data';
import { beforeRiskSeedSetup } from './risk-seed-setup-legacy.mjs';

const file = 'packages/database/test/fixtures/risk-certification.ts';
const source = readFileSync(file, 'utf8');
const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'seedRiskCertification',
);
if (!declaration) throw Error('ACTUAL_NATIVE_RISK_SEED_REQUIRED');
const text = declaration.getText(parsed);
if (!text.startsWith('export async function seedRiskCertification('))
  throw Error('REVIEW_NATIVE_RISK_SEED_EXPORT');
const body = ts.transpileModule(text.slice('export '.length), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

it('retains the complete prior native seed and scheduler/review source bytes beneath reviewed preparation changes', () => {
  for (const [path, expected] of [
    [file, '6b73c812085a6e1230fa0bc01a34c1525b0ed42c5832c5908056d35e5922f54c'],
    [
      'scripts/database-cohorts.mjs',
      'eb202513d8d4f50ca9484bffa71e0ef6f9415914342616fc617ed646e4ac9b02',
    ],
    [
      'scripts/native-main-scopes.mjs',
      'de2c7a134a6bd29d3c3e7f5fd539462ece16ae976f7af37be05af9a7a5307193',
    ],
  ]) {
    const current = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
    const previous = beforeRiskSeedSetup(path, current);
    expect(createHash('sha256').update(previous).digest('hex')).toBe(expected);
    expect(beforeRiskSeedSetup(path, previous)).toBe(previous);
  }
});

it('rejects changed or duplicated native seed review blocks without hiding SQL or assertion changes', () => {
  const current = source.replaceAll('\r\n', '\n');
  const block = current.match(
    /^ {2}\/\/ BEGIN NATIVE RISK SEED LANES\n[\s\S]*?^ {2}\/\/ END NATIVE RISK SEED LANES\n/mu,
  )[0];
  const boundary = block.indexOf('\n') + 1;
  const changed = block.slice(0, boundary) + '  // unreviewed\n' + block.slice(boundary);
  for (const candidate of [current + block, current.replace(block, changed)])
    expect(() => beforeRiskSeedSetup(file, candidate)).toThrow('RISK_SEED_REVIEW_REQUIRED');
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function gate() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture({ blockRegistry = false, blockPolicy = false, failPolicy = false, missing } = {}) {
  const registryGate = gate(),
    policyGate = gate(),
    events = [];
  if (!blockRegistry) registryGate.resolve();
  if (!blockPolicy) policyGate.resolve();
  const policyFailure = Error('POLICY_FAILED');
  const registry = {
    putBatch: vi.fn(async (records) => {
      expect(records).toHaveLength(1);
      events.push('registry:put');
      return { ok: true, value: records };
    }),
    close: vi.fn(async () => {
      events.push('registry:closed');
    }),
  };
  const openRegistry = vi.fn(async () => {
    events.push('registry:opening');
    await registryGate.promise;
    return registry;
  });
  const portfolio = vi.fn(async () => {
    events.push('portfolio');
  });
  const draft = vi.fn(async (_binding, request) => {
    expect(events).toContain('portfolio');
    events.push('draft');
    return {
      id: randomUUID(),
      intentId: randomUUID(),
      command: { ...request.order, clientOrderId: '1' },
    };
  });
  const platform = vi.fn(async () => {
    events.push('platform');
    await policyGate.promise;
    if (failPolicy) throw policyFailure;
  });
  const user = vi.fn(async () => {
    expect(events).toContain('platform');
    events.push('user');
  });
  const checkComplete = () => {
    for (const event of ['registry:closed', 'portfolio', 'draft', 'platform', 'user'])
      expect(events).toContain(event);
  };
  const loss = vi.fn(async () => {
    checkComplete();
    events.push('loss');
  });
  const market = vi.fn(async () => {
    checkComplete();
    events.push('market');
  });
  const observation = vi.fn(async () => {
    checkComplete();
    expect(events).toContain('market');
    events.push('observation');
    return { status: 'APPLIED' };
  });
  const admin = vi.fn(async () => ({ rows: [] }));
  const ports = {
    admin: { query: admin },
    portfolio: { apply: portfolio },
    orders: { create: draft },
    platform: { update: platform },
    user: { update: user },
    loss: { append: loss },
    market: { publish: market },
    observer: { publish: observation },
    registryOptions: { connectionString: 'server-owned-fixture', environment: 'test' },
  };
  const actual = vm.runInNewContext(
    body + '\nseedRiskCertification;',
    {
      captureFixture,
      randomUUID,
      createPostgresInstrumentRegistry: openRegistry,
      expect,
      binding,
      snapshot,
      orderBindingSchema,
      riskLimitsSchema,
      riskNativeObservationSchema,
      marketSnapshotPublicationSchema,
      parseDecimal,
      Buffer,
      io: () => ({ signal: new AbortController().signal, deadline: Date.now() + 2500 }),
    },
    { filename: 'actual-native-risk-seed-fixture', timeout: 1000 },
  );
  const pending = actual(ports, missing).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  return {
    registryGate,
    policyGate,
    pending,
    registry,
    platform,
    user,
    portfolio,
    draft,
    loss,
    market,
    observation,
    admin,
    events,
    policyFailure,
  };
}

it('prepares independent policies and Portfolio/DRAFT while registry readiness is pending without publishing evidence', async () => {
  const f = fixture({ blockRegistry: true });
  let settled = false;
  f.pending.then(() => {
    settled = true;
  });
  try {
    await tick();
    expect(f.platform).toHaveBeenCalledTimes(1);
    expect(f.portfolio).toHaveBeenCalledTimes(1);
    expect(f.draft).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    for (const method of [f.loss, f.market, f.observation]) expect(method).not.toHaveBeenCalled();
  } finally {
    f.registryGate.resolve();
    await f.pending;
  }
});

it('drains a pending registry after policy failure before rejecting and never publishes ready evidence', async () => {
  const f = fixture({ blockRegistry: true, failPolicy: true });
  let settled = false;
  f.pending.then(() => {
    settled = true;
  });
  try {
    await tick();
    expect(f.platform).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    f.registryGate.resolve();
    expect((await f.pending).error).toBe(f.policyFailure);
    expect(f.registry.close).toHaveBeenCalledTimes(1);
    for (const method of [f.loss, f.market, f.observation]) expect(method).not.toHaveBeenCalled();
  } finally {
    f.registryGate.resolve();
    await f.pending;
  }
});

it('drains an independent policy lane after registry failure without a partially ready source', async () => {
  const f = fixture({ blockRegistry: true, blockPolicy: true }),
    failure = Error('REGISTRY_FAILED');
  let settled = false;
  f.pending.then(() => {
    settled = true;
  });
  try {
    await tick();
    f.registryGate.reject(failure);
    await tick();
    expect(f.platform).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    f.policyGate.resolve();
    expect((await f.pending).error).toBe(failure);
    for (const method of [f.loss, f.market, f.observation]) expect(method).not.toHaveBeenCalled();
  } finally {
    f.registryGate.resolve();
    f.policyGate.resolve();
    await f.pending;
  }
});

it.each([undefined, 'LOSS', 'OBSERVATION'])(
  'retains all actual seed operations and deliberate missing %s evidence',
  async (missing) => {
    const f = fixture({ missing });
    const result = await f.pending;
    expect(result.error).toBeUndefined();
    expect(result.value.key.intentId).toBe(result.value.created.intentId);
    for (const method of [
      f.registry.putBatch,
      f.registry.close,
      f.portfolio,
      f.draft,
      f.platform,
      f.user,
      f.market,
    ])
      expect(method).toHaveBeenCalledTimes(1);
    expect(f.admin).toHaveBeenCalledTimes(7);
    expect(f.loss).toHaveBeenCalledTimes(missing === 'LOSS' ? 0 : 1);
    expect(f.observation).toHaveBeenCalledTimes(missing === 'OBSERVATION' ? 0 : 1);
    expect(result.value.observed).toEqual(
      missing === 'OBSERVATION' ? undefined : { status: 'APPLIED' },
    );
  },
);
