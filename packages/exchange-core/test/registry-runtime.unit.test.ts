import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import {
  createInstrumentRegistry,
  type InstrumentRecord,
  type RuntimeInstrumentRegistry,
} from '../src/registry.js';
import { failure } from '../src/errors.js';
import { featureSchema } from '../src/scope.js';
import { createBinanceAdapterWithIo } from '../../exchange-binance/src/adapter.js';
import { createBybitAdapterWithIo } from '../../exchange-bybit/src/adapter.js';
import { createOkxAdapterWithIo } from '../../exchange-okx/src/adapter.js';
import {
  adapterProfile as binanceProfile,
  getBinanceProfile,
} from '../../exchange-binance/src/profiles.js';
import {
  adapterProfile as bybitProfile,
  getBybitProfile,
} from '../../exchange-bybit/src/profiles.js';
import { adapterProfile as okxProfile, getOkxProfile } from '../../exchange-okx/src/profiles.js';
import type { MarketScope } from '../src/scope.js';
import { createBinanceAdapter } from '../../exchange-binance/src/index.js';
import { createBybitAdapter } from '../../exchange-bybit/src/index.js';
import { createOkxAdapter } from '../../exchange-okx/src/index.js';
import { normalizeExchangeInfo } from '../../exchange-binance/src/public-data.js';
import { normalizeInstrument as bybitInstrument } from '../../exchange-bybit/src/public-data.js';
import { normalizeInstrument as okxInstrument } from '../../exchange-okx/src/public-data.js';
import { exchangeInfo, spotSymbol } from '../../exchange-binance/test/fixtures/public-data.js';
import { nativeInstrument as bybitNative } from '../../exchange-bybit/test/fixtures.js';
import { nativeInstrument as okxNative } from '../../exchange-okx/test/fixtures.js';

