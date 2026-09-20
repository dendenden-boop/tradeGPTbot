import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuthMailer } from '../src/mail.js';
import type { AuthMailer, AuthMailerOptions } from '../src/mail.js';

// smtp-server ships JavaScript. Keep its test-only adapter narrow instead of
// introducing a second, incompatible set of Nodemailer declarations.
const { SMTPServer } = createRequire(import.meta.url)('smtp-server') as {
  SMTPServer: new (options: {
    secure: boolean;
    authOptional: boolean;
    disabledCommands: string[];
    logger: false;
    size: number;
    onData(stream: Readable, session: unknown, callback: (error?: Error) => void): void;
  }) => {
    server: Server;
    on(event: 'error', listener: (error: Error) => void): void;
    listen(port: number, host: string, callback: () => void): void;
    close(callback: () => void): void;
  };
};

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

function options(port: number): AuthMailerOptions {
  return {
    origin: 'http://127.0.0.1:3000',
    smtp: {
      host: '127.0.0.1',
      port,
      secure: false,
      requireTls: false,
      from: 'auth@example.invalid',
    },
  };
}

function ownMailer(port: number): AuthMailer {
  const mailer = createAuthMailer(options(port));
  cleanup.push(() => mailer.close());
  return mailer;
}

function trackSockets(server: Server): Set<Socket> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  return sockets;
}

async function localSink(
  tlsMode: 'none' | 'implicit' | 'starttls' = 'none',
): Promise<{ port: number; messages: string[] }> {
  const messages: string[] = [];
  const server = new SMTPServer({
    secure: tlsMode === 'implicit',
    authOptional: true,
    disabledCommands: tlsMode === 'starttls' ? ['AUTH'] : ['AUTH', 'STARTTLS'],
    logger: false,
    size: 4_096,
    onData(stream, _session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.once('end', () => {
        messages.push(Buffer.concat(chunks).toString('utf8'));
        callback();
      });
      stream.once('error', () => callback(new Error('TEST_SMTP_READ_FAILED')));
    },
  });
  // TLS rejection is expected in the certificate tests below. The sink uses
  // smtp-server's explicitly test-only self-signed localhost certificate.
  server.on('error', () => {});
  const sockets = trackSockets(server.server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        // The TLS wrapper owns these accepted TCP handles after upgrade. Closing
        // raw handles concurrently can race Windows TLS teardown; let the SMTP
        // server close its own TLS connections after the rejected client exits.
        if (tlsMode === 'none') for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  );
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('TEST_SMTP_ADDRESS_INVALID');
  return { port: address.port, messages };
}

