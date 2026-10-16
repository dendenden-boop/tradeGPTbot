import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi, afterEach } from 'vitest';
import { canonical } from '@ctp/portfolio';
import {
  createPaperRuntimeCollectorCore,
  type PaperRuntimeProbes,
  type PaperRuntimeProbe,
} from '../src/runtime-collector-core.js';
import { createUnavailablePaperRuntimeProbe } from '../src/runtime-collector.js';
import {
  decodePaperRuntimeContext,
  paperRuntimeDependencies,
  type PaperRuntimeObserver,
  type PaperRuntimePublication,
  type PaperRuntimeReceipt,
} from '../src/runtime-domain.js';
import { runtimeFixture } from './runtime-fixtures.js';

type MutableProbe = { -readonly [K in keyof PaperRuntimeProbe]: PaperRuntimeProbe[K] };
type MutableProbes = { -readonly [K in keyof PaperRuntimeProbes]: MutableProbe };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}
const io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2500 });
function fixture() {
  const f = runtimeFixture(Date.now());
  const context = () =>
    decodePaperRuntimeContext(
      {
        kind: 'PAPER_RUNTIME_CONTEXT',
        owner: f.owner,
        configuration: f.w.configuration,
        current: f.w.current,
        asOf: Date.now(),
      },
      f.owner,
      Date.now(),
    );
  let head: PaperRuntimeReceipt | null = null;
  const events = new Map<string, PaperRuntimeReceipt>();
  const observer = {
    context: vi.fn<PaperRuntimeObserver['context']>(() => Promise.resolve(context())),
    head: vi.fn<PaperRuntimeObserver['head']>(() => Promise.resolve(head)),
    publish: vi.fn<PaperRuntimeObserver['publish']>((p) => {
      if (p.expectedRevision !== (head?.revision ?? '0'))
        return Promise.reject(new Error('PAPER_RUNTIME_CONFLICT'));
      const receipt: PaperRuntimeReceipt = {
        id: p.id,
        owner: p.observation.owner,
        configurationId: p.observation.configurationId,
        revision: (BigInt(p.expectedRevision) + 1n).toString(),
        hash: createHash('sha256').update(canonical(p)).digest('hex'),
        publishedAt: Date.now(),
        replayed: false,
      };
      events.set(p.id, receipt);
      head = receipt;
      return Promise.resolve(receipt);
    }),
    find: vi.fn<PaperRuntimeObserver['find']>((p) => {
      const r = events.get(p.id);
      return Promise.resolve(r ? { ...r, replayed: true } : null);
    }),
    close: vi.fn<PaperRuntimeObserver['close']>(() => Promise.resolve()),
  } satisfies PaperRuntimeObserver;
  const probes = Object.fromEntries(
    paperRuntimeDependencies.map((dependency) => [
      dependency,
      {
        dependency,
        sample: vi.fn<PaperRuntimeProbe['sample']>((ctx) =>
          Promise.resolve({
            dependency,
            contextHash: ctx.hash,
            fact: {
              sourceId: dependency + ':server-probe',
              asOf: Date.now(),
              status: 'HEALTHY' as const,
            },
          }),
        ),
        close: vi.fn<PaperRuntimeProbe['close']>(() => Promise.resolve()),
      },
    ]),
  ) as unknown as MutableProbes;
  return { f, observer, probes, events };
}

it('collects all nine original scoped facts and publishes one immutable observation without financial authority', async () => {
  const t = fixture(),
    c = createPaperRuntimeCollectorCore(t.observer, t.probes);
  const result = await c.collect(t.f.owner, io());
  expect(result.kind).toBe('PUBLISHED');
  expect(result.publication.expectedRevision).toBe('0');
  expect(Object.keys(result.publication.observation.health)).toEqual([...paperRuntimeDependencies]);
  expect(t.observer.publish).toHaveBeenCalledTimes(1);
  for (const d of paperRuntimeDependencies) expect(t.probes[d].sample).toHaveBeenCalledTimes(1);
  expect(Object.isFrozen(result.publication.observation.health)).toBe(true);
  for (const name of ['approve', 'reserve', 'permit', 'execute']) expect(name in c).toBe(false);
  await c.close();
});

