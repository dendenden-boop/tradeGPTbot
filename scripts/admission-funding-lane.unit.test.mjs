import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { runIndependentFixtureSetup } from '../packages/database/test/fixtures/native-default-port.js';
import { beforeAdmissionFundingLane } from './admission-funding-lane-legacy.mjs';

const file = 'packages/database/test/paper-admission.integration.test.ts';
const source = readFileSync(file, 'utf8');
const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'tenantReady',
);
if (!declaration) throw Error('ACTUAL_ADMISSION_FIXTURE_REQUIRED');
const body = ts.transpileModule(declaration.getText(parsed), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

it('retains every accepted native source byte beneath the exact reviewed funding-lane block', () => {
  const current = source.replaceAll('\r\n', '\n');
  const predecessor = beforeAdmissionFundingLane(file, current);
  expect(createHash('sha256').update(predecessor).digest('hex')).toBe(
    'c9fe097d55c5e8d2e61d0311a99b5d44595a53e01f8ec1b17c364bd1030ed374',
  );
  expect(beforeAdmissionFundingLane(file, predecessor)).toBe(predecessor);
});

it('retains every preceding scheduler byte beneath its renewed exact fixture fingerprint', () => {
  const path = 'scripts/database-cohorts.mjs';
  const current = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  expect(createHash('sha256').update(beforeAdmissionFundingLane(path, current)).digest('hex')).toBe(
    '6843c437099f6bab1273898b31d7b8f3d4e360db6f761c78fa224154ad4c865b',
  );
});

it('rejects altered or duplicated funding-lane review blocks without concealing native changes', () => {
  const current = source.replaceAll('\r\n', '\n');
  const block = current.match(
    /^\/\/ BEGIN ADMISSION FUNDING LANE\n[\s\S]*?^\/\/ END ADMISSION FUNDING LANE\n/mu,
  )[0];
  const boundary = block.indexOf('\n') + 1;
  const changed = block.slice(0, boundary) + '// unreviewed\n' + block.slice(boundary);
  for (const candidate of [current + block, current.replace(block, changed)])
    expect(() => beforeAdmissionFundingLane(file, candidate)).toThrow(
      'ADMISSION_FUNDING_REVIEW_REQUIRED',
    );
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
function fixture({ failPolicy = false } = {}) {
  const funding = gate(),
    events = [],
    policyFailure = Error('POLICY_FAILED');
  const frame = {
    c: { owner: { tenantId: 'isolated-tenant' } },
    binding: { accountId: 'isolated-account' },
    draft: { order: { type: 'LIMIT' } },
    f: {
      s: { timestamp: 0, ticker: {}, book: {} },
      p: { timestamp: 0, trade: {} },
    },
  };
  const fundCash = vi.fn(async (configuration) => {
    expect(configuration).toBe(frame.c);
    events.push('funding:start');
    const id = await funding.promise;
    events.push('funding:done');
    return id;
  });
  const ensurePolicies = vi.fn(async (tenantId) => {
    expect(tenantId).toBe(frame.c.owner.tenantId);
    events.push('policy:start');
    if (failPolicy) throw policyFailure;
    events.push('policy:done');
  });
  const create = vi.fn(async (binding, draft) => {
    expect(binding).toBe(frame.binding);
    expect(draft).toBe(frame.draft);
    expect(events).toContain('funding:done');
    events.push('draft');
    return { intentId: 'isolated-intent' };
  });
  const snapshot = vi.fn(async (payload) => {
    expect(payload).toBe(frame.f.s);
    expect(events).toContain('funding:done');
    events.push('snapshot');
  });
  const trade = vi.fn(async (payload) => {
    expect(payload).toBe(frame.f.p);
    expect(events).toContain('funding:done');
    events.push('trade');
  });
  const initialize = vi.fn(async (owner) => {
    expect(owner).toBe(frame.c.owner);
    for (const event of ['funding:done', 'draft', 'snapshot', 'trade', 'policy:done'])
      expect(events).toContain(event);
    events.push('book');
  });
  const bindings = {
    fixture: async () => frame,
    fundCash,
    runIndependentFixtureSetup,
    openOrders: async () => ({ create }),
    publicMarketFixturePorts: {
      snapshots: async () => ({ publish: snapshot }),
      trades: async () => ({ publish: trade }),
    },
    ensurePolicies,
    openBook: async () => ({ initialize }),
    io: () => ({ signal: new AbortController().signal, deadline: Date.now() + 2500 }),
    parseDecimal: (value) => value,
    draftSchema: { parse: (value) => value },
  };
  const actual = vm.runInNewContext(body + '\ntenantReady;', bindings, {
    filename: 'actual-native-admission-setup-fixture',
    timeout: 1000,
  });
  const pending = actual().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  return {
    funding,
    pending,
    frame,
    events,
    ensurePolicies,
    create,
    snapshot,
    trade,
    initialize,
    fundCash,
    policyFailure,
  };
}

it('starts independent actual policy setup while the one shared funding operation is pending', async () => {
  const f = fixture();
  try {
    await tick();
    expect(f.fundCash).toHaveBeenCalledTimes(1);
    expect(f.ensurePolicies).toHaveBeenCalledTimes(1);
  } finally {
    f.funding.resolve('funding-id');
    await f.pending;
  }
});

it('retains funding before draft and market timestamps/publications, and book after all lanes', async () => {
  const f = fixture();
  try {
    await tick();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(f.trade).not.toHaveBeenCalled();
    expect(f.initialize).not.toHaveBeenCalled();
    expect(f.frame.f.s.timestamp).toBe(0);
    expect(f.frame.f.p.timestamp).toBe(0);
    const completedAt = Date.now();
    f.funding.resolve('funding-id');
    const result = await f.pending;
    expect(result.error).toBeUndefined();
    expect(result.value.fundingId).toBe('funding-id');
    expect(result.value.request).toEqual({ owner: f.frame.c.owner, intentId: 'isolated-intent' });
    expect(f.frame.f.s.timestamp).toBeGreaterThanOrEqual(completedAt);
    expect(f.frame.f.p.timestamp).toBeGreaterThanOrEqual(completedAt);
    for (const method of [
      f.fundCash,
      f.ensurePolicies,
      f.create,
      f.snapshot,
      f.trade,
      f.initialize,
    ])
      expect(method).toHaveBeenCalledTimes(1);
  } finally {
    f.funding.resolve('funding-id');
    await f.pending;
  }
});

it('drains pending funding after an independent policy failure before rejecting without bootstrap', async () => {
  const f = fixture({ failPolicy: true });
  let settled = false;
  f.pending.then(() => {
    settled = true;
  });
  try {
    await tick();
    expect(f.ensurePolicies).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    expect(f.initialize).not.toHaveBeenCalled();
    f.funding.resolve('funding-id');
    expect((await f.pending).error).toBe(f.policyFailure);
    expect(f.initialize).not.toHaveBeenCalled();
  } finally {
    f.funding.resolve('funding-id');
    await f.pending;
  }
});

it('runs and drains independent policy setup on funding failure without draft, market or book effects', async () => {
  const f = fixture(),
    failure = Error('FUNDING_FAILED');
  try {
    await tick();
    f.funding.reject(failure);
    expect((await f.pending).error).toBe(failure);
    expect(f.ensurePolicies).toHaveBeenCalledTimes(1);
    for (const method of [f.create, f.snapshot, f.trade, f.initialize])
      expect(method).not.toHaveBeenCalled();
  } finally {
    f.funding.resolve('funding-id');
    await f.pending;
  }
});
