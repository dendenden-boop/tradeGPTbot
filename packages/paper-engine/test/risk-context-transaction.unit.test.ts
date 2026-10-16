import { afterEach, expect, it, vi } from 'vitest';
import { riskContextFixture } from './risk-context-fixtures.js';
const fake = vi.hoisted<{
  queries: string[];
  result: unknown;
  commitFails: boolean;
  end(): Promise<void>;
}>(() => ({
  queries: [],
  result: undefined,
  commitFails: false,
  end: () => Promise.resolve(),
}));
vi.mock('pg', () => ({
  Client: class {
    on() {}
    async connect() {}
    query(sql: string) {
      fake.queries.push(sql);
      if (sql === 'COMMIT' && fake.commitFails) throw new Error('PRIVATE SQL/CREDENTIAL DETAIL');
      return Promise.resolve({
        rows: sql.includes(' AS safe')
          ? [{ safe: true }]
          : sql.includes('capture_risk_context($1')
            ? [{ result: fake.result }]
            : [],
      });
    }
    async end() {
      await fake.end();
    }
  },
}));
import { createPostgresPaperRiskContextSource } from '../src/postgres-risk-context.js';
afterEach(() => {
  vi.restoreAllMocks();
  fake.commitFails = false;
  fake.end = () => Promise.resolve();
  fake.queries = [];
});
async function fixture() {
  const f = riskContextFixture();
  fake.result = f.wire;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(200000);
  const h = await createPostgresPaperRiskContextSource({
    connectionString: 'postgresql://context:fixture@127.0.0.1/test',
    environment: 'test',
  });
  fake.queries = [];
  return { f, clock, h, io: { signal: new AbortController().signal, deadline: 202000 } };
}
it('uses exactly one fixed context RPC and known COMMIT; separate source RPCs cannot substitute', async () => {
  const { f, h, io } = await fixture();
  try {
    await h.read(f.request, io);
    expect(fake.queries).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      "SELECT set_config('app.tenant_id',$1,true)",
      'SELECT ctp_paper.capture_risk_context($1::jsonb) AS result',
      'COMMIT',
    ]);
  } finally {
    await h.close();
  }
});
it('uncertain read COMMIT exposes no context or raw database error', async () => {
  const { f, h, io } = await fixture();
  fake.commitFails = true;
  try {
    await expect(h.read(f.request, io)).rejects.toThrow('PAPER_RISK_CONTEXT_UNCERTAIN');
  } finally {
    await h.close();
  }
});
it.each(['deadline', 'abort', 'stale'] as const)(
  'post-COMMIT physical settlement cannot return %s evidence',
  async (kind) => {
    const { f, clock, h, io } = await fixture(),
      controller = new AbortController();
    if (kind === 'stale') io.deadline = 210000;
    fake.end = () => {
      if (kind === 'abort') controller.abort();
      else clock.mockReturnValue(kind === 'deadline' ? 202000 : 205001);
      return Promise.resolve();
    };
    try {
      await expect(h.read(f.request, { ...io, signal: controller.signal })).rejects.toThrow(
        kind === 'stale' ? 'PAPER_RISK_CONTEXT_STALE' : 'PAPER_RISK_CONTEXT_ABORTED',
      );
      expect(fake.queries).toContain('COMMIT');
    } finally {
      await h.close();
    }
  },
);
it('conflicting captured epochs roll back before COMMIT with a sanitized error', async () => {
  const { f, h, io } = await fixture();
  f.wire.authority.identity.userSessionEpoch = '1';
  try {
    await expect(h.read(f.request, io)).rejects.toThrow('PAPER_RISK_CONTEXT_EPOCH');
    expect(fake.queries.at(-1)).toBe('ROLLBACK');
    expect(fake.queries).not.toContain('COMMIT');
  } finally {
    await h.close();
  }
});
