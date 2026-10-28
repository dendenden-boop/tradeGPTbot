// Test-only native reporter delivery. No production/deployment import path.
// A completion callback may still expose pending data. Keep that entity until
// an actual native task update confirms a terminal result; never infer PASS.
export function createNativeProgressDelivery({ emit, acknowledge, delay }) {
  let pending,
    delivered = false,
    delivery;
  async function result(test) {
    if (test.task.name !== 'completed native owner progress witness') return emit(test);
    if (delivered) return delivery;
    const current = test.result();
    if (current.state === 'pending') {
      pending = test;
      return;
    }
    if (!['passed', 'failed', 'skipped'].includes(current.state))
      throw Error('NATIVE_PROGRESS_TERMINAL_RESULT_REQUIRED');
    pending = undefined;
    delivered = true;
    const captured = Object.freeze({ ...current });
    const event = new Proxy(test, {
      get(target, key) {
        if (key === 'result') return () => captured;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    delivery = (async () => {
      await delay();
      await emit(event);
      if (captured.state === 'passed') await acknowledge();
    })();
    return delivery;
  }
  return Object.freeze({
    result,
    async update() {
      if (pending) await result(pending);
    },
  });
}
