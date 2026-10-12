import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { immutable, sameMarketScope } from '@ctp/exchange-core';
import {
  marketTradeKeySchema,
  marketTradePublicationSchema,
  marketSnapshotPublicationSchema,
} from '@ctp/market-data';
import { paperOwnerSchema, paperConfigurationReceiptSchema } from './configuration-domain.js';
import { preparePaperFrame } from './model.js';
import type { FrameReadPorts, PaperMarketFrames, PaperMarketFrameCapture } from './frame-domain.js';

const requestSchema = z.strictObject({ owner: paperOwnerSchema, key: marketTradeKeySchema });
const ioSchema = z.strictObject({
  signal: z.instanceof(AbortSignal),
  deadline: z.number().int().safe(),
});
const proof = {
  id: z.uuid(),
  revision: z
    .string()
    .refine((v) => /^[1-9][0-9]{0,18}$/u.exec(v)?.[0] === v && BigInt(v) <= 9223372036854775807n),
  hash: z.string().regex(/^[a-f0-9]{64}$/u),
};
const snapshotSchema = z.strictObject({ ...proof, publication: marketSnapshotPublicationSchema });
const tradeSchema = z.strictObject({ ...proof, publication: marketTradePublicationSchema });
const errors = new Set([
  'PAPER_FRAME_ABORTED',
  'PAPER_FRAME_SCOPE',
  'PAPER_FRAME_UNCERTAIN',
  'PAPER_FRAME_CHANGED',
  'PAPER_FRAME_EVIDENCE',
  'PAPER_FRAME_STALE',
]);

/** Private source seam, deliberately absent from public package exports. A
 * capture is read-only calculator input, never an atomic financial certificate. */
