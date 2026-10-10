import { createServer, createConnection, type Socket } from 'node:net';

/** Native PostgreSQL fixture: suppress one acknowledged server COMMIT after a
 * publication. No query/result mocks; the real backend commits before response loss. */
export async function registryCommitProxy(
  connectionString: string,
  effect:
    | 'REGISTRY'
    | 'PORTFOLIO'
    | 'MARKET'
    | 'CERTIFICATE'
    | 'ADMISSION'
    | 'UNSENT_RECOVERY'
    | 'AMEND_APPLICATION'
    | 'PAPER_CONFIGURATION'
    | 'PAPER_PORTFOLIO'
    | 'PAPER_FUNDING' = 'REGISTRY',
) {
  const marker = {
    REGISTRY: 'SELECT ctp_registry.publish(',
    PORTFOLIO: 'UPDATE ctp_portfolio.book SET state',
    MARKET: 'UPDATE ctp_market.partition SET state',
    CERTIFICATE: 'SELECT ctp_certification.insert_certificate(',
    ADMISSION: 'SELECT ctp_admission.persist(',
    UNSENT_RECOVERY: "UPDATE public.submission_attempt SET status='REJECTED'",
    AMEND_APPLICATION: 'SELECT ctp_execution.apply_amendment(',
    PAPER_CONFIGURATION: 'SELECT ctp_paper.register_configuration(',
    PAPER_FUNDING: 'SELECT ctp_paper.initialize_funding(',
    PAPER_PORTFOLIO: 'SELECT ctp_paper.capture_initial_portfolio(',
  }[effect];
  const target = new URL(connectionString),
    sockets = new Set<Socket>();
  if (target.hostname !== '127.0.0.1' || !/^\d+$/.test(target.port))
    throw new Error('ISOLATED_PROXY_TARGET');
  let armed = false,
    dropped = 0;
  const server = createServer((front) => {
    const back = createConnection({ host: target.hostname, port: Number(target.port) });
    sockets.add(front);
    sockets.add(back);
    let input = Buffer.alloc(0),
      output = Buffer.alloc(0),
      startup = true,
      published = false;
    const destroy = () => {
      front.destroy();
      back.destroy();
    };
    front.on('error', destroy);
    back.on('error', destroy);
    front.once('close', () => {
      sockets.delete(front);
      back.destroy();
    });
    back.once('close', () => {
      sockets.delete(back);
      front.destroy();
    });
    front.on('data', (bytes) => {
      input = Buffer.concat([input, bytes]);
      if (input.length > 2097152) {
        destroy();
        return;
      }
      while (input.length >= (startup ? 4 : 5)) {
        const length = input.readInt32BE(startup ? 0 : 1),
          total = length + (startup ? 0 : 1);
        if (length < 4 || total > 1048581) {
          destroy();
          return;
        }
        if (input.length < total) break;
        const frame = input.subarray(0, total);
        input = input.subarray(total);
        if (!startup && (frame[0] === 80 || frame[0] === 81) && frame.includes(Buffer.from(marker)))
          published = true;
        startup = false;
        back.write(frame);
      }
    });
    back.on('data', (bytes) => {
      output = Buffer.concat([output, bytes]);
      if (output.length > 2097152) {
        destroy();
        return;
      }
      while (output.length >= 5) {
        const length = output.readInt32BE(1),
          total = length + 1;
        if (length < 4 || total > 1048581) {
          destroy();
          return;
        }
        if (output.length < total) break;
        const frame = output.subarray(0, total);
        output = output.subarray(total);
        if (
          armed &&
          published &&
          dropped === 0 &&
          frame[0] === 67 &&
          frame.subarray(5).toString() === 'COMMIT\0'
        ) {
          dropped++;
          destroy();
          return;
        }
        front.write(frame);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('PROXY_PORT');
  const url = new URL(target);
  url.port = String(address.port);
  return {
    connectionString: url.href,
    arm: () => {
      armed = true;
    },
    dropped: () => dropped,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
