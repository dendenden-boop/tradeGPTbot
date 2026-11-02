type Closable = { close(): Promise<void> };

/** Test-only setup of three independent lanes. Drain every actual operation,
 * including on failure, before callers may initialize the book or admit risk.
 * No result cache, retry, synthetic receipt or change to an IO deadline. */
export async function runIndependentFixtureSetup<A, B, C>(
  lanes: readonly [() => Promise<A>, () => Promise<B>, () => Promise<C>],
): Promise<[A, B, C]> {
  if (
    !Array.isArray(lanes) ||
    lanes.length !== 3 ||
    lanes.some((lane) => typeof lane !== 'function')
  )
    throw Error('NATIVE_SETUP_LANES');
  const outcomes = await Promise.allSettled([
    Promise.resolve().then(lanes[0]),
    Promise.resolve().then(lanes[1]),
    Promise.resolve().then(lanes[2]),
  ]);
  if (outcomes[0].status === 'rejected') throw outcomes[0].reason;
  if (outcomes[1].status === 'rejected') throw outcomes[1].reason;
  if (outcomes[2].status === 'rejected') throw outcomes[2].reason;
  return [outcomes[0].value, outcomes[1].value, outcomes[2].value];
}

// Test-only default transport lifetime. Every method still executes the actual
// authority, including its independent physical client/transaction per call.
// Explicit proxy connections always construct fresh real transports.
export function createNativeDefaultFixturePort<T extends Closable>(
  open: (connectionString: string) => Promise<T>,
  defaultConnection: () => string,
): (connectionString?: string) => Promise<T> {
  let current: { opening: Promise<T>; closing: Promise<void> | undefined } | undefined;
  function get(connectionString = defaultConnection()): Promise<T> {
    if (connectionString !== defaultConnection()) return open(connectionString);
    if (current?.closing) return current.closing.then(() => get(connectionString));
    if (current) return current.opening;
    const state = {
      opening: Promise.resolve().then(() => open(connectionString)),
      closing: undefined as Promise<void> | undefined,
    };
    current = state;
    state.opening = state.opening.then((actual) => {
      const facade = Object.create(null) as Record<string, (...args: unknown[]) => unknown>;
      for (const key of Reflect.ownKeys(actual)) {
        const descriptor = Object.getOwnPropertyDescriptor(actual, key);
        if (typeof key !== 'string' || typeof descriptor?.value !== 'function')
          throw Error('NATIVE_FIXTURE_METHODS_REQUIRED');
        const method = descriptor.value as (...args: unknown[]) => unknown;
        facade[key] =
          key === 'close'
            ? () =>
                (state.closing ??= Promise.resolve()
                  .then(() => actual.close())
                  .then(() => {
                    if (current === state) current = undefined;
                  }))
            : (...args) => Reflect.apply(method, actual, args);
      }
      if (!Object.hasOwn(facade, 'close')) throw Error('NATIVE_FIXTURE_METHODS_REQUIRED');
      return Object.freeze(facade) as unknown as T;
    });
    return state.opening;
  }
  return get;
}
