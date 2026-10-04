import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';

export async function httpFixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const sockets = new Set<Socket>();
  const server = createServer(handler);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  return {
    url,
    server,
    sockets,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export async function wsFixture(onConnection: (socket: WebSocket) => void = () => undefined) {
  const http = await httpFixture((_request, response) => response.writeHead(404).end());
  const server = new WebSocketServer({ server: http.server, perMessageDeflate: false });
  server.on('connection', (socket) => {
    socket.on('error', () => undefined);
    onConnection(socket);
  });
  const url = new URL(http.url);
  url.protocol = 'ws:';
  return {
    ...http,
    url,
    ws: server,
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await http.close();
    },
  };
}

export async function until(predicate: () => boolean, milliseconds = 1500) {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('fixture condition timed out');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

export async function tlsHangFixture() {
  const sockets = new Set<Socket>();
  let bytes = 0;
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: new URL(`https://127.0.0.1:${(server.address() as AddressInfo).port}`),
    sockets,
    get bytes() {
      return bytes;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
