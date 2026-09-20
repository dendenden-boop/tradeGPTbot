// Local test/development tool only. Stores bounded ephemeral messages and never relays mail.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { SMTPServer } from 'smtp-server';

export async function createMailSink({ host = '127.0.0.1', smtpPort = 0, httpPort = 0 } = {}) {
  if (!['test', 'development'].includes(process.env.NODE_ENV))
    throw new Error('Local mail sink requires test/development');
  if (!['127.0.0.1', '0.0.0.0'].includes(host)) throw new Error('Invalid local mail sink bind');
  const messages = [];
  const sessions = new Set();
  const prune = () => {
    const cutoff = Date.now() - 3600_000;
    while (messages[0] && (messages[0].receivedAt < cutoff || messages.length > 127))
      messages.shift();
  };
  const smtp = new SMTPServer({
    secure: false,
    disabledCommands: ['AUTH', 'STARTTLS'],
    authOptional: true,
    logger: false,
    size: 65_536,
    socketTimeout: 5000,
    closeTimeout: 1000,
    onConnect(session, callback) {
      if (sessions.size >= 16) return callback(new Error('Local mail sink capacity reached'));
      sessions.add(session.id);
      callback();
    },
    onClose(session) {
      sessions.delete(session.id);
    },
    onRcptTo(address, _session, callback) {
      callback(
        /@[^@\s]+\.invalid$/iu.test(address.address)
          ? undefined
          : new Error('Local sink accepts .invalid recipients only'),
      );
    },
    onData(stream, session, callback) {
      let size = 0;
      const chunks = [];
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 65_536) chunks.push(chunk);
      });
      stream.on('error', () => callback(new Error('Local message read failed')));
      stream.on('end', () => {
        if (stream.sizeExceeded || size > 65_536)
          return callback(new Error('Local message too large'));
        prune();
        messages.push({
          receivedAt: Date.now(),
          to: session.envelope.rcptTo.map((item) => item.address),
          raw: Buffer.concat(chunks).toString('utf8'),
        });
        callback();
      });
    },
  });
  smtp.on('error', () => {});
  const http = createServer(
    { maxHeaderSize: 4096, requestTimeout: 2000, headersTimeout: 2000 },
    (request, response) => {
      response.setHeader('content-type', 'application/json');
      response.setHeader('cache-control', 'no-store');
      response.setHeader('x-content-type-options', 'nosniff');
      response.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
      // Host validation also blocks DNS rebinding from a public attacker-controlled name.
      if (!/^(?:127\.0\.0\.1|localhost)(?::[1-9]\d{0,4})?$/u.test(request.headers.host ?? '')) {
        response.writeHead(403).end('{}');
        return;
      }
      // No CORS. A browser site cannot inspect messages through cross-origin fetch.
      if (request.headers.origin || request.headers['sec-fetch-site'] === 'cross-site') {
        response.writeHead(403).end('{}');
        return;
      }
      if (request.method !== 'GET' || !['/messages', '/health'].includes(request.url)) {
        response.writeHead(404).end('{}');
        return;
      }
      prune();
      response.end(JSON.stringify(request.url === '/health' ? { status: 'ok' } : messages));
    },
  );
  http.maxConnections = 32;
  const listen = (server, port) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  let closed;
  const close = () =>
    (closed ??= Promise.all([
      new Promise((resolve) => smtp.close(resolve)),
      new Promise((resolve) => {
        http.close(resolve);
        http.closeAllConnections();
      }),
    ]).then(() => {
      messages.length = 0;
    }));
  try {
    await listen(smtp, smtpPort);
    await listen(http, httpPort);
  } catch {
    await close();
    throw new Error('Local mail sink could not bind');
  }
  return { messages, smtpPort: smtp.server.address().port, httpPort: http.address().port, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sink = await createMailSink({
    host: process.env.MAIL_SINK_HOST ?? '127.0.0.1',
    smtpPort: Number(process.env.MAIL_SINK_SMTP_PORT ?? '1025'),
    httpPort: Number(process.env.MAIL_SINK_HTTP_PORT ?? '8025'),
  });
  process.once('SIGTERM', () => {
    void sink.close();
  });
  process.once('SIGINT', () => {
    void sink.close();
  });
  console.log('Local mail sink ready; messages are ephemeral and never forwarded.');
}