it('a restarted collector rereads the durable head and takes new probes instead of resetting the revision', async () => {
  const t = fixture();
  const first = createPaperRuntimeCollectorCore(t.observer, t.probes);
  const a = await first.collect(t.f.owner, io());
  await first.close();
  const freshProbes = fixture().probes;
  const second = createPaperRuntimeCollectorCore(
    { ...t.observer, close: vi.fn<PaperRuntimeObserver['close']>(() => Promise.resolve()) },
    freshProbes,
  );
  const b = await second.collect(t.f.owner, io());
  expect(b.publication.id).not.toBe(a.publication.id);
  expect(b.publication.expectedRevision).toBe('1');
  expect(t.observer.head).toHaveBeenCalledTimes(2);
  for (const d of paperRuntimeDependencies) {
    expect(t.probes[d].sample).toHaveBeenCalledTimes(1);
    expect(freshProbes[d].sample).toHaveBeenCalledTimes(1);
  }
  await second.close();
});

it('lost acknowledged publication is UNCERTAIN and explicit reconciliation never republishes', async () => {
  const t = fixture(),
    publish = t.observer.publish;
  t.observer.publish = vi.fn<PaperRuntimeObserver['publish']>(async (p, opts) => {
    await publish(p, opts);
    throw new Error('PAPER_RUNTIME_UNCERTAIN');
  });
  const c = createPaperRuntimeCollectorCore(t.observer, t.probes);
  const result = await c.collect(t.f.owner, io());
  expect(result.kind).toBe('UNCERTAIN');
  const receipt = await c.reconcile(result.publication, io());
  expect(receipt?.id).toBe(result.publication.id);
  expect(receipt?.replayed).toBe(true);
  expect(t.observer.publish).toHaveBeenCalledTimes(1);
  await c.close();
});

it('a conflicting receipt after known dispatch cannot masquerade as definitive rollback', async () => {
  const t = fixture(),
    publish = t.observer.publish;
  t.observer.publish = vi.fn<PaperRuntimeObserver['publish']>(async (p, opts) => ({
    ...(await publish(p, opts)),
    hash: '0'.repeat(64),
  }));
  const c = createPaperRuntimeCollectorCore(t.observer, t.probes);
  const result = await c.collect(t.f.owner, io());
  expect(result.kind).toBe('UNCERTAIN');
  expect((await c.reconcile(result.publication, io()))?.hash).not.toBe('0'.repeat(64));
  expect(t.observer.publish).toHaveBeenCalledTimes(1);
  await c.close();
});

it('expiry during receipt verification cannot return PUBLISHED after the cycle deadline', async () => {
  vi.useFakeTimers();
  const t = fixture(),
    publish = t.observer.publish;
  t.observer.publish = vi.fn<PaperRuntimeObserver['publish']>(async (p, opts) => {
    const r = await publish(p, opts);
    // Deterministically emulate CPU/scheduling time consumed by validation after
    // transport settled. It must still obey the same original deadline.
    return {
      ...r,
      get hash() {
        vi.setSystemTime(Date.now() + 3001);
        return r.hash;
      },
    };
  });
  const c = createPaperRuntimeCollectorCore(t.observer, t.probes);
  const result = await c.collect(t.f.owner, io());
  expect(result.kind).toBe('UNCERTAIN');
  expect((await c.reconcile(result.publication, io()))?.id).toBe(result.publication.id);
  await c.close();
});

it.each(paperRuntimeDependencies)(
  'rejects %s facts captured under another context before publication',
  async (d) => {
    const t = fixture(),
      sample = t.probes[d].sample;
    t.probes[d].sample = vi.fn<PaperRuntimeProbe['sample']>(async (ctx, opts) => ({
      ...(await sample(ctx, opts)),
      contextHash: '0'.repeat(64),
    }));
    const c = createPaperRuntimeCollectorCore(t.observer, t.probes);
    await expect(c.collect(t.f.owner, io())).rejects.toThrow('PAPER_RUNTIME_COLLECTOR_PROBE');
    expect(t.observer.publish).not.toHaveBeenCalled();
    await c.close();
  },
);

