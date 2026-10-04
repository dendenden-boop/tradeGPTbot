import { expect, it } from 'vitest';
import { createWsPool } from '../src/pool.js';
import type { PublicFeedPort, FeedIntent } from '../src/ports.js';
import { scope } from './fixtures.js';
const intent = (i: number): FeedIntent => ({
  scope,
  instrumentId: `COIN${i}USDT`,
  profileId: 'binance-spot-testnet-v1',
});
it('shards 300 topics into three sockets and reference counts duplicate intents', async () => {
  let opened = 0,
    closed = 0;
  const port: PublicFeedPort = {
    maxTopics: 100,
    maxConnections: 3,
    async open(topics) {
      await Promise.resolve();
      expect(topics.length).toBeLessThanOrEqual(100);
      opened++;
      return {
        async close() {
          await Promise.resolve();
          closed++;
        },
      };
    },
  };
  const pool = createWsPool({ port, now: () => 1000, onInput: () => {}, onGap: () => {} });
  for (let i = 0; i < 300; i++) pool.retain(intent(i));
  pool.retain(intent(0));
  await pool.tick();
  await pool.settled();
  expect(opened).toBe(3);
  expect(pool.metrics().topics).toBe(300);
  await pool.release(intent(0));
  expect(pool.metrics().topics).toBe(300);
  await pool.close();
  expect(closed).toBe(3);
});
it('reconnects with bounded full jitter, resubscribes intents and fences old generations', async () => {
  let now = 1000,
    opens = 0,
    gaps = 0;
  let fail: (reason: string) => void = () => {};
  const port: PublicFeedPort = {
    maxTopics: 100,
    maxConnections: 3,
    async open(_topics, _ctx, _input, onGap) {
      await Promise.resolve();
      opens++;
      fail = onGap;
      return { async close() {} };
    },
  };
  const pool = createWsPool({
    port,
    now: () => now,
    random: () => 0.5,
    onInput: () => {},
    onGap: () => {
      gaps++;
    },
  });
  pool.retain(intent(0));
  await pool.tick();
  await pool.settled();
  const old = fail;
  fail('DISCONNECT');
  await pool.settled();
  expect(gaps).toBe(1);
  await pool.tick();
  expect(opens).toBe(1);
  now += 1000;
  await pool.tick();
  await pool.settled();
  expect(opens).toBe(2);
  old('LATE_CLOSE');
  expect(gaps).toBe(1);
  await pool.close();
});
it('abort of a hung establishment retains capacity until the actual promise settles', async () => {
  let aborted = false,
    resolve!: () => void;
  const port: PublicFeedPort = {
    maxTopics: 1,
    maxConnections: 1,
    open(_i, c) {
      return new Promise((r) => {
        resolve = () => r({ async close() {} });
        c.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
          },
          { once: true },
        );
      });
    },
  };
  const pool = createWsPool({ port, now: () => 1000, onInput: () => {}, onGap: () => {} });
  pool.retain(intent(0));
  await pool.tick();
  const closing = pool.close();
  expect(aborted).toBe(true);
  expect(pool.metrics().connections).toBe(1);
  resolve();
  await closing;
  expect(pool.metrics().connections).toBe(0);
});
it('a released but unsettled source still counts against the physical connection cap', async () => {
  let finish!: () => void;
  const port: PublicFeedPort = {
    maxTopics: 1,
    maxConnections: 1,
    open() {
      return new Promise((r) => {
        finish = () => r({ close: () => Promise.resolve() });
      });
    },
  };
  const pool = createWsPool({ port, now: () => 1000, onInput: () => {}, onGap: () => {} });
  pool.retain(intent(0));
  await pool.tick();
  const released = pool.release(intent(0));
  expect(() => pool.retain({ ...intent(1), profileId: 'another-profile' })).toThrow(
    'CONNECTION_CAPACITY',
  );
  finish();
  await released;
  await pool.close();
});
