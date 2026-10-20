import { afterEach, expect, it, vi } from 'vitest';
const fake = vi.hoisted<{
  queries: string[];
  safe: boolean;
  commitReject: boolean;
  onCommit: (() => void) | undefined;
  end: () => Promise<void>;
}>(() => ({
  queries: [],
  safe: true,
  commitReject: false,
  onCommit: undefined,
  end: () => Promise.resolve(),
}));
// Only SQL protocol outcomes are mocked here. The other suite owns real hung
// TCP sockets; these fixtures are not PostgreSQL/role/financial acceptance.
vi.mock('pg', () => ({
  Client: class {
    on() {}
    async connect() {}
    query(text: string) {
      fake.queries.push(text);
      if (text === 'COMMIT') {
        fake.onCommit?.();
        if (fake.commitReject) return Promise.reject(Error('PRIVATE_CREDENTIAL_CANARY'));
      }
      return Promise.resolve({ rows: text.includes(' AS safe') ? [{ safe: fake.safe }] : [] });
    }
    async end() {
      await fake.end();
    }
  },
}));
import { openPaperAdmissionDatabase } from '../src/admission-database.js';

const options = {
  connectionString: 'postgresql://fixture:private-fixture@127.0.0.1/paper',
  environment: 'test' as const,
};
const tenant = '11111111-1111-4111-8111-111111111111';
const io = (signal = new AbortController().signal, ms = 2500) => ({
  signal,
  deadline: Date.now() + ms,
});
afterEach(() => {
  fake.safe = true;
  fake.commitReject = false;
  fake.onCommit = undefined;
  fake.end = () => Promise.resolve();
  fake.queries = [];
});

it('executes one bounded transaction and clears the connection instead of exporting a grant', async () => {
  const db = await openPaperAdmissionDatabase(options);
  fake.queries = [];
  try {
    expect(
      await db.transaction(tenant, io(), async (sql) => {
        await sql.query('SELECT 42');
        return 'transport-only';
      }),
    ).toBe('transport-only');
    expect(fake.queries).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      "SELECT set_config('app.tenant_id',$1,true)",
      'SELECT 42',
      'COMMIT',
    ]);
  } finally {
    await db.close();
  }
});
it('retains four pending work slots, rejects overflow and releases a slot only after abort settles', async () => {
  const db = await openPaperAdmissionDatabase(options),
    controllers = Array.from({ length: 4 }, () => new AbortController());
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  let entered = 0;
  const pending = controllers.map((c) =>
    db.transaction(tenant, io(c.signal), async () => {
      if (++entered === 4) start();
      return new Promise<never>(() => {});
    }),
  );
  for (const p of pending) void p.catch(() => {});
  try {
    await started;
    await expect(db.transaction(tenant, io(), () => Promise.resolve(null))).rejects.toThrow(
      'PAPER_ADMISSION_BUSY',
    );
    controllers[0]!.abort();
    await expect(pending[0]).rejects.toThrow('PAPER_ADMISSION_ABORTED');
    expect(await db.transaction(tenant, io(), () => Promise.resolve('replacement'))).toBe(
      'replacement',
    );
  } finally {
    await db.close();
    await Promise.allSettled(pending);
  }
});
it('lost COMMIT returns uncertainty once without replaying a mutation or exposing SQL details', async () => {
  const db = await openPaperAdmissionDatabase(options);
  fake.queries = [];
  fake.commitReject = true;
  try {
    try {
      await db.transaction(tenant, io(), () => Promise.resolve('not-a-grant'));
      throw Error('expected failure');
    } catch (error) {
      expect((error as Error).message).toBe('PAPER_ADMISSION_UNCERTAIN');
      expect(JSON.stringify(error)).not.toContain('PRIVATE_CREDENTIAL_CANARY');
    }
    expect(fake.queries.filter((q) => q === 'COMMIT')).toHaveLength(1);
    expect(fake.queries).not.toContain('ROLLBACK');
  } finally {
    await db.close();
  }
});
it('a signal aborted during an acknowledged COMMIT never publishes the result', async () => {
  const db = await openPaperAdmissionDatabase(options),
    c = new AbortController();
  fake.queries = [];
  fake.onCommit = () => c.abort();
  try {
    await expect(
      db.transaction(tenant, io(c.signal), () => Promise.resolve('not-a-grant')),
    ).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
    expect(fake.queries.filter((q) => q === 'COMMIT')).toHaveLength(1);
  } finally {
    await db.close();
  }
});
it('closes a hung internal calculation and refuses all later work', async () => {
  const db = await openPaperAdmissionDatabase(options);
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const pending = db.transaction(tenant, io(), async () => {
    start();
    return new Promise<never>(() => {});
  });
  void pending.catch(() => {});
  await started;
  await db.close();
  await expect(pending).rejects.toThrow('PAPER_ADMISSION_CLOSED');
  const count = fake.queries.length;
  await expect(db.transaction(tenant, io(), () => Promise.resolve(null))).rejects.toThrow(
    'PAPER_ADMISSION_CLOSED',
  );
  expect(fake.queries).toHaveLength(count);
});
it('failed physical cleanup quarantines the driver and cannot publish a committed result', async () => {
  const db = await openPaperAdmissionDatabase(options);
  fake.end = () => new Promise<void>(() => {});
  await expect(db.transaction(tenant, io(), () => Promise.resolve('not-a-grant'))).rejects.toThrow(
    'PAPER_ADMISSION_UNCERTAIN',
  );
  await expect(db.transaction(tenant, io(), () => Promise.resolve(null))).rejects.toThrow(
    'PAPER_ADMISSION_CLOSED',
  );
  await expect(db.close()).rejects.toThrow('PAPER_ADMISSION_CLOSE_FAILED');
});
it('refuses an unsafe constructor authority without exposing its SQL transport', async () => {
  fake.safe = false;
  await expect(openPaperAdmissionDatabase(options)).rejects.toThrow('PAPER_ADMISSION_ROLE_UNSAFE');
  expect(fake.queries).toContain('ROLLBACK');
});
it('validates tenant and context before opening a transaction', async () => {
  const db = await openPaperAdmissionDatabase(options);
  fake.queries = [];
  try {
    await expect(
      db.transaction('untrusted-tenant', io(), () => Promise.resolve(null)),
    ).rejects.toThrow('PAPER_ADMISSION_INPUT');
    const c = new AbortController();
    c.abort();
    await expect(db.transaction(tenant, io(c.signal), () => Promise.resolve(null))).rejects.toThrow(
      'PAPER_ADMISSION_ABORTED',
    );
    expect(fake.queries).toEqual([]);
  } finally {
    await db.close();
  }
});
