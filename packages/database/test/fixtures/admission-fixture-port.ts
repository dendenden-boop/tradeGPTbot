import type { createPostgresPaperOrderRiskPort } from '@ctp/paper-engine/risk';

type Port = Awaited<ReturnType<typeof createPostgresPaperOrderRiskPort>>;
/** Test-only constructor lifetime. Every financial operation still reaches the
 * actual fixed authority with original arguments, current SQL and a new physical
 * transaction. No receipt, tenant, binding, policy or monetary state is cached. */
export function createAdmissionFixturePort(open: () => Promise<Port>): () => Promise<Port> {
  let current: { opening: Promise<Port>; closing: Promise<void> | undefined } | undefined;
  function get(): Promise<Port> {
    if (current?.closing) return current.closing.then(get);
    if (current) return current.opening;
    const state = {
      opening: Promise.resolve().then(open),
      closing: undefined as Promise<void> | undefined,
    };
    current = state;
    state.opening = state.opening.then((actual) =>
      Object.freeze({
        approve(...args: Parameters<Port['approve']>) {
          return actual.approve(...args);
        },
        reconcileApproval(...args: Parameters<Port['reconcileApproval']>) {
          return actual.reconcileApproval(...args);
        },
        close() {
          // Only a successfully settled physical close permits a fresh lifetime.
          // Failed construction/cleanup remains failed; no fallback or auto-retry.
          return (state.closing ??= Promise.resolve()
            .then(() => actual.close())
            .then(() => {
              if (current === state) current = undefined;
            }));
        },
      }),
    );
    return state.opening;
  }
  return get;
}