it.each(['dependency', 'old', 'future', 'status', 'extra', 'missing'] as const)(
  'rejects %s probe output without manufacturing a successful fact',
  async (fault) => {
    const t = fixture(),
      sample = t.probes.executor.sample;
    t.probes.executor.sample = vi.fn<PaperRuntimeProbe['sample']>(async (ctx, opts) => {
      const original = await sample(ctx, opts);
      const bad: unknown =
        fault === 'dependency'
          ? { ...original, dependency: 'database' }
          : fault === 'old'
            ? { ...original, fact: { ...original.fact, asOf: ctx.asOf - 1 } }
            : fault === 'future'
              ? { ...original, fact: { ...original.fact, asOf: Date.now() + 10000 } }
              : fault === 'status'
                ? { ...original, fact: { ...original.fact, status: 'ready' } }
                : fault === 'extra'
                  ? { ...original, health: 'HEALTHY' }
                  : { dependency: 'executor', contextHash: ctx.hash };
      return bad as Awaited<ReturnType<PaperRuntimeProbe['sample']>>;
    });
    const c = createPaperRuntimeCollectorCore(t.observer, t.probes);
    await expect(c.collect(t.f.owner, io())).rejects.toThrow('PAPER_RUNTIME_COLLECTOR_PROBE');
    expect(t.observer.publish).not.toHaveBeenCalled();
    await c.close();
  },
);

it.each(['FAILED', 'UNKNOWN'] as const)(
  'preserves explicit %s instead of renewing a healthy default',
  async (status) => {
    const t = fixture(),
      sample = t.probes.executor.sample;
    let original: Awaited<ReturnType<PaperRuntimeProbe['sample']>> | undefined;
    t.probes.executor.sample = vi.fn<PaperRuntimeProbe['sample']>(async (ctx, opts) => {
      original = {
        ...(await sample(ctx, opts)),
        fact: { sourceId: 'executor:original', asOf: Date.now(), status },
      };
      return original;
    });
    const c = createPaperRuntimeCollectorCore(t.observer, t.probes),
      result = await c.collect(t.f.owner, io());
    expect(result.kind).toBe('PUBLISHED');
    expect(result.publication.observation.health.executor).toEqual(original?.fact);
    await c.close();
  },
);

it.each(['PAPER_RUNTIME_EPOCH', 'PAPER_RUNTIME_CONFLICT', 'PAPER_RUNTIME_ORDERING'])(
  'propagates definitive %s without blind retry',
  async (failure) => {
    const t = fixture();
    t.observer.publish = vi.fn<PaperRuntimeObserver['publish']>(() =>
      Promise.reject(new Error(failure)),
    );
    const c = createPaperRuntimeCollectorCore(t.observer, t.probes);
    await expect(c.collect(t.f.owner, io())).rejects.toThrow(failure);
    expect(t.observer.publish).toHaveBeenCalledTimes(1);
    await c.close();
  },
);

