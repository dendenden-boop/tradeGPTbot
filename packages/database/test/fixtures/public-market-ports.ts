/** Test-only lifetime for two public evidence writers, never their results. */
export function createPublicMarketFixturePorts<S, T>(factories: {
  snapshots(): Promise<S>;
  trades(): Promise<T>;
}): { snapshots(): Promise<S>; trades(): Promise<T> } {
  const openSnapshots = factories.snapshots,
    openTrades = factories.trades;
  let snapshots: Promise<S> | undefined, trades: Promise<T> | undefined;
  // Retain a failed constructor as well: fixture setup must fail closed rather
  // than silently retry. Publications and reads remain actual native methods.
  return Object.freeze({
    snapshots: () => (snapshots ??= Promise.resolve().then(openSnapshots)),
    trades: () => (trades ??= Promise.resolve().then(openTrades)),
  });
}
