import { createInstrumentRegistry } from '../packages/exchange-core/dist/index.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHtxAdapter } from '../packages/exchange-htx/dist/index.js';
import {
  getHtxProfile,
  adapterProfile,
  htxProfileIds,
} from '../packages/exchange-htx/dist/profiles.js';

// Manual server-owned read-only acceptance. No connection/credentials/authorizer;
// importing the script does not start I/O, and no CLI destinations are accepted.
const operations = [
  'getServerTime',
  'getSymbols',
  'getTicker',
  'getOrderBook',
  'getHistoricalCandles',
  'subscribeTicker',
];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function probeHtxPublic() {
  const startedAt = new Date().toISOString(),
    profiles = [];
  let blockedGlobally = null;
  for (const profileId of htxProfileIds) {
    if (blockedGlobally) {
      profiles.push({
        profileId,
        operations: operations.map((operation) => ({
          operation,
          status: 'NOT_RUN',
          code: blockedGlobally,
        })),
      });
      continue;
    }
    const start = Date.now(),
      deadline = start + 20_000,
      controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 20_000);
    const endpoint = getHtxProfile(profileId),
      profile = adapterProfile(endpoint),
      symbol = endpoint.spot ? 'btcusdt' : 'BTC-USDT';
    let reservations = 0,
      connections = 0,
      controls = 0;
    const httpStatuses = [];
    const limiter = {
      async reserve(request, context) {
        if (
          context.signal.aborted ||
          Date.now() >= context.deadline ||
          request.profileId !== profileId ||
          request.accountId !== null ||
          request.orders !== 0 ||
          !['GET', 'WS'].includes(request.method) ||
          reservations >= 12 ||
          connections + request.connectionAttempts > 2 ||
          controls + request.controlMessages > 5
        )
          return false;
        reservations++;
        connections += request.connectionAttempts;
        controls += request.controlMessages;
        return true;
      },
      async observe(_request, status) {
        httpStatuses.push(status);
      },
    };
    const capabilities = ['PUBLIC_READ', 'PUBLIC_STREAM', 'HISTORICAL_CANDLES'].map((feature) => ({
      profile,
      feature,
      support: 'SUPPORTED',
      implementation: 'NATIVE',
      constraints:
        feature === 'HISTORICAL_CANDLES'
          ? { instrumentIds: [symbol], timeframes: ['1m'] }
          : feature === 'PUBLIC_STREAM'
            ? { instrumentIds: [symbol] }
            : {},
      evidenceUrl: 'https://huobiapi.github.io/docs/spot/v1/en/',
      checkedAt: start,
      expiresAt: start + 30_000,
      adapterVersion: 'htx-v1',
    }));
    const adapter = createHtxAdapter({
      registry: createInstrumentRegistry({ capacity: 1, versionCapacity: 128 }),
      profileId,
      symbols: [symbol],
      capabilities,
      limiter,
    });
    const context = (end = deadline) => ({
      profile: adapter.profile,
      account: null,
      deadline: Math.min(deadline, end),
      signal: controller.signal,
      correlationId: `probe-${profileId}`,
    });
    const results = [];
    let metadata = false,
      blocked = null;
    try {
      for (const operation of operations) {
        if (blocked || (operation !== 'getServerTime' && operation !== 'getSymbols' && !metadata)) {
          results.push({ operation, status: 'NOT_RUN', code: blocked ?? 'INSTRUMENT_UNAVAILABLE' });
          continue;
        }
        let result;
        const countBefore = httpStatuses.length;
        if (operation === 'getServerTime') result = await adapter.getServerTime({}, context());
        else if (operation === 'getSymbols') {
          result = await adapter.getSymbols(
            { limit: 1, cursor: null, queryId: 'probe-metadata' },
            context(),
          );
          metadata = result.ok && result.value.items.some((i) => i.id === symbol);
        } else if (operation === 'getTicker')
          result = await adapter.getTicker({ instrumentId: symbol }, context());
        else if (operation === 'getOrderBook')
          result = await adapter.getOrderBook({ instrumentId: symbol, depth: 5 }, context());
        else if (operation === 'getHistoricalCandles') {
          const to = Math.floor(Date.now() / 60_000) * 60_000;
          result = await adapter.getHistoricalCandles(
            {
              instrumentId: symbol,
              timeframe: '1m',
              from: to - 180_000,
              to,
              limit: 3,
              cursor: null,
              queryId: 'probe-candles',
            },
            context(),
          );
        } else {
          const subscribed = await adapter.subscribeTicker(
            { instrumentId: symbol },
            context(Date.now() + 2500),
          );
          if (!subscribed.ok) {
            results.push({ operation, status: 'NOT_RUN', code: `WS_${subscribed.error.code}` });
            continue;
          }
          try {
            const next = await subscribed.value[Symbol.asyncIterator]().next();
            results.push(
              next.done || next.value.kind !== 'DATA'
                ? { operation, status: 'NOT_RUN', code: 'WS_NO_DATA' }
                : {
                    operation,
                    status: 'PASS',
                    shape: { lastAvailable: next.value.data.last.state === 'AVAILABLE' },
                  },
            );
          } finally {
            await subscribed.value.unsubscribe();
          }
          continue;
        }
        const status = httpStatuses.length > countBefore ? httpStatuses.at(-1) : undefined;
        if (!result.ok) {
          const code = result.error.code;
          if (status === 403 || status === 451) {
            blocked = `NETWORK_${status}`;
            blockedGlobally = blocked;
          } else if (status === 429) blocked = 'NETWORK_429';
          else if (
            status === undefined &&
            ['ABORTED', 'DEADLINE_EXCEEDED', 'UNAVAILABLE'].includes(code)
          )
            blocked = 'NETWORK_UNAVAILABLE';
          results.push({
            operation,
            status: blocked ? 'NOT_RUN' : 'FAIL',
            code: blocked ?? code,
            ...(status === undefined ? {} : { httpStatus: status }),
          });
        } else {
          const value = result.value;
          const shape =
            operation === 'getSymbols' || operation === 'getHistoricalCandles'
              ? { items: value.items.length, nextPage: value.nextCursor !== null }
              : operation === 'getOrderBook'
                ? {
                    bids: value.bids.length,
                    asks: value.asks.length,
                    sequencePresent: value.sourceSequence !== null,
                  }
                : operation === 'getTicker'
                  ? { lastAvailable: value.last.state === 'AVAILABLE' }
                  : { exchangeTimePresent: Number.isSafeInteger(value.exchangeTime) };
          results.push({
            operation,
            status: 'PASS',
            shape,
            ...(status === undefined ? {} : { httpStatus: status }),
          });
        }
      }
    } catch {
      results.push({ operation: 'profile', status: 'FAIL', code: 'PROBE_FAILED' });
    } finally {
      clearTimeout(timer);
      controller.abort();
      await adapter.disconnect();
    }
    profiles.push({
      profileId,
      reservations,
      connections,
      controls,
      httpStatuses,
      operations: results,
    });
  }
  const failed = profiles.some((p) => p.operations.some((x) => x.status === 'FAIL')),
    partial = profiles.some((p) => p.operations.some((x) => x.status === 'NOT_RUN'));
  const report = {
    status: failed ? 'FAIL' : partial ? 'PARTIAL' : 'PASS',
    startedAt,
    completedAt: new Date().toISOString(),
    scope:
      'Server-controlled public REST/WS only; btcusdt/BTC-USDT; <=12 reservations, <=2 connections, <=5 controls per profile; stop all profiles on 403/451; no retries/redirects/alternate hosts/private requests/mutations',
    profiles,
  };
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(
    path.join(root, 'test-results/phase8-htx-public-probe.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      status: report.status,
      profiles: profiles.map((p) => ({
        profileId: p.profileId,
        operations: p.operations.map((x) => ({
          operation: x.operation,
          status: x.status,
          code: x.code,
        })),
      })),
    }),
  );
  return failed ? 1 : partial ? 2 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  process.exitCode = await probeHtxPublic();
