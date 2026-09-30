import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSubscription,
  type StreamEvent,
  type SubscriptionOptions,
} from '../src/subscription.js';

function parseNumber(input: unknown): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new Error('raw upstream secret that must not escape');
  }
  return input;
}

const done = { done: true, value: undefined };
const event = <T>(value: StreamEvent<T>) => ({ done: false, value });
const make = (options: Partial<SubscriptionOptions<number>> = {}) =>
  createSubscription({ capacity: 2, parse: parseNumber, ...options });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('bounded subscription data and terminal events', () => {
  it('parses unknown input and delivers typed DATA in order', async () => {
    const source = createSubscription({ capacity: 2, parse: (value: unknown) => String(value) });
    const iterator = source.subscription[Symbol.asyncIterator]();
    expect(source.push(17)).toBe(true);
    expect(source.push(23)).toBe(true);
    expect(source.subscription.health()).toEqual({ status: 'ACTIVE', queued: 2 });
    expect(await iterator.next()).toEqual(event({ kind: 'DATA', data: '17' }));
    expect(await iterator.next()).toEqual(event({ kind: 'DATA', data: '23' }));
    expect(source.subscription.health()).toEqual({ status: 'ACTIVE', queued: 0 });
    await source.subscription.unsubscribe();
  });

  it('replaces a full queue with exactly one terminal overflow event', async () => {
    const parse = vi.fn(parseNumber);
    const source = make({ capacity: 1, parse });
    const iterator = source.subscription[Symbol.asyncIterator]();
    expect(source.push(1)).toBe(true);
    expect(source.push(2)).toBe(false);
    for (let index = 0; index < 1000; index++) expect(source.push(index)).toBe(false);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(source.subscription.health()).toEqual({ status: 'RESYNC_REQUIRED', queued: 0 });
    expect(await iterator.next()).toEqual(event({ kind: 'RESYNC_REQUIRED', reason: 'OVERFLOW' }));
    source.close();
    source.gap();
    await source.subscription.unsubscribe();
    expect(await iterator.next()).toEqual(done);
  });

  it('bounds the largest permitted queue', async () => {
    const source = make({ capacity: 1024 });
    for (let index = 0; index < 1024; index++) expect(source.push(index)).toBe(true);
    expect(source.subscription.health().queued).toBe(1024);
    expect(source.push(1024)).toBe(false);
    expect(source.subscription.health()).toEqual({ status: 'RESYNC_REQUIRED', queued: 0 });
    await source.subscription.unsubscribe();
  });

  it('discards queued data on malformed input without leaking or logging it', async () => {
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn');
    const source = make();
    const iterator = source.subscription[Symbol.asyncIterator]();
    source.push(1);
    expect(source.push({ token: 'sensitive input' })).toBe(false);
    expect(await iterator.next()).toEqual(event({ kind: 'RESYNC_REQUIRED', reason: 'MALFORMED' }));
    expect(await iterator.next()).toEqual(done);
    expect(source.push(2)).toBe(false);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports a source gap once and rejects all later input', async () => {
    const source = make();
    const iterator = source.subscription[Symbol.asyncIterator]();
    source.push(1);
    source.gap();
    source.gap();
    expect(source.push(2)).toBe(false);
    expect(await iterator.next()).toEqual(event({ kind: 'RESYNC_REQUIRED', reason: 'SOURCE_GAP' }));
    expect(await iterator.next()).toEqual(done);
  });

  it('drains accepted data before source close, without silently dropping it', async () => {
    const source = make();
    const iterator = source.subscription[Symbol.asyncIterator]();
    source.push(1);
    source.push(2);
    source.close();
    source.close();
    expect(source.push(3)).toBe(false);
    expect(source.subscription.health()).toEqual({ status: 'CLOSED', queued: 2 });
    expect(await iterator.next()).toEqual(event({ kind: 'DATA', data: 1 }));
    expect(await iterator.next()).toEqual(event({ kind: 'DATA', data: 2 }));
    expect(await iterator.next()).toEqual(event({ kind: 'CLOSED', reason: 'SOURCE_CLOSED' }));
    expect(await iterator.next()).toEqual(done);
  });

  it('handles reentrant parser cancellation and queue filling', async () => {
    const controller = new AbortController();
    const canceled = make({
      signal: controller.signal,
      parse: (input) => {
        controller.abort();
        return parseNumber(input);
      },
    });
    expect(canceled.push(1)).toBe(false);
    expect(await canceled.subscription[Symbol.asyncIterator]().next()).toEqual(
      event({ kind: 'CLOSED', reason: 'ABORTED' }),
    );

    const source = make({
      capacity: 1,
      parse: (input) => {
        if (input === 1) source.push(2);
        return parseNumber(input);
      },
    });
    expect(source.push(1)).toBe(false);
    expect(source.subscription.health()).toEqual({ status: 'RESYNC_REQUIRED', queued: 0 });
    expect(await source.subscription[Symbol.asyncIterator]().next()).toEqual(
      event({ kind: 'RESYNC_REQUIRED', reason: 'OVERFLOW' }),
    );
  });
});

