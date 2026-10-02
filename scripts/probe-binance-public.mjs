import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createBinanceAdapter,
  getBinanceProfile,
} from '../packages/exchange-binance/dist/index.js';

// Manual read-only acceptance probe. Importing this module never starts network I/O.
// Build @ctp/exchange-core and @ctp/exchange-binance before invoking the Node CLI.
const PROFILE_IDS = Object.freeze([
  'binance-spot-live-v1',
  'binance-spot-testnet-v1',
  'binance-spot-demo-v1',
  'binance-usdm-live-v1',
  'binance-usdm-testnet-v1',
]);
const OPERATIONS = Object.freeze([
  'getServerTime',
  'getSymbols',
  'getTicker',
  'getOrderBook',
  'getHistoricalCandles',
  'subscribeTicker',
]);
const MAX_WEIGHT = 40;
const MAX_REQUESTS = 8;
const PROFILE_WINDOW_MS = 10_000;
const WS_WINDOW_MS = 3500;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = path.join(root, 'test-results', 'phase5-binance-public-probe.json');

function nativeEvidence(endpoint, startedAt) {
  const spot = endpoint.scope.market === 'SPOT';
  const rest = spot
    ? 'https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md'
    : 'https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data';
  const streams = spot
    ? 'https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md'
    : 'https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/market';
  const profile = Object.freeze({
    ...endpoint.scope,
    accountMode: endpoint.accountMode,
    profileVersion: 'binance-contract-v1',
    endpointProfileId: endpoint.id,
  });
  return ['PUBLIC_READ', 'HISTORICAL_CANDLES', 'PUBLIC_STREAM'].map((feature) => ({
    profile,
    feature,
    support: 'SUPPORTED',
    implementation: 'NATIVE',
    constraints:
      feature === 'PUBLIC_READ'
        ? {}
        : feature === 'HISTORICAL_CANDLES'
          ? { instrumentIds: ['BTCUSDT'], timeframes: ['1m'] }
          : { instrumentIds: ['BTCUSDT'] },
    evidenceUrl: feature === 'PUBLIC_STREAM' ? streams : rest,
    checkedAt: startedAt,
    expiresAt: startedAt + 60_000,
    adapterVersion: 'binance-v1',
  }));
}

function shape(operation, value) {
  if (operation === 'getServerTime')
    return {
      exchangeTimePresent: Number.isSafeInteger(value.exchangeTime),
      receivedAtPresent: Number.isSafeInteger(value.receivedAt),
    };
  if (operation === 'getSymbols' || operation === 'getHistoricalCandles')
    return { items: value.items.length, nextPage: value.nextCursor !== null };
  if (operation === 'getOrderBook')
    return {
      bids: value.bids.length,
      asks: value.asks.length,
      snapshot: value.kind === 'SNAPSHOT',
      exchangeTimePresent: value.exchangeTime !== null,
      sourceSequencePresent: value.sourceSequence !== null,
    };
  return {
    lastAvailable: value.last.state === 'AVAILABLE',
    bidAvailable: value.bid.state === 'AVAILABLE',
    askAvailable: value.ask.state === 'AVAILABLE',
    exchangeTimePresent: Number.isSafeInteger(value.exchangeTime),
  };
}

function blockedCode(status, code, expired) {
  if (status === 403 || status === 451) return `NETWORK_${status}`;
  if (status === 418 || status === 429) return `NETWORK_${status}`;
  if (status >= 300 && status < 400) return 'NETWORK_REDIRECT';
  if (status >= 500) return `NETWORK_${status}`;
  if (status === undefined && expired) return 'NETWORK_DEADLINE';
  if (status === undefined && ['UNAVAILABLE', 'ABORTED', 'DEADLINE_EXCEEDED'].includes(code))
    return 'NETWORK_UNAVAILABLE';
  return null;
}

