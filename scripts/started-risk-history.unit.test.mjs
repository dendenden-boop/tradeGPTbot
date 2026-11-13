import { beforeHistoricalInventory } from './historical-inventory-legacy.mjs';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { beforeStartedRisk } from './started-risk-legacy.mjs';
const rawRead = (p) =>
  fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const read = (p) => beforeHistoricalInventory(p, rawRead(p));
it.each([
  ['scripts/test-database.mjs', '6b4c4b4bef95a98ca875a88077361495e1ede88eecd20e87ed53ec1df6d218b6'],
  [
    'scripts/native-proof-artifacts.mjs',
    '17cabc9a2b7d8db433de88af450a9f9547d867761dbfb2d5c4c529a4f2c5c688',
  ],
])(
  'retains every accepted mainc9 harness statement outside reviewed additions in %s',
  (file, hash) => {
    const source = read(file);
    const original = beforeStartedRisk(file, source);
    expect(createHash('sha256').update(original).digest('hex')).toBe(hash);
    expect(beforeStartedRisk(file, original)).toBe(original);
    const block = source.match(
      /^[ \t]*\/\/ BEGIN PAPER STARTED RISK ([A-Z_]+)\n[\s\S]*?^[ \t]*\/\/ END PAPER STARTED RISK \1\n/mu,
    )[0];
    const at = block.indexOf('\n') + 1;
    for (const corrupt of [
      source + block,
      source.replace(block, block.slice(0, at) + '// changed\n' + block.slice(at)),
      source.replace('END PAPER STARTED RISK', 'END CHANGED SOURCE'),
    ])
      expect(() => beforeStartedRisk(file, corrupt)).toThrow('PAPER_STARTED_RISK_REVIEW_REQUIRED');
  },
);