it.each([
  'id',
  'owner',
  'configuration',
  'hash',
  'revision',
  'future',
  'replayed',
  'extra',
] as const)(
  'a %s receipt mismatch after dispatch remains UNCERTAIN with exact retained reconciliation',
  async (fault) => {
    const t = fixture(),
      publish = t.observer.publish;
    t.observer.publish = vi.fn<PaperRuntimeObserver['publish']>(async (p, opts) => {
      const r = await publish(p, opts);
      return fault === 'id'
        ? { ...r, id: randomUUID() }
        : fault === 'owner'
          ? { ...r, owner: { ...r.owner, accountId: randomUUID() } }
          : fault === 'configuration'
            ? { ...r, configurationId: randomUUID() }
            : fault === 'hash'
              ? { ...r, hash: '0'.repeat(64) }
              : fault === 'revision'
                ? { ...r, revision: '500' }
                : fault === 'future'
                  ? { ...r, publishedAt: Date.now() + 100000 }
                  : fault === 'replayed'
                    ? { ...r, replayed: true }
                    : { ...r, grant: 'not-a-grant' };
    });
    const c = createPaperRuntimeCollectorCore(t.observer, t.probes),
      result = await c.collect(t.f.owner, io());
    expect(result.kind).toBe('UNCERTAIN');
    const r = await c.reconcile(result.publication, io());
    expect(r?.id).toBe(result.publication.id);
    expect(r?.hash).toBe(createHash('sha256').update(canonical(result.publication)).digest('hex'));
    expect(t.observer.publish).toHaveBeenCalledTimes(1);
    await c.close();
  },
);

it('expired original observations remain reconcilable without fresh probes or renewed timestamps', async () => {
  vi.useFakeTimers();
  const t = fixture(),
    c = createPaperRuntimeCollectorCore(t.observer, t.probes);
  const first = await c.collect(t.f.owner, io());
  const original = canonical(first.publication);
  vi.setSystemTime(Date.now() + 86400000);
  const r = await c.reconcile(JSON.parse(original) as PaperRuntimePublication, io());
  expect(r?.id).toBe(first.publication.id);
  expect(canonical(first.publication)).toBe(original);
  expect(t.observer.context).toHaveBeenCalledTimes(1);
  expect(t.observer.publish).toHaveBeenCalledTimes(1);
  await c.close();
});

it('reconciliation rejects a conflicting stored receipt and never calls publish', async () => {
  const t = fixture(),
    c = createPaperRuntimeCollectorCore(t.observer, t.probes);
  const result = await c.collect(t.f.owner, io());
  t.observer.find = vi.fn<PaperRuntimeObserver['find']>(() =>
    Promise.resolve({
      ...t.events.get(result.publication.id)!,
      hash: '0'.repeat(64),
      replayed: true,
    }),
  );
  await expect(c.reconcile(result.publication, io())).rejects.toThrow('PAPER_RUNTIME_CORRUPT');
  expect(t.observer.publish).toHaveBeenCalledTimes(1);
  await c.close();
});

it('pre-abort and invalid owner reject before observer or probe I/O', async () => {
  const t = fixture(),
    c = createPaperRuntimeCollectorCore(t.observer, t.probes);
  await expect(
    c.collect(t.f.owner, { signal: AbortSignal.abort(), deadline: Date.now() + 1000 }),
  ).rejects.toThrow('PAPER_RUNTIME_COLLECTOR_ABORTED');
  await expect(
    c.collect({ ...t.f.owner, mode: 'LIVE' } as unknown as typeof t.f.owner, io()),
  ).rejects.toThrow('PAPER_RUNTIME_COLLECTOR_INPUT');
  expect(t.observer.head).not.toHaveBeenCalled();
  for (const d of paperRuntimeDependencies) expect(t.probes[d].sample).not.toHaveBeenCalled();
  await c.close();
});

it('abort before publication starts is an error, never false UNCERTAIN', async () => {
  const t = fixture(),
    ctrl = new AbortController(),
    sample = t.probes.executor.sample;
  t.probes.executor.sample = vi.fn<PaperRuntimeProbe['sample']>(async (ctx, opts) => {
    const result = await sample(ctx, opts);
    ctrl.abort();
    return result;
  });
  const c = createPaperRuntimeCollectorCore(t.observer, t.probes);
  await expect(c.collect(t.f.owner, { ...io(), signal: ctrl.signal })).rejects.toThrow(
    'PAPER_RUNTIME_COLLECTOR_ABORTED',
  );
  expect(t.observer.publish).not.toHaveBeenCalled();
  await c.close();
});

