import { canonical } from '@ctp/portfolio';
import { policyFingerprint } from '@ctp/risk-engine';
import { currentRiskEvaluationFixture } from './current-risk-evaluation-fixtures.js';
import { wireHash } from './admission-wire-fixtures.js';
import { projectPaperCurrentLoss } from '../src/current-loss-domain.js';
import type { historicalInventoryFixture } from './historical-inventory-fixtures.js';

// Test-only complete wire content. A resealed graph proves no database target
// provenance, authorization, current heads, reservation or financial authority.
export function currentOrderRiskFixture() {
  const f = currentRiskEvaluationFixture(),
    s = f.source;
  const inventory = JSON.parse(s.inventory.text) as ReturnType<
    typeof historicalInventoryFixture
  >['wire'];
  inventory.catalog.find((a) => a.accountId === f.target.owner.accountId)!.clientIdHighWatermark =
    '2';
  s.inventory = f.seal(inventory);
  s.lossInput.current.sourceHash = s.inventory.hash;
  s.lossInput.coverage.sourceHash = s.inventory.hash;
  s.loss = f.seal(projectPaperCurrentLoss(s.lossInput, f.now));
  s.lossReference.hash = s.loss.hash;
  s.ordersInLastMinute = 2;
  f.target.command.clientOrderId = '2';
  for (const p of s.policies) {
    p.limits.maxOrdersPerMinute = 2;
    p.limitsHash = policyFingerprint(p.limits);
  }
  const commandHash = wireHash({
    operation: 'createOrder',
    binding: f.request.admission.binding,
    command: f.target.command,
  });
  const request = {
    kind: 'PAPER_CURRENT_ORDER_RISK_CAPTURE' as const,
    source: f.request,
    target: { orderId: f.target.orderId, intentId: f.target.intentId, commandHash },
  };
  const target = {
    ...f.target,
    commandHash,
    createdAt: f.now - 1,
    status: 'CREATED' as const,
    orderVersion: 0 as const,
  };
  function reply() {
    // Retain the exact head projection used by the accepted current decoder.
    const trade = JSON.parse(s.market.trade.text) as { id: string; expectedRevision: string };
    s.sourceHeads = wireHash({
      request: f.request,
      catalog: inventory.catalog,
      executionHash: wireHash(inventory.executed.execution),
      books: [],
      markets: inventory.markets.map(({ id, revision, hash }) => ({ id, revision, hash })),
      runtime: {
        id: s.runtime.publication.id,
        revision: s.runtime.publication.revision,
        hash: s.runtime.publication.hash,
        publishedAt: s.runtime.publication.publishedAt,
      },
      policies: s.policies,
      controlsHash: s.controls.hash,
      trade: {
        id: trade.id,
        revision: (BigInt(trade.expectedRevision) + 1n).toString(),
        hash: s.market.trade.hash,
      },
      modelHash: s.capability.modelHash,
      ordersInLastMinute: s.ordersInLastMinute,
    });
    s.fingerprint = wireHash({
      sourceHeads: s.sourceHeads,
      lossHash: s.loss.hash,
      lossReference: s.lossReference,
      capability: s.capability,
    });
    return JSON.parse(
      canonical({
        kind: 'CAPTURED',
        request,
        capturedAt: f.now,
        target,
        certificate: f.seal(f.certificate),
      }),
    ) as {
      kind: 'CAPTURED';
      request: typeof request;
      capturedAt: number;
      target: typeof target;
      certificate: { text: string; hash: string };
    };
  }
  return { ...f, request, sourceRequest: f.request, target, commandHash, reply };
}
