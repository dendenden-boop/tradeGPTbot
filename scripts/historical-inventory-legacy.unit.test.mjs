import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  beforeHistoricalInventory,
  historicalInventoryReview,
} from './historical-inventory-legacy.mjs';
const sourceOf = async (file) =>
  (await readFile(new URL('../' + file, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const hash = (text) => createHash('sha256').update(text).digest('hex');
it.each(Object.keys(historicalInventoryReview))(
  'retains the complete accepted main harness below exact inventory additions: %s',
  async (file) => {
    const source = await sourceOf(file),
      review = historicalInventoryReview[file];
    expect(hash(beforeHistoricalInventory(file, source))).toBe(review.predecessor);
    for (const changed of [
      source + '// outside\n',
      '// prefix\n' + source,
      source + source,
      source.replace('90000', '90001'),
    ].filter((s) => s !== source))
      expect(() => beforeHistoricalInventory(file, changed)).toThrow(
        'PAPER_HISTORICAL_INVENTORY_REVIEW_REQUIRED',
      );
    for (const patch of review.patches) {
      expect(source.split(patch.next)).toHaveLength(2);
      expect(() =>
        beforeHistoricalInventory(file, source.replace(patch.next, patch.next + patch.next)),
      ).toThrow('PAPER_HISTORICAL_INVENTORY_REVIEW_REQUIRED');
      expect(() =>
        beforeHistoricalInventory(
          file,
          source.replace(patch.next, patch.next.replace('\n', '\n// unreviewed\n')),
        ),
      ).toThrow('PAPER_HISTORICAL_INVENTORY_REVIEW_REQUIRED');
    }
  },
);
it('preserves all previous valuation review patches and every original unit assertion', async () => {
  const dependency =
    "import { beforeHistoricalInventory } from './historical-inventory-legacy.mjs';\n";
  const helper = (await sourceOf('scripts/executed-valuation-legacy.mjs'))
    .replace(dependency, '')
    .replace('  source = beforeHistoricalInventory(file, source);\n', '');
  expect(hash(helper)).toBe('e1f66e54c2861d048265c95d3fb65f805476981419add2c285228eb2b272e53f');
  const unit = (await sourceOf('scripts/executed-valuation-legacy.unit.test.mjs'))
    .replace(dependency, '')
    .replace(
      "const sourceOf = async (file) =>\n  beforeHistoricalInventory(\n    file,\n    (await readFile(new URL('../' + file, import.meta.url), 'utf8')).replaceAll('\\r\\n', '\\n'),\n  );\n",
      '',
    )
    .replaceAll(
      'await sourceOf(file)',
      "(await readFile(new URL('../' + file, import.meta.url), 'utf8')).replaceAll(\n      '\\r\\n',\n      '\\n',\n    )",
    );
  expect(hash(unit)).toBe('ad18a6ee6045d665fa8ff476eaad5ef2d32cfe152952b87417a170a65654e989');
});
