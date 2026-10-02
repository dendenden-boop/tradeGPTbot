import fastify from 'fastify';

// Disposable dependency regression process, never part of API composition.
const app = fastify({ http2: true, logger: false });
app.get('/trailers', (_request, reply) => {
  reply.trailer('checksum', () => Promise.resolve('verified'));
  return reply.send({ ok: true });
});
const address = await app.listen({ host: '127.0.0.1', port: 0 });
process.send?.({ kind: 'READY', address });
process.on('message', (message) => {
  if (message?.kind === 'STOP') void app.close().then(() => process.exit(0));
});
