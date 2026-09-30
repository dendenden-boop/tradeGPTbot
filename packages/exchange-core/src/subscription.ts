export type StreamEvent<T> =
  | { kind: 'DATA'; data: T }
  | { kind: 'RESYNC_REQUIRED'; reason: 'OVERFLOW' | 'MALFORMED' | 'SOURCE_GAP' }
  | { kind: 'CLOSED'; reason: 'UNSUBSCRIBED' | 'ABORTED' | 'DEADLINE' | 'SOURCE_CLOSED' };

export interface Subscription<T> extends AsyncIterable<StreamEvent<T>> {
  unsubscribe(): Promise<void>;
  /** Queued counts buffered DATA events, excluding the separately held terminal event. */
  health(): { status: 'ACTIVE' | 'RESYNC_REQUIRED' | 'CLOSED'; queued: number };
}

export interface SubscriptionOptions<T> {
  capacity: number;
  parse: (input: unknown) => T;
  signal?: AbortSignal;
  /** Absolute epoch milliseconds, at most 24 hours in the future. */
  deadline?: number;
  now?: () => number;
  /** Called once after any terminal transition has released timer/listener resources. */
  onClose?: () => void;
}

const MAX_DEADLINE_WINDOW_MS = 86_400_000;
type TerminalEvent = Exclude<StreamEvent<never>, { kind: 'DATA' }>;
type ReadResult<T> = IteratorResult<StreamEvent<T>, undefined>;

/**
 * One iterator and one pending read are permitted. A resync event is terminal;
 * recovery requires a fresh snapshot and subscription. Source close drains DATA
 * first; explicit cancellation discards queued DATA. Iterator return relinquishes
 * unread events and releases all resources, as required by for-await early exit.
 */
