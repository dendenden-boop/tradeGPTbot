import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
const pins = {
  stable: {
    'packages/paper-engine/src/started-execution.ts':
      '88b4a0c504d87b77bb36500fd85999000801c0f6491ce19e9ae8f8ddeab5cfb5',
    'packages/paper-engine/src/admission-database.ts':
      '8788c23b80b437ceac6090c14e43f1b1981b0fac9fcf398f9f85f84ce7f0a199',
    'packages/paper-engine/src/execution-risk-domain.ts':
      'bc0662fc8ce6d9775f8f1882e847200db518cc3a0f30c9f02428cbc61b38d756',
    'packages/paper-engine/src/index.ts':
      '8f27d39a7a4dffc507bfc75a69129d0e84bd384331048e6d10c86b748a2dae00',
  },
  risk: 'packages/paper-engine/src/postgres-started-risk.ts',
  oldRisk: '22e35523ddd651c666436267e8fe5bf468bdb5fac54440ac498417f7d215b291',
  wrapperHash: '3e3a7506597330403df592327e60db593e562b005110a1e720e658a95f63e43b',
  migrationDigest: '4318d9c8724743039d74e9665133862c15540ca39e69737e1220accedd8c04f3',
};
const read = (p) =>
  fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const hash = (s) => createHash('sha256').update(s).digest('hex');
it.each(Object.entries(pins.stable))(
  'keeps accepted calculation/transport/default Risk/pure boundary unchanged: %s',
  (file, expected) => {
    expect(hash(read(file))).toBe(expected);
  },
);
it('preserves the complete accepted current-Risk reader with only the reviewed private wrappers', () => {
  const source = read(pins.risk),
    start = source.indexOf('/** Internal fixed-RPC helpers.'),
    end = source.indexOf('/** Current read/re-evaluation only.', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const wrapper = source.slice(start, end);
  expect(hash(wrapper)).toBe(pins.wrapperHash);
  expect(hash(source.replace(wrapper, ''))).toBe(pins.oldRisk);
});
it('keeps all 64 published migration bodies and ordering immutable', () => {
  const root = 'packages/database/prisma/migrations';
  const names = fs
    .readdirSync(new URL('../' + root, import.meta.url))
    .filter((n) => /^\d/.test(n))
    .sort();
  expect(names.length).toBeGreaterThanOrEqual(64);
  expect(
    hash(
      JSON.stringify(
        names.slice(0, 64).map((n) => [n, hash(read(root + '/' + n + '/migration.sql'))]),
      ),
    ),
  ).toBe(pins.migrationDigest);
});
