/** Test-only lifetime for two public evidence writers, never their results. */
export function createPublicMarketFixturePorts<S, T>(factories: {
  snapshots(): Promise<S>;
  trades(): Promise<T>;
}): { snapshots(): Promise<S>; trades(): Promise<T> } {
  void factories;
  throw new Error('PUBLIC_MARKET_FIXTURE_NOT_IMPLEMENTED');
}
