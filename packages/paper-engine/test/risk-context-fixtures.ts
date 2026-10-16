import { createHash, randomUUID } from 'node:crypto';
import { canonical } from '@ctp/portfolio';
import { paperConfigurationReceiptSchema } from '../src/configuration-domain.js';
import { paperRuntimeDependencies, type PaperRuntimePublication } from '../src/runtime-domain.js';
import { riskAuthorityFixture } from './risk-authority-fixtures.js';

export function riskContextFixture() {
  const f = riskAuthorityFixture();
  const origin = JSON.parse(f.order.book.origin.receiptText) as {
    configuration: { receiptText: string; hash: string };
  };
  const configuration = paperConfigurationReceiptSchema.parse(
    JSON.parse(origin.configuration.receiptText),
  );
  const identity = f.wire.identity;
  const publication: PaperRuntimePublication = {
    id: randomUUID(),
    expectedRevision: '9007199254740993',
    observation: {
      owner: f.request.owner,
      configurationId: configuration.configuration.id,
      configurationHash: origin.configuration.hash,
      permissionEpoch: identity.permissionEpoch,
      userSessionEpoch: identity.userSessionEpoch,
      accountVersion: identity.accountVersion,
      health: Object.fromEntries(
        paperRuntimeDependencies.map((k) => [
          k,
          {
            sourceId: k + ':test-only:v1',
            asOf: 200000,
            status: 'HEALTHY',
          },
        ]),
      ) as PaperRuntimePublication['observation']['health'],
    },
  };
  const runtime = {
    kind: 'PAPER_RUNTIME_CAPTURE',
    owner: f.request.owner,
    asOf: 200000,
    configuration: origin.configuration,
    current: {
      permissionEpoch: identity.permissionEpoch,
      userSessionEpoch: identity.userSessionEpoch,
      accountVersion: identity.accountVersion,
      ...configuration.accountIdentity,
    },
    publication: {
      id: publication.id,
      revision: '9007199254740994',
      text: '',
      hash: '',
      publishedAt: 200000,
    },
  };
  const seal = () => {
    f.seal();
    runtime.publication.text = canonical(publication);
    runtime.publication.hash = createHash('sha256').update(runtime.publication.text).digest('hex');
  };
  seal();
  return {
    ...f,
    seal,
    publication,
    runtime,
    wire: { kind: 'PAPER_RISK_CONTEXT_CAPTURE', asOf: 200000, authority: f.wire, runtime },
  };
}