async function probeProfile(profileId) {
  const startedAt = Date.now();
  const deadline = startedAt + PROFILE_WINDOW_MS;
  const endpoint = getBinanceProfile(profileId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROFILE_WINDOW_MS);
  timer.unref();
  let requests = 0;
  let weight = 0;
  let wsAttempts = 0;
  const statuses = [];
  const results = [];
  let blocked = null;
  let eligible = false;
  // Deliberately tiny per-profile manual budget. Production uses a coordinated
  // egress/account limiter; this probe cannot authorize any private operation.
  const limiter = Object.freeze({
    reserve(request, context) {
      if (
        context.signal.aborted ||
        Date.now() >= context.deadline ||
        request.profileId !== profileId ||
        request.accountId !== null ||
        !['GET', 'WS'].includes(request.method) ||
        request.orders !== 0 ||
        !Number.isSafeInteger(request.weight) ||
        request.weight < 0 ||
        requests + 1 > MAX_REQUESTS ||
        weight + request.weight > MAX_WEIGHT ||
        (request.method === 'WS' && wsAttempts >= 1)
      )
        return Promise.resolve(false);
      requests += 1;
      weight += request.weight;
      if (request.method === 'WS') wsAttempts += 1;
      return Promise.resolve(true);
    },
    observe(_request, status) {
      // Only numeric HTTP evidence, never response bodies, headers or exchange messages.
      statuses.push(status);
      return Promise.resolve();
    },
  });
  const adapter = createBinanceAdapter({
    profileId,
    symbols: ['BTCUSDT'],
    capabilities: nativeEvidence(endpoint, startedAt),
    limiter,
  });
  const context = (until = deadline) => ({
    profile: adapter.profile,
    account: null,
    deadline: Math.min(deadline, until),
    signal: controller.signal,
    correlationId: `public-probe-${profileId}`,
  });
  try {
    for (const operation of OPERATIONS) {
      if (
        blocked !== null ||
        (operation !== 'getServerTime' && operation !== 'getSymbols' && !eligible)
      ) {
        results.push({ operation, status: 'NOT_RUN', code: blocked ?? 'INSTRUMENT_UNAVAILABLE' });
        continue;
      }
      if (Date.now() >= deadline) {
        blocked = 'NETWORK_DEADLINE';
        results.push({ operation, status: 'NOT_RUN', code: blocked });
        continue;
      }
      if (operation === 'subscribeTicker') {
        const subscribed = await adapter.subscribeTicker(
          { instrumentId: 'BTCUSDT' },
          context(Date.now() + WS_WINDOW_MS),
        );
        if (!subscribed.ok) {
          const code = subscribed.error.code;
          results.push({ operation, status: 'NOT_RUN', code: `WS_${code}` });
          continue;
        }
        try {
          const iterator = subscribed.value[Symbol.asyncIterator]();
          const next = await iterator.next();
          if (next.done || next.value.kind !== 'DATA')
            results.push({
              operation,
              status: 'NOT_RUN',
              code: next.done ? 'WS_NO_DATA' : `WS_${next.value.kind}_${next.value.reason}`,
            });
          else
            results.push({ operation, status: 'PASS', shape: shape(operation, next.value.data) });
        } finally {
          await subscribed.value.unsubscribe();
        }
        continue;
      }
      const before = statuses.length;
      let result;
      if (operation === 'getServerTime') result = await adapter.getServerTime({}, context());
      else if (operation === 'getSymbols')
        result = await adapter.getSymbols(
          { limit: 1, cursor: null, queryId: 'public-probe-symbols' },
          context(),
        );
      else if (operation === 'getTicker')
        result = await adapter.getTicker({ instrumentId: 'BTCUSDT' }, context());
      else if (operation === 'getOrderBook')
        result = await adapter.getOrderBook({ instrumentId: 'BTCUSDT', depth: 5 }, context());
      else {
        const to = Math.floor(Date.now() / 60_000) * 60_000;
        result = await adapter.getHistoricalCandles(
          {
            instrumentId: 'BTCUSDT',
            timeframe: '1m',
            from: to - 180_000,
            to,
            limit: 3,
            cursor: null,
            queryId: 'public-probe-candles',
          },
          context(),
        );
      }
      const status = statuses.length > before ? statuses.at(-1) : undefined;
      if (!result.ok) {
        const code = result.error.code;
        blocked = blockedCode(status, code, Date.now() >= deadline);
        results.push({
          operation,
          status: blocked === null ? 'FAIL' : 'NOT_RUN',
          code: blocked ?? code,
          ...(status === undefined ? {} : { httpStatus: status }),
        });
        if (operation === 'getServerTime') eligible = false;
      } else {
        results.push({
          operation,
          status: 'PASS',
          shape: shape(operation, result.value),
          ...(status === undefined ? {} : { httpStatus: status }),
        });
        if (operation === 'getSymbols')
          eligible = result.value.items.some(
            (item) => item.id === 'BTCUSDT' && item.status === 'TRADING',
          );
      }
    }
  } catch {
    // No stack/cause/raw exchange response reaches the artifact or process output.
    results.push({ operation: 'probe', status: 'FAIL', code: 'PROBE_EXCEPTION' });
  } finally {
    clearTimeout(timer);
    await adapter.disconnect();
  }
  return {
    profileId,
    status:
      blocked !== null
        ? 'BLOCKED'
        : results.some((result) => result.status === 'FAIL')
          ? 'FAIL'
          : results.every((result) => result.status === 'PASS')
            ? 'PASS'
            : 'PARTIAL',
    ...(blocked === null ? {} : { code: blocked }),
    durationMs: Date.now() - startedAt,
    budget: { requests, weight, wsAttempts, maxRequests: MAX_REQUESTS, maxWeight: MAX_WEIGHT },
    operations: results,
  };
}

export async function probeBinancePublic() {
  const startedAt = new Date().toISOString();
  const profiles = [];
  // No retries, redirects, alternate hosts, proxy routes or regional bypasses.
  for (const profileId of PROFILE_IDS) profiles.push(await probeProfile(profileId));
  return {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    source: 'BUILT_PUBLIC_BINANCE_ADAPTER',
    status: profiles.some((profile) => profile.status === 'FAIL')
      ? 'FAIL'
      : profiles.every((profile) => profile.status === 'PASS')
        ? 'PASS'
        : 'PARTIAL',
    liveTradingEnabled: false,
    privateRequests: 0,
    mutations: 0,
    profiles,
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const report = await probeBinancePublic();
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(
      JSON.stringify({
        status: report.status,
        profiles: report.profiles.map(({ profileId, status, code }) => ({
          profileId,
          status,
          ...(code === undefined ? {} : { code }),
        })),
        artifact: path.relative(root, reportPath).replaceAll(path.sep, '/'),
      }),
    );
    process.exitCode = report.status === 'PASS' ? 0 : report.status === 'FAIL' ? 1 : 2;
  } catch {
    console.error('PUBLIC_BINANCE_PROBE_FAILED');
    process.exitCode = 1;
  }
}