describe('authentication SMTP delivery', () => {
  it('delivers both one-use links through a loopback SMTP sink, with tokens only in fragments', async () => {
    const sink = await localSink();
    const mailer = ownMailer(sink.port);
    await Promise.all([mailer.ready(), mailer.ready()]);
    expect(sink.messages).toHaveLength(0);
    const token = Buffer.alloc(32, 7).toString('base64url');
    await mailer.send('verify-email', 'alice@example.invalid', token);
    await mailer.send('reset-password', 'alice@example.invalid', token);
    expect(sink.messages).toHaveLength(2);
    const decoded = sink.messages.map((message) =>
      message.replace(/=\r\n/g, '').replace(/=3D/g, '='),
    );
    expect(decoded[0]).toContain(`http://127.0.0.1:3000/verify-email#token=${token}`);
    expect(decoded[0]).toContain('30 minutes');
    expect(decoded[1]).toContain(`http://127.0.0.1:3000/reset-password#token=${token}`);
    expect(decoded[1]).toContain('15 minutes');
    expect(decoded.join('')).not.toContain('?token=');
  });

  it('rejects message/header injection before opening SMTP connections', async () => {
    const sink = await localSink();
    const mailer = ownMailer(sink.port);
    await expect(
      mailer.send(
        'verify-email',
        'alice@example.invalid\r\nBcc: victim@example.invalid',
        'a'.repeat(43),
      ),
    ).rejects.toMatchObject({ code: 'MAIL_INVALID' });
    await expect(
      mailer.send('verify-email', 'alice@example.invalid', 'a'.repeat(43) + '\n'),
    ).rejects.toMatchObject({ code: 'MAIL_INVALID' });
    expect(sink.messages).toHaveLength(0);
    expect(() =>
      createAuthMailer({ ...options(sink.port), origin: 'https://example.invalid/evil' }),
    ).toThrow('MAIL_INVALID');
    expect(() =>
      createAuthMailer({ ...options(sink.port), origin: 'https://example.invalid' }),
    ).toThrow('MAIL_INVALID');
  });

  it('fails closed if STARTTLS is required but unavailable', async () => {
    const sink = await localSink();
    const config = options(sink.port);
    const mailer = createAuthMailer({ ...config, smtp: { ...config.smtp, requireTls: true } });
    cleanup.push(() => mailer.close());
    await expect(mailer.ready()).rejects.toMatchObject({ message: 'MAIL_UNAVAILABLE' });
    expect(sink.messages).toHaveLength(0);
  });

  it.each(['implicit', 'starttls'] as const)(
    'rejects an untrusted certificate over %s TLS before delivering tokens',
    async (tlsMode) => {
      const sink = await localSink(tlsMode);
      const config = options(sink.port);
      const mailer = createAuthMailer({
        ...config,
        smtp: { ...config.smtp, secure: tlsMode === 'implicit', requireTls: true },
      });
      cleanup.push(() => mailer.close());
      await expect(
        mailer.send('verify-email', 'alice@example.invalid', 'a'.repeat(43)),
      ).rejects.toMatchObject({ message: 'MAIL_UNAVAILABLE' });
      expect(sink.messages).toHaveLength(0);
    },
  );

  it.each([false, true])(
    'caps simultaneous sends and cancels active sockets during shutdown (TLS=%j)',
    async (secure) => {
      const server = createServer(); // deliberately never sends a greeting
      const sockets = trackSockets(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      cleanup.push(
        () =>
          new Promise<void>((resolve) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => resolve());
          }),
      );
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('TEST_SMTP_ADDRESS_INVALID');
      const config = options(address.port);
      const mailer = createAuthMailer({ ...config, smtp: { ...config.smtp, secure } });
      cleanup.push(() => mailer.close());
      const pending = Array.from({ length: 8 }, () =>
        mailer.send('verify-email', 'alice@example.invalid', 'a'.repeat(43)),
      );
      const settled = Promise.allSettled(pending);
      await expect(
        mailer.send('verify-email', 'alice@example.invalid', 'a'.repeat(43)),
      ).rejects.toMatchObject({ code: 'MAIL_BUSY' });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(sockets.size).toBeLessThanOrEqual(8);
      const started = performance.now();
      await mailer.close();
      expect(performance.now() - started).toBeLessThan(1_000);
      expect((await settled).every(({ status }) => status === 'rejected')).toBe(true);
      await expect(mailer.ready()).rejects.toMatchObject({ code: 'MAIL_CLOSED' });
      await mailer.close();
    },
  );

  it('enforces an absolute deadline even when an SMTP peer keeps the socket active', async () => {
    const server = createServer((socket) => {
      socket.write('220 test.example.invalid ESMTP\r\n');
      const timer = setInterval(() => socket.write('250-still-waiting\r\n'), 200);
      socket.once('close', () => clearInterval(timer));
    });
    const sockets = trackSockets(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resolve());
        }),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TEST_SMTP_ADDRESS_INVALID');
    const mailer = ownMailer(address.port);
    const started = performance.now();
    await expect(mailer.ready()).rejects.toMatchObject({ message: 'MAIL_UNAVAILABLE' });
    expect(performance.now() - started).toBeGreaterThan(4_000);
    expect(performance.now() - started).toBeLessThan(6_500);
  });
});
