import { createServer, type Socket } from 'node:net';

/** Actual bounded TCP/protocol fixture, not PostgreSQL SQL/security acceptance.
 * Only the first connection completes startup; subsequent handshakes blackhole. */
export async function postgresHandshakeFixture(blackholeAll = false) {
  const sockets = new Set<Socket>();
  let accepted = 0;
  let responding = false;
  function frame(code: string, payload: Buffer) {
    const length = Buffer.alloc(4);
    length.writeInt32BE(payload.length + 4);
    return Buffer.concat([Buffer.from(code), length, payload]);
  }
  const cstring = (s: string) => Buffer.from(s + '\0');
  function description() {
    const fields = Buffer.alloc(20);
    fields.writeUInt16BE(1, 0);
    fields.writeUInt32BE(16, 8);
    fields.writeInt16BE(1, 12);
    fields.writeInt32BE(-1, 14);
    return frame('T', Buffer.concat([fields.subarray(0, 2), cstring('safe'), fields.subarray(2)]));
  }
  const safeRow = () => frame('D', Buffer.from([0, 1, 0, 0, 0, 1, 116]));
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    if (++accepted > 16) {
      socket.destroy();
      return;
    }
    const first = responding || (accepted === 1 && !blackholeAll);
    let buffer = Buffer.alloc(0),
      startup = true,
      sql = '';
    socket.on('data', (chunk) => {
      if (!first) return;
      if (buffer.length + chunk.length > 65536) {
        socket.destroy();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (startup) {
        if (buffer.length < 4 || buffer.length < buffer.readInt32BE(0)) return;
        buffer = buffer.subarray(buffer.readInt32BE(0));
        startup = false;
        socket.write(
          Buffer.concat([
            frame('R', Buffer.alloc(4)),
            frame('K', Buffer.alloc(8)),
            frame('Z', Buffer.from('I')),
          ]),
        );
      }
      while (buffer.length >= 5 && buffer.length >= buffer.readInt32BE(1) + 1) {
        const code = String.fromCharCode(buffer[0]!),
          size = buffer.readInt32BE(1) + 1;
        if (size < 5 || size > 65536) {
          socket.destroy();
          return;
        }
        const payload = buffer.subarray(5, size);
        buffer = buffer.subarray(size);
        if (code === 'Q') {
          sql = payload.toString();
          const data = sql.includes('AS safe') ? [description(), safeRow()] : [];
          socket.write(
            Buffer.concat([
              ...data,
              frame(
                'C',
                cstring(
                  sql.startsWith('BEGIN')
                    ? 'BEGIN'
                    : sql.startsWith('COMMIT')
                      ? 'COMMIT'
                      : 'SELECT 0',
                ),
              ),
              frame('Z', Buffer.from('I')),
            ]),
          );
        }
        if (code === 'P') {
          sql = payload.subarray(1).toString();
          socket.write(frame('1', Buffer.alloc(0)));
        }
        if (code === 'B') socket.write(frame('2', Buffer.alloc(0)));
        if (code === 'D')
          socket.write(sql.includes('AS safe') ? description() : frame('n', Buffer.alloc(0)));
        if (code === 'E')
          socket.write(
            Buffer.concat([
              ...(sql.includes('AS safe') ? [safeRow()] : []),
              frame('C', cstring('SELECT 1')),
            ]),
          );
        if (code === 'S') socket.write(frame('Z', Buffer.from('I')));
        if (code === 'X') socket.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TCP_PORT');
  return {
    connectionString: `postgresql://fixture:fixture@127.0.0.1:${address.port}/fixture`,
    sockets,
    recover() {
      responding = true;
    },
    disconnect() {
      for (const socket of sockets) socket.destroy();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
