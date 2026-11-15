import { randomUUID } from 'node:crypto';
import { canonical } from '@ctp/portfolio';
import { z } from 'zod';
import { newOrderSchema, parseDecimal } from '@ctp/exchange-core';
import { policyFingerprint } from '@ctp/risk-engine';
import { currentRiskFixture } from './current-risk-fixtures.js';
import { wireHash } from './admission-wire-fixtures.js';

// Content fixtures only. Neither resealing nor evaluating proves SQL provenance,
// current source heads, durable admission, a Risk grant or permission to trade.
export function currentRiskEvaluationFixture() {
  const f = currentRiskFixture();
  for (const policy of f.source.policies) {
    policy.limits.maxPriceDeviationRate = parseDecimal('1');
    policy.limits.minLiquidityNotional = parseDecimal('0');
    policy.limitsHash = policyFingerprint(policy.limits);
  }
  const binding = f.request.admission.binding;
  const inventory = z
    .object({
      executed: z.object({
        execution: z.object({
          input: z.object({
            attempt: z.object({
              request: z.object({
                admission: z.object({
                  command: newOrderSchema,
                  dbInstrumentId: z.uuid(),
                  dbRuleId: z.uuid(),
                }),
              }),
            }),
          }),
        }),
      }),
    })
    .parse(JSON.parse(f.source.inventory.text));
  const original = inventory.executed.execution.input.attempt.request.admission;
  const target = {
    owner: { tenantId: binding.tenantId, accountId: binding.accountId, mode: 'PAPER' as const },
    orderId: String(randomUUID()),
    intentId: String(randomUUID()),
    dbInstrumentId: original.dbInstrumentId,
    dbRuleId: original.dbRuleId,
    command: {
      ...original.command,
      clientOrderId: 'next-calculation-only',
      size: { kind: 'BASE_QUANTITY' as const, asset: 'BTC', value: '0.2' },
    },
  };
  function reseal() {
    const s = f.source;
    // These are the exact heads of this one-account test graph.
    s.sourceHeads = wireHash({
      request: f.request,
      catalog: f.inventory.accounts.map((a) => ({ accountId: a.accountId, ...a.accountState })),
      executionHash: wireHash(
        z
          .object({ executed: z.object({ execution: z.unknown() }) })
          .parse(JSON.parse(s.inventory.text)).executed.execution,
      ),
      books: [],
      markets: f.inventory.markets.map(({ id, revision, hash }) => ({ id, revision, hash })),
      runtime: {
        id: s.runtime.publication.id,
        revision: s.runtime.publication.revision,
        hash: s.runtime.publication.hash,
        publishedAt: s.runtime.publication.publishedAt,
      },
      policies: s.policies,
      controlsHash: s.controls.hash,
      trade: {
        id: z.object({ id: z.uuid() }).parse(JSON.parse(s.market.trade.text)).id,
        revision: (
          BigInt(
            z.object({ expectedRevision: z.string() }).parse(JSON.parse(s.market.trade.text))
              .expectedRevision,
          ) + 1n
        ).toString(),
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
    const input = {
      now: f.now,
      sourceRequest: f.request,
      certificate: f.seal(f.certificate),
      target,
    };
    // The calculator deliberately accepts JSON content, not optional undefined
    // properties left by a test-only object graph before wire serialization.
    return JSON.parse(canonical(input)) as typeof input;
  }
  return { ...f, target, reseal };
}
