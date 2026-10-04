import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExchangeAdapter } from '@ctp/exchange-core';
import { normalizeInstrument } from '../src/public-data.js';
import { harness } from './harness.js';
import { scope, now } from './fixtures.js';
const raw = JSON.parse(
  readFileSync(new URL('./fixtures/demo-spot-instrument.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const adapters: ExchangeAdapter[] = [];
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.disconnect();
});
describe('actual 2026-10-04 OKX Demo Spot native metadata regression', () => {
  it('empty native Spot maxMktSz preserves readable metadata and explicit unsupported admission', () => {
    const r = normalizeInstrument(raw, scope, now, 'native-demo-spot');
    expect(r.record.rules.quantityUnit).toBe('BASE');
    expect(r.record.rules.marketMaxQuantity).toBe('9999999999');
    expect(r.admission.unsupportedConstraints).toContain('maxMktSz');
    expect(r.admission.unsupportedConstraints).toContain('posLmtAmt');
  });
  it('actual unproved fields fail closed for new risk through Core', async () => {
    const x = harness();
    adapters.push(x.adapter);
    x.state.instrument = { ...raw };
    const v = await x.warm();
    expect(
      await x.adapter.createOrder(x.permit('createOrder', x.order(v)), x.context()),
    ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'UNSUPPORTED' } });
    expect(x.admission.validate).not.toHaveBeenCalled();
    expect(x.request.mock.calls.some(([r]) => r.method === 'POST')).toBe(false);
  });
});
