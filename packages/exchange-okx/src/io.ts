import { request as httpRequest } from 'node:http';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import WebSocket from 'ws';

export interface IoContext {
  readonly signal: AbortSignal;
  readonly deadline: number;
}

export interface HttpRequest {
  readonly url: URL;
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface NetworkSocket {
  send(text: string): Promise<void>;
  close(): Promise<void>;
}

/** Internal transport primitive. The composition root supplies only resolved endpoint profiles. */
export interface NetworkIo {
  request(input: HttpRequest, context: IoContext): Promise<HttpResponse>;
  openSocket(
    url: URL,
    context: IoContext,
    onMessage: (text: string) => void,
    onEnd: () => void,
  ): Promise<NetworkSocket>;
  close(): Promise<void>;
}

type ErrorCode =
  'ABORTED' | 'DEADLINE_EXCEEDED' | 'INVALID_RESPONSE' | 'UNAVAILABLE' | 'BUSY' | 'CLOSED';
class NetworkIoError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    Object.freeze(this);
  }
}
const error = (code: ErrorCode) => new NetworkIoError(code);
const MAX_BODY = 2 * 1024 * 1024;
const MAX_HEADERS = 16 * 1024;
const MAX_WS_BUFFER = 64 * 1024;
const MAX_DEADLINE = 30_000;
const CLOSE_GRACE = 250;

function checkContext(context: IoContext): ErrorCode | undefined {
  if (context.signal.aborted) return 'ABORTED';
  if (!Number.isSafeInteger(context.deadline)) return 'INVALID_RESPONSE';
  const remaining = context.deadline - Date.now();
  if (remaining <= 0) return 'DEADLINE_EXCEEDED';
  if (remaining > MAX_DEADLINE) return 'INVALID_RESPONSE';
  return undefined;
}

function validUrl(url: URL, protocols: readonly string[]): boolean {
  return (
    protocols.includes(url.protocol) &&
    url.username === '' &&
    url.password === '' &&
    url.hash === '' &&
    url.href.length <= 8192
  );
}

