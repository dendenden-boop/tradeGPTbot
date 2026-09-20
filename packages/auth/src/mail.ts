import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { createTransport } from 'nodemailer';
import type { SMTPTransportOptions } from 'nodemailer/lib/smtp-transport';

export type AuthMailKind = 'verify-email' | 'reset-password';
export type MailErrorCode = 'MAIL_INVALID' | 'MAIL_BUSY' | 'MAIL_CLOSED' | 'MAIL_UNAVAILABLE';

export class MailError extends Error {
  constructor(readonly code: MailErrorCode) {
    super(code);
    this.name = 'MailError';
  }
}

export interface AuthMailer {
  send(kind: AuthMailKind, email: string, token: string): Promise<void>;
  ready(): Promise<void>;
  close(): Promise<void>;
}

export interface AuthMailerOptions {
  readonly origin: string;
  readonly smtp: {
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
    readonly requireTls: boolean;
    readonly user?: string;
    readonly password?: string;
    readonly from: string;
  };
}

function isMailbox(value: string): boolean {
  return (
    value.length <= 254 &&
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)
  );
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function validateOptions(options: AuthMailerOptions): void {
  try {
    const origin = new URL(options.origin);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
    if (
      origin.origin !== options.origin ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local)) ||
      !options.smtp.host ||
      hasControlCharacters(options.smtp.host) ||
      /[\s/\\@]/u.test(options.smtp.host) ||
      !Number.isInteger(options.smtp.port) ||
      options.smtp.port < 1 ||
      options.smtp.port > 65_535 ||
      !isMailbox(options.smtp.from) ||
      (options.smtp.user === undefined) !== (options.smtp.password === undefined) ||
      (options.smtp.user !== undefined &&
        (!options.smtp.user || hasControlCharacters(options.smtp.user))) ||
      (options.smtp.password !== undefined && !options.smtp.password) ||
      (origin.protocol === 'https:' && !options.smtp.secure && !options.smtp.requireTls)
    )
      throw new Error('invalid');
  } catch {
    throw new MailError('MAIL_INVALID');
  }
}

export function createAuthMailer(options: AuthMailerOptions): AuthMailer {
  validateOptions(options);
  let closed = false;
  let closing: Promise<void> | undefined;
  let readiness: Promise<void> | undefined;
  let readyUntil = 0;
  const active = new Set<{ stop(): void; done: Promise<void> }>();

  async function run(send?: { kind: AuthMailKind; email: string; token: string }): Promise<void> {
    if (closed) throw new MailError('MAIL_CLOSED');
    // No Nodemailer pool or offline queue. One extra slot belongs to readiness;
    // the service separately bounds pending deliveries before account lookup.
    if (active.size >= (send ? 8 : 9)) throw new MailError('MAIL_BUSY');
    let socket: Socket | undefined;
    let ended = false;
    let rejectStopped: (error: MailError) => void = () => {};
    const stopped = new Promise<never>((_resolve, reject) => {
      rejectStopped = reject;
    });
    const transportOptions: SMTPTransportOptions = {
      host: options.smtp.host,
      port: options.smtp.port,
      secure: options.smtp.secure,
      requireTLS: options.smtp.requireTls,
      opportunisticTLS: false,
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      connectionTimeout: 1_000,
      greetingTimeout: 1_000,
      socketTimeout: 3_000,
      dnsTimeout: 1_000,
      logger: false,
      debug: false,
      transactionLog: false,
      disableFileAccess: true,
      disableUrlAccess: true,
      maxRecipients: 1,
      name: 'ctp-api',
      ...(options.smtp.user === undefined
        ? {}
        : {
            auth: { user: options.smtp.user, pass: options.smtp.password },
          }),
      // SMTPTransport.close() does not close active connections. Owning the
      // underlying TCP socket makes the absolute deadline and shutdown real,
      // including a peer that keeps resetting the library's idle timeout.
      getSocket(_smtpOptions, callback) {
        if (ended) {
          callback(new MailError('MAIL_UNAVAILABLE'));
          return;
        }
        let returned = false;
        const fail = () => {
          if (!returned) {
            returned = true;
            callback(new MailError('MAIL_UNAVAILABLE'));
          }
        };
        socket = createConnection({ host: options.smtp.host, port: options.smtp.port });
        socket.once('error', fail);
        socket.once('close', fail);
        socket.once('connect', () => {
          if (ended) {
            socket?.destroy();
            fail();
            return;
          }
          returned = true;
          // Nodemailer upgrades this socket for both implicit TLS and STARTTLS;
          // certificate verification is always enabled above.
          callback(null, { connection: socket });
        });
      },
    };
    const transporter = createTransport(transportOptions);
    const stop = () => {
      ended = true;
      socket?.destroy();
      transporter.close();
      rejectStopped(new MailError('MAIL_UNAVAILABLE'));
    };
    const deadline = setTimeout(stop, 5_000);
    const work = Promise.resolve().then(async () => {
      if (!send) {
        await transporter.verify();
        return;
      }
      const verification = send.kind === 'verify-email';
      // Fragments are not sent to an HTTP server or included in Referer.
      const link = `${options.origin}/${send.kind}#token=${send.token}`;
      const result = await transporter.sendMail({
        from: { address: options.smtp.from, name: 'Crypto Trading Platform' },
        to: { address: send.email, name: '' },
        envelope: { from: options.smtp.from, to: [send.email] },
        subject: verification ? 'Verify your email address' : 'Reset your password',
        text: `${verification ? 'Verify your email address' : 'Reset your password'}:\n\n${link}\n\nThis single-use link expires in ${verification ? '30' : '15'} minutes. If you did not request it, ignore this email.`,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      if (result.accepted.length !== 1 || result.rejected.length !== 0)
        throw new MailError('MAIL_UNAVAILABLE');
    });
    const job = { stop, done: Promise.resolve() };
    job.done = Promise.race([work, stopped])
      .catch(() => {
        readyUntil = 0;
        throw new MailError('MAIL_UNAVAILABLE');
      })
      .finally(() => {
        clearTimeout(deadline);
        ended = true;
        socket?.destroy();
        transporter.close();
        active.delete(job);
      });
    active.add(job);
    await job.done;
  }

  return {
    async send(kind, email, token) {
      if (
        (kind !== 'verify-email' && kind !== 'reset-password') ||
        !isMailbox(email) ||
        !/^[A-Za-z0-9_-]{43}$/.test(token)
      ) {
        throw new MailError('MAIL_INVALID');
      }
      await run({ kind, email, token });
    },
    ready() {
      if (closed) return Promise.reject(new MailError('MAIL_CLOSED'));
      if (Date.now() < readyUntil) return Promise.resolve();
      if (!readiness) {
        readiness = run()
          .then(() => {
            readyUntil = Date.now() + 1_000;
          })
          .finally(() => {
            readiness = undefined;
          });
      }
      return readiness;
    },
    close() {
      if (!closing) {
        closed = true;
        for (const job of active) job.stop();
        closing = Promise.allSettled([...active].map(({ done }) => done)).then(() => undefined);
      }
      return closing;
    },
  };
}
