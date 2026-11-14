import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as server from '../src/risk.js';
import * as pure from '../src/index.js';
import { historicalInventoryFixture } from './historical-inventory-fixtures.js';
import { currentRiskFixture } from './current-risk-fixtures.js';
import { decodePaperCurrentRiskContents } from '../src/postgres-current-risk.js';

const fake = vi.hoisted<{
  queries: string[];
  safe: boolean;
  payload: unknown;
  failure: Error | null;
}>(() => ({
  queries: [],
  safe: true,
  payload: null,
  failure: null,
}));
vi.mock('pg', () => ({
  Client: class {
    on() {}
    async connect() {}
    async end() {}
    async query(text: string) {
      await Promise.resolve();
      fake.queries.push(text);
      if (text.includes(' AS safe')) return { rows: [{ safe: fake.safe }] };
      if (text.includes(' AS result')) {
        if (fake.failure) throw fake.failure;
        return { rows: [{ result: fake.payload }] };
      }
      return { rows: [] };
    }
  },
}));
interface Coordinator {
  certify(request: unknown, context: ReturnType<typeof io>): Promise<unknown>;
  readCurrent(request: unknown, context: ReturnType<typeof io>): Promise<unknown>;
  advanceLoss(request: unknown, context: ReturnType<typeof io>): Promise<unknown>;
  close(): Promise<void>;
}
const ports: Coordinator[] = [];
const options = {
  connectionString: 'postgresql://paper_current:unit-password@127.0.0.1/current_risk',
  environment: 'test',
};
function entry() {
  const value = (server as unknown as Record<string, unknown>)[
    'createPostgresPaperCurrentRiskCoordinator'
  ];
  if (typeof value !== 'function') throw Error('PAPER_CURRENT_RISK_COORDINATOR_MISSING');
  return value as (options: unknown) => Promise<Coordinator>;
}
const io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2000 });
function request() {
  const f = historicalInventoryFixture(1);
  return { ...f.request, kind: 'PAPER_CURRENT_RISK_CERTIFY' };
}
async function open() {
  const value = await entry()(options);
  ports.push(value);
  fake.queries.length = 0;
  return value;
}
beforeEach(() => {
  Object.assign(fake, { queries: [], safe: true, payload: null, failure: null });
});
afterEach(async () => {
  for (const port of ports.splice(0)) await port.close();
  vi.restoreAllMocks();
});

