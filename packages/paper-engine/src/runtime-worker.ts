import { z } from 'zod';
import {
  createPostgresPaperRuntimeCollector,
  type PaperRuntimeCollectorOptions,
} from './runtime-collector.js';
import { bindPaperRuntimeProbes, type PaperRuntimeProbes } from './runtime-collector-core.js';
import {
  createPaperRuntimeWorkerCore,
  paperRuntimeWorkerSettingsSchema,
  type PaperRuntimeWorker,
} from './runtime-worker-core.js';
import type { PaperOwner } from './configuration-domain.js';

export interface PaperRuntimeWorkerOptions extends PaperRuntimeCollectorOptions {
  /** Immutable server startup inventory, never account IDs from an HTTP request. */
  readonly owners: readonly PaperOwner[];
  readonly intervalMs: number;
}

/** Constructs an idle observation-only worker. All probes are explicit server
 * ports; there is no all-healthy default or financial dispatch authority. */
export async function createPostgresPaperRuntimeWorker(
  raw: PaperRuntimeWorkerOptions,
): Promise<PaperRuntimeWorker> {
  const parsed = z
    .strictObject({
      ...paperRuntimeWorkerSettingsSchema.shape,
      database: z.strictObject({
        connectionString: z.string().min(1).max(4096),
        environment: z.enum(['test', 'development', 'staging', 'production']),
        io: z
          .strictObject({ signal: z.instanceof(AbortSignal), deadline: z.number().int().safe() })
          .optional(),
      }),
      probes: z.custom<PaperRuntimeProbes>((value) => {
        try {
          bindPaperRuntimeProbes(value as PaperRuntimeProbes);
          return true;
        } catch {
          return false;
        }
      }),
    })
    .safeParse(raw);
  if (!parsed.success) throw new Error('PAPER_RUNTIME_WORKER_INPUT');
  const { owners, intervalMs, probes, database } = parsed.data;
  const { connectionString, environment, io } = database;
  const collector = await createPostgresPaperRuntimeCollector({
    database: { connectionString, environment, ...(io ? { io } : {}) },
    probes,
  });
  try {
    return createPaperRuntimeWorkerCore(collector, { owners, intervalMs });
  } catch {
    await collector.close();
    throw new Error('PAPER_RUNTIME_WORKER_INPUT');
  }
}
