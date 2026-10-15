import { expect, it, vi } from 'vitest';
import type { NetworkSocket } from '../src/io.js';
import { harness } from './harness.js';
import { now } from './fixtures.js';

it.each([
  ['before bounded ACK entry', 2],
  ['before lazy ACK adoption', 4],
] as const)('owns the ACK rejection when deadline expires %s', async (_name, expireAtCheck) => {
  let armed = false,
    checks = 0,
    deadline = now + 5000;
  const unhandled: unknown[] = [];
  const observe = (reason: unknown) => unhandled.push(reason);
  const x = harness('okx-spot-demo-v1', {
    now: () => (armed && ++checks >= expireAtCheck ? deadline : now),
  });
  process.on('unhandledRejection', observe);
  try {
    await x.warm();
    const context = x.context();
    deadline = context.deadline;
    x.limiter.reserve.mockImplementation((request) => {
      if (request.method === 'WS' && request.controlMessages === 1) {
        armed = true;
        checks = 0;
      }
      return Promise.resolve(true);
    });
    const originalSend = x.socket.send.bind(x.socket);
    // The actual control write is permitted to settle, but its ACK never arrives.
    x.socket.send = vi.fn<NetworkSocket['send']>(() => Promise.resolve());
    expect(await x.adapter.subscribeTicker({ instrumentId: 'BTC-USDT' }, context)).toMatchObject({
      ok: false,
      error: { code: 'UNAVAILABLE' },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(checks).toBeGreaterThanOrEqual(expireAtCheck);
    expect(x.state.socketClosed).toBe(1);
    // This observer does not replace/remove Vitest's own unhandled-error listener.
    expect(unhandled).toEqual([]);
    armed = false;
    x.limiter.reserve.mockResolvedValue(true);
    x.socket.send = originalSend;
    expect(
      await x.adapter.subscribeTicker({ instrumentId: 'BTC-USDT' }, x.context()),
    ).toMatchObject({
      ok: true,
    });
  } finally {
    armed = false;
    await x.adapter.disconnect();
    process.removeListener('unhandledRejection', observe);
  }
});
