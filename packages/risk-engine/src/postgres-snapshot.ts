import { immutable } from '@ctp/exchange-core';
import { z } from 'zod';
import { canonical } from '@ctp/portfolio';
import {
  riskSnapshotKeySchema,
  riskSnapshotCertificateSchema,
  riskEvidenceHash,
  type RiskSnapshotKey,
  type RiskSnapshotCertificate,
  type RiskSnapshotStore,
  type SnapshotIo,
  type SnapshotIdentity,
} from './coordinator.js';
import { decodeRiskSnapshotCapture } from './snapshot-capture.js';
import {
  openCertificationDatabase,
  type CertificationDatabaseOptions,
} from './postgres-certification.js';
type SnapshotTransaction = Parameters<Parameters<RiskSnapshotStore['transaction']>[2]>[0];
/** Fixed SQL source graph; callers cannot inject a capture port or raw evidence. */
export async function createPostgresRiskSnapshotStore(
  options: CertificationDatabaseOptions,
): Promise<RiskSnapshotStore & { close(): Promise<void> }> {
  const database = await openCertificationDatabase(options, 'CERTIFIER');
  const { transaction, check } = database;
  return Object.freeze({
    async transaction<T>(
      rawKey: RiskSnapshotKey,
      io: SnapshotIo,
      work: (tx: SnapshotTransaction) => Promise<T>,
    ): Promise<T> {
      const key = immutable(riskSnapshotKeySchema.parse(rawKey));
      if (!key.intentId) throw new Error('RISK_SNAPSHOT_INTENT_REQUIRED');
      return transaction(key, io, async (p) => {
        let previous: RiskSnapshotCertificate | null = null,
          allocated: SnapshotIdentity | null = null,
          inserted = false;
        const sqlKey = canonical(key);
        const result = await work({
          async capture() {
            check(io);
            const r = await p.query<{ result: unknown }>(
              'SELECT ctp_certification.capture_sources($1::jsonb) AS result',
              [sqlKey],
            );
            check(io);
            return decodeRiskSnapshotCapture(r.rows[0]?.result, key, Date.now(), previous);
          },
          async nextIdentity() {
            if (allocated) throw new Error('RISK_SNAPSHOT_IDENTITY_REUSE');
            const r = await p.query<{ result: unknown }>(
              'SELECT ctp_certification.next_identity($1::jsonb) AS result',
              [sqlKey],
            );
            allocated = z
              .strictObject({ id: z.uuid(), revision: z.string().regex(/^[1-9][0-9]{0,18}$/) })
              .parse(r.rows[0]?.result);
            return immutable(allocated);
          },
          async insert(rawCertificate) {
            const certificate = riskSnapshotCertificateSchema.parse(rawCertificate);
            if (
              inserted ||
              !allocated ||
              allocated.id !== certificate.id ||
              allocated.revision !== certificate.revision ||
              riskEvidenceHash(certificate.projection.key) !== riskEvidenceHash(key) ||
              certificate.hash !== riskEvidenceHash(certificate.projection)
            )
              throw new Error('RISK_SNAPSHOT_INSERT_CONFLICT');
            check(io);
            await p.query('SELECT ctp_certification.insert_certificate($1::jsonb,$2::text)', [
              sqlKey,
              canonical(certificate),
            ]);
            inserted = true;
          },
          async read() {
            if (allocated || inserted) throw new Error('RISK_SNAPSHOT_READ_ORDER');
            const r = await p.query<{ result: unknown }>(
              'SELECT ctp_certification.read_certificate($1::jsonb) AS result',
              [sqlKey],
            );
            const raw = r.rows[0]?.result;
            previous = raw === null ? null : riskSnapshotCertificateSchema.parse(raw);
            return previous === null ? null : immutable(previous);
          },
        });
        if (allocated && !inserted) throw new Error('RISK_SNAPSHOT_UNPERSISTED_IDENTITY');
        return result;
      });
    },
    close: database.close,
  });
}
