import { createHash } from 'node:crypto';
// Only exact reviewed additions peel before the accepted predecessor checks.
const pins = {
  'scripts/test-database.mjs': {
    IMPORT: '18d2b75fe7d913e30f18e5eb6e4c97fadc0c0e959a48ce6fd0be4b132fc9743a',
    OWNER: '7a62a5cad373a10e9afb3404577e9fe8d2087284af1b0b9cc2c43d32bdef78c1',
    OVERLAP: 'd4c659fe53da2d87f9bb7dcaeed1f65fd222919cdaa46f8695b6e0383392f0f2',
  },
  'scripts/native-proof-artifacts.mjs': {
    REPORT: 'a19a05af17fc080d30009bb1fd5cf8421e8633112372726ae08579f62414e0fd',
    DEADLINE: 'd5d406bddfe83a6738a8b53c8fb82301ff9fd80cdd56eae1b8f21ddeb562dba0',
    EVIDENCE: '9ecdf3a7083b2d47fde4dfd561fa400551eab1e8ff6143a97eb6437d04a14aeb',
  },
  'scripts/started-source-harness.unit.test.mjs': {
    FIXTURE: 'b09d8add3a3f849b19749d7a20df1a3470a56f7f6294935b81fb688b1b3f9adf',
  },
  'scripts/started-risk-harness.unit.test.mjs': {
    FIXTURE: 'b09d8add3a3f849b19749d7a20df1a3470a56f7f6294935b81fb688b1b3f9adf',
  },
};
export function beforeStartedPreview(file, source) {
  const expected = pins[file];
  if (!expected || !source.includes('PAPER STARTED PREVIEW')) return source;
  const blocks = [
    ...source.matchAll(
      /^[ \t]*\/\/ BEGIN PAPER STARTED PREVIEW ([A-Z_]+)\n[\s\S]*?^[ \t]*\/\/ END PAPER STARTED PREVIEW \1\n/gm,
    ),
  ];
  if (
    blocks.length !== Object.keys(expected).length ||
    (source.match(/PAPER STARTED PREVIEW/gu) ?? []).length !== blocks.length * 2 ||
    blocks.some(
      (b, i) =>
        b[1] !== Object.keys(expected)[i] ||
        createHash('sha256').update(b[0]).digest('hex') !== expected[b[1]],
    )
  )
    throw Error('PAPER_STARTED_PREVIEW_REVIEW_REQUIRED');
  for (const block of blocks) source = source.replace(block[0], '');
  return source;
}
