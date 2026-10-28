import { expect, it } from 'vitest';

const name = 'completed native owner progress witness';
const entity = (read, title = name) => ({ id: 'case-1', task: { name: title }, result: read });
async function open(options) {
  const module = await import('./fixtures/native-progress-event.mjs').catch(() => ({}));
  expect(module.createNativeProgressDelivery).toBeTypeOf('function');
  return module.createNativeProgressDelivery(options);
}
function output() {
  const emitted = [], acknowledged = [];
  return {
    emitted, acknowledged,
    emit: (test) => emitted.push(test.result()),
    acknowledge: async () => { acknowledged.push(true); },
    delay: async () => {},
  };
}
it('defers pending completion until a subsequent genuine passed update', async () => {
  const o = output(), d = await open(o);
  let state = 'pending';
  const test = entity(() => ({ state }));
  await d.result(test);
  expect(o.emitted).toEqual([]);
  expect(o.acknowledged).toEqual([]);
  state = 'passed';
  await d.update();
  expect(o.emitted).toEqual([{ state: 'passed' }]);
  expect(o.acknowledged).toEqual([true]);
});
it('never manufactures PASS while pending, failed or skipped', async () => {
  for (const terminal of ['pending', 'failed', 'skipped']) {
    const o = output(), d = await open(o);
    let state = 'pending';
    await d.result(entity(() => ({ state })));
    state = terminal;
    await d.update();
    expect(o.acknowledged).toEqual([]);
    expect(o.emitted).toEqual(terminal === 'pending' ? [] : [{ state: terminal }]);
  }
});
it('copies the terminal result before asynchronous delivery without rereading its live view', async () => {
  const o = output(), result = { state: 'passed' };
  o.delay = async () => { result.state = 'pending'; };
  const d = await open(o);
  await d.result(entity(() => result));
  expect(o.emitted).toEqual([{ state: 'passed' }]);
  expect(o.acknowledged).toEqual([true]);
});
it('delivers concurrent duplicate completion and update callbacks exactly once', async () => {
  const o = output(), d = await open(o), test = entity(() => ({ state: 'passed' }));
  await Promise.all([d.result(test), d.result(test), d.update()]);
  expect(o.emitted).toEqual([{ state: 'passed' }]);
  expect(o.acknowledged).toEqual([true]);
});
it('propagates delivery or acknowledgement failure without inventing a second emission', async () => {
  for (const stage of ['emit', 'acknowledge']) {
    const o = output(), original = o[stage];
    o[stage] = (...args) => { original(...args); throw Error('NATIVE_PROGRESS_DELIVERY_FAILED'); };
    const d = await open(o), test = entity(() => ({ state: 'passed' }));
    await expect(d.result(test)).rejects.toThrow('NATIVE_PROGRESS_DELIVERY_FAILED');
    await d.update();
    expect(o.emitted).toHaveLength(1);
    expect(o.acknowledged).toHaveLength(stage === 'emit' ? 0 : 1);
  }
});
it('acknowledges only the actual completed witness and passes other native results through', async () => {
  const o = output(), d = await open(o);
  await d.result(entity(() => ({ state: 'passed' }), 'different native case'));
  expect(o.emitted).toEqual([{ state: 'passed' }]);
  expect(o.acknowledged).toEqual([]);
});