it('requires the server current-Risk coordinator factory before accepting certificate content', () => {
  expect(
    (server as unknown as Record<string, unknown>)['createPostgresPaperCurrentRiskCoordinator'],
  ).toBeTypeOf('function');
});
it('decodes the full fixed-source graph and preserves an immutable certificate across repeated reads', async () => {
  const f = currentRiskFixture();
  vi.spyOn(Date, 'now').mockReturnValue(f.now);
  const port = await open();
  fake.payload = f.reply();
  expect(decodePaperCurrentRiskContents(f.reply().certificate, f.request, f.now).id).toBe(
    f.certificate.id,
  );
  const certificate = await port.certify(f.request, io());
  expect(certificate).toMatchObject({
    id: f.certificate.id,
    revision: f.certificate.revision,
    loss: { actualEquity: f.inventory.valuation.equity, complete: true },
    snapshot: { lossBaselineComplete: true, market: { executionBoundEnforced: false } },
  });
  expect(certificate).not.toHaveProperty('grant');
  expect(certificate).not.toHaveProperty('permit');
  expect(await port.readCurrent(f.request, io())).toEqual(certificate);
  expect(fake.queries.filter((q) => q === 'COMMIT')).toHaveLength(2);
});
it('does not expose certification or loss-journal authority from the pure root', () => {
  expect(pure).not.toHaveProperty('createPostgresPaperCurrentRiskCoordinator');
  expect(pure).not.toHaveProperty('decodePaperCurrentRiskCertificate');
});
it.each([
  [
    'inventory seal',
    (f: ReturnType<typeof currentRiskFixture>) => {
      f.source.inventory.hash = '0'.repeat(64);
    },
  ],
  [
    'source head identity',
    (f: ReturnType<typeof currentRiskFixture>) => {
      f.source.sourceHeads = '0'.repeat(64);
    },
  ],
  [
    'policy refresh',
    (f: ReturnType<typeof currentRiskFixture>) => {
      f.source.policies[0]!.version = '9007199254740994';
    },
  ],
  [
    'checkpoint binding',
    (f: ReturnType<typeof currentRiskFixture>) => {
      f.source.lossReference.hash = '0'.repeat(64);
    },
  ],
  [
    'missing kill switch',
    (f: ReturnType<typeof currentRiskFixture>) => {
      f.source.controls = f.seal({ global: [], tenant: [], activePauses: [], circuits: [] });
    },
  ],
  [
    'loss equity substitution',
    (f: ReturnType<typeof currentRiskFixture>) => {
      f.source.lossInput.current.equity = '1';
    },
  ],
] as const)(
  'rejects a resealed outer certificate with invalid %s before COMMIT',
  async (_name, mutate) => {
    const f = currentRiskFixture();
    vi.spyOn(Date, 'now').mockReturnValue(f.now);
    const port = await open();
    mutate(f);
    fake.payload = f.reply();
    await expect(port.certify(f.request, io())).rejects.toThrow(/^PAPER_/u);
    expect(fake.queries).not.toContain('COMMIT');
    expect(fake.queries.filter((q) => q.includes(' AS result'))).toHaveLength(1);
  },
);
it('does not renew original source clocks when reading an immutable certificate later', async () => {
  const f = currentRiskFixture(),
    clock = vi.spyOn(Date, 'now').mockReturnValue(f.now),
    port = await open();
  fake.payload = f.reply();
  const first = await port.certify(f.request, io());
  clock.mockReturnValue(f.now + 100);
  expect(await port.readCurrent(f.request, io())).toEqual(first);
  clock.mockReturnValue(f.now + 1000);
  await expect(port.readCurrent(f.request, io())).rejects.toThrow(/^PAPER_/u);
  expect(fake.queries.filter((q) => q === 'COMMIT')).toHaveLength(2);
});
it.each([
  { backend: () => ({ complete: true }) },
  { client: {} },
  { work: () => ({ grant: true }) },
  { clock: () => 1 },
  { role: 'postgres' },
  { tenantId: 'caller-tenant' },
  { endpoint: 'https://caller.invalid' },
  { credentials: 'caller-secret' },
])('rejects caller-supplied acquisition authority %j before connecting', async (extra) => {
  await expect(entry()({ ...options, ...extra })).rejects.toThrow(/^PAPER_/u);
  expect(fake.queries).toEqual([]);
});
it('rejects a physical runtime with a substituted SQL role', async () => {
  fake.safe = false;
  await expect(entry()(options)).rejects.toThrow('PAPER_ADMISSION_ROLE_UNSAFE');
  expect(fake.queries.some((q) => q.includes(' AS result'))).toBe(false);
});
it.each(['certify', 'readCurrent', 'advanceLoss'] as const)(
  '%s rejects added certificate, policy and complete-history claims before SQL',
  async (method) => {
    const port = await open();
    await expect(
      port[method](
        {
          ...request(),
          certificate: { id: 'caller-certificate', hash: 'a'.repeat(64) },
          policies: [],
          loss: { complete: true, peak: '1000000' },
        },
        io(),
      ),
    ).rejects.toThrow(/^PAPER_/u);
    expect(fake.queries).toEqual([]);
  },
);
it.each(['certify', 'readCurrent', 'advanceLoss'] as const)(
  '%s rejects a contradictory native mode before SQL',
  async (method) => {
    const port = await open(),
      r = request();
    await expect(
      port[method](
        { ...r, admission: { ...r.admission, binding: { ...r.admission.binding, mode: 'DEMO' } } },
        io(),
      ),
    ).rejects.toThrow(/^PAPER_/u);
    expect(fake.queries).toEqual([]);
  },
);
it('does not read selector getters while rejecting an accessor-bearing request', async () => {
  const port = await open(),
    r = request();
  let reads = 0;
  Object.defineProperty(r, 'authorization', {
    enumerable: true,
    get() {
      reads++;
      return { permissionEpoch: '0', userSessionEpoch: '0' };
    },
  });
  await expect(port.certify(r, io())).rejects.toThrow(/^PAPER_/u);
  expect(reads).toBe(0);
  expect(fake.queries).toEqual([]);
});
it('rejects a cyclic selector without SQL or unbounded recursion', async () => {
  const port = await open(),
    r: Record<string, unknown> = request();
  r['admission'] = r;
  await expect(port.certify(r, io())).rejects.toThrow(/^PAPER_/u);
  expect(fake.queries).toEqual([]);
});
it.each(['certify', 'readCurrent', 'advanceLoss'] as const)(
  '%s observes abort and deadline before starting SQL',
  async (method) => {
    const port = await open(),
      abort = new AbortController();
    abort.abort();
    await expect(port[method](request(), { ...io(), signal: abort.signal })).rejects.toThrow(
      /^PAPER_/u,
    );
    await expect(port[method](request(), { ...io(), deadline: Date.now() - 1 })).rejects.toThrow(
      /^PAPER_/u,
    );
    expect(fake.queries).toEqual([]);
  },
);
it('rejects certificate-shaped JSON without its complete fixed-source graph', async () => {
  const port = await open();
  fake.payload = {
    kind: 'PAPER_CURRENT_RISK_CERTIFICATE',
    id: '00000000-0000-4000-8000-000000000001',
    revision: '1',
    hash: 'a'.repeat(64),
    inventory: { complete: true },
    loss: { complete: true, adjustedCurrentEquity: '1', adjustedPeakEquity: '1' },
    snapshot: { lossBaselineComplete: true },
  };
  await expect(port.certify(request(), io())).rejects.toThrow(/^PAPER_/u);
  expect(fake.queries.filter((q) => q.includes(' AS result'))).toHaveLength(1);
  expect(fake.queries).not.toContain('COMMIT');
});
it('does not expose private SQL or credentials from a failed capture', async () => {
  const port = await open();
  fake.failure = Error('private SQL postgresql://private:credential@hidden-host/native');
  const error: unknown = await port.certify(request(), io()).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toMatch(/^Error: PAPER_/u);
  expect(String(error)).not.toMatch(/private SQL|credential|hidden-host/u);
  expect(fake.queries.filter((q) => q.includes(' AS result'))).toHaveLength(1);
});