const NOW = 1_800_000_000_000;
const assets = Array.from({ length: 300 }, (_, i) => `A${String(i).padStart(3, '0')}`);
const limiter = { reserve: () => Promise.resolve(true), observe: async () => {} };
const cases = [
  {
    exchange: 'BINANCE',
    profileId: 'binance-spot-testnet-v1',
    factory: createBinanceAdapter,
    assemble: createBinanceAdapterWithIo,
  },
  {
    exchange: 'BYBIT',
    profileId: 'bybit-spot-testnet-v1',
    factory: createBybitAdapter,
    assemble: createBybitAdapterWithIo,
  },
  {
    exchange: 'OKX',
    profileId: 'okx-spot-demo-v1',
    factory: createOkxAdapter,
    assemble: createOkxAdapterWithIo,
  },
] as const;
// Contract driver only, not a production registry implementation. Per-identity
// reference stores let this test exceed the former adapter-wide budget without
// evicting a single historical ID. Runtime storage is supplied by the server.
function ownedFixtureRegistry() {
  const stores = new Map<string, ReturnType<typeof createInstrumentRegistry>>();
  const key = (scope: MarketScope, id: string) =>
    JSON.stringify([scope.exchange, scope.region, scope.market, scope.environment, id]);
  let writes = 0;
  const port: RuntimeInstrumentRegistry = {
    get(scope, id, now) {
      return stores.get(key(scope, id))?.get(scope, id, now) ?? failure('NOT_FOUND');
    },
    put(record, now) {
      const k = key(record.instrument.scope, record.instrument.id);
      const store =
        stores.get(k) ?? createInstrumentRegistry({ capacity: 1, versionCapacity: 100_000 });
      const result = store.put(record, now);
      if (result.ok) {
        stores.set(k, store);
        writes++;
      }
      return result;
    },
  };
  return { port, count: () => stores.size, writes: () => writes };
}
// Small durable contract driver: acknowledge only after append+fsync, swap the
// validated candidate after commit, and replay every version on reopening.
// This finite fixture is deliberately not shipped or claimed as a runtime service.
function journalFixture(path: string) {
  type Entry = { record: InstrumentRecord; now: number };
  const entries: Entry[] = readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Entry);
  function recover(history: readonly Entry[]) {
    const registry = createInstrumentRegistry({ capacity: 300, versionCapacity: 100_000 });
    for (const e of history)
      if (!registry.put(e.record, e.now).ok) throw new Error('RECOVERY_FAILED');
    return registry;
  }
  let current = recover(entries);
  const port: RuntimeInstrumentRegistry = {
    get: (scope, id, now) => current.get(scope, id, now),
    put(record, now) {
      const candidate = recover(entries),
        result = candidate.put(record, now);
      if (!result.ok) return result;
      const fd = openSync(path, 'a');
      try {
        writeSync(fd, JSON.stringify({ record, now }) + '\n');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      entries.push({ record, now });
      current = candidate;
      return result;
    },
  };
  return port;
}
function records(exchange: MarketScope['exchange'], refresh: number): readonly InstrumentRecord[] {
  const now = NOW + refresh * 60_000;
  const observation = `refresh-${refresh}`;
  const scope: MarketScope = {
    exchange,
    region: 'global',
    market: 'SPOT',
    environment: exchange === 'OKX' ? 'DEMO' : 'TESTNET',
  };
  if (exchange === 'BINANCE')
    return normalizeExchangeInfo(
      exchangeInfo(
        assets.map((baseAsset) => ({ ...spotSymbol(), baseAsset, symbol: `${baseAsset}USDT` })),
      ),
      scope,
      now,
      observation,
    );
  return assets.map((asset) =>
    exchange === 'BYBIT'
      ? bybitInstrument(
          { ...bybitNative(), baseCoin: asset, symbol: `${asset}USDT` },
          scope,
          now,
          observation,
        ).record
      : okxInstrument(
          { ...okxNative(), baseCcy: asset, instId: `${asset}-USDT` },
          scope,
          now,
          observation,
        ).record,
  );
}
describe.each(cases)(
  '$exchange cross-adapter registry lifecycle reproduction',
  ({ exchange, profileId, factory, assemble }) => {
    it('rejects incomplete injected ports at the production export boundary', () => {
      const symbols = records(exchange, 0).map((r) => r.instrument.exchangeSymbol);
      for (const registry of [
        null,
        {},
        { get: () => failure('NOT_FOUND') },
        { put: () => failure('BUSY') },
        { get: 1, put: () => failure('BUSY') },
      ])
        expect(() =>
          factory({ profileId, symbols, capabilities: [], limiter, registry } as never),
        ).toThrow(`INVALID_${exchange}_CONFIGURATION`);
    });
    it('300 unchanged instruments exhaust the old default; production must require an explicit runtime owner', () => {
      const registry = createInstrumentRegistry({ capacity: 300, versionCapacity: 100_000 });
      let accepted = 0;
      let failure: unknown;
      for (let refresh = 0; refresh < 170 && !failure; refresh++) {
        const batch = records(exchange, refresh);
        expect(batch).toHaveLength(300);
        for (let i = 0; i < batch.length; i++) {
          const result = registry.put(batch[i], NOW + refresh * 60_000);
          if (!result.ok) {
            failure = { refresh, instrument: i, code: result.error.code };
            expect(
              registry.get(
                batch[i]!.instrument.scope,
                batch[i]!.instrument.id,
                NOW + refresh * 60_000,
              ),
            ).toMatchObject({ ok: false, error: { code: 'STALE_METADATA' } });
            break;
          }
          accepted++;
        }
      }
      expect(accepted).toBe(50_000);
      expect(failure).toEqual({ refresh: 166, instrument: 200, code: 'BUSY' });
      expect(registry.size()).toBe(300);
      const symbols = records(exchange, 0).map((r) => r.instrument.exchangeSymbol);
      // Unknown input deliberately omits the dependency; runtime validation must reject it.
      const input = { profileId, symbols, capabilities: [], limiter };
      expect(() => factory(input as never)).toThrow(`INVALID_${exchange}_CONFIGURATION`);
    }, 60_000);
    it('180 real metadata refreshes for 300 symbols use the injected owner across adapter recreation', async () => {
      const registry = ownedFixtureRegistry();
      let clock = NOW,
        requests = 0;
      const symbols = records(exchange, 0).map((r) => r.instrument.exchangeSymbol);
      const profile =
        exchange === 'BINANCE'
          ? binanceProfile(getBinanceProfile('binance-spot-testnet-v1'))
          : exchange === 'BYBIT'
            ? bybitProfile(getBybitProfile('bybit-spot-testnet-v1'))
            : okxProfile(getOkxProfile('okx-spot-demo-v1'));
      const input = {
        profileId,
        symbols,
        registry: registry.port,
        limiter,
        now: () => clock,
        capabilities: featureSchema.options.map((feature) => ({
          profile,
          feature,
          support: 'SUPPORTED',
          implementation: 'NATIVE',
          constraints: {},
          evidenceUrl: 'https://example.test/registry-contract',
          checkedAt: NOW - 1,
          expiresAt: NOW + 86_400_000,
          adapterVersion: `${exchange.toLowerCase()}-v1`,
        })),
      };
      const io = {
        request() {
          requests++;
          const rows =
            exchange === 'BINANCE'
              ? assets.map((baseAsset) => ({
                  ...spotSymbol(),
                  baseAsset,
                  symbol: `${baseAsset}USDT`,
                }))
              : exchange === 'BYBIT'
                ? assets.map((baseCoin) => ({
                    ...bybitNative(),
                    baseCoin,
                    symbol: `${baseCoin}USDT`,
                  }))
                : assets.map((baseCcy) => ({ ...okxNative(), baseCcy, instId: `${baseCcy}-USDT` }));
          const body =
            exchange === 'BINANCE'
              ? exchangeInfo(rows)
              : exchange === 'BYBIT'
                ? {
                    retCode: 0,
                    result: { category: 'spot', list: rows, nextPageCursor: '' },
                    time: clock,
                  }
                : { code: '0', data: rows };
          return Promise.resolve({ status: 200, headers: {}, body: JSON.stringify(body) });
        },
        openSocket: () => Promise.reject(new Error('NO_WS_IN_METADATA_CONTRACT')),
        close: async () => {},
      };
      let adapter = assemble(input as never, io);
      try {
        for (let refresh = 0; refresh < 180; refresh++) {
          clock = NOW + refresh * 60_000;
          if (refresh === 90) {
            await adapter.disconnect();
            adapter = assemble(input as never, io);
          }
          const context = {
            profile: adapter.profile,
            account: null,
            signal: new AbortController().signal,
            deadline: clock + 5000,
            correlationId: 'registry-contract',
          };
          const query = { limit: 200, cursor: null, queryId: `refresh-${refresh}` };
          const first = await adapter.getSymbols(query, context);
          if (!first.ok) throw new Error(`${exchange} refresh ${refresh}: ${first.error.code}`);
          expect(first.value.items).toHaveLength(200);
          const last = await adapter.getSymbols(
            { ...query, cursor: first.value.nextCursor },
            context,
          );
          if (!last.ok) throw new Error(last.error.code);
          expect(last.value.items).toHaveLength(100);
          expect(last.value.nextCursor).toBeNull();
          expect(registry.count()).toBe(300);
          const rules = await adapter.getSymbolInfo(
            { instrumentId: first.value.items[0]!.id },
            context,
          );
          expect(rules.ok).toBe(true);
          // Registry injection grants neither private authority nor trading permission.
          expect(await adapter.getBalances({}, context)).toMatchObject({
            ok: false,
            error: { code: 'AUTHORIZATION_REQUIRED' },
          });
        }
        expect(requests).toBe(180);
        expect(registry.writes()).toBe(54_000); // 108k version IDs, beyond the old budget.
      } finally {
        await adapter.disconnect();
      }
    }, 60_000);
    it('injected durable history survives reopen and rejects independent rules/metadata A→B→A reuse', async () => {
      const root = resolve(tmpdir());
      const directory = mkdtempSync(join(root, 'registry-contract-'));
      const path = join(directory, 'history.jsonl');
      const fd = openSync(path, 'w');
      closeSync(fd);
      try {
        const a = records(exchange, 0)[0]!,
          b = records(exchange, 1)[0]!;
        const first = journalFixture(path);
        expect((await first.put(a, NOW)).ok).toBe(true);
        expect((await first.put(b, NOW + 60_000)).ok).toBe(true);
        const reopened = journalFixture(path);
        expect(reopened.get(b.instrument.scope, b.instrument.id, NOW + 60_000)).toMatchObject({
          ok: true,
          value: b,
        });
        const attempts = [
          { ...b, rules: { ...b.rules, version: a.rules.version } },
          { ...b, instrument: { ...b.instrument, metadataVersion: a.instrument.metadataVersion } },
        ];
        for (const attempted of attempts)
          expect(reopened.put(attempted, NOW + 60_000)).toMatchObject({
            ok: false,
            error: { code: 'INVALID_RESPONSE' },
          });
        expect(
          journalFixture(path).get(b.instrument.scope, b.instrument.id, NOW + 60_000),
        ).toMatchObject({ ok: true, value: b });
        // A fresh reference instance has no restart history: explicitly unsuitable for runtime recovery.
        expect(createInstrumentRegistry({ capacity: 300 }).put(a, NOW).ok).toBe(true);
        const corrupt = openSync(path, 'a');
        try {
          writeSync(corrupt, '{"incomplete":');
          fsyncSync(corrupt);
        } finally {
          closeSync(corrupt);
        }
        expect(() => journalFixture(path)).toThrow(); // Never recover as an empty writable registry.
      } finally {
        expect(dirname(resolve(directory))).toBe(root);
        expect(basename(directory).startsWith('registry-contract-')).toBe(true);
        rmSync(directory, { recursive: true, force: true });
      }
    });
  },
);
