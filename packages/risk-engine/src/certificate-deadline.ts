import type { RiskSnapshotProjection } from './coordinator.js';
import { intersectRiskLimits } from './policy.js';

/** Internal proof lifetime: a newer receipt cannot extend older native evidence. */
export function certificateDeadline(projection: RiskSnapshotProjection, deadline: number): number {
  const limits = intersectRiskLimits(projection.platform.limits, projection.user.limits);
  return Math.min(
    deadline,
    projection.snapshot.sourceAt + limits.maxEvidenceAgeMs,
    projection.metadata.record.rules.expiresAt,
    ...projection.metadata.capabilities.map((c) => c.expiresAt),
  );
}
