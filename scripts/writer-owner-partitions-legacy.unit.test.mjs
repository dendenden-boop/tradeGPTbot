import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  writerOwnerReview,
  beforeWriterOwnerPartitions,
} from './writer-owner-partitions-legacy.mjs';
const text = readFileSync(writerOwnerReview.file, 'utf8').replaceAll('\r\n', '\n');
it('restores the complete exact pre-partition runner with every original owner assertion and90s limit', () => {
  const old = beforeWriterOwnerPartitions(writerOwnerReview.file, text);
  expect(createHash('sha256').update(old).digest('hex')).toBe(
    '9d7730c7248d15ff540355b909f91e4a945263e7de69abab8c5158cf99e382dd',
  );
  expect(old).toContain('executionCommitOwner.numPassedTests, 49');
  expect(old).toContain('secrets, echo: true, timeoutMs: 90000');
  expect(beforeWriterOwnerPartitions(writerOwnerReview.file, old)).toBe(old);
});
it.each(['timeout', 'owner proof', 'missing import', 'duplicate block'])(
  'rejects unreviewed parallel-owner changes: %s',
  (defect) => {
    const candidate =
      defect === 'timeout'
        ? text.replace(
            writerOwnerReview.currentBlock,
            writerOwnerReview.currentBlock.replace('timeoutMs: 90000', 'timeoutMs: 180000'),
          )
        : defect === 'owner proof'
          ? text.replace('runWriterOwnerSuite(', 'unreviewedWriterSuite(')
          : defect === 'missing import'
            ? text.replace(writerOwnerReview.importBlock, '')
            : text + writerOwnerReview.currentBlock;
    expect(candidate).not.toBe(text);
    expect(() => beforeWriterOwnerPartitions(writerOwnerReview.file, candidate)).toThrow(
      'WRITER_OWNER_REVIEW_REQUIRED',
    );
  },
);
