import { z } from 'zod';
import { immutable } from '@ctp/exchange-core';
import { paperOwnerSchema, type PaperOwner } from './configuration-domain.js';
import type { PaperRuntimeCollector } from './runtime-collector-core.js';
import type { PaperRuntimePublication } from './runtime-domain.js';

export type PaperRuntimeWorkerState =
  'IDLE' | 'RUNNING' | 'STOPPING' | 'STOPPED' | 'UNCERTAIN' | 'FAILED';
export interface PaperRuntimeWorkerReport {
  readonly state: 'STOPPED' | 'UNCERTAIN' | 'FAILED';
  readonly uncertain: readonly PaperRuntimePublication[];
  readonly collectionFailed: boolean;
  readonly closed: boolean;
}
export interface PaperRuntimeWorker {
  readonly run: (signal: AbortSignal) => Promise<PaperRuntimeWorkerReport>;
  readonly close: () => Promise<void>;
  readonly state: () => PaperRuntimeWorkerState;
}
export const paperRuntimeWorkerSettingsSchema = z.strictObject({
  owners: z
    .array(paperOwnerSchema)
    .min(1)
    .max(4)
    .refine((owners) => new Set(owners.map((o) => o.accountId)).size === owners.length),
  intervalMs: z.number().int().min(100).max(1000),
});

/** Private test composition seam. Production always opens the fixed PostgreSQL
 * collector. No health verdict, financial effect or automatic recovery. */
export function createPaperRuntimeWorkerCore(
  collector: PaperRuntimeCollector,
  raw: { readonly owners: readonly PaperOwner[]; readonly intervalMs: number },
): PaperRuntimeWorker {
  const settings = paperRuntimeWorkerSettingsSchema.safeParse(raw);
  if (!settings.success) throw new Error('PAPER_RUNTIME_WORKER_INPUT');
  const { owners, intervalMs } = immutable(settings.data);
  const collect = collector.collect.bind(collector),
    closeCollector = collector.close.bind(collector);
  const controller = new AbortController();
  let state: PaperRuntimeWorkerState = 'IDLE',
    collectionFailed = false;
  let lifetime: Promise<PaperRuntimeWorkerReport> | undefined,
    portClose: Promise<void> | undefined,
    closing: Promise<void> | undefined;
  const uncertain: PaperRuntimePublication[] = [];
  let report: PaperRuntimeWorkerReport | undefined;
  const bounded = <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('PAPER_RUNTIME_WORKER_CLOSE_FAILED')), 3000);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  };
  const release = () => {
    if (!portClose) {
      portClose = bounded(Promise.resolve().then(closeCollector));
      void portClose.catch(() => {});
    }
    return portClose;
  };
  const stop = () => {
    if (!report) state = 'STOPPING';
    controller.abort();
    void release().catch(() => {});
  };
  const finish = (closed: boolean) => {
    const terminal =
      uncertain.length > 0 ? 'UNCERTAIN' : collectionFailed || !closed ? 'FAILED' : 'STOPPED';
    report = immutable({ state: terminal, uncertain, collectionFailed, closed });
    state = terminal;
    return report;
  };
  const delay = () =>
    new Promise<void>((resolve) => {
      if (controller.signal.aborted) {
        resolve();
        return;
      }
      const done = () => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, intervalMs);
      controller.signal.addEventListener('abort', done, { once: true });
    });
  const loop = async (owner: PaperOwner) => {
    while (!controller.signal.aborted) {
      try {
        const result = await collect(owner, {
          signal: controller.signal,
          deadline: Date.now() + 3000,
        });
        if (result.kind === 'UNCERTAIN') {
          uncertain.push(result.publication);
          stop();
          return;
        }
      } catch {
        // A normal group shutdown is not a second collection failure. The
        // collector independently retains every ambiguous dispatch as UNCERTAIN.
        if (!controller.signal.aborted) {
          collectionFailed = true;
          stop();
        }
        return;
      }
      if (!controller.signal.aborted) await delay();
    }
  };
  return Object.freeze({
    run(signal: AbortSignal) {
      if (!(signal instanceof AbortSignal))
        return Promise.reject(new Error('PAPER_RUNTIME_WORKER_INPUT'));
      if (state !== 'IDLE') return Promise.reject(new Error('PAPER_RUNTIME_WORKER_STATE'));
      state = 'RUNNING';
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
      lifetime = (async () => {
        try {
          await Promise.all(owners.map(loop));
        } finally {
          stop();
          signal.removeEventListener('abort', stop);
        }
        let closed = true;
        try {
          await release();
        } catch {
          closed = false;
        }
        return finish(closed);
      })();
      void lifetime.catch(() => {});
      return lifetime;
    },
    close() {
      if (closing) return closing;
      stop();
      const end =
        lifetime ??
        release().then(
          () => finish(true),
          () => finish(false),
        );
      closing = bounded(
        Promise.allSettled([release(), end]).then(([physical, task]) => {
          if (physical?.status === 'rejected' || task?.status === 'rejected')
            throw new Error('PAPER_RUNTIME_WORKER_CLOSE_FAILED');
        }),
      );
      void closing.catch(() => {});
      return closing;
    },
    state: () => state,
  });
}
