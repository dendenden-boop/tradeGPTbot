import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { immutable } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import {
  paperOwnerSchema,
  type PaperConfigurationIo,
  type PaperOwner,
} from './configuration-domain.js';
import {
  paperRuntimeDependencies,
  paperRuntimeHealthSchema,
  paperRuntimePublicationSchema,
  paperRuntimeReceiptSchema,
  type PaperRuntimeContext,
  type PaperRuntimeObserver,
  type PaperRuntimePublication,
  type PaperRuntimeReceipt,
} from './runtime-domain.js';

export type PaperRuntimeDependency = (typeof paperRuntimeDependencies)[number];
export interface PaperRuntimeProbe {
  readonly dependency: PaperRuntimeDependency;
  /** Trusted server I/O only. Must physically settle on abort/deadline/close. */
  readonly sample: (
    context: PaperRuntimeContext,
    io: PaperConfigurationIo,
  ) => Promise<{
    readonly dependency: PaperRuntimeDependency;
    readonly contextHash: string;
    readonly fact: PaperRuntimePublication['observation']['health']['database'];
  }>;
  readonly close: () => Promise<void>;
}
export type PaperRuntimeProbes = Readonly<Record<PaperRuntimeDependency, PaperRuntimeProbe>>;
export type PaperRuntimeCollection =
  | Readonly<{
      kind: 'PUBLISHED';
      publication: PaperRuntimePublication;
      receipt: PaperRuntimeReceipt;
    }>
  | Readonly<{ kind: 'UNCERTAIN'; publication: PaperRuntimePublication }>;
export interface PaperRuntimeCollector {
  collect(owner: PaperOwner, io: PaperConfigurationIo): Promise<PaperRuntimeCollection>;
  reconcile(
    publication: PaperRuntimePublication,
    io: PaperConfigurationIo,
  ): Promise<PaperRuntimeReceipt | null>;
  close(): Promise<void>;
}

const ioSchema = z.strictObject({
  signal: z.instanceof(AbortSignal),
  deadline: z.number().int().safe(),
});
const sampleSchema = z.strictObject({
  dependency: z.enum(paperRuntimeDependencies),
  contextHash: z.string().regex(/^[a-f0-9]{64}$/u),
  fact: paperRuntimeHealthSchema.shape.database,
});
const definitive = new Set([
  'PAPER_RUNTIME_CONFLICT',
  'PAPER_RUNTIME_EPOCH',
  'PAPER_RUNTIME_ORDERING',
  'PAPER_RUNTIME_OWNERSHIP',
  'PAPER_RUNTIME_INPUT',
  'PAPER_RUNTIME_CORRUPT',
  'PAPER_RUNTIME_MISSING',
  'PAPER_RUNTIME_INCOMPLETE',
  'PAPER_RUNTIME_MARKET',
  'PAPER_RUNTIME_CAPACITY',
  'PAPER_RUNTIME_ROLE_UNSAFE',
  'PAPER_RUNTIME_STALE',
]);
const code = (error: unknown) =>
  error instanceof Error &&
  (definitive.has(error.message) ||
    /^PAPER_RUNTIME_COLLECTOR_(INPUT|BUSY|CLOSED|ABORTED|STALE|PROBE|CAPACITY)$/u.test(
      error.message,
    ))
    ? error.message
    : 'PAPER_RUNTIME_COLLECTOR_STORE_FAILED';
const hash = (p: PaperRuntimePublication) =>
  createHash('sha256').update(canonical(p)).digest('hex');

/** Private validation; freezes the server's exact method bindings, not a public
 * health payload. Each port owns its I/O and must settle physically on close. */
export function bindPaperRuntimeProbes(probes: PaperRuntimeProbes): PaperRuntimeProbes {
  if (
    !probes ||
    typeof probes !== 'object' ||
    Object.keys(probes).length !== paperRuntimeDependencies.length ||
    paperRuntimeDependencies.some((d) => !Object.keys(probes).includes(d)) ||
    new Set(paperRuntimeDependencies.map((d) => probes[d])).size !== paperRuntimeDependencies.length
  )
    throw new Error('PAPER_RUNTIME_COLLECTOR_INPUT');
  const bound = paperRuntimeDependencies.map((d) => {
    const p = probes[d];
    if (!p || p.dependency !== d || typeof p.sample !== 'function' || typeof p.close !== 'function')
      throw new Error('PAPER_RUNTIME_COLLECTOR_INPUT');
    return [d, Object.freeze({ dependency: d, sample: p.sample.bind(p), close: p.close.bind(p) })];
  });
  return Object.freeze(Object.fromEntries(bound)) as PaperRuntimeProbes;
}

