import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createPostgresPaperRuntimeObservations } from './postgres-runtime.js';
import { paperRuntimeDependencies } from './runtime-domain.js';
import type { PaperRuntimeDatabaseOptions } from './runtime-database.js';
import {
  bindPaperRuntimeProbes,
  createPaperRuntimeCollectorCore,
  type PaperRuntimeCollector,
  type PaperRuntimeDependency,
  type PaperRuntimeProbe,
  type PaperRuntimeProbes,
} from './runtime-collector-core.js';

export interface PaperRuntimeCollectorOptions {
  readonly database: PaperRuntimeDatabaseOptions;
  /** Exclusive server-owned ports, never HTTP/request-supplied health values. */
  readonly probes: PaperRuntimeProbes;
}

/** Explicit negative sensor for an absent service. Never a HEALTHY default. */
export function createUnavailablePaperRuntimeProbe(
  dependency: PaperRuntimeDependency,
): PaperRuntimeProbe {
  if (!paperRuntimeDependencies.includes(dependency))
    throw new Error('PAPER_RUNTIME_COLLECTOR_INPUT');
  let closed = false;
  const probe: PaperRuntimeProbe = {
    dependency,
    sample(context, io) {
      if (closed || io.signal.aborted || Date.now() >= io.deadline)
        return Promise.reject(new Error('PAPER_RUNTIME_COLLECTOR_ABORTED'));
      return Promise.resolve({
        dependency,
        contextHash: context.hash,
        fact: {
          sourceId: `unavailable:${dependency}:${randomUUID()}`,
          asOf: Date.now(),
          status: 'UNKNOWN' as const,
        },
      });
    },
    close() {
      closed = true;
      return Promise.resolve();
    },
  };
  return Object.freeze(probe);
}

/** One bounded server collection cycle; no timer worker, certificate or grant.
 * Persistence is always the existing fixed PostgreSQL observer, without a memory
 * default. Successful construction transfers ownership of all nine probe ports. */
export async function createPostgresPaperRuntimeCollector(
  raw: PaperRuntimeCollectorOptions,
): Promise<PaperRuntimeCollector> {
  const parsed = z
    .strictObject({
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
  if (!parsed.success) throw new Error('PAPER_RUNTIME_COLLECTOR_INPUT');
  const probes = bindPaperRuntimeProbes(parsed.data.probes);
  const { connectionString, environment, io } = parsed.data.database;
  const observer = await createPostgresPaperRuntimeObservations({
    connectionString,
    environment,
    ...(io ? { io } : {}),
  });
  try {
    return createPaperRuntimeCollectorCore(observer, probes);
  } catch {
    await observer.close();
    throw new Error('PAPER_RUNTIME_COLLECTOR_INPUT');
  }
}
