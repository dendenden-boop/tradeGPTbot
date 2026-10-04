import { describe, expect, it } from 'vitest';
import {
  createInstrumentRegistry,
  type RuntimeInstrumentRegistry,
  type ReferenceInstrumentRegistry,
} from '@ctp/exchange-core';
import { createHtxAdapterWithIo } from '../src/adapter.js';
import { harness } from './harness.js';
import { spot } from './fixtures.js';
describe('HTX injected registry lifecycle for 300 instruments', () => {
  it('180 refreshes and adapter recreation use the same owner without hidden 100k exhaustion', async () => {
    const x = harness(),
      owners = new Map<string, ReferenceInstrumentRegistry>(),
      symbols = Array.from({ length: 300 }, (_, i) => `c${i}usdt`),
      rows = symbols.map((symbol, i) => ({ ...spot, symbol, bc: `c${i}` }));
    await x.adapter.disconnect();
    let puts = 0;
    // Bounded 180-refresh fixture, not a production persistence service. Each identity retains history.
    const registry: RuntimeInstrumentRegistry = {
      get(scope, id, t) {
        const r = owners.get(id);
        if (!r) throw new Error('UNINITIALIZED_FIXTURE_ID');
        return r.get(scope, id, t);
      },
      put(record, t) {
        let r = owners.get(record.instrument.id);
        if (!r) {
          r = createInstrumentRegistry({ capacity: 1, versionCapacity: 400 });
          owners.set(record.instrument.id, r);
        }
        puts++;
        return r.put(record, t);
      },
    };
    x.state.route = (r) =>
      r.url.pathname === '/v1/settings/common/market-symbols'
        ? x.response(rows, { full: 1 })
        : x.native(r);
    const options = { ...x.options, symbols, registry };
    let adapter = createHtxAdapterWithIo(options, x.io);
    try {
      for (let refresh = 0; refresh < 180; refresh++) {
        if (refresh === 90) {
          await adapter.disconnect();
          adapter = createHtxAdapterWithIo(options, x.io);
        }
        const first = await adapter.getSymbols(
          { limit: 200, cursor: null, queryId: `r${refresh}` },
          x.context(),
        );
        expect(first.ok).toBe(true);
        if (!first.ok) throw new Error(first.error.code);
        const last = await adapter.getSymbols(
          { limit: 200, cursor: first.value.nextCursor, queryId: `r${refresh}` },
          x.context(),
        );
        expect(last).toMatchObject({
          ok: true,
          value: { nextCursor: null },
        });
        if (!last.ok) throw new Error();
        expect(first.value.items.length + last.value.items.length).toBe(300);
        x.state.time += 60001;
      }
      expect(puts).toBe(54000);
      expect(owners.size).toBe(300);
      const owner = owners.get(symbols[0]!)!,
        old = owner.get(x.endpoint.scope, symbols[0]!, x.state.time - 60001);
      if (!old.ok) throw new Error();
      expect(
        owner.put(
          {
            ...old.value,
            instrument: { ...old.value.instrument, metadataVersion: 'new-meta' },
            rules: {
              ...old.value.rules,
              version: 'new-rules',
              effectiveAt: x.state.time,
              expiresAt: x.state.time + 60000,
            },
          },
          x.state.time,
        ).ok,
      ).toBe(true);
      expect(
        owner.put(
          {
            ...old.value,
            rules: {
              ...old.value.rules,
              effectiveAt: x.state.time,
              expiresAt: x.state.time + 60000,
            },
          },
          x.state.time,
        ),
      ).toMatchObject({ ok: false });
    } finally {
      await adapter.disconnect();
    }
  }, 60000);
});
