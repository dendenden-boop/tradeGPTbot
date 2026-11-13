import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
const pins = {
  'scripts/started-source-history.unit.test.mjs':
    'ca16b0e638b66009cb8226dd54ead2316845f46d6a554a6067bf6abd5276b751',
  'scripts/started-risk-history.unit.test.mjs':
    '56f4eb6e1017fe10e84ccdb08222f7ab8781b48080787c6b6186dc4dcc3bd609',
  'scripts/started-preview-history.unit.test.mjs':
    'df39d45f55527802fd2caa1e55efa9cfe129d96c0436633a33dad842bcd08f11',
};
it.each(Object.entries(pins))(
  'preserves every original history-guard assertion while isolating its fixture: %s',
  async (file, pin) => {
    const source = (await readFile(new URL('../' + file, import.meta.url), 'utf8')).replaceAll(
      '\r\n',
      '\n',
    );
    const original = source
      .replace(
        "import { beforeHistoricalInventory } from './historical-inventory-legacy.mjs';\n",
        '',
      )
      .replace('const rawRead = (p) =>', 'const read = (p) =>')
      .replace('const read = (p) => beforeHistoricalInventory(p, rawRead(p));\n', '');
    expect(createHash('sha256').update(original).digest('hex')).toBe(pin);
  },
);
