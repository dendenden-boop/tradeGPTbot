import { createServer, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { openPaperAdmissionDatabase } from '../src/admission-database.js';

const i16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
};
const i32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const str = (s: string) => Buffer.from(s + '\0');
const frame = (tag: string, ...body: Buffer[]) => {
  const data = Buffer.concat(body);
  return Buffer.concat([Buffer.from(tag), i32(data.length + 4), data]);
};
const command = (text: string) =>
  Buffer.concat([frame('C', str(text)), frame('Z', Buffer.from('I'))]);
const role = () =>
  Buffer.concat([
    frame('T', i16(1), str('safe'), i32(0), i16(0), i32(16), i16(1), i32(-1), i16(0)),
    frame('D', i16(1), i32(1), Buffer.from('t')),
    command('SELECT 1'),
  ]);

/** Real pg client and physical TCP, with a deliberately minimal test-only wire
 * peer. It can simulate an unavailable backend, not database SQL/roles, source
 * authenticity, transaction durability or financial acceptance. */
async function peer() {
  const sockets = new Set<Socket>(),
    seen: { text: string; socket: Socket }[] = [];
  const listener = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0),
      startup = true;
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (startup) {
        if (pending.length < 4) return;
        const length = pending.readInt32BE();
        if (pending.length < length) return;
        pending = pending.subarray(length);
        startup = false;
        socket.write(
          Buffer.concat([
            frame('R', i32(0)),
            frame('S', str('client_encoding'), str('UTF8')),
            frame('Z', Buffer.from('I')),
          ]),
        );
      }
      while (pending.length >= 5) {
        const length = pending.readInt32BE(1);
        if (pending.length < 1 + length) return;
        const tag = pending.toString('utf8', 0, 1),
          body = pending.subarray(5, 1 + length);
        pending = pending.subarray(1 + length);
        if (tag === 'X') {
          socket.end();
          continue;
        }
        if (tag !== 'Q') {
          socket.destroy();
          return;
        }
        const text = body.subarray(0, body.length - 1).toString('utf8');
        seen.push({ text, socket });
        if (text === 'COMMIT' && loseCommit) {
          socket.destroy();
          continue;
        }
        if (text.startsWith('SELECT hung')) continue;
        socket.write(
          text.includes(' AS safe')
            ? role()
            : command(text.startsWith('SELECT') ? 'SELECT 0' : text),
        );
      }
    });
  });
  let loseCommit = false;
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw Error('fixture address');
  return {
    options: {
      connectionString: `postgresql://fixture:physical-private@127.0.0.1:${address.port}/paper`,
      environment: 'test',
    },
    sockets,
    seen,
    loseCommit() {
      loseCommit = true;
    },
    async waitFor(count: number) {
      const until = Date.now() + 1500;
      while (
        seen.filter((q) => q.text.startsWith('SELECT hung')).length < count &&
        Date.now() < until
      )
        await delay(5);
      expect(seen.filter((q) => q.text.startsWith('SELECT hung'))).toHaveLength(count);
    },
    async drained() {
      const until = Date.now() + 1000;
      while (sockets.size && Date.now() < until) await delay(5);
      expect(sockets.size).toBe(0);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
}
const io = (signal = new AbortController().signal, ms = 2000) => ({
  signal,
  deadline: Date.now() + ms,
});

it.each(['abort', 'deadline'] as const)(
  'physically settles a hung query after %s and admits subsequent work',
  async (kind) => {
    const h = await peer(),
      c = new AbortController();
    const db = await openPaperAdmissionDatabase(h.options),
      start = performance.now();
    const pending = db.transaction(
      null,
      io(c.signal, kind === 'deadline' ? 250 : 2000),
      async (sql) => {
        await sql.query('SELECT hung');
        return 'never-a-grant';
      },
    );
    void pending.catch(() => {});
    try {
      await h.waitFor(1);
      if (kind === 'abort') c.abort();
      await expect(pending).rejects.toThrow('PAPER_ADMISSION_ABORTED');
      await h.drained();
      expect(performance.now() - start).toBeLessThan(1500);
      expect(
        await db.transaction(null, io(), async (sql) => {
          await sql.query('SELECT alive');
          return 'transport-only';
        }),
      ).toBe('transport-only');
      await h.drained();
    } finally {
      c.abort();
      await pending.catch(() => {});
      await db.close();
      await h.close();
    }
  },
);
it('four physical hung queries retain slots until settling, without queuing or overflowing', async () => {
  const h = await peer(),
    db = await openPaperAdmissionDatabase(h.options);
  const cs = Array.from({ length: 4 }, () => new AbortController());
  const jobs = cs.map((c, i) =>
    db.transaction(null, io(c.signal), async (sql) => {
      await sql.query('SELECT hung ' + i);
      return 'never';
    }),
  );
  for (const job of jobs) void job.catch(() => {});
  try {
    await h.waitFor(4);
    expect(h.sockets.size).toBe(4);
    await expect(db.transaction(null, io(), () => Promise.resolve('overflow'))).rejects.toThrow(
      'PAPER_ADMISSION_BUSY',
    );
    const firstSocket = h.seen.find((q) => q.text === 'SELECT hung 0')!.socket;
    cs[0]!.abort();
    await expect(jobs[0]).rejects.toThrow('PAPER_ADMISSION_ABORTED');
    // Wait for the peer's FIN observation; the client cleanup already settled.
    const until = Date.now() + 1000;
    while (h.sockets.has(firstSocket) && Date.now() < until) await delay(5);
    expect(h.sockets.has(firstSocket)).toBe(false);
    expect(await db.transaction(null, io(), () => Promise.resolve('replacement'))).toBe(
      'replacement',
    );
    await db.close();
    for (const job of jobs.slice(1)) await expect(job).rejects.toThrow('PAPER_ADMISSION_CLOSED');
    await h.drained();
  } finally {
    cs.forEach((c) => c.abort());
    await db.close();
    await Promise.allSettled(jobs);
    await h.close();
  }
});
it('a physical connection loss after COMMIT dispatch produces uncertainty and no blind retry', async () => {
  const h = await peer(),
    db = await openPaperAdmissionDatabase(h.options);
  h.seen.length = 0;
  h.loseCommit();
  try {
    await expect(
      db.transaction(null, io(), async (sql) => {
        await sql.query('SELECT mutation-protocol');
        return 'not-a-grant';
      }),
    ).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
    expect(h.seen.map((q) => q.text)).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      'SELECT mutation-protocol',
      'COMMIT',
    ]);
    await h.drained();
  } finally {
    await db.close();
    await h.close();
  }
});
