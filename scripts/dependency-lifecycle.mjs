// Existing dependency-test stop/start behaviour, extracted for regression reproduction.
export function createDependencyLifecycle({ service, compose }) {
  return {
    stop: () => compose(['stop', '--timeout', '1', service]),
    start: () => compose(['start', service]),
  };
}