export function createNetworkIo(): NetworkIo {
  let closed = false;
  let closing: Promise<void> | undefined;
  const requests = new Set<() => Promise<void>>();
  const sockets = new Set<() => Promise<void>>();

  function request(input: HttpRequest, context: IoContext): Promise<HttpResponse> {
    return new Promise<HttpResponse>((resolve, reject) => {
      const invalid = closed ? 'CLOSED' : checkContext(context);
      if (invalid) {
        reject(error(invalid));
        return;
      }
      if (requests.size >= 16) {
        reject(error('BUSY'));
        return;
      }
      if (
        !validUrl(input.url, ['http:', 'https:']) ||
        !['GET', 'POST', 'PUT', 'DELETE'].includes(input.method) ||
        (input.body !== undefined &&
          (typeof input.body !== 'string' || Buffer.byteLength(input.body) > MAX_BODY))
      ) {
        reject(error('INVALID_RESPONSE'));
        return;
      }
      let headers: Record<string, string>;
      try {
        headers = { ...input.headers };
        let bytes = 0;
        for (const [key, value] of Object.entries(headers)) {
          if (typeof value !== 'string') throw error('INVALID_RESPONSE');
          bytes += Buffer.byteLength(key) + Buffer.byteLength(value) + 4;
        }
        if (bytes > MAX_HEADERS) throw error('INVALID_RESPONSE');
      } catch {
        reject(error('INVALID_RESPONSE'));
        return;
      }
      let req: ClientRequest | undefined;
      let response: IncomingMessage | undefined;
      let settled = false;
      let failure: ErrorCode | undefined;
      let forceTimer: NodeJS.Timeout | undefined;
      let release!: () => void;
      const completion = new Promise<void>((done) => {
        release = done;
      });
      const abort = () => stop('ABORTED');
      const close = () => {
        stop('CLOSED');
        return completion;
      };
      function finish(result?: HttpResponse) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        context.signal.removeEventListener('abort', abort);
        requests.delete(close);
        release();
        if (result && !failure) resolve(result);
        else reject(error(failure ?? 'UNAVAILABLE'));
      }
      function stop(code: ErrorCode) {
        if (settled || failure) return;
        failure = code;
        // Destroy, rather than merely racing a timeout: Node's timeout event alone does not abort I/O.
        response?.destroy();
        req?.destroy();
        if (!req || req.closed) {
          finish();
          return;
        }
        forceTimer = setTimeout(() => {
          req?.destroy();
          finish();
        }, CLOSE_GRACE);
        forceTimer.unref();
      }
      requests.add(close);
      context.signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => stop('DEADLINE_EXCEEDED'),
        Math.max(1, context.deadline - Date.now()),
      );
      timer.unref();
      try {
        const makeRequest = input.url.protocol === 'https:' ? httpsRequest : httpRequest;
        req = makeRequest(
          input.url,
          {
            method: input.method,
            headers,
            agent: false,
            maxHeaderSize: MAX_HEADERS,
            // Explicitly bounded independently of DNS, TCP, TLS, response headers and body progress.
            timeout: Math.max(1, context.deadline - Date.now()),
          },
          (message) => {
            response = message;
            message.on('error', () => stop('UNAVAILABLE'));
            message.on('aborted', () => stop('UNAVAILABLE'));
            if (failure || settled) {
              message.destroy();
              return;
            }
            const length = message.headers['content-length'];
            if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) {
              stop('INVALID_RESPONSE');
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            message.on('data', (chunk: Buffer) => {
              if (failure || settled) return;
              bytes += chunk.length;
              if (bytes > MAX_BODY) {
                stop('INVALID_RESPONSE');
                return;
              }
              chunks.push(chunk);
            });
            message.on('end', () => {
              if (failure || settled) return;
              if (!message.complete || message.statusCode === undefined) {
                stop('UNAVAILABLE');
                return;
              }
              try {
                const body = new TextDecoder('utf-8', { fatal: true }).decode(
                  Buffer.concat(chunks, bytes),
                );
                const values: Record<string, string> = Object.create(null) as Record<
                  string,
                  string
                >;
                for (const [key, value] of Object.entries(message.headers)) {
                  if (value !== undefined)
                    values[key] = Array.isArray(value) ? value.join(', ') : value;
                }
                finish(
                  Object.freeze({
                    status: message.statusCode,
                    headers: Object.freeze(values),
                    body,
                  }),
                );
              } catch {
                stop('INVALID_RESPONSE');
              }
            });
          },
        );
        req.on('error', (cause: NodeJS.ErrnoException) =>
          stop(cause.code === 'HPE_HEADER_OVERFLOW' ? 'INVALID_RESPONSE' : 'UNAVAILABLE'),
        );
        req.on('timeout', () => stop('DEADLINE_EXCEEDED'));
        req.on('close', () => {
          if (!settled) finish();
        });
        req.on('upgrade', (_message, socket) => {
          socket.destroy();
          stop('INVALID_RESPONSE');
        });
        if (context.signal.aborted) stop('ABORTED');
        else if (Date.now() >= context.deadline) stop('DEADLINE_EXCEEDED');
        else req.end(input.body);
      } catch {
        stop('INVALID_RESPONSE');
      }
    });
  }

  function openSocket(
    url: URL,
    context: IoContext,
    onMessage: (text: string) => void,
    onEnd: () => void,
  ): Promise<NetworkSocket> {
    return new Promise<NetworkSocket>((resolve, reject) => {
      const invalid = closed ? 'CLOSED' : checkContext(context);
      if (invalid) {
        reject(error(invalid));
        return;
      }
      if (sockets.size >= 16) {
        reject(error('BUSY'));
        return;
      }
      if (!validUrl(url, ['ws:', 'wss:'])) {
        reject(error('INVALID_RESPONSE'));
        return;
      }
      let socket: WebSocket | undefined;
      let opened = false;
      let stopped = false;
      let finalized = false;
      let failure: ErrorCode = 'UNAVAILABLE';
      let closeTimer: NodeJS.Timeout | undefined;
      let release!: () => void;
      const completion = new Promise<void>((done) => {
        release = done;
      });
      const sends = new Set<(code?: ErrorCode) => void>();
      let sendBytes = 0;
      const abort = () => stop('ABORTED');
      const close = () => {
        stop('CLOSED', true);
        return completion;
      };
      const shutdown = () => {
        stop('CLOSED');
        return completion;
      };
      function finish() {
        if (finalized) return;
        finalized = true;
        stopped = true;
        if (timer) clearTimeout(timer);
        if (closeTimer) clearTimeout(closeTimer);
        context.signal.removeEventListener('abort', abort);
        for (const done of sends) done('CLOSED');
        sockets.delete(shutdown);
        release();
        if (!opened) reject(error(failure));
        try {
          onEnd();
        } catch {
          /* A consumer callback cannot retain a network resource. */
        }
      }
      function stop(code: ErrorCode, graceful = false) {
        if (stopped) return;
        stopped = true;
        failure = code;
        if (!socket || socket.readyState === WebSocket.CLOSED) {
          finish();
          return;
        }
        if (graceful && socket.readyState === WebSocket.OPEN) socket.close();
        else socket.terminate();
        closeTimer = setTimeout(() => {
          socket?.terminate();
          finish();
        }, CLOSE_GRACE);
        closeTimer.unref();
      }
      function send(text: string): Promise<void> {
        return new Promise<void>((sent, failed) => {
          if (stopped || !socket || socket.readyState !== WebSocket.OPEN) {
            failed(error('CLOSED'));
            return;
          }
          if (typeof text !== 'string') {
            failed(error('INVALID_RESPONSE'));
            return;
          }
          const bytes = Buffer.byteLength(text);
          if (
            sends.size >= 16 ||
            bytes + Math.max(sendBytes, socket.bufferedAmount) > MAX_WS_BUFFER
          ) {
            failed(error('BUSY'));
            return;
          }
          let done = false;
          const settle = (code?: ErrorCode) => {
            if (done) return;
            done = true;
            sendBytes -= bytes;
            sends.delete(settle);
            if (code) failed(error(code));
            else sent();
          };
          sendBytes += bytes;
          sends.add(settle);
          try {
            socket.send(text, { binary: false, compress: false }, (cause) =>
              settle(cause ? 'UNAVAILABLE' : undefined),
            );
          } catch {
            settle('UNAVAILABLE');
            stop('UNAVAILABLE');
          }
        });
      }
      sockets.add(shutdown);
      context.signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => stop('DEADLINE_EXCEEDED'),
        Math.max(1, context.deadline - Date.now()),
      );
      timer.unref();
      try {
        socket = new WebSocket(url, {
          agent: false,
          autoPong: true,
          perMessageDeflate: false,
          followRedirects: false,
          maxPayload: 1024 * 1024,
          maxHeaderSize: MAX_HEADERS,
          handshakeTimeout: Math.max(1, context.deadline - Date.now()),
        });
        socket.on('error', (cause: Error) => {
          // ws has its own handshake timer; it may fire before our deadline callback.
          // Preserve cancellation/deadline semantics regardless of event-loop ordering.
          stop(
            checkContext(context) ??
              (!opened && cause.message === 'Opening handshake has timed out'
                ? 'DEADLINE_EXCEEDED'
                : 'UNAVAILABLE'),
          );
        });
        socket.on('close', finish);
        socket.on('open', () => {
          if (stopped || context.signal.aborted || Date.now() >= context.deadline) {
            stop(context.signal.aborted ? 'ABORTED' : 'DEADLINE_EXCEEDED');
            socket?.terminate();
            return;
          }
          opened = true;
          resolve(Object.freeze({ send, close }));
        });
        socket.on('message', (data, binary) => {
          if (stopped) return;
          if (binary) {
            stop('INVALID_RESPONSE');
            return;
          }
          try {
            const bytes = Array.isArray(data)
              ? Buffer.concat(data)
              : data instanceof ArrayBuffer
                ? Buffer.from(data)
                : data;
            onMessage(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
          } catch {
            stop('INVALID_RESPONSE');
          }
        });
        if (context.signal.aborted) stop('ABORTED');
        else if (Date.now() >= context.deadline) stop('DEADLINE_EXCEEDED');
      } catch {
        stop('INVALID_RESPONSE');
      }
    });
  }

  return Object.freeze({
    request,
    openSocket,
    close() {
      if (closing) return closing;
      closed = true;
      closing = Promise.all([...requests, ...sockets].map((stop) => stop())).then(() => undefined);
      return closing;
    },
  });
}
