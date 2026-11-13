import { beforeHistoricalInventory } from './historical-inventory-legacy.mjs';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { beforeStartedSource } from './started-source-legacy.mjs';
const rawRead = (p) =>
  fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const read = (p) => beforeHistoricalInventory(p, rawRead(p));
it.each([
  ['scripts/test-database.mjs', 'e5868f72d54c3d437de1f6bf19ae04f7164c520acd65618d7f6d5ccb82f5fbe7'],
  [
    'scripts/native-proof-artifacts.mjs',
    '184c478533918f51e64d6758c1c636f7ee5ec5bc3166b475b252e2c46350dc33',
  ],
])(
  'retains every accepted main74 harness statement outside reviewed additions in %s',
  (file, hash) => {
    const source = read(file);
    const original = beforeStartedSource(file, source);
    expect(createHash('sha256').update(original).digest('hex')).toBe(hash);
    expect(beforeStartedSource(file, original)).toBe(original);
    const block = source.match(
      /^[ \t]*\/\/ BEGIN PAPER STARTED SOURCE ([A-Z_]+)\n[\s\S]*?^[ \t]*\/\/ END PAPER STARTED SOURCE \1\n/mu,
    )[0];
    const at = block.indexOf('\n') + 1;
    for (const corrupt of [
      source + block,
      source.replace(block, block.slice(0, at) + '// changed\n' + block.slice(at)),
      source.replace('END PAPER STARTED SOURCE', 'END CHANGED SOURCE'),
    ])
      expect(() => beforeStartedSource(file, corrupt)).toThrow(
        'PAPER_STARTED_SOURCE_REVIEW_REQUIRED',
      );
  },
);
