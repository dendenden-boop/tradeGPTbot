import { setTimeout as wait } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { expect, it } from 'vitest';
import { createPostgresConnections } from '@ctp/exchange-core';
import { postgresHandshakeFixture } from '../../exchange-core/test/fixtures/postgres-handshake.js';
const io = (signal = new AbortController().signal, ms = 1000) => ({
  signal,
  deadline: Date.now() + ms,
});
async function until(test: () => boolean) {
  for (let i = 0; i < 50 && !test(); i++) await wait(5);
  expect(test()).toBe(true);
}
it('preserves existing eight-way duplicate request concurrency with bounded acquisition', async () => {
  const fixture = await postgresHandshakeFixture();
  fixture.recover();
  const physical = createPostgresConnections();
  const pool = new Pool({
    connectionString: fixture.connectionString,
    max: 4,
    stream: physical.stream,
  });
  pool.on('error', () => {});
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, async () => {
        const client: PoolClient = await physical.connect(pool, io());
        try {
          return (await client.query<{ safe: boolean }>('SELECT true AS safe')).rows[0]?.safe;
        } finally {
          client.release();
        }
      }),
    );
    expect(results).toEqual(
      Array.from({ length: 8 }, () => ({ status: 'fulfilled', value: true })),
    );
    expect(pool.waitingCount).toBe(0);
    expect(pool.totalCount).toBeLessThanOrEqual(4);
  } finally {
    await physical.close();
    await pool.end();
    await fixture.close();
  }
});
it('rejects saturated physical handshake admission without a hidden wait queue and recovers after actual abort settlement', async () => {
  const fixture = await postgresHandshakeFixture(true),
    physical = createPostgresConnections();
  const pool = new Pool({
    connectionString: fixture.connectionString,
    max: 4,
    stream: physical.stream,
    connectionTimeoutMillis: 1000,
  });
  pool.on('error', () => {});
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const pending = controllers.map((c) =>
    physical.connect(pool, io(c.signal)).then(
      (p) => {
        p.release();
        return 'CONNECTED';
      },
      () => 'ABORTED',
    ),
  );
  try {
    await until(() => fixture.sockets.size === 4);
    await expect(physical.connect(pool, io())).rejects.toThrow('POSTGRES_CONNECTION_BUSY');
    expect(pool.waitingCount).toBe(0);
    controllers.forEach((c) => c.abort());
    expect(await Promise.all(pending)).toEqual(Array.from({ length: 8 }, () => 'ABORTED'));
    await until(() => fixture.sockets.size === 0);
    fixture.recover();
    const recovered: PoolClient = await physical.connect(pool, io());
    expect((await recovered.query('SELECT true AS safe')).rows[0]).toEqual({ safe: true });
    recovered.release();
  } finally {
    controllers.forEach((c) => c.abort());
    await physical.close();
    await pool.end();
    await fixture.close();
  }
});
it('does not carry an old handshake deadline or AbortSignal into a reused idle connection', async () => {
  const fixture = await postgresHandshakeFixture(),
    physical = createPostgresConnections();
  const pool = new Pool({
    connectionString: fixture.connectionString,
    max: 4,
    stream: physical.stream,
  });
  pool.on('error', () => {});
  const controller = new AbortController();
  try {
    const first: PoolClient = await physical.connect(pool, io(controller.signal, 100));
    first.release();
    controller.abort();
    await wait(150);
    expect(fixture.sockets.size).toBe(1);
    const second: PoolClient = await physical.connect(pool, io());
    expect(second).toBe(first);
    expect((await second.query('SELECT true AS safe')).rows[0]).toEqual({ safe: true });
    second.release();
  } finally {
    await physical.close();
    await pool.end();
    await fixture.close();
  }
});
it('close physically settles pending authentication before returning and rejects new acquisition', async () => {
  const fixture = await postgresHandshakeFixture(true),
    physical = createPostgresConnections();
  const pool = new Pool({
    connectionString: fixture.connectionString,
    max: 4,
    stream: physical.stream,
  });
  pool.on('error', () => {});
  const pending = physical.connect(pool, io()).then(
    (p) => {
      p.release();
      return false;
    },
    () => true,
  );
  try {
    await until(() => fixture.sockets.size === 1);
    const started = Date.now();
    await physical.close();
    expect(await pending).toBe(true);
    expect(Date.now() - started).toBeLessThan(250);
    await until(() => fixture.sockets.size === 0);
    await expect(physical.connect(pool, io())).rejects.toThrow('POSTGRES_CONNECTION_ABORTED');
  } finally {
    await physical.close();
    await pool.end();
    await fixture.close();
  }
});
