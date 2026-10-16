import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createPaperRuntimeWorkerCore } from '../src/runtime-worker-core.js';
import type {
  PaperRuntimeCollector,
  PaperRuntimeCollection,
} from '../src/runtime-collector-core.js';
import type { PaperOwner } from '../src/configuration-domain.js';
import { runtimeFixture } from './runtime-fixtures.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}
function fixture(count = 1) {
  vi.useFakeTimers();
  const f = runtimeFixture(Date.now());
  const owners = Array.from({ length: count }, (_, i) =>
    i === 0 ? { ...f.owner } : { ...f.owner, accountId: randomUUID() },
  );
  const publication = (owner: PaperOwner = owners[0]!) => ({
    ...f.publication,
    id: randomUUID(),
    observation: { ...f.publication.observation, owner },
  });
  const published = (owner: PaperOwner = owners[0]!): PaperRuntimeCollection => {
    const p = publication(owner);
    return {
      kind: 'PUBLISHED',
      publication: p,
      receipt: {
        id: p.id,
        owner,
        configurationId: p.observation.configurationId,
        revision: '4',
        hash: 'a'.repeat(64),
        publishedAt: Date.now(),
        replayed: false,
      },
    };
  };
  const collector = {
    collect: vi.fn<PaperRuntimeCollector['collect']>((owner) => Promise.resolve(published(owner))),
    reconcile: vi.fn<PaperRuntimeCollector['reconcile']>(() => Promise.resolve(null)),
    close: vi.fn<PaperRuntimeCollector['close']>(() => Promise.resolve()),
  } satisfies PaperRuntimeCollector;
  const settings = { owners, intervalMs: 100 };
  return {
    owners,
    publication,
    published,
    collector,
    settings,
    create: () => createPaperRuntimeWorkerCore(collector, settings),
  };
}

