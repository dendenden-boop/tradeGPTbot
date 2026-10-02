import { fork } from 'node:child_process';
import { connect, type IncomingHttpHeaders } from 'node:http2';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('Fastify HTTP/2 trailers do not crash the process (GHSA-4mh8-r7rc-xpvc)', async () => {
  const child = fork(
    fileURLToPath(new URL('./fixtures/fastify-trailer.mjs', import.meta.url)),
    [],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  const exited = once(child, 'exit');
  // Consume only bounded error output; the assertion identifies a crash without dumping internals.
  let failure = false;
  child.stderr?.on('data', () => {
    failure = true;
  });
  let session: ReturnType<typeof connect> | undefined;
  try {
    const ready = await Promise.race([
      once(child, 'message').then(([message]: unknown[]) => message),
      exited.then(() => {
        throw new Error('HTTP2_FIXTURE_EXITED_BEFORE_READY');
      }),
    ]);
    if (
      ready === null ||
      typeof ready !== 'object' ||
      !('address' in ready) ||
      typeof ready.address !== 'string'
    )
      throw new Error('INVALID_FIXTURE_READY');
    session = connect(ready.address);
    session.on('error', () => {
      /* Stream failure below captures the dependency crash. */
    });
    for (let index = 0; index < 2; index++) {
      const stream = session.request({ ':path': '/trailers' });
      let body = '';
      let trailer: unknown;
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        body += chunk;
      });
      stream.on('trailers', (headers: IncomingHttpHeaders) => {
        trailer = headers.checksum;
      });
      const completed = once(stream, 'end');
      stream.end();
      await Promise.race([
        completed,
        exited.then(() => {
          throw new Error('FASTIFY_HTTP2_TRAILER_PROCESS_CRASHED');
        }),
      ]);
      expect(body).toBe('{"ok":true}');
      expect(trailer).toBe('verified');
      expect(failure).toBe(false);
      expect(child.exitCode).toBeNull();
    }
  } finally {
    session?.destroy();
    if (child.connected) child.send({ kind: 'STOP' });
    if (child.exitCode === null && child.signalCode === null) {
      const timer = setTimeout(() => child.kill(), 1000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }
  }
});
