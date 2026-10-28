import { expect, it, vi } from 'vitest';
import { createPublicMarketFixturePorts } from './fixtures/public-market-ports.js';

it('fixture public writers are lazy and have only two fixed kinds', () => {
  const snapshots = vi.fn(async () => ({ kind: 'snapshot' }));
  const trades = vi.fn(async () => ({ kind: 'trade' }));
  const ports = createPublicMarketFixturePorts({ snapshots, trades });
  expect(Object.keys(ports).sort()).toEqual(['snapshots', 'trades']);
  expect(snapshots).not.toHaveBeenCalled();
  expect(trades).not.toHaveBeenCalled();
});

it('concurrent fixture acquisition opens and registers a public writer exactly once', async () => {
  let finish!: (value: object) => void;
  const ready = new Promise<object>((resolve) => {
    finish = resolve;
  });
  const owned: object[] = [];
  const snapshots = vi.fn(async () => {
    const port = await ready;
    owned.push(port);
    return port;
  });
  const ports = createPublicMarketFixturePorts({ snapshots, trades: async () => ({}) });
  const first = ports.snapshots(),
    second = ports.snapshots();
  expect(second).toBe(first);
  await Promise.resolve();
  expect(snapshots).toHaveBeenCalledTimes(1);
  const writer = {};
  finish(writer);
  expect(await first).toBe(writer);
  expect(await ports.snapshots()).toBe(writer);
  expect(owned).toEqual([writer]);
});

it('snapshot and trade acquisition do not collapse their native identities', async () => {
  const snapshot = {},
    trade = {};
  const snapshots = vi.fn(async () => snapshot),
    trades = vi.fn(async () => trade);
  const ports = createPublicMarketFixturePorts({ snapshots, trades });
  const [a, b] = await Promise.all([ports.snapshots(), ports.trades()]);
  expect(a).toBe(snapshot);
  expect(b).toBe(trade);
  expect(a).not.toBe(b);
  await ports.snapshots();
  await ports.trades();
  expect(snapshots).toHaveBeenCalledTimes(1);
  expect(trades).toHaveBeenCalledTimes(1);
});

it('a failed public writer constructor stays failed without implicit retry', async () => {
  const error = new Error('native role rejected');
  const snapshots = vi.fn(async () => {
    throw error;
  });
  const ports = createPublicMarketFixturePorts({ snapshots, trades: async () => ({}) });
  const first = ports.snapshots();
  await expect(first).rejects.toBe(error);
  expect(ports.snapshots()).toBe(first);
  await expect(ports.snapshots()).rejects.toBe(error);
  expect(snapshots).toHaveBeenCalledTimes(1);
});

it('a synchronous constructor failure is retained and does not disable the other writer', async () => {
  const error = new Error('constructor failed'),
    trade = {};
  const snapshots = vi.fn((): Promise<object> => {
    throw error;
  });
  const ports = createPublicMarketFixturePorts({ snapshots, trades: async () => trade });
  const first = ports.snapshots();
  await expect(first).rejects.toBe(error);
  expect(ports.snapshots()).toBe(first);
  expect(await ports.trades()).toBe(trade);
  expect(snapshots).toHaveBeenCalledTimes(1);
});

it('every publication still invokes the actual writer with fresh input and fresh result', async () => {
  let revision = 0;
  const writer = { publish: vi.fn(async (input: object) => ({ input, revision: ++revision })) };
  const ports = createPublicMarketFixturePorts({
    snapshots: async () => writer,
    trades: async () => ({}),
  });
  const a = {},
    b = {};
  const first = await (await ports.snapshots()).publish(a);
  const second = await (await ports.snapshots()).publish(b);
  expect(first).toEqual({ input: a, revision: 1 });
  expect(second).toEqual({ input: b, revision: 2 });
  expect(first).not.toBe(second);
  expect(writer.publish.mock.calls).toEqual([[a], [b]]);
});

it('fixture ownership tracks only two handles and teardown closes each once', async () => {
  const owned: { close(): Promise<void> }[] = [];
  const snapshots = { close: vi.fn(async () => {}) },
    trades = { close: vi.fn(async () => {}) };
  const own = async <T extends { close(): Promise<void> }>(port: T) => {
    owned.push(port);
    return port;
  };
  const ports = createPublicMarketFixturePorts({
    snapshots: () => own(snapshots),
    trades: () => own(trades),
  });
  for (let fixture = 0; fixture < 300; fixture++)
    await Promise.all([ports.snapshots(), ports.trades()]);
  expect(owned).toEqual([snapshots, trades]);
  await Promise.all(owned.map((port) => port.close()));
  expect(snapshots.close).toHaveBeenCalledTimes(1);
  expect(trades.close).toHaveBeenCalledTimes(1);
});
