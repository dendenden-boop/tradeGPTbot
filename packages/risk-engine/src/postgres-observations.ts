import { z } from 'zod';
import { immutable } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { riskNativeObservationSchema } from './snapshot-observations.js';
import {
  openCertificationDatabase,
  type CertificationDatabaseOptions,
} from './postgres-certification.js';
import type { SnapshotIo } from './coordinator.js';
export const riskObservationPublicationSchema = z.strictObject({
  id: z.uuid(),
  expectedRevision: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,18})$/)
    .refine((v) => BigInt(v) < 9223372036854775807n),
  observation: riskNativeObservationSchema,
});
export type RiskObservationPublication = z.infer<typeof riskObservationPublicationSchema>;
const receipt = z.strictObject({
  id: z.uuid(),
  revision: z.string().regex(/^[1-9][0-9]{0,18}$/),
  replayed: z.boolean(),
});
/** Isolated server collector authority: no policy, exposure, Portfolio or grant writer. */
export async function createPostgresRiskObservations(options: CertificationDatabaseOptions) {
  const database = await openCertificationDatabase(options, 'OBSERVER');
  return Object.freeze({
    async publish(raw: RiskObservationPublication, io: SnapshotIo) {
      const p = immutable(riskObservationPublicationSchema.parse(raw)),
        text = canonical(p);
      if (Buffer.byteLength(text, 'utf8') > 1048576) throw new Error('RISK_OBSERVATION_CAPACITY');
      return database.transaction(p.observation.key, io, async (sql) => {
        const r = await sql.query<{ result: unknown }>(
          'SELECT ctp_certification.publish_observation($1::text) AS result',
          [text],
        );
        const result = receipt.parse(r.rows[0]?.result);
        if (result.id !== p.id) throw new Error('RISK_OBSERVATION_CONFLICT');
        return immutable(result);
      });
    },
    close: database.close,
  });
}
