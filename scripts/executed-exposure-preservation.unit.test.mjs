import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  beforeExecutedExposureRoot,
  beforeExecutedExposureHash,
  executedExposureAddition,
} from './executed-exposure-legacy.mjs';
const source = readFileSync('packages/paper-engine/src/index.ts', 'utf8').replaceAll('\r\n', '\n');
it('retains every accepted calculator root byte beneath the one appended exposure export', () => {
  expect(source.endsWith(executedExposureAddition)).toBe(true);
  const retained = beforeExecutedExposureRoot(source);
  expect(createHash('sha256').update(retained).digest('hex')).toBe(beforeExecutedExposureHash);
  expect(retained).toContain('calculatePaperStartedTransition');
});
it.each(['prefix', 'trailing', 'duplicate', 'body', 'missing'])(
  'rejects unreviewed root %s without weakening the predecessor pin',
  (kind) => {
    const bad =
      kind === 'prefix'
        ? '// prefix\n' + source
        : kind === 'trailing'
          ? source + '// trailing\n'
          : kind === 'duplicate'
            ? source + executedExposureAddition
            : kind === 'body'
              ? '// altered model export' + source.slice(source.indexOf('\n'))
              : source.slice(0, -executedExposureAddition.length);
    expect(() => beforeExecutedExposureRoot(bad)).toThrow('PAPER_EXECUTED_EXPOSURE_ROOT_REVIEW');
  },
);
