import { z } from 'zod';
import { createPostgresMarketSnapshots, createPostgresMarketTrades } from '@ctp/market-data';
import { createPostgresPaperConfiguration } from './postgres-configuration.js';
import { createPaperFrameReader } from './frame-reader.js';
import type { PaperConfigurationIo } from './configuration-domain.js';
import type { PaperMarketFrames } from './frame-domain.js';
const deploymentSchema = z.strictObject({
  configurationUrl: z.string().min(1).max(4096),
  snapshotUrl: z.string().min(1).max(4096),
  tradeUrl: z.string().min(1).max(4096),
  environment: z.enum(['test', 'development', 'staging', 'production']),
  io: z
    .strictObject({ signal: z.instanceof(AbortSignal), deadline: z.number().int().safe() })
    .optional(),
});

/** Server-only composition. All URLs/roles are deployment-owned; there is no
 * public HTTP route, caller port, raw exchange credential or source override. */
export async function createPostgresPaperMarketFrames(rawOptions: {
  configurationUrl: string;
  snapshotUrl: string;
  tradeUrl: string;
  environment: 'test' | 'development' | 'staging' | 'production';
  io?: PaperConfigurationIo;
}): Promise<PaperMarketFrames> {
  let options: z.infer<typeof deploymentSchema>;
  try {
    options = deploymentSchema.parse(rawOptions);
    const urls = [options.configurationUrl, options.snapshotUrl, options.tradeUrl].map(
      (s) => new URL(s),
    );
    for (const u of urls)
      if (
        !['postgres:', 'postgresql:'].includes(u.protocol) ||
        !u.username ||
        !u.password ||
        !u.pathname.slice(1) ||
        u.pathname.slice(1).includes('/') ||
        u.hash ||
        [...u.searchParams.keys()].some((k) => k !== 'sslmode') ||
        [...u.searchParams.keys()].length > 1 ||
        (['staging', 'production'].includes(options.environment) &&
          (u.searchParams.get('sslmode') !== 'verify-full' ||
            process.env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0')) ||
        (options.environment === 'test' &&
          !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
      )
        throw new Error();
    const database = (u: URL) =>
      JSON.stringify([u.hostname, u.port || '5432', decodeURIComponent(u.pathname)]);
    if (
      new Set(urls.map(database)).size !== 1 ||
      new Set(urls.map((u) => decodeURIComponent(u.username))).size !== 3
    )
      throw new Error();
    if (options.io && (options.io.signal.aborted || options.io.deadline <= Date.now()))
      throw new Error();
  } catch {
    throw new Error('PAPER_FRAME_DATABASE_URL');
  }
  const owned: { close(): Promise<void> }[] = [];
  const guard = () => {
    if (options.io && (options.io.signal.aborted || options.io.deadline <= Date.now()))
      throw new Error('PAPER_FRAME_ABORTED');
  };
  try {
    guard();
    const configuration = await createPostgresPaperConfiguration({
      connectionString: options.configurationUrl,
      environment: options.environment,
      ...(options.io ? { io: options.io } : {}),
    });
    owned.push(configuration);
    guard();
    const snapshots = await createPostgresMarketSnapshots({
      connectionString: options.snapshotUrl,
      environment: options.environment,
    });
    owned.push(snapshots);
    guard();
    const trades = await createPostgresMarketTrades({
      connectionString: options.tradeUrl,
      environment: options.environment,
      ...(options.io ? { io: options.io } : {}),
    });
    owned.push(trades);
    guard();
    return createPaperFrameReader({ configuration, snapshots, trades });
  } catch {
    await Promise.allSettled(owned.map((p) => p.close()));
    throw new Error('PAPER_FRAME_STARTUP');
  }
}
