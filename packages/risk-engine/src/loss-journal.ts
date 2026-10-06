import { z } from 'zod';
import { decimalSchema, timestampSchema } from '@ctp/exchange-core';
import { riskEvidenceScopeSchema } from './evidence.js';

const counter = (allowZero: boolean, maximum: bigint) =>
  z.string().refine((v) => {
    if (!/^(0|[1-9][0-9]{0,18})$/.test(v)) return false;
    const n = BigInt(v);
    return n.toString() === v && n <= maximum && (allowZero || n > 0n);
  });
const before = counter(true, 9223372036854775806n);
const sequence = counter(false, 9223372036854775807n);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const proof = z.strictObject({ sourceId: z.uuid(), sourceHash: hash });
const opening = proof.extend({ at: timestampSchema, equity: decimalSchema });
/** Server collector input only: coverage is an audited native-history claim, never caller authority. */
export const lossBatchSchema = z
  .strictObject({
    scope: riskEvidenceScopeSchema,
    dayStart: timestampSchema,
    id: z.uuid(),
    expectedSequence: before,
    opening: opening.nullable(),
    coveredThrough: timestampSchema,
    events: z
      .array(
        z.strictObject({
          id: z.uuid(),
          at: timestampSchema,
          kind: z.enum(['FLOW', 'REALIZED', 'EQUITY']),
          amount: decimalSchema,
        }),
      )
      .min(1)
      .max(1000),
    coverage: proof.extend({ from: timestampSchema, through: timestampSchema }),
  })
  .superRefine((p, c) => {
    const last = p.events.at(-1);
    if (
      p.dayStart % 86400000 !== 0 ||
      p.coveredThrough < p.dayStart ||
      p.coveredThrough >= p.dayStart + 86400000 ||
      (p.expectedSequence === '0'
        ? p.opening?.at !== p.dayStart || p.coverage.from !== p.dayStart
        : p.opening !== null) ||
      p.coverage.from < p.dayStart ||
      p.coverage.from > p.coveredThrough ||
      p.coverage.through !== p.coveredThrough ||
      last?.kind !== 'EQUITY' ||
      last.at !== p.coveredThrough ||
      new Set(p.events.map((e) => e.id)).size !== p.events.length ||
      p.events.some(
        (e, i) => e.at < (p.events[i - 1]?.at ?? p.coverage.from) || e.at > p.coveredThrough,
      )
    )
      c.addIssue({ code: 'custom', message: 'RISK_LOSS_JOURNAL_INPUT' });
  });
export type LossBatch = z.infer<typeof lossBatchSchema>;
export const lossCheckpointSchema = z.strictObject({
  scope: riskEvidenceScopeSchema,
  dayStart: timestampSchema,
  sequence,
  batchId: z.uuid(),
  coveredThrough: timestampSchema,
  openingEquity: decimalSchema,
  externalFlows: decimalSchema,
  netRealized: decimalSchema,
  adjustedCurrentEquity: decimalSchema,
  adjustedPeakEquity: decimalSchema,
  hash,
});
export type LossCheckpoint = z.infer<typeof lossCheckpointSchema>;
export interface LossJournal {
  append(
    batch: LossBatch,
    io: { signal: AbortSignal; deadline: number },
  ): Promise<Readonly<LossCheckpoint>>;
  read(
    scope: LossBatch['scope'],
    dayStart: number,
    io: { signal: AbortSignal; deadline: number },
  ): Promise<Readonly<LossCheckpoint>>;
  close(): Promise<void>;
}