export function createSubscription<T>(options: SubscriptionOptions<T>): {
  subscription: Subscription<T>;
  push(input: unknown): boolean;
  gap(): void;
  close(): void;
} {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('Invalid subscription options');
  }
  const { capacity, parse, signal, deadline, now = Date.now, onClose } = options;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1024) {
    throw new RangeError('Subscription capacity must be an integer from 1 to 1024');
  }
  if (typeof parse !== 'function' || typeof now !== 'function') {
    throw new TypeError('Invalid subscription parser or clock');
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError('Invalid subscription signal');
  }
  if (onClose !== undefined && typeof onClose !== 'function') {
    throw new TypeError('Invalid subscription close callback');
  }
  const readClock = (): number => {
    let value: number;
    try {
      value = now();
    } catch {
      throw new TypeError('Invalid subscription clock');
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('Invalid subscription clock');
    }
    return value;
  };
  let initialTime: number | undefined;
  if (deadline !== undefined) {
    initialTime = readClock();
    if (
      !Number.isSafeInteger(deadline) ||
      deadline < 0 ||
      deadline - initialTime > MAX_DEADLINE_WINDOW_MS
    ) {
      throw new RangeError('Invalid subscription deadline');
    }
  }

  const queue: StreamEvent<T>[] = [];
  let status: 'ACTIVE' | 'RESYNC_REQUIRED' | 'CLOSED' = 'ACTIVE';
  let terminal: TerminalEvent | undefined;
  let pending: ((result: ReadResult<T>) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let iteratorClaimed = false;
  let iteratorReturned = false;
  let listening = false;
  const done = (): ReadResult<T> => ({ done: true, value: undefined });

  const cleanup = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (signal !== undefined && listening) {
      signal.removeEventListener('abort', onAbort);
      listening = false;
    }
  };
  const finish = (event: TerminalEvent, discardData: boolean): void => {
    if (status !== 'ACTIVE') return;
    status = event.kind === 'RESYNC_REQUIRED' ? 'RESYNC_REQUIRED' : 'CLOSED';
    cleanup();
    if (discardData) queue.length = 0;
    terminal = Object.freeze(event);
    if (pending !== undefined) {
      const resolve = pending;
      pending = undefined;
      terminal = undefined;
      resolve({ done: false, value: event });
    }
    try {
      onClose?.();
    } catch {
      // Producer cleanup failures must not replace or leak into a terminal event.
    }
  };
  const onAbort = (): void => {
    finish({ kind: 'CLOSED', reason: 'ABORTED' }, true);
  };
  const enforceDeadline = (): void => {
    if (deadline === undefined || status !== 'ACTIVE') return;
    // A broken clock must not leave an otherwise expired stream active.
    let currentTime: number;
    try {
      currentTime = readClock();
    } catch {
      finish({ kind: 'CLOSED', reason: 'DEADLINE' }, true);
      return;
    }
    if (currentTime >= deadline) finish({ kind: 'CLOSED', reason: 'DEADLINE' }, true);
  };
  const unsubscribe = (): Promise<void> => {
    finish({ kind: 'CLOSED', reason: 'UNSUBSCRIBED' }, true);
    // Also release buffered DATA after an already observed source close.
    queue.length = 0;
    return Promise.resolve();
  };

  const iterator: AsyncIterator<StreamEvent<T>, undefined> = {
    next(): Promise<ReadResult<T>> {
      if (pending !== undefined) {
        return Promise.reject(new TypeError('Only one pending subscription read is permitted'));
      }
      enforceDeadline();
      if (iteratorReturned) return Promise.resolve(done());
      const event = queue.shift();
      if (event !== undefined) return Promise.resolve({ done: false, value: event });
      if (terminal !== undefined) {
        const event = terminal;
        terminal = undefined;
        return Promise.resolve({ done: false, value: event });
      }
      if (status !== 'ACTIVE') return Promise.resolve(done());
      return new Promise((resolve) => {
        pending = resolve;
      });
    },
    return(): Promise<ReadResult<T>> {
      void unsubscribe();
      iteratorReturned = true;
      terminal = undefined;
      return Promise.resolve(done());
    },
  };
  const subscription: Subscription<T> = {
    [Symbol.asyncIterator](): AsyncIterator<StreamEvent<T>> {
      if (iteratorClaimed) throw new TypeError('Subscription permits only one iterator');
      iteratorClaimed = true;
      return iterator;
    },
    unsubscribe,
    health() {
      enforceDeadline();
      return { status, queued: queue.length };
    },
  };

  if (signal?.aborted) {
    onAbort();
  } else if (deadline !== undefined && initialTime !== undefined && deadline <= initialTime) {
    finish({ kind: 'CLOSED', reason: 'DEADLINE' }, true);
  } else {
    if (signal !== undefined) {
      signal.addEventListener('abort', onAbort, { once: true });
      listening = true;
    }
    if (deadline !== undefined && initialTime !== undefined) {
      timer = setTimeout(
        () => finish({ kind: 'CLOSED', reason: 'DEADLINE' }, true),
        deadline - initialTime,
      );
      timer.unref();
    }
  }

  return {
    subscription,
    push(input: unknown): boolean {
      enforceDeadline();
      if (status !== 'ACTIVE') return false;
      if (queue.length >= capacity) {
        finish({ kind: 'RESYNC_REQUIRED', reason: 'OVERFLOW' }, true);
        return false;
      }
      let data: T;
      try {
        data = parse(input);
      } catch {
        finish({ kind: 'RESYNC_REQUIRED', reason: 'MALFORMED' }, true);
        return false;
      }
      // Parsing may invoke user code that cancels the subscription.
      enforceDeadline();
      if (status !== 'ACTIVE') return false;
      const event: StreamEvent<T> = Object.freeze({ kind: 'DATA', data });
      if (pending !== undefined) {
        const resolve = pending;
        pending = undefined;
        resolve({ done: false, value: event });
      } else if (queue.length >= capacity) {
        // Reentrant parser callbacks cannot grow the queue beyond its bound.
        finish({ kind: 'RESYNC_REQUIRED', reason: 'OVERFLOW' }, true);
        return false;
      } else {
        queue.push(event);
      }
      return true;
    },
    gap(): void {
      enforceDeadline();
      finish({ kind: 'RESYNC_REQUIRED', reason: 'SOURCE_GAP' }, true);
    },
    close(): void {
      enforceDeadline();
      finish({ kind: 'CLOSED', reason: 'SOURCE_CLOSED' }, false);
    },
  };
}