export function createPaperFrameReader(ports: FrameReadPorts): PaperMarketFrames {
  const now = ports.now ?? Date.now,
    active = new Set<Promise<unknown>>(),
    controllers = new Set<AbortController>();
  let closed = false,
    closing: Promise<void> | undefined;
  const fail = (code: string): never => {
    throw new Error(code);
  };
  return Object.freeze({
    capture(
      raw: Parameters<PaperMarketFrames['capture']>[0],
      rawIo: Parameters<PaperMarketFrames['capture']>[1],
    ) {
      if (closed) return Promise.reject(new Error('PAPER_FRAME_CLOSED'));
      const request = requestSchema.safeParse(raw),
        checkedIo = ioSchema.safeParse(rawIo);
      if (!request.success || !checkedIo.success)
        return Promise.reject(new Error('PAPER_FRAME_INPUT'));
      const io = checkedIo.data;
      if (io.signal.aborted || io.deadline <= now())
        return Promise.reject(new Error('PAPER_FRAME_ABORTED'));
      if (active.size >= 4) return Promise.reject(new Error('PAPER_FRAME_BUSY'));
      const child = new AbortController();
      controllers.add(child);
      const abort = () => child.abort();
      io.signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, Math.min(3000, io.deadline - now()));
      const context = { signal: child.signal, deadline: Math.min(io.deadline, now() + 3000) };
      const guard = () => {
        if (child.signal.aborted || closed || now() >= context.deadline)
          fail('PAPER_FRAME_ABORTED');
      };
      // Await every underlying operation after a failure. No Promise.race frees
      // a pending slot or leaves a detached peer read using server authority.
      async function together<T extends readonly unknown[]>(work: {
        [K in keyof T]: () => Promise<T[K]>;
      }): Promise<T> {
        const results = await Promise.allSettled(
          work.map((operation) =>
            Promise.resolve()
              .then(operation)
              .catch((error: unknown) => {
                child.abort();
                throw error;
              }),
          ),
        );
        const uncertain = results.some(
          (r) =>
            r.status === 'rejected' &&
            r.reason instanceof Error &&
            /_UNCERTAIN$/u.test(r.reason.message),
        );
        if (uncertain) fail('PAPER_FRAME_UNCERTAIN');
        const rejected = results.find((r) => r.status === 'rejected');
        if (rejected?.status === 'rejected') throw rejected.reason;
        guard();
        return results.map((r) => (r as PromiseFulfilledResult<unknown>).value) as unknown as T;
      }
      const task: Promise<Readonly<PaperMarketFrameCapture>> = (async () => {
        try {
          guard();
          const owner = request.data.owner,
            key = request.data.key;
          const firstConfiguration = paperConfigurationReceiptSchema.parse(
            await ports.configuration.read(owner, context),
          );
          guard();
          if (
            !isDeepStrictEqual(firstConfiguration.configuration.owner, owner) ||
            !sameMarketScope(firstConfiguration.configuration.source, key.scope)
          )
            fail('PAPER_FRAME_SCOPE');
          const age = Math.min(5000, firstConfiguration.configuration.model.maxEvidenceAgeMs);
          const [firstBook, firstTrade] = await together([
            () => ports.snapshots.read(key, context, age),
            () => ports.trades.read(key, context, age),
          ]);
          const [lastConfiguration, lastBook, lastTrade] = await together([
            () => ports.configuration.read(owner, context),
            () => ports.snapshots.read(key, context, age),
            () => ports.trades.read(key, context, age),
          ]);
          if (
            ![
              [firstConfiguration, lastConfiguration],
              [firstBook, lastBook],
              [firstTrade, lastTrade],
            ].every(([a, b]) => isDeepStrictEqual(a, b))
          )
            fail('PAPER_FRAME_CHANGED');
          const configuration = paperConfigurationReceiptSchema.parse(lastConfiguration),
            book = snapshotSchema.parse(lastBook),
            trade = tradeSchema.parse(lastTrade);
          if (book.publication.kind !== 'SNAPSHOT' || trade.publication.kind !== 'TRADE')
            throw new Error('PAPER_FRAME_EVIDENCE');
          const b = book.publication,
            t = trade.publication;
          if (
            book.id !== b.id ||
            trade.id !== t.id ||
            !isDeepStrictEqual(key, b.key) ||
            !isDeepStrictEqual(key, t.key) ||
            !isDeepStrictEqual(b.record, t.record)
          )
            fail('PAPER_FRAME_EVIDENCE');
          const capturedAt = now();
          const times = [
            b.timestamp,
            b.ticker.exchangeTime,
            b.ticker.receivedAt,
            b.book.receivedAt,
            t.timestamp,
            t.trade.exchangeTime,
            t.trade.receivedAt,
            ...(b.book.exchangeTime === null ? [] : [b.book.exchangeTime]),
          ];
          const expiresAt = Math.min(
            io.deadline,
            t.record.rules.expiresAt,
            ...(t.record.instrument.expiryAt === null ? [] : [t.record.instrument.expiryAt]),
            ...times.map((at) => at + age),
          );
          if (
            configuration.createdAt > capturedAt ||
            times.some((at) => at > capturedAt) ||
            expiresAt <= capturedAt
          )
            fail('PAPER_FRAME_STALE');
          const frame = preparePaperFrame({
            now: capturedAt,
            model: configuration.configuration.model,
            record: t.record,
            book: b.book,
            trade: t.trade,
          });
          if (now() >= expiresAt) fail('PAPER_FRAME_STALE');
          guard();
          return immutable({
            configuration,
            frame,
            capturedAt,
            expiresAt,
            evidence: {
              snapshotId: book.id,
              snapshotRevision: book.revision,
              snapshotHash: book.hash,
              tradeId: trade.id,
              tradeRevision: trade.revision,
              tradeHash: trade.hash,
            },
          });
        } catch (error) {
          if (error instanceof Error && errors.has(error.message)) throw error;
          if (error instanceof Error && /_UNCERTAIN$/u.test(error.message))
            fail('PAPER_FRAME_UNCERTAIN');
          if (io.signal.aborted || closed || now() >= context.deadline) fail('PAPER_FRAME_ABORTED');
          throw new Error('PAPER_FRAME_READ_FAILED', {
            // eslint-disable-next-line preserve-caught-error -- SQL/native payloads and DSNs must not escape the server composition.
            cause: new Error('PAPER_FRAME_PORT_FAILED'),
          });
        } finally {
          clearTimeout(timer);
          io.signal.removeEventListener('abort', abort);
          controllers.delete(child);
        }
      })();
      active.add(task);
      const release = () => {
        active.delete(task);
      };
      void task.then(release, release);
      return task;
    },
    close() {
      if (!closing) {
        closed = true;
        for (const c of controllers) c.abort();
        closing = (async () => {
          const operations = [...active];
          const result = await Promise.allSettled([
            ports.configuration.close(),
            ports.snapshots.close(),
            ports.trades.close(),
            ...operations,
          ]);
          if (result.slice(0, 3).some((r) => r.status === 'rejected'))
            fail('PAPER_FRAME_CLOSE_FAILED');
        })();
      }
      return closing;
    },
  });
}
