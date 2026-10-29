/** Test-only lifetime for one actual OrderStore connection pool, never results. */
export function createOrderFixturePort<T>(open: () => Promise<T>): () => Promise<T> {
  let opening: Promise<T> | undefined;
  // A failed constructor remains failed. No fallback role, reconnect or retry.
  // The unchanged native store still receives every binding/draft/IO call.
  return () => (opening ??= Promise.resolve().then(open));
}
