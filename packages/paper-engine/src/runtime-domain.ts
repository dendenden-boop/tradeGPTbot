import { createHash } from 'node:crypto';
import { z } from 'zod';
import { idSchema, immutable, timestampSchema } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import {
  paperOwnerSchema,
  paperConfigurationReceiptSchema,
  type PaperOwner,
  type PaperConfigurationIo,
} from './configuration-domain.js';

const maxEpoch = 9223372036854775807n;
const epoch = z
  .string()
  .refine((v) => /^(0|[1-9][0-9]{0,18})$/u.exec(v)?.[0] === v && BigInt(v) <= maxEpoch);
const sessionEpoch = epoch.refine(
  (v) => /^(0|[1-9][0-9]{0,9})$/u.exec(v)?.[0] === v && BigInt(v) <= 2147483647n,
);
const version = z.number().int().nonnegative().max(2147483647);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const uuid = z.uuid().transform((v) => v.toLowerCase());
const fact = z.strictObject({
  sourceId: z.string().refine((v) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.exec(v)?.[0] === v),
  asOf: timestampSchema,
  status: z.enum(['HEALTHY', 'FAILED', 'UNKNOWN']),
});
export const paperRuntimeDependencies = [
  'database',
  'limiter',
  'authentication',
  'publicMarket',
  'executor',
  'clock',
  'latency',
  'rejectRate',
  'maintenance',
] as const;
export const paperRuntimeHealthSchema = z.strictObject({
  database: fact,
  limiter: fact,
  authentication: fact,
  publicMarket: fact,
  executor: fact,
  clock: fact,
  latency: fact,
  rejectRate: fact,
  maintenance: fact,
});
export const paperRuntimeObservationSchema = z.strictObject({
  owner: paperOwnerSchema,
  configurationId: uuid,
  configurationHash: digest,
  permissionEpoch: epoch,
  userSessionEpoch: sessionEpoch,
  accountVersion: version,
  health: paperRuntimeHealthSchema,
});
export const paperRuntimePublicationSchema = z.strictObject({
  id: uuid,
  expectedRevision: epoch.refine(
    (v) => /^(0|[1-9][0-9]{0,18})$/u.exec(v)?.[0] === v && BigInt(v) < maxEpoch,
  ),
  observation: paperRuntimeObservationSchema,
});
export type PaperRuntimePublication = z.infer<typeof paperRuntimePublicationSchema>;
export const paperRuntimeReceiptSchema = z.strictObject({
  id: uuid,
  owner: paperOwnerSchema,
  configurationId: uuid,
  revision: epoch.refine((v) => v !== '0'),
  hash: digest,
  publishedAt: timestampSchema,
  replayed: z.boolean(),
});
export type PaperRuntimeReceipt = z.infer<typeof paperRuntimeReceiptSchema>;
const configurationWire = z.strictObject({ receiptText: z.string().max(8192), hash: digest });
const current = z.strictObject({
  permissionEpoch: epoch,
  userSessionEpoch: sessionEpoch,
  accountVersion: version,
  externalAccountId: idSchema,
  clientIdEpoch: idSchema,
});
const contextWire = z.strictObject({
  kind: z.literal('PAPER_RUNTIME_CONTEXT'),
  owner: paperOwnerSchema,
  asOf: timestampSchema,
  configuration: configurationWire,
  current,
});
const wire = z.strictObject({
  kind: z.literal('PAPER_RUNTIME_CAPTURE'),
  owner: paperOwnerSchema,
  asOf: timestampSchema,
  configuration: configurationWire,
  current,
  publication: z.strictObject({
    id: uuid,
    revision: epoch.refine((v) => v !== '0'),
    text: z.string().max(16384),
    hash: digest,
    publishedAt: timestampSchema,
  }),
});
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const textHash = (v: string) => createHash('sha256').update(v).digest('hex');
export type PaperRuntimeSource = ReturnType<typeof decodePaperRuntimeSource>;
export type PaperRuntimeContext = ReturnType<typeof decodePaperRuntimeContext>;
export interface PaperRuntimeObserver {
  context(owner: PaperOwner, io: PaperConfigurationIo): Promise<PaperRuntimeContext>;
  publish(
    publication: PaperRuntimePublication,
    io: PaperConfigurationIo,
  ): Promise<PaperRuntimeReceipt>;
  /** Explicit reconciliation of the exact original publication; never retries I/O. */
  find(
    publication: PaperRuntimePublication,
    io: PaperConfigurationIo,
  ): Promise<PaperRuntimeReceipt | null>;
  /** Retained head receipt even after expiry, for producer restart/CAS recovery. */
  head(owner: PaperOwner, io: PaperConfigurationIo): Promise<PaperRuntimeReceipt | null>;
  close(): Promise<void>;
}
export interface PaperRuntimeReader {
  read(owner: PaperOwner, io: PaperConfigurationIo): Promise<PaperRuntimeSource>;
  close(): Promise<void>;
}

/** The collector uses this current server binding before taking probes. It is
 * short-lived context, never authority to reuse old facts under a new epoch. */
