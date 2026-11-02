type Closable = { close(): Promise<void> };

// Tests-first: retain the existing fresh-constructor behavior until the
// repeated default-handle lifetime regression is recorded.
export function createNativeDefaultFixturePort<T extends Closable>(
  open: (connectionString: string) => Promise<T>,
  defaultConnection: () => string,
): (connectionString?: string) => Promise<T> {
  return (connectionString = defaultConnection()) => open(connectionString);
}
