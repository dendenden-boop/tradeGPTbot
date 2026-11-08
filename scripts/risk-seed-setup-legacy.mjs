// Exact test-only predecessor restoration for independent native seed preparation.
import { createHash } from 'node:crypto';
// BEGIN CERTIFIED CLUSTER LEGACY_IMPORT
import { beforeCertifiedCluster } from './certified-cluster-legacy.mjs';
// END CERTIFIED CLUSTER LEGACY_IMPORT
const original =
  "  const registry = await createPostgresInstrumentRegistry({\n    ...ports.registryOptions,\n    scope: i.scope,\n    instrumentIds: [i.id],\n  });\n  try {\n    if (ports.nativeProfile) {\n      // Native public transport has already durably published this exact immutable version.\n      expect(registry.get(i.scope, i.id, Date.now())).toEqual({ ok: true, value: f.risk.record });\n    } else expect((await registry.putBatch([f.risk.record], Date.now(), io())).ok).toBe(true);\n  } finally {\n    await registry.close();\n  }\n  await portfolio.apply(\n    { ...binding(), ...identities },\n    snapshot({ id: randomUUID(), timestamp: f.now }),\n    0,\n    io(),\n  );\n  const { clientOrderId: omitted, ...order } = f.risk.order;\n  void omitted;\n  const created = await orders.create(\n    orderBindingSchema.parse(b),\n    {\n      key: randomUUID(),\n      dbInstrumentId: f.key.dbInstrumentId,\n      dbRuleId: f.key.dbRuleId,\n      positionSide: 'NET',\n      bucket: 'CROSS',\n      order,\n    },\n    io(),\n  );\n  f.key.intentId = created.intentId;\n  f.raw.intent.id = created.intentId;\n  f.raw.intent.command = created.command;\n  const p =\n    (\n      await admin.query<{ version: string }>(\n        \"SELECT version::text FROM ctp_risk.policy_head WHERE scope='PLATFORM' AND mode='TESTNET'\",\n      )\n    ).rows[0]?.version ?? '0';\n  await platform.update(\n    {\n      scope: { kind: 'PLATFORM' },\n      mode: 'TESTNET',\n      eventId: randomUUID(),\n      expectedVersion: p,\n      reason: 'ISOLATED_CERTIFICATION_FIXTURE',\n      limits: riskLimitsSchema.parse(f.risk.platform),\n    },\n    io(),\n  );\n  await user.update(\n    {\n      scope: { kind: 'USER', tenantId: b.tenantId },\n      mode: 'TESTNET',\n      eventId: randomUUID(),\n      expectedVersion: '0',\n      reason: 'ISOLATED_CERTIFICATION_FIXTURE',\n      limits: riskLimitsSchema.parse(f.risk.user),\n    },\n    io(),\n  );\n";
const reviewedInput = '7f6f2037b5afc4e5e8e74a8390091fc04511ae2777fbda417f9b84d0268942f9',
  previousInput = '6b73c812085a6e1230fa0bc01a34c1525b0ed42c5832c5908056d35e5922f54c';
export function beforeRiskSeedSetup(file, source) {
  // BEGIN CERTIFIED CLUSTER LEGACY_RESTORE
  source = beforeCertifiedCluster(file, source);
  // END CERTIFIED CLUSTER LEGACY_RESTORE
  if (['scripts/database-cohorts.mjs', 'scripts/native-main-scopes.mjs'].includes(file)) {
    if (!source.includes(reviewedInput)) return source;
    if (source.split(reviewedInput).length !== 2) throw Error('RISK_SEED_REVIEW_REQUIRED');
    return source.replace(reviewedInput, previousInput);
  }
  if (
    file !== 'packages/database/test/fixtures/risk-certification.ts' ||
    !source.includes('NATIVE RISK SEED LANES')
  )
    return source;
  const blocks = source.match(
    /^ {2}\/\/ BEGIN NATIVE RISK SEED LANES\n[\s\S]*?^ {2}\/\/ END NATIVE RISK SEED LANES\n/gm,
  );
  if (
    blocks?.length !== 1 ||
    (source.match(/NATIVE RISK SEED LANES/gu) ?? []).length !== 2 ||
    createHash('sha256').update(blocks[0]).digest('hex') !==
      '75486adc8ff4adb2c92756a5a4770851fd04ffffafdd62219393c0b16b355fe8'
  )
    throw Error('RISK_SEED_REVIEW_REQUIRED');
  return source.replace(blocks[0], original);
}