export function decodePaperRuntimeContext(raw: unknown, rawOwner: unknown, now: number) {
  try {
    timestampSchema.parse(now);
    const owner = paperOwnerSchema.parse(rawOwner),
      w = contextWire.parse(raw),
      configuration = paperConfigurationReceiptSchema.parse(
        JSON.parse(w.configuration.receiptText),
      );
    if (
      Buffer.byteLength(canonical(raw), 'utf8') > 16384 ||
      textHash(w.configuration.receiptText) !== w.configuration.hash ||
      canonical(w.owner) !== canonical(owner) ||
      canonical(configuration.configuration.owner) !== canonical(owner) ||
      configuration.accountIdentity.externalAccountId !== w.current.externalAccountId ||
      configuration.accountIdentity.clientIdEpoch !== w.current.clientIdEpoch ||
      configuration.createdAt > w.asOf ||
      w.asOf > now
    )
      throw new Error('PAPER_RUNTIME_CORRUPT');
    const validUntil =
      w.asOf + Math.min(5000, configuration.configuration.model.maxEvidenceAgeMs) + 1;
    if (now >= validUntil) throw new Error('PAPER_RUNTIME_STALE');
    const content = {
      owner,
      configuration,
      configurationHash: w.configuration.hash,
      current: w.current,
      asOf: w.asOf,
    };
    return immutable({
      kind: 'PAPER_RUNTIME_CONTEXT' as const,
      ...content,
      validUntil,
      hash: hash(content),
    });
  } catch (error) {
    throw new Error(
      error instanceof Error && error.message === 'PAPER_RUNTIME_STALE'
        ? error.message
        : 'PAPER_RUNTIME_CORRUPT',
      {
        // eslint-disable-next-line preserve-caught-error -- Stored deployment/account context stays private.
        cause: new Error('PAPER_RUNTIME_INVALID'),
      },
    );
  }
}

/** Private content checks. Only the fixed SQL source establishes provenance;
 * probe facts, serialized objects and hashes are never a Risk approval. */
export function decodePaperRuntimeSource(raw: unknown, rawOwner: unknown, now: number) {
  try {
    timestampSchema.parse(now);
    const owner = paperOwnerSchema.parse(rawOwner);
    if (Buffer.byteLength(canonical(raw), 'utf8') > 65536)
      throw new Error('PAPER_RUNTIME_CAPACITY');
    const w = wire.parse(raw),
      configuration = paperConfigurationReceiptSchema.parse(
        JSON.parse(w.configuration.receiptText),
      ),
      publication = paperRuntimePublicationSchema.parse(JSON.parse(w.publication.text)),
      observation = publication.observation,
      configurationHash = w.configuration.hash;
    if (
      textHash(w.configuration.receiptText) !== configurationHash ||
      textHash(w.publication.text) !== w.publication.hash ||
      canonical(w.owner) !== canonical(owner) ||
      canonical(configuration.configuration.owner) !== canonical(owner) ||
      canonical(observation.owner) !== canonical(owner) ||
      observation.configurationId !== configuration.configuration.id ||
      observation.configurationHash !== configurationHash ||
      w.publication.id !== publication.id ||
      BigInt(publication.expectedRevision) + 1n !== BigInt(w.publication.revision) ||
      configuration.accountIdentity.externalAccountId !== w.current.externalAccountId ||
      configuration.accountIdentity.clientIdEpoch !== w.current.clientIdEpoch ||
      configuration.createdAt > w.publication.publishedAt ||
      w.publication.publishedAt > w.asOf ||
      w.asOf > now
    )
      throw new Error('PAPER_RUNTIME_CORRUPT');
    if (
      observation.permissionEpoch !== w.current.permissionEpoch ||
      observation.userSessionEpoch !== w.current.userSessionEpoch ||
      observation.accountVersion !== w.current.accountVersion
    )
      throw new Error('PAPER_RUNTIME_EPOCH');
    const age = Math.min(5000, configuration.configuration.model.maxEvidenceAgeMs),
      facts = paperRuntimeDependencies.map((k) => observation.health[k]);
    if (facts.some((f) => f.asOf < configuration.createdAt || f.asOf > w.publication.publishedAt))
      throw new Error('PAPER_RUNTIME_CORRUPT');
    const validUntil = Math.min(...facts.map((f) => f.asOf + age + 1));
    if (facts.some((f) => f.asOf > now || now - f.asOf > age) || now >= validUntil)
      throw new Error('PAPER_RUNTIME_STALE');
    const reference = {
      id: publication.id,
      revision: w.publication.revision,
      hash: w.publication.hash,
      publishedAt: w.publication.publishedAt,
    };
    const content = {
      owner,
      configurationHash,
      current: w.current,
      reference,
      health: observation.health,
    };
    return immutable({
      kind: 'PAPER_RUNTIME_SOURCE' as const,
      asOf: w.asOf,
      validUntil,
      ...content,
      configuration,
      blockedBy: paperRuntimeDependencies.filter((k) => observation.health[k].status !== 'HEALTHY'),
      hash: hash(content),
    });
  } catch (error) {
    const code =
      error instanceof Error && /^PAPER_RUNTIME_(CAPACITY|STALE|EPOCH)$/u.test(error.message)
        ? error.message
        : 'PAPER_RUNTIME_CORRUPT';
    throw new Error(code, {
      // eslint-disable-next-line preserve-caught-error -- Stored account/probe contents stay private.
      cause: new Error('PAPER_RUNTIME_INVALID'),
    });
  }
}
