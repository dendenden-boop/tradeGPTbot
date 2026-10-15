import { createHash, randomUUID } from 'node:crypto';
import { canonical } from '@ctp/portfolio';
import { fixture as modelFixture } from './fixtures.js';
import { paperRuntimeDependencies, type PaperRuntimePublication } from '../src/runtime-domain.js';

export const runtimeNow = 1800000000000;
export function runtimeFixture(now = runtimeNow) {
  const owner = { tenantId: randomUUID(), accountId: randomUUID(), mode: 'PAPER' as const };
  const configuration = {
    configuration: {
      id: randomUUID(),
      owner,
      source: {
        exchange: 'BINANCE' as const,
        market: 'SPOT' as const,
        environment: 'LIVE' as const,
        region: 'global',
      },
      valuationAsset: 'USDT',
      model: modelFixture().model,
    },
    accountIdentity: {
      externalAccountId: 'paper:' + owner.accountId,
      clientIdEpoch: 'paper-runtime-fixture',
    },
    createdAt: now - 100,
  };
  const receiptText = canonical(configuration),
    hash = createHash('sha256').update(receiptText).digest('hex');
  const health = Object.fromEntries(
    paperRuntimeDependencies.map((k) => [
      k,
      { sourceId: k + ':probe:v1', asOf: now - 20, status: 'HEALTHY' },
    ]),
  ) as PaperRuntimePublication['observation']['health'];
  const publication: PaperRuntimePublication = {
    id: randomUUID(),
    expectedRevision: '3',
    observation: {
      owner,
      configurationId: configuration.configuration.id,
      configurationHash: hash,
      permissionEpoch: '9007199254740993',
      userSessionEpoch: '2147483647',
      accountVersion: 0,
      health,
    },
  };
  const w = {
    kind: 'PAPER_RUNTIME_CAPTURE' as const,
    owner,
    asOf: now,
    configuration: { receiptText, hash },
    current: {
      permissionEpoch: publication.observation.permissionEpoch,
      userSessionEpoch: publication.observation.userSessionEpoch,
      accountVersion: 0,
      ...configuration.accountIdentity,
    },
    publication: {
      id: publication.id,
      revision: '4',
      text: canonical(publication),
      hash: '',
      publishedAt: now - 10,
    },
  };
  w.publication.hash = createHash('sha256').update(w.publication.text).digest('hex');
  return { owner, configuration, publication, w, now };
}
export function replaceRuntimePublication(
  w: ReturnType<typeof runtimeFixture>['w'],
  publication: PaperRuntimePublication,
) {
  w.publication.text = canonical(publication);
  w.publication.hash = createHash('sha256').update(w.publication.text).digest('hex');
}