it.each(['abort', 'deadline'] as const)(
  '%s during publication preserves the original payload and holds the slot until actual settlement',
  async (reason) => {
    vi.useFakeTimers();
    const t = fixture(),
      gate = deferred<PaperRuntimeReceipt>(),
      publish = t.observer.publish;
    let dispatched: PaperRuntimePublication | undefined;
    t.observer.publish = vi.fn<PaperRuntimeObserver['publish']>(async (p) => {
      dispatched = p;
      return gate.promise;
    });
    const c = createPaperRuntimeCollectorCore(t.observer, t.probes),
      ctrl = new AbortController();
    const pending = c.collect(t.f.owner, { signal: ctrl.signal, deadline: Date.now() + 2000 });
    await flush();
    expect(dispatched).toBeDefined();
    if (reason === 'abort') ctrl.abort();
    else await vi.advanceTimersByTimeAsync(2001);
    const result = await pending;
    expect(result.kind).toBe('UNCERTAIN');
    expect(result.publication).toEqual(dispatched);
    await expect(c.collect(t.f.owner, io())).rejects.toThrow('PAPER_RUNTIME_COLLECTOR_BUSY');
    gate.resolve(await publish(result.publication, io()));
    await flush();
    expect((await c.reconcile(result.publication, io()))?.id).toBe(result.publication.id);
    expect(t.observer.publish).toHaveBeenCalledTimes(1);
    await c.close();
  },
);

it('a hung probe keeps its account busy after caller deadline until its physical promise settles', async () => {
  vi.useFakeTimers();
  const t = fixture(),
    gate = deferred<Awaited<ReturnType<PaperRuntimeProbe['sample']>>>(),
    original = t.probes.executor.sample;
  let originalFact: Awaited<ReturnType<PaperRuntimeProbe['sample']>> | undefined;
  let first = true;
  t.probes.executor.sample = vi.fn<PaperRuntimeProbe['sample']>(async (ctx, opts) => {
    const value = await original(ctx, opts);
    if (!first) return value;
    first = false;
    originalFact = value;
    return gate.promise;
  });
  const c = createPaperRuntimeCollectorCore(t.observer, t.probes);
  const pending = c.collect(t.f.owner, { ...io(), deadline: Date.now() + 10000 });
  const rejection = expect(pending).rejects.toThrow('PAPER_RUNTIME_COLLECTOR_ABORTED');
  await flush();
  expect(originalFact).toBeDefined();
  await vi.advanceTimersByTimeAsync(3001);
  await rejection;
  expect(t.observer.publish).not.toHaveBeenCalled();
  await expect(c.collect(t.f.owner, io())).rejects.toThrow('PAPER_RUNTIME_COLLECTOR_BUSY');
  gate.resolve(originalFact!);
  await flush();
  // Another call reaches the same bound probe, now with fresh scoped facts.
  const again = c.collect(t.f.owner, io());
  await flush();
  expect(t.probes.executor.sample).toHaveBeenCalledTimes(2);
  expect((await again).kind).toBe('PUBLISHED');
  await c.close();
});

it('four physical flights have no waiting queue and are not released by caller abort alone', async () => {
  const t = fixture(),
    gate = deferred<PaperRuntimeReceipt | null>();
  t.observer.head = vi.fn<PaperRuntimeObserver['head']>(async () => gate.promise);
  const c = createPaperRuntimeCollectorCore(t.observer, t.probes);
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const owners = controllers.map(() => ({ ...t.f.owner, accountId: randomUUID() }));
  const work = owners.map((owner, i) =>
    c.collect(owner, { ...io(), signal: controllers[i]!.signal }),
  );
  const settled = Promise.allSettled(work);
  await flush();
  expect(t.observer.head).toHaveBeenCalledTimes(4);
  await expect(c.collect(t.f.owner, io())).rejects.toThrow('PAPER_RUNTIME_COLLECTOR_BUSY');
  await expect(c.collect(owners[0]!, io())).rejects.toThrow('PAPER_RUNTIME_COLLECTOR_BUSY');
  controllers.forEach((ctrl) => ctrl.abort());
  await settled;
  await expect(c.collect(t.f.owner, io())).rejects.toThrow('PAPER_RUNTIME_COLLECTOR_BUSY');
  gate.resolve(null);
  await flush();
  // New calls can start after every owned head promise physically settles.
  await expect(c.collect(t.f.owner, io())).resolves.toMatchObject({ kind: 'PUBLISHED' });
  await c.close();
});

