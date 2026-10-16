import { createHash } from 'node:crypto';
import { immutable } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import {
  paperOwnerSchema,
  type PaperOwner,
  type PaperConfigurationIo,
} from './configuration-domain.js';
import { openPaperRuntimeDatabase, type PaperRuntimeDatabaseOptions } from './runtime-database.js';
import {
  paperRuntimePublicationSchema,
  paperRuntimeReceiptSchema,
  decodePaperRuntimeSource,
  decodePaperRuntimeContext,
  type PaperRuntimePublication,
  type PaperRuntimeObserver,
  type PaperRuntimeReader,
} from './runtime-domain.js';

/** Trusted server probe collector only; no automatic probes or financial writer. */
export async function createPostgresPaperRuntimeObservations(
  options: PaperRuntimeDatabaseOptions,
): Promise<PaperRuntimeObserver> {
  const database = await openPaperRuntimeDatabase(options, 'OBSERVER');
  function parse(raw: PaperRuntimePublication) {
    const p = paperRuntimePublicationSchema.safeParse(raw);
    if (!p.success) throw new Error('PAPER_RUNTIME_INPUT');
    const publication = immutable(p.data),
      text = canonical(publication);
    if (Buffer.byteLength(text, 'utf8') > 16384) throw new Error('PAPER_RUNTIME_CAPACITY');
    return { publication, text, hash: createHash('sha256').update(text).digest('hex') };
  }
  async function lookup(rawOwner: PaperOwner, id: string | null, io: PaperConfigurationIo) {
    const owner = paperOwnerSchema.safeParse(rawOwner);
    if (!owner.success) throw new Error('PAPER_RUNTIME_INPUT');
    return database.tx(owner.data.tenantId, io, async (sql) => {
      const result = await sql.query<{ result: unknown }>(
        'SELECT ctp_paper.lookup_runtime_observation($1::jsonb) AS result',
        [JSON.stringify({ owner: owner.data, id })],
      );
      if (result.rows[0]?.result === null) return null;
      const receipt = paperRuntimeReceiptSchema.parse(result.rows[0]?.result);
      if (
        canonical(receipt.owner) !== canonical(owner.data) ||
        (id !== null && receipt.id !== id) ||
        !receipt.replayed ||
        receipt.publishedAt > Date.now()
      )
        throw new Error('PAPER_RUNTIME_CORRUPT');
      return immutable(receipt);
    });
  }
  return Object.freeze({
    async context(rawOwner: PaperOwner, io: PaperConfigurationIo) {
      const owner = paperOwnerSchema.safeParse(rawOwner);
      if (!owner.success) throw new Error('PAPER_RUNTIME_INPUT');
      const context = await database.tx(owner.data.tenantId, io, async (sql) => {
        const result = await sql.query<{ result: unknown }>(
          'SELECT ctp_paper.read_runtime_observation_context($1::jsonb) AS result',
          [JSON.stringify(owner.data)],
        );
        return decodePaperRuntimeContext(result.rows[0]?.result, owner.data, Date.now());
      });
      if (io.signal.aborted || Date.now() >= io.deadline) throw new Error('PAPER_RUNTIME_ABORTED');
      if (Date.now() >= context.validUntil) throw new Error('PAPER_RUNTIME_STALE');
      return context;
    },
    async publish(raw: PaperRuntimePublication, io: PaperConfigurationIo) {
      const { publication: p, text, hash } = parse(raw);
      return database.tx(p.observation.owner.tenantId, io, async (sql) => {
        const result = await sql.query<{ result: unknown }>(
          'SELECT ctp_paper.publish_runtime_observation($1::text) AS result',
          [text],
        );
        const receipt = paperRuntimeReceiptSchema.parse(result.rows[0]?.result);
        if (
          receipt.id !== p.id ||
          receipt.hash !== hash ||
          canonical(receipt.owner) !== canonical(p.observation.owner) ||
          receipt.configurationId !== p.observation.configurationId ||
          BigInt(receipt.revision) !== BigInt(p.expectedRevision) + 1n ||
          receipt.publishedAt > Date.now()
        )
          throw new Error('PAPER_RUNTIME_CORRUPT');
        return immutable(receipt);
      });
    },
    async find(raw: PaperRuntimePublication, io: PaperConfigurationIo) {
      const { publication: p, hash } = parse(raw);
      const receipt = await lookup(p.observation.owner, p.id, io);
      if (
        receipt !== null &&
        (receipt.hash !== hash ||
          receipt.configurationId !== p.observation.configurationId ||
          BigInt(receipt.revision) !== BigInt(p.expectedRevision) + 1n)
      )
        throw new Error('PAPER_RUNTIME_CONFLICT');
      return receipt;
    },
    head: (owner: PaperOwner, io: PaperConfigurationIo) => lookup(owner, null, io),
    close: () => database.close(),
  });
}

/** Read-only current PAPER runtime facts. No HEALTHY fallback or Risk grant. */
export async function createPostgresPaperRuntimeSource(
  options: PaperRuntimeDatabaseOptions,
): Promise<PaperRuntimeReader> {
  const database = await openPaperRuntimeDatabase(options, 'READER');
  return Object.freeze({
    async read(rawOwner: PaperOwner, io: PaperConfigurationIo) {
      const owner = paperOwnerSchema.safeParse(rawOwner);
      if (!owner.success) throw new Error('PAPER_RUNTIME_INPUT');
      const source = await database.tx(owner.data.tenantId, io, async (sql) => {
        const result = await sql.query<{ result: unknown }>(
          'SELECT ctp_paper.capture_runtime_observation($1::jsonb) AS result',
          [JSON.stringify(owner.data)],
        );
        return decodePaperRuntimeSource(result.rows[0]?.result, owner.data, Date.now());
      });
      if (io.signal.aborted || Date.now() >= io.deadline) throw new Error('PAPER_RUNTIME_ABORTED');
      if (Date.now() >= source.validUntil) throw new Error('PAPER_RUNTIME_STALE');
      return source;
    },
    close: () => database.close(),
  });
}