describe('subscription consumer lifecycle', () => {
  it('resolves a waiting read directly without growing the queue', async () => {
    const source = make({ capacity: 1 });
    const iterator = source.subscription[Symbol.asyncIterator]();
    const next = iterator.next();
    expect(source.push(7)).toBe(true);
    expect(await next).toEqual(event({ kind: 'DATA', data: 7 }));
    expect(source.subscription.health().queued).toBe(0);
    await source.subscription.unsubscribe();
  });

  it('rejects concurrent pending reads without losing the original waiter', async () => {
    const source = make();
    const iterator = source.subscription[Symbol.asyncIterator]();
    const waiting = iterator.next();
    await expect(iterator.next()).rejects.toThrow('Only one pending subscription read');
    await expect(iterator.next()).rejects.toThrow('Only one pending subscription read');
    source.push(1);
    expect(await waiting).toEqual(event({ kind: 'DATA', data: 1 }));
    const following = iterator.next();
    source.close();
    expect(await following).toEqual(event({ kind: 'CLOSED', reason: 'SOURCE_CLOSED' }));
    expect(await iterator.next()).toEqual(done);
  });

  it('rejects a second iterator before and after termination', async () => {
    const source = make();
    source.subscription[Symbol.asyncIterator]();
    expect(() => source.subscription[Symbol.asyncIterator]()).toThrow('only one iterator');
    await source.subscription.unsubscribe();
    expect(() => source.subscription[Symbol.asyncIterator]()).toThrow('only one iterator');
  });

  it.each(['gap', 'close', 'malformed'] as const)('settles pending read on %s', async (action) => {
    const source = make();
    const iterator = source.subscription[Symbol.asyncIterator]();
    const next = iterator.next();
    if (action === 'malformed') source.push(null);
    else source[action]();
    const expected =
      action === 'close'
        ? { kind: 'CLOSED' as const, reason: 'SOURCE_CLOSED' as const }
        : {
            kind: 'RESYNC_REQUIRED' as const,
            reason: action === 'gap' ? ('SOURCE_GAP' as const) : ('MALFORMED' as const),
          };
    expect(await next).toEqual(event(expected));
    expect(await iterator.next()).toEqual(done);
  });

  it('unsubscribes twice safely and resolves a pending read with one CLOSED event', async () => {
    const source = make();
    const iterator = source.subscription[Symbol.asyncIterator]();
    const next = iterator.next();
    await source.subscription.unsubscribe();
    await source.subscription.unsubscribe();
    expect(await next).toEqual(event({ kind: 'CLOSED', reason: 'UNSUBSCRIBED' }));
    expect(await iterator.next()).toEqual(done);
    expect(source.push(1)).toBe(false);
  });

  it('cancels queued data on unsubscribe while still delivering the terminal event', async () => {
    const source = make();
    source.push(1);
    await source.subscription.unsubscribe();
    const iterator = source.subscription[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual(event({ kind: 'CLOSED', reason: 'UNSUBSCRIBED' }));
    expect(await iterator.next()).toEqual(done);
  });

  it('return is idempotent, settles a pending read, and relinquishes future events', async () => {
    const source = make();
    const iterator = source.subscription[Symbol.asyncIterator]();
    const next = iterator.next();
    expect(await iterator.return?.()).toEqual(done);
    expect(await iterator.return?.()).toEqual(done);
    expect(await next).toEqual(event({ kind: 'CLOSED', reason: 'UNSUBSCRIBED' }));
    expect(await iterator.next()).toEqual(done);
    expect(source.subscription.health()).toEqual({ status: 'CLOSED', queued: 0 });
  });

  it('for-await break closes the subscription and releases buffered data', async () => {
    const source = make();
    source.push(1);
    source.push(2);
    const received: StreamEvent<number>[] = [];
    for await (const value of source.subscription) {
      received.push(value);
      break;
    }
    expect(received).toEqual([{ kind: 'DATA', data: 1 }]);
    expect(source.subscription.health()).toEqual({ status: 'CLOSED', queued: 0 });
    expect(source.push(3)).toBe(false);
  });
});

describe('subscription cancellation and resource cleanup', () => {
  it('honors an already aborted signal without installing a listener or timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort(new Error('private abort cause'));
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    const source = make({ signal: controller.signal, deadline: Date.now() + 100 });
    const iterator = source.subscription[Symbol.asyncIterator]();
    expect(addListener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(await iterator.next()).toEqual(event({ kind: 'CLOSED', reason: 'ABORTED' }));
    expect(await iterator.next()).toEqual(done);
    expect(source.push(1)).toBe(false);
  });

  it('aborts between reads, discarding buffered data and removing resources', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const source = make({ signal: controller.signal, deadline: Date.now() + 100 });
    const iterator = source.subscription[Symbol.asyncIterator]();
    source.push(1);
    expect(await iterator.next()).toEqual(event({ kind: 'DATA', data: 1 }));
    source.push(2);
    controller.abort('private upstream abort reason');
    expect(removeListener).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    expect(await iterator.next()).toEqual(event({ kind: 'CLOSED', reason: 'ABORTED' }));
    expect(await iterator.next()).toEqual(done);
  });

  it('aborts a pending read', async () => {
    const controller = new AbortController();
    const source = make({ signal: controller.signal });
    const iterator = source.subscription[Symbol.asyncIterator]();
    const next = iterator.next();
    controller.abort();
    expect(await next).toEqual(event({ kind: 'CLOSED', reason: 'ABORTED' }));
    expect(await iterator.next()).toEqual(done);
  });

  it('unrefs its deadline timer and expires a pending read at the deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const setTimer = vi.spyOn(globalThis, 'setTimeout');
    const source = make({ signal: controller.signal, deadline: 1100 });
    const timer = setTimer.mock.results[0]?.value as ReturnType<typeof setTimeout>;
    expect(timer.hasRef()).toBe(false);
    const iterator = source.subscription[Symbol.asyncIterator]();
    const next = iterator.next();
    await vi.advanceTimersByTimeAsync(99);
    expect(source.subscription.health().status).toBe('ACTIVE');
    await vi.advanceTimersByTimeAsync(1);
    expect(await next).toEqual(event({ kind: 'CLOSED', reason: 'DEADLINE' }));
    expect(removeListener).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(await iterator.next()).toEqual(done);
    expect(source.push(1)).toBe(false);
  });

  it('expires immediately when the deadline is already reached', async () => {
    vi.useFakeTimers();
    const source = make({ deadline: 1000, now: () => 1000 });
    expect(vi.getTimerCount()).toBe(0);
    expect(await source.subscription[Symbol.asyncIterator]().next()).toEqual(
      event({ kind: 'CLOSED', reason: 'DEADLINE' }),
    );
  });

  it('checks the absolute deadline even when the event loop has not run the timer', async () => {
    vi.useFakeTimers();
    let time = 1000;
    const source = make({ deadline: 1100, now: () => time });
    source.push(1);
    time = 1100;
    expect(source.push(2)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(await source.subscription[Symbol.asyncIterator]().next()).toEqual(
      event({ kind: 'CLOSED', reason: 'DEADLINE' }),
    );
  });

  it('fails closed if the injected clock breaks after creation', async () => {
    vi.useFakeTimers();
    const now = vi
      .fn()
      .mockReturnValueOnce(1000)
      .mockImplementation(() => {
        throw new Error('private clock diagnostic');
      });
    const source = make({ deadline: 1100, now });
    expect(source.push(1)).toBe(false);
    expect(await source.subscription[Symbol.asyncIterator]().next()).toEqual(
      event({ kind: 'CLOSED', reason: 'DEADLINE' }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['unsubscribe', 'close', 'gap', 'malformed', 'overflow', 'return'] as const)(
    'cleans timers and abort listeners on %s',
    async (action) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const addListener = vi.spyOn(controller.signal, 'addEventListener');
      const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
      const source = make({ capacity: 1, signal: controller.signal, deadline: Date.now() + 100 });
      expect(vi.getTimerCount()).toBe(1);
      if (action === 'unsubscribe') await source.subscription.unsubscribe();
      else if (action === 'return') await source.subscription[Symbol.asyncIterator]().return?.();
      else if (action === 'malformed') source.push(null);
      else if (action === 'overflow') {
        source.push(1);
        source.push(2);
      } else source[action]();
      expect(removeListener).toHaveBeenCalledOnce();
      expect(removeListener.mock.calls[0]?.[1]).toBe(addListener.mock.calls[0]?.[1]);
      expect(vi.getTimerCount()).toBe(0);
      const status = source.subscription.health().status;
      controller.abort();
      await vi.advanceTimersByTimeAsync(100);
      expect(source.subscription.health().status).toBe(status);
      expect(removeListener).toHaveBeenCalledOnce();
    },
  );
});

describe('subscription option validation', () => {
  it.each([0, -1, 1.5, 1025, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
    'rejects invalid capacity %s',
    (capacity) => {
      expect(() => make({ capacity })).toThrow(RangeError);
    },
  );

  it.each([-1, 1000.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 86_401_001])(
    'rejects invalid or unbounded deadline %s without installing resources',
    (deadline) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const addListener = vi.spyOn(controller.signal, 'addEventListener');
      expect(() => make({ deadline, now: () => 1000, signal: controller.signal })).toThrow(
        RangeError,
      );
      expect(addListener).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('accepts the exact 24 hour deadline boundary', async () => {
    vi.useFakeTimers();
    const source = make({ deadline: 86_401_000, now: () => 1000 });
    expect(vi.getTimerCount()).toBe(1);
    await source.subscription.unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([null, undefined, [], { capacity: 1 }, { capacity: 1, parse: 2 }])(
    'rejects malformed options',
    (options) => {
      expect(() => createSubscription(options as SubscriptionOptions<unknown>)).toThrow(TypeError);
    },
  );

  it.each([{ signal: {} }, { now: 1 }])('rejects malformed signal or clock', (options) => {
    expect(() => make(options as unknown as Partial<SubscriptionOptions<number>>)).toThrow(
      TypeError,
    );
  });

  it.each([NaN, Infinity, -1, 1.5])('rejects invalid clock value %s', (value) => {
    expect(() => make({ now: () => value, deadline: 1000 })).toThrow('Invalid subscription clock');
  });

  it('sanitizes errors from the initial clock read', () => {
    expect(() =>
      make({
        deadline: 1000,
        now: () => {
          throw new Error('secret clock information');
        },
      }),
    ).toThrow('Invalid subscription clock');
  });
});

describe('subscription producer close callback', () => {
  it.each([
    'unsubscribe',
    'return',
    'close',
    'gap',
    'malformed',
    'overflow',
    'abort',
    'deadline',
  ] as const)('calls producer cleanup once after local resource cleanup on %s', async (action) => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const observations: { timers: number; listenerRemovals: number; active: boolean }[] = [];
    const onClose = vi.fn(() => {
      observations.push({
        timers: vi.getTimerCount(),
        listenerRemovals: removeListener.mock.calls.length,
        active: source.subscription.health().status === 'ACTIVE',
      });
      // Reentrant producer shutdown does not invoke this callback again.
      source.close();
    });
    const source = make({ capacity: 1, signal: controller.signal, deadline: 1100, onClose });
    if (action === 'unsubscribe') await source.subscription.unsubscribe();
    else if (action === 'return') await source.subscription[Symbol.asyncIterator]().return?.();
    else if (action === 'malformed') source.push(null);
    else if (action === 'overflow') {
      source.push(1);
      source.push(2);
    } else if (action === 'abort') controller.abort();
    else if (action === 'deadline') await vi.advanceTimersByTimeAsync(100);
    else source[action]();
    expect(onClose).toHaveBeenCalledOnce();
    expect(observations).toEqual([{ timers: 0, listenerRemovals: 1, active: false }]);
    source.close();
    source.gap();
    await source.subscription.unsubscribe();
    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each(['abort', 'deadline'] as const)(
    'calls producer cleanup when initially terminal due to %s without a consumer',
    (action) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      if (action === 'abort') controller.abort();
      const onClose = vi.fn();
      const source = make({ signal: controller.signal, deadline: 1000, now: () => 1000, onClose });
      expect(onClose).toHaveBeenCalledOnce();
      expect(source.subscription.health().status).toBe('CLOSED');
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('contains callback exceptions and delivers the original terminal event to a waiting reader', async () => {
    const onClose = vi.fn(() => {
      throw new Error('private producer shutdown diagnostic');
    });
    const source = make({ onClose });
    const iterator = source.subscription[Symbol.asyncIterator]();
    const next = iterator.next();
    expect(() => source.close()).not.toThrow();
    expect(await next).toEqual(event({ kind: 'CLOSED', reason: 'SOURCE_CLOSED' }));
    expect(await iterator.next()).toEqual(done);
    await source.subscription.unsubscribe();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([null, 1, {}])('rejects malformed producer close callbacks', (onClose) => {
    expect(() => make({ onClose } as unknown as Partial<SubscriptionOptions<number>>)).toThrow(
      'Invalid subscription close callback',
    );
  });
});