it('close aborts and physically drains all owned probes and is idempotent', async () => {
  const t = fixture(),
    gate = deferred<Awaited<ReturnType<PaperRuntimeProbe['sample']>>>();
  let result: Awaited<ReturnType<PaperRuntimeProbe['sample']>> | undefined;
  const sample = t.probes.executor.sample;
  t.probes.executor.sample = vi.fn<PaperRuntimeProbe['sample']>(async (ctx, opts) => {
    result = await sample(ctx, opts);
    return gate.promise;
  });
  t.probes.executor.close = vi.fn<PaperRuntimeProbe['close']>(() => {
    gate.resolve(result!);
    return Promise.resolve();
  });
  const c = createPaperRuntimeCollectorCore(t.observer, t.probes),
    pending = c.collect(t.f.owner, io());
  const rejection = expect(pending).rejects.toThrow('PAPER_RUNTIME_COLLECTOR_ABORTED');
  await flush();
  const closing = c.close();
  expect(c.close()).toBe(closing);
  await rejection;
  await closing;
  expect(t.observer.publish).not.toHaveBeenCalled();
  expect(t.observer.close).toHaveBeenCalledTimes(1);
  for (const d of paperRuntimeDependencies) expect(t.probes[d].close).toHaveBeenCalledTimes(1);
  await expect(c.collect(t.f.owner, io())).rejects.toThrow('PAPER_RUNTIME_COLLECTOR_CLOSED');
});

it('a broken port close fails within the bounded close deadline and never reopens admission', async () => {
  vi.useFakeTimers();
  const t = fixture(),
    gate = deferred<void>();
  t.probes.executor.close = vi.fn<PaperRuntimeProbe['close']>(async () => gate.promise);
  const c = createPaperRuntimeCollectorCore(t.observer, t.probes),
    closing = c.close();
  const rejection = expect(closing).rejects.toThrow('PAPER_RUNTIME_COLLECTOR_CLOSE_FAILED');
  await vi.advanceTimersByTimeAsync(3001);
  await rejection;
  await expect(c.collect(t.f.owner, io())).rejects.toThrow('PAPER_RUNTIME_COLLECTOR_CLOSED');
  expect(c.close()).toBe(closing);
  gate.resolve();
  await flush();
});

it('explicit unavailable executor can publish only UNKNOWN and closes permanently', async () => {
  const t = fixture(),
    probe = createUnavailablePaperRuntimeProbe('executor');
  const probes = { ...t.probes, executor: probe };
  const c = createPaperRuntimeCollectorCore(t.observer, probes),
    result = await c.collect(t.f.owner, io());
  expect(result.publication.observation.health.executor.status).toBe('UNKNOWN');
  expect(result.publication.observation.health.executor.sourceId).toMatch(
    /^unavailable:executor:/u,
  );
  await c.close();
  const ctx = await t.observer.context(t.f.owner, io());
  await expect(probe.sample(ctx, io())).rejects.toThrow('PAPER_RUNTIME_COLLECTOR_ABORTED');
});

it('300 fresh cycles retain only durable head state and never exhaust in-memory pending capacity', async () => {
  const t = fixture(),
    c = createPaperRuntimeCollectorCore(t.observer, t.probes);
  for (let i = 0; i < 300; i++) {
    const r = await c.collect(t.f.owner, io());
    expect(r.kind).toBe('PUBLISHED');
    expect(r.publication.expectedRevision).toBe(String(i));
  }
  expect(t.observer.head).toHaveBeenCalledTimes(300);
  expect(t.observer.publish).toHaveBeenCalledTimes(300);
  await c.close();
});
