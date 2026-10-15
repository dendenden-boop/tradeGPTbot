import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';
import {
  createPostgresPaperConfiguration,
  paperConfigurationSchema,
} from '@ctp/paper-engine/configuration';
import {
  createPostgresPaperRuntimeObservations,
  createPostgresPaperRuntimeSource,
  paperRuntimeDependencies,
  type PaperRuntimePublication,
} from '@ctp/paper-engine/runtime';
import { fixture as modelFixture } from '../../paper-engine/test/fixtures.js';

if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('ISOLATED_PAPER_RUNTIME_RUNNER_REQUIRED');
const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error('ISOLATED_PAPER_RUNTIME_VARIABLE_REQUIRED');
  return value;
};
const admin = new Pool({
  connectionString: required('DATABASE_MIGRATION_URL'),
  max: 3,
  query_timeout: 5000,
});
const io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2500 });
const handles: { close(): Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
  await admin.end();
});
async function observer() {
  const h = await createPostgresPaperRuntimeObservations({
    connectionString: required('DATABASE_PAPER_RUNTIME_OBSERVER_URL'),
    environment: 'test',
  });
  handles.push(h);
  return h;
}
async function reader() {
  const h = await createPostgresPaperRuntimeSource({
    connectionString: required('DATABASE_PAPER_RUNTIME_READER_URL'),
    environment: 'test',
  });
  handles.push(h);
  return h;
}
async function fixture() {
  const c = paperConfigurationSchema.parse({
    id: randomUUID(),
    owner: { tenantId: randomUUID(), accountId: randomUUID(), mode: 'PAPER' },
    source: { exchange: 'BINANCE', market: 'SPOT', environment: 'LIVE', region: 'global' },
    valuationAsset: 'USDT',
    model: modelFixture().model,
  });
  await admin.query(
    `INSERT INTO public."user"(id,"emailNormalized",status,"emailVerifiedAt","updatedAt") VALUES($1,$2,'ACTIVE',now(),now())`,
    [c.owner.tenantId, c.owner.tenantId + '@example.invalid'],
  );
  await admin.query(
    `INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") VALUES($1,$2,'BINANCE','PAPER',$3,'global','SIMULATED','ACTIVE','paper-runtime-test',now())`,
    [c.owner.accountId, c.owner.tenantId, 'paper:' + c.owner.accountId],
  );
  const config = await createPostgresPaperConfiguration({
    connectionString: required('DATABASE_PAPER_CONFIGURATION_URL'),
    environment: 'test',
  });
  try {
    await config.register(c, io());
  } finally {
    await config.close();
  }
  const writer = await observer(),
    context = await writer.context(c.owner, io());
  const health = Object.fromEntries(
    paperRuntimeDependencies.map((k) => [
      k,
      { sourceId: k + ':probe:1', asOf: Date.now(), status: 'HEALTHY' },
    ]),
  ) as PaperRuntimePublication['observation']['health'];
  const publication: PaperRuntimePublication = {
    id: randomUUID(),
    expectedRevision: '0',
    observation: {
      owner: c.owner,
      configurationId: c.id,
      configurationHash: context.configurationHash,
      permissionEpoch: context.current.permissionEpoch,
      userSessionEpoch: context.current.userSessionEpoch,
      accountVersion: context.current.accountVersion,
      health,
    },
  };
  return { c, writer, context, publication };
}
it('native successive publications advance revision 1 to 2 and survive producer/reader restart', async () => {
  const f = await fixture();
  const first = await f.writer.publish(f.publication, io());
  expect(first.revision).toBe('1');
  const second: PaperRuntimePublication = {
    ...structuredClone(f.publication),
    id: randomUUID(),
    expectedRevision: '1',
  };
  for (const key of paperRuntimeDependencies) second.observation.health[key].asOf = Date.now();
  const receipt = await f.writer.publish(second, io());
  expect(receipt.revision).toBe('2');
  await f.writer.close();
  const restarted = await observer();
  expect(await restarted.head(f.c.owner, io())).toEqual({ ...receipt, replayed: true });
  const source = await reader();
  expect((await source.read(f.c.owner, io())).reference.id).toBe(second.id);
});