it('is idle until run, takes fresh sequential cycles with bounded deadlines and returns no financial authority', async () => {
  const f = fixture(),
    worker = f.create(),
    c = new AbortController();
  expect(worker.state()).toBe('IDLE');
  expect(f.collector.collect).not.toHaveBeenCalled();
  const task = worker.run(c.signal);
  await flush();
  expect(worker.state()).toBe('RUNNING');
  await vi.advanceTimersByTimeAsync(200);
  expect(f.collector.collect).toHaveBeenCalledTimes(3);
  for (const [owner, io] of f.collector.collect.mock.calls) {
    expect(owner).toEqual(f.owners[0]);
    expect(io.deadline).toBeLessThanOrEqual(Date.now() + 3000);
  }
  c.abort();
  const result = await task;
  expect(result).toEqual({
    state: 'STOPPED',
    uncertain: [],
    collectionFailed: false,
    closed: true,
  });
  expect(Object.isFrozen(result)).toBe(true);
  for (const key of ['approve', 'reserve', 'permit', 'execute', 'healthy'])
    expect(key in worker).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it('never overlaps or catches up a delayed account cycle', async () => {
  const f = fixture(),
    gate = deferred<PaperRuntimeCollection>();
  f.collector.collect.mockImplementationOnce(() => gate.promise);
  const worker = f.create(),
    c = new AbortController(),
    task = worker.run(c.signal);
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.collector.collect).toHaveBeenCalledTimes(1);
  gate.resolve(f.published());
  await flush();
  await vi.advanceTimersByTimeAsync(99);
  expect(f.collector.collect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.collector.collect).toHaveBeenCalledTimes(2);
  c.abort();
  await task;
});
it('runs at most four distinct owner loops and closes only after their physical collector gate settles', async () => {
  const f = fixture(4),
    gate = deferred<PaperRuntimeCollection>(),
    physical = deferred<void>();
  f.collector.collect.mockImplementation(() => gate.promise);
  f.collector.close.mockImplementation(() => physical.promise);
  const worker = f.create(),
    task = worker.run(new AbortController().signal);
  await flush();
  expect(f.collector.collect).toHaveBeenCalledTimes(4);
  const closing = worker.close();
  let ended = false;
  void closing.then(() => {
    ended = true;
  });
  await flush();
  expect(ended).toBe(false);
  expect(worker.state()).toBe('STOPPING');
  gate.resolve(f.published());
  physical.resolve();
  await closing;
  expect((await task).closed).toBe(true);
  expect(f.collector.close).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it('copies and freezes server inventory rather than following later caller mutations', async () => {
  const f = fixture(),
    original = { ...f.owners[0]! },
    worker = f.create(),
    c = new AbortController();
  f.owners[0]!.accountId = randomUUID();
  f.settings.intervalMs = 1000;
  const task = worker.run(c.signal);
  await flush();
  await vi.advanceTimersByTimeAsync(100);
  expect(f.collector.collect).toHaveBeenCalledTimes(2);
  expect(f.collector.collect.mock.calls[0]![0]).toEqual(original);
  expect(Object.isFrozen(f.collector.collect.mock.calls[0]![0])).toBe(true);
  c.abort();
  await task;
});
it('pre-abort closes owned ports without sampling or scheduling', async () => {
  const f = fixture(),
    worker = f.create(),
    c = new AbortController();
  c.abort();
  expect((await worker.run(c.signal)).state).toBe('STOPPED');
  expect(f.collector.collect).not.toHaveBeenCalled();
  expect(f.collector.close).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it('invalid run input cannot start or consume the idle worker', async () => {
  const f = fixture(),
    worker = f.create();
  await expect(worker.run({} as AbortSignal)).rejects.toThrow('PAPER_RUNTIME_WORKER_INPUT');
  expect(worker.state()).toBe('IDLE');
  await worker.close();
});
it('rejects a second concurrent run without starting another cycle', async () => {
  const f = fixture(),
    worker = f.create(),
    c = new AbortController(),
    task = worker.run(c.signal);
  await flush();
  await expect(worker.run(c.signal)).rejects.toThrow('PAPER_RUNTIME_WORKER_STATE');
  expect(f.collector.collect).toHaveBeenCalledTimes(1);
  c.abort();
  await task;
});
it('cannot restart a terminated instance or silently restore admission', async () => {
  const f = fixture(),
    worker = f.create(),
    c = new AbortController();
  c.abort();
  await worker.run(c.signal);
  await expect(worker.run(new AbortController().signal)).rejects.toThrow(
    'PAPER_RUNTIME_WORKER_STATE',
  );
});
it('close before run is idempotent and never samples', async () => {
  const f = fixture(),
    worker = f.create(),
    a = worker.close(),
    b = worker.close();
  expect(a).toBe(b);
  await a;
  expect(worker.state()).toBe('STOPPED');
  expect(f.collector.collect).not.toHaveBeenCalled();
  expect(f.collector.close).toHaveBeenCalledTimes(1);
  await expect(worker.run(new AbortController().signal)).rejects.toThrow(
    'PAPER_RUNTIME_WORKER_STATE',
  );
});
it('abort during the post-cycle delay removes the timer and all future ticks', async () => {
  const f = fixture(),
    worker = f.create(),
    c = new AbortController(),
    task = worker.run(c.signal);
  await flush();
  c.abort();
  await task;
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.collector.collect).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it('UNCERTAIN retains the exact immutable original and never retries or reconciles automatically', async () => {
  const f = fixture(),
    p = f.publication();
  f.collector.collect.mockResolvedValue({ kind: 'UNCERTAIN', publication: p });
  const worker = f.create(),
    result = await worker.run(new AbortController().signal);
  expect(result).toEqual({
    state: 'UNCERTAIN',
    uncertain: [p],
    collectionFailed: false,
    closed: true,
  });
  expect(Object.isFrozen(result.uncertain[0]!.observation)).toBe(true);
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.collector.collect).toHaveBeenCalledTimes(1);
  expect(f.collector.reconcile).not.toHaveBeenCalled();
});
it('retains all four ambiguous outcomes created by group shutdown, not just the first', async () => {
  const f = fixture(4),
    publications = f.owners.map((o) => f.publication(o));
  f.collector.collect.mockImplementation((owner, io) => {
    const i = f.owners.findIndex((o) => o.accountId === owner.accountId),
      p = publications[i]!;
    if (i === 0) return Promise.resolve({ kind: 'UNCERTAIN', publication: p });
    return new Promise((resolve) =>
      io.signal.addEventListener('abort', () => resolve({ kind: 'UNCERTAIN', publication: p }), {
        once: true,
      }),
    );
  });
  const result = await f.create().run(new AbortController().signal);
  expect(result.state).toBe('UNCERTAIN');
  expect(result.uncertain).toEqual(publications);
  expect(f.collector.collect).toHaveBeenCalledTimes(4);
  expect(f.collector.reconcile).not.toHaveBeenCalled();
});
it('a definitive failure cannot hide another account UNKNOWN produced during shutdown', async () => {
  const f = fixture(2),
    p = f.publication(f.owners[1]);
  f.collector.collect.mockImplementation((owner, io) =>
    owner.accountId === f.owners[0]!.accountId
      ? Promise.reject(new Error('private-postgres-credential'))
      : new Promise((resolve) =>
          io.signal.addEventListener(
            'abort',
            () => resolve({ kind: 'UNCERTAIN', publication: p }),
            { once: true },
          ),
        ),
  );
  const result = await f.create().run(new AbortController().signal);
  expect(result).toEqual({
    state: 'UNCERTAIN',
    uncertain: [p],
    collectionFailed: true,
    closed: true,
  });
  expect(JSON.stringify(result)).not.toContain('private-postgres-credential');
});
it('a definitive collection error stops scheduling and returns sanitized failure without retry', async () => {
  const f = fixture();
  f.collector.collect.mockRejectedValue(new Error('private credential'));
  const worker = f.create(),
    result = await worker.run(new AbortController().signal);
  expect(result).toEqual({ state: 'FAILED', uncertain: [], collectionFailed: true, closed: true });
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.collector.collect).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain('private');
});
it('external abort after dispatch preserves UNKNOWN without labelling normal shutdown a collection failure', async () => {
  const f = fixture(),
    p = f.publication();
  f.collector.collect.mockImplementation(
    (_, io) =>
      new Promise((resolve) =>
        io.signal.addEventListener('abort', () => resolve({ kind: 'UNCERTAIN', publication: p }), {
          once: true,
        }),
      ),
  );
  const worker = f.create(),
    c = new AbortController(),
    task = worker.run(c.signal);
  await flush();
  c.abort();
  expect(await task).toEqual({
    state: 'UNCERTAIN',
    uncertain: [p],
    collectionFailed: false,
    closed: true,
  });
});
it('close failure preserves UNKNOWN and never claims the physical ports closed', async () => {
  const f = fixture(),
    p = f.publication();
  f.collector.collect.mockResolvedValue({ kind: 'UNCERTAIN', publication: p });
  f.collector.close.mockRejectedValue(new Error('private close details'));
  const worker = f.create(),
    result = await worker.run(new AbortController().signal);
  expect(result).toEqual({
    state: 'UNCERTAIN',
    uncertain: [p],
    collectionFailed: false,
    closed: false,
  });
  await expect(worker.close()).rejects.toThrow('PAPER_RUNTIME_WORKER_CLOSE_FAILED');
  expect(f.collector.close).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it('a hung close fails within 3000ms and late physical settlement cannot restore admission', async () => {
  const f = fixture(),
    physical = deferred<void>();
  f.collector.close.mockImplementation(() => physical.promise);
  const worker = f.create(),
    c = new AbortController(),
    task = worker.run(c.signal);
  await flush();
  const closing = worker.close(),
    rejected = expect(closing).rejects.toThrow('PAPER_RUNTIME_WORKER_CLOSE_FAILED');
  await vi.advanceTimersByTimeAsync(3000);
  await rejected;
  expect(await task).toEqual({
    state: 'FAILED',
    uncertain: [],
    collectionFailed: false,
    closed: false,
  });
  physical.resolve();
  await flush();
  expect(worker.state()).toBe('FAILED');
  await expect(worker.run(c.signal)).rejects.toThrow('PAPER_RUNTIME_WORKER_STATE');
  expect(worker.close()).toBe(closing);
  expect(vi.getTimerCount()).toBe(0);
});
it('300 successful cycles retain no receipt history and the next UNKNOWN halts without capacity exhaustion', async () => {
  const f = fixture(),
    p = f.publication();
  let cycles = 0;
  f.collector.collect.mockImplementation((owner) =>
    Promise.resolve(++cycles <= 300 ? f.published(owner) : { kind: 'UNCERTAIN', publication: p }),
  );
  const worker = f.create(),
    task = worker.run(new AbortController().signal);
  await vi.advanceTimersByTimeAsync(30000);
  expect((await task).uncertain).toEqual([p]);
  expect(cycles).toBe(301);
  expect(vi.getTimerCount()).toBe(0);
});
it('a negative committed observation is never converted into a health certificate or operational readiness', async () => {
  const f = fixture(),
    result = f.published();
  result.publication.observation.health.executor.status = 'UNKNOWN';
  f.collector.collect.mockResolvedValue(result);
  const worker = f.create(),
    c = new AbortController(),
    task = worker.run(c.signal);
  await flush();
  expect(worker.state()).toBe('RUNNING');
  expect(result.publication.observation.health.executor.status).toBe('UNKNOWN');
  c.abort();
  expect((await task).uncertain).toEqual([]);
});
