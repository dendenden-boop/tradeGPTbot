import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { it, expect } from 'vitest';
import { beforeExecutionStart } from './execution-start-legacy.mjs';
const read = (p) =>
  fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const hash = (s) => createHash('sha256').update(s).digest('hex');
it.each([
  ['scripts/test-database.mjs', '28d7fa9fb66b73cad691eaf643664e608085625469dc2c561cf2400db4c8c8c1'],
  [
    'scripts/native-proof-artifacts.mjs',
    '578ed9d8dc8f5e9328a1a470626b42a05867b95c5cde075ea4a02ac9d2d5237c',
  ],
])(
  'reconstructs every accepted main62 statement in %s outside reviewed additions',
  (file, expected) => {
    const normalized = beforeExecutionStart(file, read(file));
    expect(hash(normalized)).toBe(expected);
    expect(beforeExecutionStart(file, normalized)).toBe(normalized);
  },
);
it.each(['scripts/test-database.mjs', 'scripts/native-proof-artifacts.mjs'])(
  'rejects changed/missing/duplicate execution-start marker bodies in %s',
  (file) => {
    const source = read(file);
    const block = source.match(
      /^[ \t]*\/\/ BEGIN PAPER EXECUTION START ([A-Z_]+)\n[\s\S]*?^[ \t]*\/\/ END PAPER EXECUTION START \1\n/mu,
    )[0];
    const firstBoundary = block.indexOf('\n') + 1;
    expect(firstBoundary).toBeGreaterThan(0);
    // Construct one intentional marker-body insertion; no escaping/sanitizing
    // or replacement of line delimiters is part of this fixture's contract.
    const changedBlock =
      block.slice(0, firstBoundary) + '// altered\n' + block.slice(firstBoundary);
    for (const changed of [
      source + block,
      source.replace('END PAPER EXECUTION START', 'END ALTERED EXECUTION START'),
      source.replace(block, changedBlock),
    ]) {
      expect(() => beforeExecutionStart(file, changed)).toThrow(
        'PAPER_EXECUTION_START_REVIEW_REQUIRED',
      );
    }
    expect(hash(beforeExecutionStart(file, source.replace('90000', '90001')))).not.toBe(
      hash(beforeExecutionStart(file, source)),
    );
  },
);
it('retains every original69-case source byte and all published61 migration files', () => {
  expect(hash(read('packages/database/test/paper-admission.integration.test.ts'))).toBe(
    'c9fe097d55c5e8d2e61d0311a99b5d44595a53e01f8ec1b17c364bd1030ed374',
  );
  const names = fs
    .readdirSync(new URL('../packages/database/prisma/migrations/', import.meta.url))
    .filter((n) => /^\d/u.test(n))
    .sort();
  expect(names).toHaveLength(62);
  expect(names[61]).toBe('202611020001_paper_execution_start');
});
