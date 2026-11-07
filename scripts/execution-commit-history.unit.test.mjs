import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { beforeExecutionCommit } from './execution-commit-legacy.mjs';

const pins = {
  'scripts/test-database.mjs': '8084950a7d515ee8f4521a756c873db3aef442e935e54ca54f541304c2af1035',
  'scripts/native-proof-artifacts.mjs':
    'd534880aec176d7c1d40c16ea67ddc4c99cf34b87ec5e7ea534d566bb8b2152e',
  'scripts/database-cohorts.mjs':
    '7c8381d35cc50716e6be317a4810ada562a5856ef9d27890061220f4edbedabe',
  'scripts/started-source-harness.unit.test.mjs':
    'bd59f53714f79c648e836b24883fab6f9f72cd2f8c0514f030bd84e3a6dc18a6',
  'scripts/started-risk-harness.unit.test.mjs':
    '7e4b5cc72631eaab163aefcfd1ff4caf0f143773707947e337320d176e37f916',
};
const hash = (s) => createHash('sha256').update(s).digest('hex');
it.each(Object.entries(pins))(
  'retains every accepted b50a9f statement beneath exact additive writer changes in %s',
  async (file, pin) => {
    const source = (await readFile(new URL('../' + file, import.meta.url), 'utf8')).replaceAll(
      '\r\n',
      '\n',
    );
    const previous = beforeExecutionCommit(file, source);
    expect(hash(previous)).toBe(pin);
    expect(beforeExecutionCommit(file, previous)).toBe(previous);
    expect(() => beforeExecutionCommit(file, source + source)).toThrow(
      'PAPER_EXECUTION_COMMIT_REVIEW_REQUIRED',
    );
    const changed = source.replace('90000', '90001');
    if (changed !== source) {
      try {
        expect(hash(beforeExecutionCommit(file, changed))).not.toBe(pin);
      } catch (e) {
        expect(e.message).toBe('PAPER_EXECUTION_COMMIT_REVIEW_REQUIRED');
      }
    }
  },
);
