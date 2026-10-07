import { AsyncLocalStorage } from 'node:async_hooks';
import { Socket } from 'node:net';

interface Io {
  readonly signal: AbortSignal;
  readonly deadline: number;
}
interface Client {
  release(destroy?: boolean): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
}
interface Pool<C extends Client> {
  readonly totalCount?: number;
  readonly idleCount?: number;
  connect(): Promise<C>;
}
/** Own the physical stream before pg exposes a connected client. This helper has
 * no SQL/credentials/financial authority and preserves each port's transaction.
 * Four physical connections plus four explicitly owned waiting acquisitions;
 * no caller is placed into pg's hidden wait queue. */
export function createPostgresConnections(capacity = 4) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 16)
    throw new Error('POSTGRES_CONNECTION_CAPACITY');
  const context = new AsyncLocalStorage<{ io: Io; created: Set<Socket> }>();
  const sockets = new Set<Socket>();
  const cleanup = new WeakMap<Socket, () => void>();
  const pending = new Set<Promise<unknown>>();
  const waiting = new Set<() => void>();
  const guarded = new WeakSet<Client>();
  let closed = false,
    connecting = 0;
  const available = <C extends Client>(pool: Pool<C>) =>
    connecting < capacity && ((pool.totalCount ?? 0) < capacity || (pool.idleCount ?? 0) > 0);
  async function waitForCapacity<C extends Client>(pool: Pool<C>, io: Io) {
    if (waiting.size >= capacity) throw new Error('POSTGRES_CONNECTION_BUSY');
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (aborted: boolean) => {
        clearTimeout(timer);
        waiting.delete(cancel);
        io.signal.removeEventListener('abort', cancel);
        if (aborted) reject(new Error('POSTGRES_CONNECTION_ABORTED'));
        else resolve();
      };
      const cancel = () => finish(true);
      const poll = () => {
        if (closed || io.signal.aborted || io.deadline <= Date.now()) finish(true);
        else if (available(pool)) {
          connecting++;
          finish(false);
        } else timer = setTimeout(poll, Math.min(5, io.deadline - Date.now()));
      };
      waiting.add(cancel);
      io.signal.addEventListener('abort', cancel, { once: true });
      poll();
    });
  }
  const stream = () => {
    const holder = context.getStore(),
      io = holder?.io;
    if (!io || closed || io.signal.aborted || io.deadline <= Date.now())
      throw new Error('POSTGRES_CONNECTION_ABORTED');
    const socket = new Socket();
    sockets.add(socket);
    holder.created.add(socket);
    socket.on('error', () => {});
    const abort = () => socket.destroy(new Error('POSTGRES_CONNECTION_ABORTED'));
    io.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.min(3000, io.deadline - Date.now()));
    cleanup.set(socket, () => {
      clearTimeout(timer);
      io.signal.removeEventListener('abort', abort);
    });
    socket.once('close', () => {
      cleanup.get(socket)?.();
      cleanup.delete(socket);
      sockets.delete(socket);
    });
    return socket;
  };
  async function connect<C extends Client>(pool: Pool<C>, caller: Io): Promise<C> {
    if (
      closed ||
      caller.signal.aborted ||
      !Number.isSafeInteger(caller.deadline) ||
      caller.deadline <= Date.now()
    )
      throw new Error('POSTGRES_CONNECTION_ABORTED');
    const io = { signal: caller.signal, deadline: Math.min(caller.deadline, Date.now() + 3000) };
    if (!available(pool)) await waitForCapacity(pool, io);
    else connecting++;
    const created = new Set<Socket>();
    let operation: Promise<C> | undefined;
    try {
      operation = context.run({ io, created }, () => pool.connect());
      pending.add(operation);
      const client = await operation;
      if (!guarded.has(client)) {
        // pg removes its idle-pool error listener on checkout. The owned client
        // still emits error after rejecting pending queries on connection loss.
        // Query failure remains authoritative; do not expose raw driver errors.
        client.on('error', () => {});
        guarded.add(client);
      }
      if (closed || io.signal.aborted || io.deadline <= Date.now()) {
        client.release(true);
        throw new Error('POSTGRES_CONNECTION_ABORTED');
      }
      return client;
    } finally {
      if (operation) pending.delete(operation);
      for (const socket of created) {
        cleanup.get(socket)?.();
        cleanup.delete(socket);
      }
      connecting--;
    }
  }
  return Object.freeze({
    stream,
    connect,
    async close() {
      if (closed) return;
      closed = true;
      for (const cancel of [...waiting]) cancel();
      const closing = [...sockets].map(
        (socket) => new Promise<void>((resolve) => socket.once('close', () => resolve())),
      );
      for (const socket of sockets) socket.destroy(new Error('POSTGRES_CONNECTION_CLOSED'));
      await Promise.allSettled([...pending]);
      await Promise.all(closing);
    },
  });
}