interface Flight {
  key: string;
  owner: PaperOwner;
  controller: AbortController;
  deadline: number;
  aborted: Promise<never>;
  pending: Set<Promise<unknown>>;
  returned: boolean;
  timer: ReturnType<typeof setTimeout>;
  detach(): void;
}

/** Private composition seam; the production factory opens the fixed PostgreSQL
 * observer. There is no reference persistence or all-healthy probe default. */
export function createPaperRuntimeCollectorCore(
  observer: PaperRuntimeObserver,
  rawProbes: PaperRuntimeProbes,
): PaperRuntimeCollector {
  const probes = bindPaperRuntimeProbes(rawProbes);
  const flights = new Map<string, Flight>();
  let closed = false,
    closing: Promise<void> | undefined;
  const release = (f: Flight) => {
    if (f.returned && f.pending.size === 0) flights.delete(f.key);
  };
  const check = (f: Flight) => {
    if (closed || f.controller.signal.aborted || Date.now() >= f.deadline)
      throw new Error('PAPER_RUNTIME_COLLECTOR_ABORTED');
  };
  const start = (rawOwner: PaperOwner, rawIo: PaperConfigurationIo) => {
    if (closed) throw new Error('PAPER_RUNTIME_COLLECTOR_CLOSED');
    const o = paperOwnerSchema.safeParse(rawOwner),
      opts = ioSchema.safeParse(rawIo);
    if (!o.success || !opts.success) throw new Error('PAPER_RUNTIME_COLLECTOR_INPUT');
    const { signal, deadline } = opts.data;
    if (signal.aborted || deadline <= Date.now())
      throw new Error('PAPER_RUNTIME_COLLECTOR_ABORTED');
    const key = canonical(o.data);
    if (flights.size >= 4 || flights.has(key)) throw new Error('PAPER_RUNTIME_COLLECTOR_BUSY');
    const controller = new AbortController(),
      abort = () => controller.abort();
    const boundedDeadline = Math.min(deadline, Date.now() + 3000);
    const aborted = new Promise<never>((_, reject) =>
      controller.signal.addEventListener(
        'abort',
        () => reject(new Error('PAPER_RUNTIME_COLLECTOR_ABORTED')),
        { once: true },
      ),
    );
    // A late probe failure/abort must stay observed even after its caller left.
    void aborted.catch(() => {});
    signal.addEventListener('abort', abort, { once: true });
    const f: Flight = {
      key,
      owner: immutable(o.data),
      controller,
      deadline: boundedDeadline,
      aborted,
      pending: new Set(),
      returned: false,
      timer: setTimeout(abort, Math.max(0, boundedDeadline - Date.now())),
      detach: () => signal.removeEventListener('abort', abort),
    };
    flights.set(key, f);
    return f;
  };
  const finish = (f: Flight) => {
    f.returned = true;
    clearTimeout(f.timer);
    f.detach();
    f.controller.abort();
    release(f);
  };
  const invoke = async <T>(
    f: Flight,
    work: (io: PaperConfigurationIo) => Promise<T>,
  ): Promise<T> => {
    check(f);
    const owned = Promise.resolve().then(() => {
      check(f);
      return work({ signal: f.controller.signal, deadline: f.deadline });
    });
    f.pending.add(owned);
    const settled = () => {
      f.pending.delete(owned);
      release(f);
    };
    void owned.then(settled, settled);
    const result = await Promise.race([owned, f.aborted]);
    check(f);
    return result;
  };
  function receipt(raw: unknown, p: PaperRuntimePublication, replay: boolean) {
    const r = paperRuntimeReceiptSchema.parse(raw);
    if (
      r.id !== p.id ||
      r.hash !== hash(p) ||
      r.replayed !== replay ||
      r.configurationId !== p.observation.configurationId ||
      canonical(r.owner) !== canonical(p.observation.owner) ||
      BigInt(r.revision) !== BigInt(p.expectedRevision) + 1n ||
      r.publishedAt > Date.now()
    )
      throw new Error('PAPER_RUNTIME_CORRUPT');
    return immutable(r);
  }
  return Object.freeze({
    async collect(rawOwner: PaperOwner, opts: PaperConfigurationIo) {
      const f = start(rawOwner, opts);
      let publication: PaperRuntimePublication | undefined,
        dispatched = false,
        rejected = false;
      try {
        const rawHead = await invoke(f, (io) => observer.head(f.owner, io));
        const head = rawHead === null ? null : paperRuntimeReceiptSchema.parse(rawHead);
        if (head && (canonical(head.owner) !== canonical(f.owner) || head.publishedAt > Date.now()))
          throw new Error('PAPER_RUNTIME_CORRUPT');
        const context = await invoke(f, (io) => observer.context(f.owner, io));
        if (
          canonical(context.owner) !== canonical(f.owner) ||
          context.asOf > Date.now() ||
          context.configuration.configuration.owner.mode !== 'PAPER' ||
          (head && head.configurationId !== context.configuration.configuration.id)
        )
          throw new Error('PAPER_RUNTIME_CORRUPT');
        const revision = head?.revision ?? '0';
        if (BigInt(revision) >= 9223372036854775807n)
          throw new Error('PAPER_RUNTIME_COLLECTOR_CAPACITY');
        f.deadline = Math.min(f.deadline, context.validUntil);
        clearTimeout(f.timer);
        f.timer = setTimeout(() => f.controller.abort(), Math.max(0, f.deadline - Date.now()));
        check(f);
        const facts = await Promise.all(
          paperRuntimeDependencies.map(async (d) => {
            const s = sampleSchema.safeParse(
              await invoke(f, (io) => probes[d].sample(context, io)),
            );
            if (
              !s.success ||
              s.data.dependency !== d ||
              s.data.contextHash !== context.hash ||
              s.data.fact.asOf < context.asOf ||
              s.data.fact.asOf > Date.now()
            )
              throw new Error('PAPER_RUNTIME_COLLECTOR_PROBE');
            return [d, s.data.fact] as const;
          }),
        );
        const health = paperRuntimeHealthSchema.parse(Object.fromEntries(facts));
        const age = Math.min(5000, context.configuration.configuration.model.maxEvidenceAgeMs);
        if (paperRuntimeDependencies.some((d) => Date.now() - health[d].asOf > age))
          throw new Error('PAPER_RUNTIME_COLLECTOR_STALE');
        publication = immutable(
          paperRuntimePublicationSchema.parse({
            id: randomUUID(),
            expectedRevision: revision,
            observation: {
              owner: f.owner,
              configurationId: context.configuration.configuration.id,
              configurationHash: context.configurationHash,
              permissionEpoch: context.current.permissionEpoch,
              userSessionEpoch: context.current.userSessionEpoch,
              accountVersion: context.current.accountVersion,
              health,
            },
          }),
        );
        const original = publication;
        const r = await invoke(f, async (io) => {
          dispatched = true;
          try {
            return await observer.publish(original, io);
          } catch (error) {
            rejected = error instanceof Error && definitive.has(error.message);
            throw error;
          }
        });
        const result = immutable({
          kind: 'PUBLISHED' as const,
          publication,
          receipt: receipt(r, publication, false),
        });
        check(f);
        return result;
      } catch (error) {
        if (dispatched && publication && !rejected)
          return immutable({ kind: 'UNCERTAIN' as const, publication });
        throw new Error(code(error), {
          // eslint-disable-next-line preserve-caught-error -- Private probe/SQL/credential errors must not cross this boundary.
          cause: new Error('PAPER_RUNTIME_COLLECTOR_FAILED'),
        });
      } finally {
        finish(f);
      }
    },
    async reconcile(rawPublication: PaperRuntimePublication, opts: PaperConfigurationIo) {
      const parsed = paperRuntimePublicationSchema.safeParse(rawPublication);
      if (!parsed.success) throw new Error('PAPER_RUNTIME_COLLECTOR_INPUT');
      const publication = immutable(parsed.data),
        f = start(publication.observation.owner, opts);
      try {
        const r = await invoke(f, (io) => observer.find(publication, io));
        const result = r === null ? null : receipt(r, publication, true);
        check(f);
        return result;
      } catch (error) {
        throw new Error(code(error), {
          // eslint-disable-next-line preserve-caught-error -- Private probe/SQL/credential errors must not cross this boundary.
          cause: new Error('PAPER_RUNTIME_COLLECTOR_FAILED'),
        });
      } finally {
        finish(f);
      }
    },
    close() {
      if (closing) return closing;
      closed = true;
      for (const f of flights.values()) f.controller.abort();
      const pending = [...flights.values()].flatMap((f) => [...f.pending]);
      const work = Promise.allSettled([
        Promise.resolve().then(() => observer.close()),
        ...paperRuntimeDependencies.map((d) => Promise.resolve().then(() => probes[d].close())),
        ...pending,
      ]).then((results) => {
        // Aborted work may reject normally; only physical port-close failures
        // are errors. Pending operations must nevertheless actually settle.
        if (
          results.slice(0, 1 + paperRuntimeDependencies.length).some((r) => r.status === 'rejected')
        )
          throw new Error('PAPER_RUNTIME_COLLECTOR_CLOSE_FAILED');
      });
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('PAPER_RUNTIME_COLLECTOR_CLOSE_FAILED')), 3000);
      });
      closing = Promise.race([work, timeout]).finally(() => clearTimeout(timer));
      return closing;
    },
  });
}
