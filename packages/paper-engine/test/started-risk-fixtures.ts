import { wireNow } from './admission-wire-fixtures.js';
import { executionRiskFixture } from './execution-risk-fixtures.js';
import { startedSourceFixture } from './started-source-fixtures.js';

// Wire content only. The fixed locked SQL reader must establish authenticity.
export function startedRiskFixture(count = 1) {
  const current = executionRiskFixture(count),
    started = startedSourceFixture(count);
  started.packet.capture = current.packet.capture;
  const { publication, ...context } = current.packet.runtime;
  void publication;
  started.packet.context = { ...context, kind: 'PAPER_RUNTIME_CONTEXT' };
  const request = { ...started.request, kind: 'PAPER_STARTED_RISK_CAPTURE' as const };
  const risk = { ...current.packet, asOf: wireNow + 1, journal: started.packet.journal };
  const packet = {
    kind: 'PAPER_STARTED_RISK_CAPTURE',
    request,
    asOf: wireNow + 1,
    started: started.packet,
    risk,
  };
  return {
    ...current,
    request,
    packet,
    started,
    seal() {
      current.seal();
      risk.controls = current.packet.controls;
    },
  };
}
