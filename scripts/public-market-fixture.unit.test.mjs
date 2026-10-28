import fs from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { format } from 'prettier';
import { expect, it } from 'vitest';
import { beforePublicMarketWriters } from './public-market-fixture-legacy.mjs';
const file = 'packages/database/test/paper-admission.integration.test.ts';
const read = (p) =>
  fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const hash = (s) => createHash('sha256').update(s).digest('hex');

it('retains the entire original61-case native fixture and cleanup after only writer-lifetime reconstruction', () => {
  expect(hash(beforePublicMarketWriters(file, read(file)))).toBe(
    'f09a8772c952ad313f101ff3410a432fee0bccd11291b1f9467c9476d408edfb',
  );
  expect(hash(read('scripts/test-database.mjs'))).toBe(
    '39480eb69aba08a9b1c88f8e51da439adc036b7222661832b961362240b424bd',
  );
});

it('limits the additive fixture cache to exactly two fixed public writer factories', async () => {
  const s = read(file),
    blocks = [...s.matchAll(/\/\/ BEGIN PUBLIC MARKET FIXTURE ([A-Z_]+)/gu)]
      .map((m) => m[1])
      .sort();
  expect(blocks).toEqual(['CACHE', 'IMPORT', 'USE']);
  const body = s.match(
    /\/\/ BEGIN PUBLIC MARKET FIXTURE CACHE\n([\s\S]+?)\/\/ END PUBLIC MARKET FIXTURE CACHE/u,
  )?.[1];
  expect(body).toBeDefined();
  const parsed = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true);
  const print = ts.createPrinter({ removeComments: true });
  const expected = ts.createSourceFile(
    file,
    `const publicMarketFixturePorts = createPublicMarketFixturePorts({
    snapshots: () => ownWriter(createPostgresMarketSnapshots({connectionString: required('DATABASE_MARKET_SNAPSHOT_URL'),environment: 'test'})),
    trades: () => ownWriter(createPostgresMarketTrades({connectionString: required('DATABASE_MARKET_TRADE_URL'),environment: 'test'})),
  });`,
    ts.ScriptTarget.Latest,
    true,
  );
  const options = { parser: 'typescript', singleQuote: true };
  expect(await format(print.printFile(parsed), options)).toBe(
    await format(print.printFile(expected), options),
  );
  expect(s).toContain('const snapshots = await publicMarketFixturePorts.snapshots(),');
  expect(s).toContain('trades = await publicMarketFixturePorts.trades();');
});

it('reconstruction rejects duplicate, missing or unexpected lifetime extension blocks', () => {
  const s = read(file);
  expect(() =>
    beforePublicMarketWriters(
      file,
      s + '// BEGIN PUBLIC MARKET FIXTURE EXTRA\nchanged\n// END PUBLIC MARKET FIXTURE EXTRA\n',
    ),
  ).toThrow('PUBLIC_MARKET_FIXTURE_BLOCKS');
  expect(() =>
    beforePublicMarketWriters(
      file,
      s.replace('BEGIN PUBLIC MARKET FIXTURE USE', 'BEGIN PUBLIC MARKET FIXTURE OTHER'),
    ),
  ).toThrow('PUBLIC_MARKET_FIXTURE_BLOCKS');
});
